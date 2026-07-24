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

// Screenshot bridge for Liaison Inspiration Library: content-script asks for
// a viewport PNG/JPEG, background captures via activeTab, returns data URL.
platform.runtime.onMessage.addListener((req, sender, sendResponse) => {
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
