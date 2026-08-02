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
    } else if (d.action === 'kvGet') {
      // 通用 kv 读（按 key），自检结果持久化用。走 background 的同一 IndexedDB。
      const resp = await new Promise((resolve) => {
        platform.runtime.sendMessage({ action: 'liaisonKvGet', key: d.payload.key }, (r) => {
          if (platform.runtime.lastError) resolve({ ok: false, error: platform.runtime.lastError.message })
          else resolve(r || { ok: false, error: 'no response' })
        })
      })
      if (!resp.ok) throw new Error(resp.error || 'kv get failed')
      result = resp.value
    } else if (d.action === 'kvSet') {
      const resp = await new Promise((resolve) => {
        platform.runtime.sendMessage({ action: 'liaisonKvSet', key: d.payload.key, value: d.payload.value }, (r) => {
          if (platform.runtime.lastError) resolve({ ok: false, error: platform.runtime.lastError.message })
          else resolve(r || { ok: false, error: 'no response' })
        })
      })
      if (!resp.ok) throw new Error(resp.error || 'kv set failed')
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
    } else if (d.action === 'selfAudit') {
      // 「自检」tab：走 background fetch（content script 直连 localhost 会被页面 CSP 挡；
      // background 用扩展权限不受页面 CSP 约束）。用「两段式短轮询」而非长连接/长回调：
      //   1) 让 background 发起审查 → 秒回 taskId（后台异步跑）
      //   2) 每 3s 让 background 查一次结果 → 秒回
      // 每次都是秒回的短请求，MV3 service worker 无需长时间存活、不会被 30s 空闲回收。
      const sendBg = (action, body) => new Promise((resolve) => {
        platform.runtime.sendMessage({ action, ...body }, (r) => {
          if (platform.runtime.lastError) resolve({ ok: false, error: platform.runtime.lastError.message })
          else resolve(r || { ok: false, error: 'no response' })
        })
      })
      const started = await sendBg('liaisonSelfAuditStart', { payload: d.payload })
      if (!started.ok || !started.taskId) throw new Error(started.error || '发起审查失败')
      const taskId = started.taskId
      const deadline = Date.now() + 200000
      let final = null
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000))
        const poll = await sendBg('liaisonSelfAuditPoll', { taskId })
        if (!poll.ok) throw new Error(poll.error || '查询结果失败')
        if (poll.status === 'running') continue
        if (poll.status === 'unknown') throw new Error('任务丢失（服务可能重启过）')
        final = poll // done / error
        break
      }
      if (!final) throw new Error('检测超时（>200s）')
      if (final.status === 'error' || !final.result) throw new Error(final.error || '服务未返回有效结果')
      result = final.result
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
// 扩展资源 base URL 通过 attribute 传给 page world bundle（inline script 会被页面 CSP 挡，
// 属性不受影响）。bundle 读 host 元素的 asset-base 拼接 loading 动画等静态资源路径。
liaison.setAttribute('asset-base', platform.runtime.getURL(''))

document.body.prepend(liaison)

platform.runtime.onMessage.addListener(request => {
  if (request.action === 'COLOR_MODE')
    liaison.setAttribute('color-mode', request.params.mode)
  else if (request.action === 'COLOR_SCHEME')
    liaison.setAttribute("color-scheme", request.params.mode)
  else if (request.action === 'liaisonInspLibChanged') {
    // 跨标签页同步（兜底通道）：另一个 tab 写入了采集库，背景 tabs.sendMessage 到本 tab。
    // __liaisonInsp 活在 page world（拿不到 chrome.runtime），经 postMessage 转发进去。
    window.postMessage({ _liaisonInspLibChanged: true }, '*')
  }
})

// 跨标签页同步（主通道）：监听 chrome.storage 的「版本信号」变化。
// 背景在 DbSet 成功后写 liaisonInspLibVersion；storage.onChanged 对所有已注入内容脚本
// 的页面可靠广播，不依赖点对点连接（比 tabs.sendMessage 稳）。转发进 page world 刷新。
try {
  platform.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if (!changes || !changes.liaisonInspLibVersion) return
    window.postMessage({ _liaisonInspLibChanged: true }, '*')
  })
} catch (e) {}
