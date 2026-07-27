// Swallow harmless "Could not establish connection" rejections from sendMessage
// when no content script is present in the active tab. These are benign in this
// extension's design and only clutter the error surface of chrome://extensions.
self.addEventListener('unhandledrejection', e => {
  const msg = e.reason && e.reason.message || ''
  if (msg.includes('Could not establish connection') ||
      msg.includes('Receiving end does not exist')) {
    e.preventDefault()
  }
})

import {gimmeToggle} from "./contextmenu/launcher.js"
import {getColorMode} from "./contextmenu/colormode.js"
import {getColorScheme} from "./contextmenu/colorscheme.js"

const state = {
  loaded:   {},
  injected: {},
}

var platform = typeof browser === 'undefined'
  ? chrome
  : browser

const toggleIn = ({id:tab_id}) => {
  const swallow = p => { if (p && typeof p.catch === 'function') p.catch(() => {}) }

  // toggle out: it's currently loaded and injected
  if (state.loaded[tab_id] && state.injected[tab_id]) {
    swallow(platform.scripting.executeScript({
      target: {tabId: tab_id},
      files: ['toolbar/eject.js'],
    }))
    state.injected[tab_id] = false
  }

  // toggle in: it's loaded and needs injected
  else if (state.loaded[tab_id] && !state.injected[tab_id]) {
    swallow(platform.scripting.executeScript({
      target: {tabId: tab_id},
      files: ['toolbar/restore.js'],
    }))
    swallow(platform.scripting.executeScript({
      target: {tabId: tab_id},
      files: ['toolbar/fullscreen.js'],
    }))
    state.injected[tab_id] = true
    getColorMode()
    getColorScheme()
  }

  // fresh start in tab
  else {
    swallow(platform.scripting.insertCSS({
      target: {tabId: tab_id},
      files: ['toolbar/bundle.css' ],
    }))
    swallow(platform.scripting.executeScript({
      target: {tabId: tab_id},
      files: ['toolbar/inject.js'],
    }))
    swallow(platform.scripting.executeScript({
      target: {tabId: tab_id},
      files: ['toolbar/fullscreen.js'],
    }))

    state.loaded[tab_id]    = true
    state.injected[tab_id]  = true
    getColorMode()
    getColorScheme()
  }

  platform.tabs.onUpdated.addListener(function(tabId) {
    if (tabId === tab_id)
      state.loaded[tabId] = false
  })
}

gimmeToggle(toggleIn)

// ---------------------------------------------------------------------------
// Inspiration Library storage — IndexedDB in the extension's own origin.
//
// Why here (background service worker) and not in inject.js: the content script
// runs in the page's origin, so its IndexedDB would be per-site (a library on
// aigc.baidu.com wouldn't be visible on another site). The old backend used
// chrome.storage.local, which is extension-global (cross-site). To keep that
// cross-site "one shared library" semantic while escaping the ~10MB quota, the
// DB lives in the SW origin and is reached via runtime messaging.
//
// The record shape is unchanged: one key ("liaison.inspiration.library") maps to
// the whole {version, snapshots:[…]} object. bundle.min.js's get/set contract is
// untouched — only the persistence layer moved. Later phases can split snapshots
// into per-row storage; for now this is a drop-in, zero-risk backend swap that
// removes the quota ceiling.
// ---------------------------------------------------------------------------
const LIAISON_DB_NAME = 'liaison-asset-library'
const LIAISON_DB_STORE = 'kv'
const LIAISON_LIB_KEY = 'liaison.inspiration.library'

function liaisonOpenDb() {
  return new Promise((resolve, reject) => {
    let req
    try {
      req = indexedDB.open(LIAISON_DB_NAME, 1)
    } catch (e) {
      reject(e)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(LIAISON_DB_STORE)) {
        db.createObjectStore(LIAISON_DB_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('indexedDB open failed'))
  })
}

function liaisonDbGet(key) {
  return liaisonOpenDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(LIAISON_DB_STORE, 'readonly')
    const req = tx.objectStore(LIAISON_DB_STORE).get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('idb get failed'))
  }))
}

function liaisonDbSet(key, value) {
  return liaisonOpenDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(LIAISON_DB_STORE, 'readwrite')
    tx.objectStore(LIAISON_DB_STORE).put(value, key)
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => reject(tx.error || new Error('idb set failed'))
    tx.onabort = () => reject(tx.error || new Error('idb set aborted'))
  }))
}

// One-time migration: if IndexedDB has no library yet but the legacy
// chrome.storage.local copy exists, move it over. Runs on the first get().
function liaisonMigrateFromLocal() {
  return liaisonDbGet(LIAISON_LIB_KEY).then(existing => {
    if (existing !== undefined && existing !== null) return existing
    return new Promise((resolve) => {
      platform.storage.local.get([LIAISON_LIB_KEY], (o) => {
        const legacy = o && o[LIAISON_LIB_KEY]
        if (legacy && typeof legacy === 'object') {
          liaisonDbSet(LIAISON_LIB_KEY, legacy)
            .then(() => resolve(legacy))
            .catch(() => resolve(legacy))
        } else {
          resolve(undefined)
        }
      })
    })
  })
}

// ---------------------------------------------------------------------------
// CDP-backed collection infrastructure (hover-state harvesting, and a reusable
// base for future CDP capabilities: matched-style provenance, pseudo-element
// rules, platform fonts, box model, live @media rules).
//
// Why CDP: some visual state can't be read from the page world at all. CSS
// `:hover` is one — it can only be triggered by a real pointer or by CDP's
// `CSS.forcePseudoState`; JS `dispatchEvent(mouseenter)` does NOT fire it
// (verified). And cross-origin `.cssRules` throw SecurityError. CDP sits at the
// DevTools layer and sidesteps both.
//
// `withCdpSession` owns the attach → enable(DOM,CSS) → work → detach lifecycle
// and GUARANTEES detach + pseudo-cleanup in a finally, so every capability
// (present and future) shares one debugging banner and one cleanup path. hover
// is just the first consumer; add more by appending capability units inside
// `collectViaCdp` — no new attach, no new bridge action, no new permission.
// ---------------------------------------------------------------------------
async function withCdpSession(tabId, worker) {
  const target = { tabId }
  const cmd = (method, params) => new Promise((res, rej) => {
    platform.debugger.sendCommand(target, method, params || {}, r => {
      const e = platform.runtime.lastError
      if (e) rej(new Error(e.message)); else res(r)
    })
  })

  // attach may reject: user declined the banner, or DevTools already owns this
  // tab (one debugger client per tab). Reject bubbles to the caller → graceful
  // degrade. No detach needed here — we never attached.
  await new Promise((res, rej) => {
    platform.debugger.attach(target, '1.3', () => {
      const e = platform.runtime.lastError
      if (e) rej(new Error(e.message)); else res()
    })
  })

  const session = {
    cmd,
    forcedNodeIds: new Set(),
    async forcePseudo(nodeId, classes) {
      await cmd('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: classes })
      if (classes && classes.length) this.forcedNodeIds.add(nodeId)
      else this.forcedNodeIds.delete(nodeId)
    },
    _rootId: null,
    async selectedNodeId() {
      if (!this._rootId) {
        const doc = await cmd('DOM.getDocument', { depth: -1 })
        this._rootId = doc.root.nodeId
      }
      const sel = await cmd('DOM.querySelector', { nodeId: this._rootId, selector: '[data-selected="true"]' })
      if (!sel || !sel.nodeId) throw new Error('no data-selected node')
      return sel.nodeId
    }
  }

  try {
    await cmd('DOM.enable')
    await cmd('CSS.enable')
    return await worker(session)
  } finally {
    // Unconditional cleanup: clear every forced pseudo, then detach (banner
    // disappears, debugger client released). Both are best-effort/idempotent.
    for (const nid of session.forcedNodeIds) {
      try { await cmd('CSS.forcePseudoState', { nodeId: nid, forcedPseudoClasses: [] }) } catch (_) {}
    }
    await new Promise(res => {
      try { platform.debugger.detach(target, () => { void platform.runtime.lastError; res() }) }
      catch (_) { res() }
    })
  }
}

// One capability unit: force :hover on the target, diff computed style (target
// + descendants) against the default state. `session` owns attach/detach; this
// function only forces the pseudo (recorded for cleanup) and reads/diffs.
async function collectHover(session, targetNodeId, whitelist) {
  const wl = whitelist && whitelist.length ? whitelist : null
  const readComputed = async (nid) => {
    const r = await session.cmd('CSS.getComputedStyleForNode', { nodeId: nid })
    const m = {}
    const arr = (r && r.computedStyle) || []
    for (let i = 0; i < arr.length; i++) {
      const name = arr[i].name
      if (!wl || wl.indexOf(name) >= 0) m[name] = arr[i].value
    }
    return m
  }
  const diffMap = (base, hov) => {
    const out = {}
    Object.keys(hov).forEach(k => { if (base[k] !== hov[k]) out[k] = hov[k] })
    return out
  }

  // descendants (cap to avoid runaway on huge subtrees; hover linkage is tiny)
  let descIds = []
  try {
    const qa = await session.cmd('DOM.querySelectorAll', { nodeId: targetNodeId, selector: '*' })
    descIds = ((qa && qa.nodeIds) || []).slice(0, 200)
  } catch (_) { descIds = [] }
  const allIds = [targetNodeId].concat(descIds)

  // baseline (before forcing hover) — same engine/nodeIds/props as hover state
  const base = {}
  for (const nid of allIds) base[nid] = await readComputed(nid)

  await session.forcePseudo(targetNodeId, ['hover'])

  // Wait for CSS transitions to finish before reading, so we capture the SETTLED
  // hover state (opacity:1, transform back to 0) rather than a mid-animation
  // frame (e.g. opacity:0.048). 450ms covers the common 0.4s transition; the
  // whole session is still under the 8s handler timeout.
  await new Promise(res => setTimeout(res, 450))

  const hov = {}
  for (const nid of allIds) hov[nid] = await readComputed(nid)

  const selfDecls = diffMap(base[targetNodeId], hov[targetNodeId])

  const descendants = []
  for (const nid of descIds) {
    const d = diffMap(base[nid], hov[nid])
    if (!Object.keys(d).length) continue
    let tag = '', cls = ''
    try {
      const dn = await session.cmd('DOM.describeNode', { nodeId: nid })
      const node = dn && dn.node
      tag = (node && node.localName) || ''
      const attrs = (node && node.attributes) || []
      for (let i = 0; i < attrs.length; i += 2) {
        if (attrs[i] === 'class') { cls = String(attrs[i + 1] || '').trim(); break }
      }
    } catch (_) {}
    const firstClass = cls ? cls.split(/\s+/)[0] : ''
    const descSel = firstClass ? '.' + firstClass : (tag || '*')
    descendants.push({ pseudo: 'hover', descSel, decls: d, matchCount: 1, sample: { tag, cls: cls.slice(0, 80), text: '' } })
  }

  return { self: selfDecls, descendants }
}

// Capability dispatcher: one attach, run every requested capability unit,
// return results keyed by capability name. Add future units here.
async function collectViaCdp(session, req) {
  const caps = (req && req.capabilities) || ['hover']
  const whitelist = (req && req.whitelist) || []
  const out = {}
  if (caps.indexOf('hover') >= 0) {
    const targetNodeId = await session.selectedNodeId()
    out.hover = await collectHover(session, targetNodeId, whitelist)
  }
  // Future (not yet implemented) — same session, same attach:
  //   if (caps.indexOf('matchedStyles') >= 0) out.matchedStyles = await collectMatchedStyles(session, ...)
  //   if (caps.indexOf('boxModel') >= 0)      out.boxModel      = await collectBoxModel(session, ...)
  return out
}

// Screenshot bridge for Liaison Inspiration Library: content-script asks for
// a viewport PNG/JPEG, background captures via activeTab, returns data URL.
platform.runtime.onMessage.addListener((req, sender, sendResponse) => {
  // IndexedDB-backed library get (with one-time migration from chrome.storage).
  if (req && req.action === 'liaisonInspDbGet') {
    liaisonMigrateFromLocal()
      .then(value => sendResponse({ ok: true, value }))
      .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }))
    return true
  }
  // IndexedDB-backed library set.
  if (req && req.action === 'liaisonInspDbSet') {
    liaisonDbSet(LIAISON_LIB_KEY, req.value)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }))
    return true
  }
  // Cross-origin CSS text bridge (A′ scheme for hover-state harvesting).
  //
  // Why: the content script harvests :hover / :focus rules by walking
  // document.styleSheets[].cssRules. For cross-origin stylesheets (e.g. a CDN
  // .css on hogee.baidu.com) the page's JS can't read .cssRules — the browser
  // throws SecurityError and the rules are silently skipped, so hover-state
  // interaction rules never reach the prompt. The background service worker,
  // however, can fetch() those URLs with the extension's host permissions
  // (<all_urls>), bypassing the page CORS restriction. Content script sends the
  // stylesheet href here, we return the raw CSS text for it to parse locally.
  if (req && req.action === 'liaisonFetchCss') {
    (async () => {
      try {
        const url = String(req.url || '')
        console.log('[liaison-hover BG] fetch request url=', url)
        if (!/^https?:\/\//i.test(url)) {
          console.warn('[liaison-hover BG] bad url', url)
          sendResponse({ ok: false, error: 'bad url' })
          return
        }
        const resp = await fetch(url, { credentials: 'omit', redirect: 'follow' })
        if (!resp.ok) {
          console.warn('[liaison-hover BG] http', resp.status, url)
          sendResponse({ ok: false, error: 'http ' + resp.status })
          return
        }
        let text = await resp.text()
        // Cap to keep messaging payload sane; hover rules live early in most
        // sheets and this is a best-effort enrichment, not a full mirror.
        const MAX = 2_000_000
        if (text.length > MAX) text = text.slice(0, MAX)
        console.log('[liaison-hover BG] fetch OK len=', text.length, url)
        sendResponse({ ok: true, text })
      } catch (e) {
        console.warn('[liaison-hover BG] fetch threw', String(e && e.message || e), url)
        sendResponse({ ok: false, error: String(e && e.message || e) })
      }
    })()
    return true
  }
  // CDP collection bridge (hover state now; future capabilities via same action).
  // Page-world bundle can't reach chrome.debugger; content script forwards here.
  if (req && req.action === 'liaisonCdpCollect') {
    const tabId = sender && sender.tab && sender.tab.id
    ;(async () => {
      if (typeof tabId !== 'number') { sendResponse({ ok: false, error: 'no tabId' }); return }
      try {
        const result = await Promise.race([
          withCdpSession(tabId, s => collectViaCdp(s, req)),
          new Promise((_, rej) => setTimeout(() => rej(new Error('cdp timeout')), 8000))
        ])
        console.log('[liaison-hover BG] cdpCollect ok', JSON.stringify(result).length, 'bytes')
        sendResponse({ ok: true, result })
      } catch (e) {
        // Idempotent safety detach: if the timeout race won, withCdpSession's
        // finally still detaches asynchronously; this second detach is a no-op
        // guard against any leak (already-detached → lastError, swallowed).
        try { platform.debugger.detach({ tabId }, () => { void platform.runtime.lastError }) } catch (_) {}
        console.warn('[liaison-hover BG] cdpCollect fail:', String(e && e.message || e))
        sendResponse({ ok: false, error: String(e && e.message || e) })
      }
    })()
    return true
  }
  if (req && req.action === 'liaisonInspCaptureVisibleTab') {
    try {
      platform.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 95 }, (dataUrl) => {
        const err = platform.runtime.lastError
        if (err || !dataUrl) {
          sendResponse({ ok: false, error: err ? err.message : 'empty dataUrl' })
          return
        }
        sendResponse({ ok: true, dataUrl })
      })
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) })
    }
    return true
  }
  // Download bridge: save the ref JPEG to disk and return the absolute path.
  // Lets the copied prompt reference the file by path instead of embedding a
  // ~100KB base64 heredoc that would otherwise dominate the prompt prefill.
  if (req && req.action === 'liaisonInspDownload') {
    try {
      const safeFilename = (typeof req.filename === 'string' && /^[A-Za-z0-9._-]+\.(jpe?g|png)$/i.test(req.filename))
        ? req.filename
        : 'liaison-ref.jpg'
      platform.downloads.download({
        url: req.dataUrl,
        filename: safeFilename,
        conflictAction: 'overwrite',
        saveAs: false
      }, (id) => {
        const err = platform.runtime.lastError
        if (err || typeof id !== 'number') {
          sendResponse({ ok: false, error: err ? err.message : 'download start failed' })
          return
        }
        const onChanged = (delta) => {
          if (delta.id !== id) return
          if (delta.error && delta.error.current) {
            platform.downloads.onChanged.removeListener(onChanged)
            sendResponse({ ok: false, error: delta.error.current })
            return
          }
          if (delta.state && delta.state.current === 'complete') {
            platform.downloads.onChanged.removeListener(onChanged)
            platform.downloads.search({ id }, (items) => {
              if (items && items[0] && items[0].filename) {
                sendResponse({ ok: true, path: items[0].filename })
              } else {
                sendResponse({ ok: false, error: 'no filename after complete' })
              }
            })
          }
        }
        platform.downloads.onChanged.addListener(onChanged)
      })
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) })
    }
    return true
  }
})
