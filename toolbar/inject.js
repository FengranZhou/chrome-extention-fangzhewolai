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
      result = await new Promise((resolve) => {
        platform.storage.local.get([d.payload.key], (o) => resolve(o && o[d.payload.key]))
      })
    } else if (d.action === 'set') {
      await new Promise((resolve, reject) => {
        platform.storage.local.set({ [d.payload.key]: d.payload.value }, () => {
          if (platform.runtime.lastError) reject(platform.runtime.lastError)
          else resolve()
        })
      })
      result = true
    } else {
      return
    }
    window.postMessage({ _liaisonInspBridgeReply: true, id: d.id, ok: true, result }, '*')
  } catch (err) {
    window.postMessage({ _liaisonInspBridgeReply: true, id: d.id, ok: false, error: String(err && err.message || err) }, '*')
  }
})

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
