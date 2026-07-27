var platform = typeof browser === 'undefined'
  ? chrome
  : browser

// Bridge between page-world bundle (no chrome.* access) and content-script
// (has chrome.storage). Used by window.__liaisonInsp for persistent library.
window.addEventListener('message', async (event) => {
  if (event.source !== window) return
  const d = event.data
  if (!d || d._liaisonInspBridge !== true || !d.id) return
  try {
    let result
    if (d.action === 'get') {
      // Library storage now lives in the background service worker's IndexedDB
      // (extension origin → cross-site shared, no ~10MB quota). Forward to it.
      // First get triggers a one-time migration from legacy chrome.storage.local.
      const resp = await new Promise((resolve) => {
        platform.runtime.sendMessage({ action: 'liaisonInspDbGet' }, (r) => {
          if (platform.runtime.lastError) resolve({ ok: false, error: platform.runtime.lastError.message })
          else resolve(r || { ok: false, error: 'no response' })
        })
      })
      if (!resp.ok) throw new Error(resp.error || 'db get failed')
      result = resp.value
    } else if (d.action === 'set') {
      const resp = await new Promise((resolve) => {
        platform.runtime.sendMessage({ action: 'liaisonInspDbSet', value: d.payload.value }, (r) => {
          if (platform.runtime.lastError) resolve({ ok: false, error: platform.runtime.lastError.message })
          else resolve(r || { ok: false, error: 'no response' })
        })
      })
      if (!resp.ok) throw new Error(resp.error || 'db set failed')
      result = true
    } else if (d.action === 'screenshot') {
      const resp = await new Promise((resolve) => {
        platform.runtime.sendMessage({ action: 'liaisonInspCaptureVisibleTab' }, (r) => {
          if (platform.runtime.lastError) resolve({ ok: false, error: platform.runtime.lastError.message })
          else resolve(r || { ok: false, error: 'no response' })
        })
      })
      if (!resp.ok) throw new Error(resp.error || 'screenshot failed')
      result = resp.dataUrl
    } else if (d.action === 'download') {
      const resp = await new Promise((resolve) => {
        platform.runtime.sendMessage({ action: 'liaisonInspDownload', dataUrl: d.payload.dataUrl, filename: d.payload.filename }, (r) => {
          if (platform.runtime.lastError) resolve({ ok: false, error: platform.runtime.lastError.message })
          else resolve(r || { ok: false, error: 'no response' })
        })
      })
      if (!resp.ok) throw new Error(resp.error || 'download failed')
      result = resp.path
    } else if (d.action === 'fetchCss') {
      // Page-world bundle can't reach chrome.runtime; bridge its cross-origin
      // CSS fetch to the background service worker (which has host permissions).
      const resp = await new Promise((resolve) => {
        platform.runtime.sendMessage({ action: 'liaisonFetchCss', url: d.payload.url }, (r) => {
          if (platform.runtime.lastError) resolve({ ok: false, error: platform.runtime.lastError.message })
          else resolve(r || { ok: false, error: 'no response' })
        })
      })
      if (!resp.ok) throw new Error(resp.error || 'fetchCss failed')
      result = resp.text
    } else if (d.action === 'cdpCollect') {
      // Page-world bundle can't reach chrome.debugger; bridge CDP-backed
      // collection (hover state now; future capabilities via same action) to
      // the background service worker. Capability-agnostic: payload carries
      // { capabilities, whitelist }, so new capabilities need no bridge change.
      const resp = await new Promise((resolve) => {
        platform.runtime.sendMessage({ action: 'liaisonCdpCollect', capabilities: d.payload.capabilities, whitelist: d.payload.whitelist }, (r) => {
          if (platform.runtime.lastError) resolve({ ok: false, error: platform.runtime.lastError.message })
          else resolve(r || { ok: false, error: 'no response' })
        })
      })
      if (!resp.ok) throw new Error(resp.error || 'cdpCollect failed')
      result = resp.result
    } else {
      return
    }
    window.postMessage({ _liaisonInspBridgeReply: true, id: d.id, ok: true, result }, '*')
  } catch (err) {
    window.postMessage({ _liaisonInspBridgeReply: true, id: d.id, ok: false, error: String(err && err.message || err) }, '*')
  }
})

// Full-screen asset-library grid UI (page world, shares window.__liaisonInsp).
// Injected before the bundle so window.__liaisonAssetUI is ready when the
// bundle's renderInspirationPanel() calls it in fullscreen mode.
const assetUiScript = document.createElement('script')
assetUiScript.src = platform.runtime.getURL('toolbar/asset-library-ui.js')
document.body.appendChild(assetUiScript)

const script = document.createElement('script')
script.type = 'module'
script.src = platform.runtime.getURL('toolbar/bundle.min.js')
document.body.appendChild(script)

const liaison = document.createElement('liaison-app')

document.body.prepend(liaison)

platform.runtime.onMessage.addListener(request => {
  if (request.action === 'COLOR_MODE')
    liaison.setAttribute('color-mode', request.params.mode)
  else if (request.action === 'COLOR_SCHEME')
    liaison.setAttribute("color-scheme", request.params.mode)
})
