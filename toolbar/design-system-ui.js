// ============================================================================
// 设计系统 · 组件面板（xiaoya3.0 设计规范）
// ----------------------------------------------------------------------------
// 面板「组件」tab 的全部渲染与交互。用户在真实页面上选好插入点位、从列表里挑
// 一个组件并填好配置 → 拼成一段 prompt → 复制 → 粘贴进下游项目的 CC 窗口 →
// 下游 CC 按设计规范落地。
//
// 架构（沿用 asset-library-ui.js 的模式，避免在 bundle.min.js 里手写大块 UI）：
// bundle 的 renderDesignPanel() 返回一个空挂载容器 `<div id="liaison-ds-root">`，
// 然后调用 window.__liaisonDesignUI.mount(rootEl, ctx)。本模块接管容器内的一切。
//
// 数据源：组件目录（catalog）随本文件内联（见 CATALOG）。它是 xiaoya 仓库
// scripts/component-catalog.mjs 的镜像——那边是给 node 脚本用的源头，这边是给
// 浏览器扩展用的投影。**改了源头要回来同步**，否则会长出"规范说 A、面板说 B"
// 的裂缝。将来接上本地桥服务后可改为运行时拉取，届时本内联副本即可退役。
//
// 交互要点：
//  - 三步流程（选组件 → 选点位 → 填配置），用返回箭头回退，不做多层弹窗。
//  - 点位拾取复用页面 hover 高亮：鼠标移动时实时描边候选容器 + 画插入指示线。
//  - 配置表单字段来自 catalog 的 fields，不是 EP 全量 props——只问"必须当场决定"的。
//  - 中文输入法：搜索框监听 composition 事件，组合中不触发重绘（吸取资产库教训）。
// ============================================================================

;(function () {
  if (typeof window === 'undefined' || window.__liaisonDesignUI) return

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]))

  // ══════════════════════════════════════════════════════════════════════════
  // 组件目录（xiaoya scripts/component-catalog.mjs 的镜像，改源头需同步）
  // ══════════════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════════════
  // 组件目录：从 GitHub 拉取，不再内联副本
  // --------------------------------------------------------------------------
  // 之前这里内联了一份 catalog 手抄副本，改了源头不改它两边就漂——正是设计系统
  // 「改一处 = 扫全部引用」纪律要防的裂缝。现在改为运行时拉取：
  //
  //   仓库跑 build-catalog.mjs → catalog.json → push → 扩展 fetch raw URL
  //
  // 这样同事装了扩展就能用最新版，**不需要本地有这个仓库**（他们也不可能有）。
  // 拉取走 background（扩展 host 权限，不受页面 CSP 约束），结果存 chrome.storage，
  // 面板打开时自动后台更新一次；拉不到就用上次缓存，首次且无网络则给出提示。
  // ══════════════════════════════════════════════════════════════════════════

  const CATALOG_URL =
    'https://raw.githubusercontent.com/FengranZhou/design-system/main/scripts/catalog.json'

  let GROUPS = []
  let CATALOG = []

  /**
   * snippet 在 JSON 里是源码字符串（函数没法 JSON 序列化），这里还原成函数。
   * 用 Function 构造而非 eval：作用域干净，拿不到本模块的闭包变量。
   * 还原失败不阻断——该组件仍可用，只是复制出的 prompt 少一段代码骨架。
   */
  function reviveSnippet(src) {
    if (!src) return null
    try {
      return new Function('return (' + src + ')')()
    } catch (e) {
      return null
    }
  }

  function applyCatalog(data) {
    if (!data || !Array.isArray(data.components)) return false
    GROUPS = data.groups || []
    CATALOG = data.components.map(function (c) {
      return {
        id: c.id, name: c.name, group: c.group, desc: c.desc,
        keywords: c.keywords || [], fields: c.fields || [],
        readRefs: c.readRefs || [], mustRules: c.mustRules || [],
        snippet: reviveSnippet(c.snippetSrc),
      }
    })
    return true
  }

  /** 经 background 读写扩展 storage（page world 拿不到 chrome.*） */
  function bridge(action, payload) {
    return new Promise(function (resolve) {
      const id = 'ds-' + action + '-' + Math.random().toString(36).slice(2)
      const onMsg = function (ev) {
        const d = ev.data
        if (!d || d._liaisonInspBridgeReply !== true || d.id !== id) return
        window.removeEventListener('message', onMsg)
        resolve(d.ok ? d.result : null)
      }
      window.addEventListener('message', onMsg)
      window.postMessage({ _liaisonInspBridge: true, id: id, action: action, payload: payload || {} }, '*')
      setTimeout(function () { window.removeEventListener('message', onMsg); resolve(null) }, 8000)
    })
  }

  /** 拉最新 catalog；失败返回 null（调用方决定用缓存还是报错） */
  async function fetchCatalog() {
    const text = await bridge('fetchCss', { url: CATALOG_URL + '?t=' + Date.now() })
    if (!text) return null
    try { return JSON.parse(text) } catch (e) { return null }
  }

  /**
   * 载入目录：先用缓存立即渲染（不阻塞界面），再后台拉最新。
   * 缓存也没有时才等网络——那是首次使用的情况。
   */
  async function loadCatalog() {
    const cached = await bridge('kvGet', { key: 'liaison.ds.catalog' })
    let hasData = false
    if (cached) { hasData = applyCatalog(cached); if (hasData) render() }

    const fresh = await fetchCatalog()
    if (fresh && applyCatalog(fresh)) {
      state.syncedAt = Date.now()
      state.syncError = ''
      bridge('kvSet', { key: 'liaison.ds.catalog', value: fresh })
      render()
    } else if (!hasData) {
      state.syncError = '无法获取组件库（检查网络）'
      render()
    } else {
      state.syncError = ''
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Prompt 拼装（xiaoya scripts/build-prompt.mjs 的镜像）
  // ══════════════════════════════════════════════════════════════════════════

  function buildPrompt(component, values, anchor, shotPath) {
    anchor = anchor || {}
    const L = []
    L.push('在页面上插入一个「' + component.name + '」，来自 xiaoya 设计系统。')
    L.push('')
    L.push('## 插入位置')
    L.push('')
    L.push('见随附截图 —— **蓝色圆点 ①** 标出了组件要插入的位置。')
    L.push('')
    if (shotPath) L.push('- **截图**：`' + shotPath + '`')
    else L.push('- ⚠️ 截图未能自动保存，请手动把打点截图一并发给我')
    if (anchor.nearText) L.push('- **打点处附近的内容**：「' + anchor.nearText + '」')
    if (anchor.url) L.push('- **页面地址**：' + anchor.url)
    L.push('')
    L.push('> 请按图上圆点的位置，在对应源文件中找到合适的插入点。')
    L.push('')

    const filled = []
    component.fields.forEach(function (f) {
      const v = values[f.key]
      if (v === undefined || v === '' || v === null) return
      let display = v
      if (f.type === 'switch') display = v ? '是' : '否'
      if (f.type === 'select') {
        const opt = (f.options || []).filter(function (o) { return String(o.value) === String(v) })[0]
        if (opt) display = opt.label
      }
      if (f.type === 'number' && Number(v) === 0) display = '撑满（100%）'
      filled.push('- ' + f.label + '：' + display)
    })
    if (filled.length) {
      L.push('## 配置')
      L.push('')
      filled.forEach(function (x) { L.push(x) })
      L.push('')
    }

    L.push('## 可照抄骨架')
    L.push('')
    L.push('```vue')
    L.push(component.snippet(values))
    L.push('```')
    L.push('')

    if (component.mustRules && component.mustRules.length) {
      L.push('## 硬约束（不读细则也必须遵守）')
      L.push('')
      component.mustRules.forEach(function (r) { L.push('- ' + r) })
      L.push('')
    }
    if (component.readRefs && component.readRefs.length) {
      L.push('## 需要展开时读这些')
      L.push('')
      L.push('> 路径相对你项目根 `CLAUDE.md` 里 `@` 指向的 design-spec 目录')
      L.push('')
      component.readRefs.forEach(function (r) { L.push('- `' + r + '`') })
      L.push('')
    }
    L.push('---')
    L.push('')
    L.push('骨架里的 `form.field` / `handleClick` 等占位命名请按实际业务改；样式值一律走设计令牌，不要写裸值。')
    return L.join('\n')
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 落点拾取：在真实页面上选插入位置
  // ══════════════════════════════════════════════════════════════════════════

  // 页面上的高亮层（描边候选元素 + 画插入指示线）。用 fixed 定位的独立 DOM，
  // 不进宿主页布局流，避免影响页面本身。
  let pickLayer = null
  let pickOutline = null
  let pickLine = null
  let pickLabel = null

  function ensurePickLayer() {
    if (pickLayer && pickLayer.isConnected) return
    pickLayer = document.createElement('div')
    pickLayer.setAttribute('data-liaison-ds-pick', '')
    pickLayer.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483646;'
    pickOutline = document.createElement('div')
    pickOutline.style.cssText =
      'position:absolute;border:1px solid rgba(35,178,131,.9);background:rgba(35,178,131,.06);' +
      'border-radius:4px;transition:all .08s ease;display:none;'
    pickLine = document.createElement('div')
    pickLine.style.cssText =
      'position:absolute;height:2px;background:#23b283;border-radius:2px;display:none;' +
      'box-shadow:0 0 0 2px rgba(35,178,131,.2);'
    pickLabel = document.createElement('div')
    pickLabel.style.cssText =
      'position:absolute;padding:2px 6px;background:#23b283;color:#fff;font-size:11px;' +
      'line-height:16px;border-radius:3px;white-space:nowrap;display:none;' +
      'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;'
    pickLayer.appendChild(pickOutline)
    pickLayer.appendChild(pickLine)
    pickLayer.appendChild(pickLabel)
    document.documentElement.appendChild(pickLayer)
  }

  function removePickLayer() {
    if (pickLayer && pickLayer.parentNode) pickLayer.parentNode.removeChild(pickLayer)
    pickLayer = null; pickOutline = null; pickLine = null; pickLabel = null
  }

  /** 元素的可见文本（截断，用于给 CC 描述"上方是什么、下方是什么"） */
  function visibleText(el) {
    if (!el) return ''
    let t = ''
    try { t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() } catch (e) {}
    return t.length > 24 ? t.slice(0, 24) + '…' : t
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 面板状态与渲染
  // ══════════════════════════════════════════════════════════════════════════

  const state = {
    root: null,
    ctx: null,
    step: 'list',        // 'list' | 'config'
    query: '',
    composing: false,
    selectedId: null,
    values: {},
    anchor: null,        // 拾取到的落点
    picking: false,
    copied: false,
    shooting: false,
    shotError: '',
    syncedAt: 0,
    syncError: '',
    loading: true,
  }

  const CSS = `
    .ds-wrap{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px;color:rgba(255,255,255,.92);}
    .ds-search{position:relative;padding:8px 10px 6px;flex:0 0 auto;}
    .ds-search input{width:100%;box-sizing:border-box;height:28px;padding:0 8px;border-radius:6px;
      border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#fff;font-size:12px;outline:none;}
    .ds-search input:focus{border-color:rgba(35,178,131,.7);background:rgba(255,255,255,.09);}
    .ds-search input::placeholder{color:rgba(255,255,255,.35);}
    .ds-anchor{margin:0 10px 6px;padding:6px 8px;border-radius:6px;font-size:11px;line-height:1.5;
      background:rgba(35,178,131,.12);border:1px solid rgba(35,178,131,.3);flex:0 0 auto;}
    .ds-anchor.is-empty{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.12);color:rgba(255,255,255,.5);}
    .ds-anchor b{color:#4ade9f;font-weight:600;}
    .ds-anchor-btn{margin-top:4px;display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;
      border-radius:4px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);
      color:rgba(255,255,255,.85);font-size:11px;cursor:pointer;}
    .ds-anchor-btn:hover{background:rgba(255,255,255,.12);}
    .ds-anchor-btn.is-active{background:rgba(35,178,131,.25);border-color:rgba(35,178,131,.6);color:#8ff0c4;}
    .ds-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:0 10px 10px;}
    .ds-group{margin-top:8px;font-size:10px;letter-spacing:.5px;color:rgba(255,255,255,.38);
      text-transform:uppercase;padding:0 2px 4px;}
    .ds-item{display:flex;flex-direction:column;gap:1px;padding:7px 8px;border-radius:6px;cursor:pointer;
      border:1px solid transparent;}
    .ds-item:hover{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.1);}
    .ds-item-name{font-size:12px;font-weight:500;color:rgba(255,255,255,.95);}
    .ds-item-desc{font-size:11px;color:rgba(255,255,255,.45);line-height:1.4;}
    .ds-empty{padding:24px 10px;text-align:center;color:rgba(255,255,255,.35);font-size:11px;}
    .ds-sync{flex:0 0 auto;padding:5px 10px;font-size:10px;color:rgba(255,255,255,.32);
      border-top:1px solid rgba(255,255,255,.07);text-align:center;}
    .ds-cfg{flex:1 1 auto;min-height:0;overflow-y:auto;padding:0 10px 10px;}
    .ds-cfg-head{display:flex;align-items:center;gap:6px;padding:6px 10px;flex:0 0 auto;}
    .ds-back{width:22px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:4px;
      border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#fff;cursor:pointer;flex:0 0 auto;}
    .ds-back:hover{background:rgba(255,255,255,.13);}
    .ds-cfg-title{font-size:12px;font-weight:600;}
    .ds-field{margin-bottom:9px;}
    .ds-field-label{display:block;font-size:11px;color:rgba(255,255,255,.6);margin-bottom:3px;}
    .ds-field input[type=text],.ds-field input[type=number],.ds-field select{width:100%;box-sizing:border-box;
      height:26px;padding:0 7px;border-radius:5px;border:1px solid rgba(255,255,255,.14);
      background:rgba(255,255,255,.06);color:#fff;font-size:12px;outline:none;}
    .ds-field select{cursor:pointer;}
    .ds-field select option{background:#2b2b2b;color:#fff;}
    .ds-field input:focus,.ds-field select:focus{border-color:rgba(35,178,131,.7);}
    .ds-field input::placeholder{color:rgba(255,255,255,.3);}
    .ds-hint{margin-top:3px;font-size:10px;line-height:1.45;color:rgba(255,255,255,.38);}
    .ds-sug{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;}
    .ds-sug button{height:20px;padding:0 7px;border-radius:10px;border:1px solid rgba(255,255,255,.16);
      background:rgba(255,255,255,.05);color:rgba(255,255,255,.62);font-size:10px;cursor:pointer;white-space:nowrap;}
    .ds-sug button:hover{background:rgba(255,255,255,.12);color:#fff;}
    .ds-sug button.is-on{background:rgba(35,178,131,.22);border-color:rgba(35,178,131,.55);color:#8ff0c4;}
    .ds-switch{display:flex;align-items:center;justify-content:space-between;gap:8px;}
    .ds-switch-track{width:32px;height:18px;border-radius:9px;background:rgba(255,255,255,.16);
      position:relative;cursor:pointer;transition:background .15s;flex:0 0 auto;}
    .ds-switch-track.is-on{background:#23b283;}
    .ds-switch-thumb{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
      background:#fff;transition:transform .15s;}
    .ds-switch-track.is-on .ds-switch-thumb{transform:translateX(14px);}
    .ds-foot{flex:0 0 auto;padding:8px 10px;border-top:1px solid rgba(255,255,255,.1);
      display:flex;flex-direction:column;gap:6px;}
    .ds-copy{width:100%;height:30px;border-radius:6px;border:none;background:#23b283;color:#fff;
      font-size:12px;font-weight:600;cursor:pointer;transition:background .15s;}
    .ds-copy:hover{background:#1e9d73;}
    .ds-copy.is-copied{background:rgba(35,178,131,.35);}
    .ds-copy:disabled{background:rgba(255,255,255,.12);color:rgba(255,255,255,.35);cursor:not-allowed;}
    .ds-foot-note{font-size:10px;line-height:1.45;color:rgba(255,255,255,.4);text-align:center;}
    .ds-prev{margin-top:2px;padding:7px 8px;border-radius:6px;background:rgba(0,0,0,.28);
      border:1px solid rgba(255,255,255,.09);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
      font-size:10px;line-height:1.5;color:rgba(255,255,255,.62);white-space:pre-wrap;word-break:break-all;
      max-height:150px;overflow-y:auto;}
  `

  function injectStyle(root) {
    // 面板在 Shadow DOM 内，样式要注入同一个 shadow root 才生效
    const holder = root.getRootNode() || document
    if (holder.querySelector && holder.querySelector('#liaison-ds-style')) return
    const st = document.createElement('style')
    st.id = 'liaison-ds-style'
    st.textContent = CSS
    if (holder.appendChild) holder.appendChild(st)
    else document.head.appendChild(st)
  }

  function matched() {
    const q = state.query.trim().toLowerCase()
    if (!q) return CATALOG
    return CATALOG.filter(function (c) {
      if (c.name.toLowerCase().indexOf(q) >= 0) return true
      if (c.desc && c.desc.toLowerCase().indexOf(q) >= 0) return true
      return (c.keywords || []).some(function (k) { return k.toLowerCase().indexOf(q) >= 0 })
    })
  }

  function anchorSummary() {
    const a = state.anchor
    if (!a) {
      return '<div class="ds-anchor is-empty">还没打点' +
        '<br><button class="ds-anchor-btn' + (state.picking ? ' is-active' : '') + '" data-ds-pick>' +
        (state.picking ? '正在打点…点击页面任意位置' : '在页面上打点') + '</button></div>'
    }
    return '<div class="ds-anchor">已打点 <b>①</b>' +
      (a.nearText ? ' · 附近：<b>' + esc(a.nearText) + '</b>' : '') +
      '<br><span style="opacity:.7">复制时会自动截图，图上带打点标记</span>' +
      '<br><button class="ds-anchor-btn' + (state.picking ? ' is-active' : '') + '" data-ds-pick>' +
      (state.picking ? '正在打点…' : '重新打点') + '</button></div>'
  }

  function renderList() {
    const list = matched()
    let html = '<div class="ds-wrap">'
    html += '<div class="ds-search"><input type="text" data-ds-search placeholder="搜索组件…" value="' + esc(state.query) + '" /></div>'
    html += anchorSummary()
    html += '<div class="ds-list">'
    if (state.loading && !CATALOG.length) {
      html += '<div class="ds-empty">正在获取组件库…</div>'
    } else if (state.syncError && !CATALOG.length) {
      html += '<div class="ds-empty">' + esc(state.syncError) + '</div>'
    } else if (!list.length) {
      html += '<div class="ds-empty">没有匹配的组件</div>'
    } else {
      GROUPS.forEach(function (g) {
        const items = list.filter(function (c) { return c.group === g.key })
        if (!items.length) return
        html += '<div class="ds-group">' + esc(g.label) + '</div>'
        items.forEach(function (c) {
          html += '<div class="ds-item" data-ds-pick-comp="' + esc(c.id) + '">' +
            '<span class="ds-item-name">' + esc(c.name) + '</span>' +
            '<span class="ds-item-desc">' + esc(c.desc || '') + '</span></div>'
        })
      })
    }
    html += '</div>'
    if (CATALOG.length) {
      const when = state.syncedAt
        ? new Date(state.syncedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        : ''
      html += '<div class="ds-sync">' + CATALOG.length + ' 个组件' +
        (when ? ' · 已同步 ' + when : ' · 使用缓存') +
        (state.syncError ? ' · <span style="color:#ff9d9d">' + esc(state.syncError) + '</span>' : '') +
        '</div>'
    }
    html += '</div>'
    return html
  }

  function renderField(f) {
    const v = state.values[f.key]
    let inner = ''
    if (f.type === 'text') {
      inner = '<input type="text" data-ds-field="' + esc(f.key) + '" value="' + esc(v == null ? '' : v) +
        '" placeholder="' + esc(f.placeholder || '') + '" />'
    } else if (f.type === 'number') {
      inner = '<input type="number" data-ds-field="' + esc(f.key) + '" value="' + esc(v == null ? '' : v) + '" />'
      if (f.suggestions && f.suggestions.length) {
        inner += '<div class="ds-sug">'
        f.suggestions.forEach(function (s) {
          const on = String(s.value) === String(v)
          inner += '<button type="button" data-ds-sug="' + esc(f.key) + '" data-ds-sug-val="' + esc(s.value) +
            '" class="' + (on ? 'is-on' : '') + '">' + esc(s.label) + '</button>'
        })
        inner += '</div>'
      }
    } else if (f.type === 'select') {
      inner = '<select data-ds-field="' + esc(f.key) + '">'
      ;(f.options || []).forEach(function (o) {
        inner += '<option value="' + esc(o.value) + '"' + (String(o.value) === String(v) ? ' selected' : '') + '>' +
          esc(o.label) + '</option>'
      })
      inner += '</select>'
    } else if (f.type === 'switch') {
      return '<div class="ds-field"><div class="ds-switch">' +
        '<span class="ds-field-label" style="margin:0;">' + esc(f.label) + '</span>' +
        '<span class="ds-switch-track' + (v ? ' is-on' : '') + '" data-ds-switch="' + esc(f.key) + '">' +
        '<span class="ds-switch-thumb"></span></span></div>' +
        (f.hint ? '<div class="ds-hint">' + esc(f.hint) + '</div>' : '') + '</div>'
    }
    return '<div class="ds-field"><label class="ds-field-label">' + esc(f.label) + '</label>' + inner +
      (f.hint ? '<div class="ds-hint">' + esc(f.hint) + '</div>' : '') + '</div>'
  }

  function renderConfig() {
    const c = CATALOG.filter(function (x) { return x.id === state.selectedId })[0]
    if (!c) { state.step = 'list'; return renderList() }

    let html = '<div class="ds-wrap">'
    html += '<div class="ds-cfg-head"><button class="ds-back" data-ds-back title="返回">‹</button>' +
      '<span class="ds-cfg-title">' + esc(c.name) + '</span></div>'
    html += anchorSummary()
    html += '<div class="ds-cfg">'
    c.fields.forEach(function (f) { html += renderField(f) })
    let preview = ''
    try { preview = c.snippet(state.values) } catch (e) { preview = '（预览生成失败：' + e.message + '）' }
    html += '<div class="ds-hint" style="margin-top:10px;">生成的代码</div>'
    html += '<div class="ds-prev">' + esc(preview) + '</div>'
    html += '</div>'
    const btnLabel = state.shooting ? '正在截图…'
      : state.copied ? '✓ 已复制，去 CC 窗口粘贴'
      : '复制到 CC 使用'
    html += '<div class="ds-foot">' +
      '<button class="ds-copy' + (state.copied ? ' is-copied' : '') + '" data-ds-copy' +
      (state.shooting ? ' disabled' : '') + '>' + btnLabel + '</button>' +
      '<div class="ds-foot-note"' + (state.shotError ? ' style="color:#ff9d9d;"' : '') + '>' +
      (state.shotError ? '⚠ ' + esc(state.shotError) + '——请手动截图发给 CC'
        : state.anchor ? '截图会自动保存到下载目录，路径已写进 prompt'
        : '未打点则不带截图') +
      '</div></div>'
    html += '</div>'
    return html
  }

  function render() {
    if (!state.root) return
    state.root.innerHTML = state.step === 'config' ? renderConfig() : renderList()
    bind()
  }

  /** 局部重渲染：保留搜索框焦点与光标位置（避免输入时跳焦） */
  function renderKeepFocus() {
    if (!state.root) return
    const active = state.root.getRootNode().activeElement
    const key = active && active.getAttribute ? active.getAttribute('data-ds-field') : null
    const isSearch = active && active.hasAttribute && active.hasAttribute('data-ds-search')
    const pos = active && active.selectionStart
    render()
    if (key) {
      const next = state.root.querySelector('[data-ds-field="' + key + '"]')
      if (next) { next.focus(); try { next.setSelectionRange(pos, pos) } catch (e) {} }
    } else if (isSearch) {
      const next = state.root.querySelector('[data-ds-search]')
      if (next) { next.focus(); try { next.setSelectionRange(pos, pos) } catch (e) {} }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 点位拾取的事件处理
  // ══════════════════════════════════════════════════════════════════════════

  let onMove = null
  let onClick = null
  let onKey = null

  /**
   * 打点：在页面任意位置标一个点，不做任何 DOM 方位推断。
   *
   * 为什么不推断方位：之前试过"按元素四边缘/中心判 before/after/left/right/append"，
   * 但用户要表达的落点往往不等于某个 DOM 元素的边——比如"放在这个标题右边、和它
   * 同一行"，DOM 上可能是插进另一个容器。方位判定越细，越容易和意图错位。
   *
   * 改为：**只记坐标 + 截图**，让下游 CC 看图判断。这与用户在 CC 窗口里"截图画个
   * 框说在这里加个东西"的既有习惯一致，实践中准确率很高——CC 有完整代码库，
   * 看图定位大概位置后再去代码里验证，比我们在浏览器侧硬推 DOM 语义更可靠。
   */
  function startPicking() {
    if (state.picking) { stopPicking(); return }
    state.picking = true
    ensurePickLayer()
    render()

    // 打点模式下十字线跟随，提示"点哪儿就标哪儿"
    onMove = function (e) {
      if (!pickLine || !pickLabel) return
      pickOutline.style.display = 'none'
      pickLine.style.display = 'none'
      pickLabel.style.display = 'block'
      pickLabel.textContent = '点击此处打点'
      pickLabel.style.left = (e.clientX + 12) + 'px'
      pickLabel.style.top = (e.clientY + 12) + 'px'
    }

    onClick = function (e) {
      if (e.target && e.target.closest &&
        (e.target.closest('liaison-app') || e.target.closest('[data-liaison-ds-pick]'))) return
      e.preventDefault()
      e.stopPropagation()

      // 记录页面绝对坐标（含滚动量），截图时换算回视口坐标画标记
      state.anchor = {
        x: e.clientX + window.scrollX,
        y: e.clientY + window.scrollY,
        viewX: e.clientX,
        viewY: e.clientY,
        url: location.href,
        // 打点处元素的文本，仅作辅助线索——不参与方位推断
        nearText: visibleText(document.elementFromPoint(e.clientX, e.clientY)),
      }
      stopPicking()
      showPin()
    }

    onKey = function (e) { if (e.key === 'Escape') stopPicking() }

    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKey, true)
  }

  // ── 打点标记（留在页面上，截图时一并拍进去）─────────────────────────────
  let pinEl = null

  function showPin() {
    hidePin()
    if (!state.anchor) return
    pinEl = document.createElement('div')
    pinEl.setAttribute('data-liaison-ds-pin', '')
    pinEl.style.cssText =
      'position:absolute;z-index:2147483645;width:26px;height:26px;border-radius:50%;' +
      'background:#0077ff;color:#fff;font:600 13px/1 -apple-system,BlinkMacSystemFont,' +
      '"PingFang SC",sans-serif;pointer-events:none;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.28);transform:translate(-50%,-50%);' +
      'border:2px solid #fff;box-sizing:border-box;' +
      'display:flex;align-items:center;justify-content:center;'
    pinEl.textContent = '1'
    pinEl.style.left = state.anchor.x + 'px'
    pinEl.style.top = state.anchor.y + 'px'
    // 挂 documentElement 不挂 body：body 若有 position/transform 会成为包含块，
    // 绝对定位坐标就会偏。挂 html 上配页面绝对坐标，任何页面都对得准。
    document.documentElement.appendChild(pinEl)
  }

  function hidePin() {
    if (pinEl && pinEl.parentNode) pinEl.parentNode.removeChild(pinEl)
    pinEl = null
  }

  /** 经 background 截当前可视区（content script 直连会被页面 CSP 挡） */
  function captureScreenshot() {
    return new Promise(function (resolve) {
      const id = 'ds-shot-' + Math.random().toString(36).slice(2)
      const onMsg = function (ev) {
        const d = ev.data
        if (!d || d._liaisonInspBridgeReply !== true || d.id !== id) return
        window.removeEventListener('message', onMsg)
        resolve(d.ok ? d.result : null)
      }
      window.addEventListener('message', onMsg)
      window.postMessage({ _liaisonInspBridge: true, id: id, action: 'screenshot', payload: {} }, '*')
      setTimeout(function () {
        window.removeEventListener('message', onMsg)
        resolve(null)
      }, 5000)
    })
  }

  /** 把截图下载到本地，返回落盘路径——CC 需要的是能读的文件而不是 dataUrl */
  function downloadShot(dataUrl) {
    return new Promise(function (resolve) {
      const id = 'ds-dl-' + Math.random().toString(36).slice(2)
      const onMsg = function (ev) {
        const d = ev.data
        if (!d || d._liaisonInspBridgeReply !== true || d.id !== id) return
        window.removeEventListener('message', onMsg)
        resolve(d.ok ? d.result : null)
      }
      window.addEventListener('message', onMsg)
      window.postMessage({
        _liaisonInspBridge: true, id: id, action: 'download',
        payload: { dataUrl: dataUrl, filename: 'liaison-ds-pin-' + Date.now() + '.png' },
      }, '*')
      setTimeout(function () {
        window.removeEventListener('message', onMsg)
        resolve(null)
      }, 8000)
    })
  }

  function stopPicking() {
    state.picking = false
    if (onMove) document.removeEventListener('mousemove', onMove, true)
    if (onClick) document.removeEventListener('click', onClick, true)
    if (onKey) document.removeEventListener('keydown', onKey, true)
    onMove = onClick = onKey = null
    removePickLayer()
    render()
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 事件绑定
  // ══════════════════════════════════════════════════════════════════════════

  function bind() {
    const root = state.root
    if (!root) return

    const search = root.querySelector('[data-ds-search]')
    if (search) {
      // 中文输入法：组合中不重绘，否则输入被打断（资产库踩过）
      search.addEventListener('compositionstart', function () { state.composing = true })
      search.addEventListener('compositionend', function (e) {
        state.composing = false
        state.query = e.target.value
        renderKeepFocus()
      })
      search.addEventListener('input', function (e) {
        if (state.composing) return
        state.query = e.target.value
        renderKeepFocus()
      })
    }

    root.querySelectorAll('[data-ds-pick]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); startPicking() })
    })

    root.querySelectorAll('[data-ds-pick-comp]').forEach(function (it) {
      it.addEventListener('click', function () {
        const id = it.getAttribute('data-ds-pick-comp')
        const c = CATALOG.filter(function (x) { return x.id === id })[0]
        if (!c) return
        state.selectedId = id
        state.values = {}
        c.fields.forEach(function (f) {
          state.values[f.key] = f.default !== undefined ? f.default : ''
        })
        state.step = 'config'
        state.copied = false
        render()
      })
    })

    const back = root.querySelector('[data-ds-back]')
    if (back) back.addEventListener('click', function () {
      state.step = 'list'; state.copied = false; render()
    })

    root.querySelectorAll('[data-ds-field]').forEach(function (inp) {
      const key = inp.getAttribute('data-ds-field')
      const handler = function (e) {
        let v = e.target.value
        if (inp.type === 'number') v = v === '' ? '' : Number(v)
        state.values[key] = v
        state.copied = false
        renderKeepFocus()
      }
      if (inp.tagName === 'SELECT') inp.addEventListener('change', handler)
      else {
        inp.addEventListener('compositionstart', function () { state.composing = true })
        inp.addEventListener('compositionend', function (e) { state.composing = false; handler(e) })
        inp.addEventListener('input', function (e) { if (!state.composing) handler(e) })
      }
    })

    root.querySelectorAll('[data-ds-sug]').forEach(function (b) {
      b.addEventListener('click', function () {
        const key = b.getAttribute('data-ds-sug')
        state.values[key] = Number(b.getAttribute('data-ds-sug-val'))
        state.copied = false
        render()
      })
    })

    root.querySelectorAll('[data-ds-switch]').forEach(function (sw) {
      sw.addEventListener('click', function () {
        const key = sw.getAttribute('data-ds-switch')
        state.values[key] = !state.values[key]
        state.copied = false
        render()
      })
    })

    const copy = root.querySelector('[data-ds-copy]')
    if (copy) copy.addEventListener('click', async function () {
      const c = CATALOG.filter(function (x) { return x.id === state.selectedId })[0]
      if (!c) return

      // 截图带打点标记：先把面板藏起来（否则会把扩展 UI 拍进去挡住页面），
      // 截完立即恢复。标记本身留在页面上，正是要拍进去的东西。
      let shotPath = ''
      state.shotError = ''
      if (state.anchor) {
        state.shooting = true
        render()
        // 截图前藏掉所有扩展 UI：光藏 liaison-app 不够，页面上还有选中框/标签/
        // 手柄等一堆自定义元素。复用 bundle 已有的 .liaison-shot-hide 机制
        // （样式由 bundle 注入，覆盖全部扩展元素）。打点标记是普通 div、
        // 不在隐藏清单里，会正常拍进图里——这正是我们要的。
        // captureVisibleTab 只拍可视区。若打点后页面滚动过，圆点可能已不在视口内
        // → 截出来的图没有标记，CC 就无从判断位置。这里先把打点位置滚回视口中央。
        const inView = state.anchor.y >= window.scrollY + 40 &&
          state.anchor.y <= window.scrollY + window.innerHeight - 40
        if (!inView) {
          window.scrollTo({ top: Math.max(0, state.anchor.y - window.innerHeight / 2), behavior: 'instant' })
          await new Promise(function (r) { setTimeout(r, 120) })
        }

        const host = document.querySelector('liaison-app')
        const prevVis = host ? host.style.visibility : ''
        if (host) host.style.visibility = 'hidden'
        try { document.documentElement.classList.add('liaison-shot-hide') } catch (e) {}
        // 等两帧让隐藏真正生效再截，否则可能拍到残留
        await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r) }) })
        try {
          const dataUrl = await captureScreenshot()
          if (!dataUrl) state.shotError = '截图失败（扩展未响应）'
          else {
            shotPath = (await downloadShot(dataUrl)) || ''
            if (!shotPath) state.shotError = '截图已生成但保存失败'
          }
        } catch (e) { state.shotError = '截图出错：' + (e && e.message || e) }
        if (host) host.style.visibility = prevVis
        try { document.documentElement.classList.remove('liaison-shot-hide') } catch (e) {}
        state.shooting = false
      }

      const text = buildPrompt(c, state.values, state.anchor, shotPath)
      let ok = false
      try {
        await navigator.clipboard.writeText(text)
        ok = true
      } catch (e) {
        // 剪贴板 API 在部分页面被策略挡住，退回 execCommand
        try {
          const ta = document.createElement('textarea')
          ta.value = text
          ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;'
          document.body.appendChild(ta)
          ta.select()
          ok = document.execCommand('copy')
          document.body.removeChild(ta)
        } catch (e2) {}
      }
      state.copied = ok
      render()
      if (ok) setTimeout(function () {
        state.copied = false; state.shotError = ''; render()
      }, 3200)
    })
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 对外契约（与 asset-library-ui.js 一致：mount / unmount）
  // ══════════════════════════════════════════════════════════════════════════

  window.__liaisonDesignUI = {
    /**
     * 宿主面板的 renderPanel() 每次都重写整个 shadow，容器会被换成新的空 div，
     * 所以这个 mount 会被反复调用（切 tab、选中元素、改样式…）。
     * **不能每次都重置状态**——否则用户填到一半的配置、已选好的落点会被清空。
     * 只有容器真的换了才重新接管；状态一律保留，交给 render() 重绘。
     */
    mount: function (rootEl, ctx) {
      const isRemount = state.root !== rootEl
      state.root = rootEl
      state.ctx = ctx || {}
      if (isRemount) injectStyle(rootEl)
      render()
      // 每次打开面板都后台同步一次：缓存先渲染、拉到新的再刷新。
      // 不做「同步按钮」——用户不该需要记得点它。
      if (!CATALOG.length || Date.now() - state.syncedAt > 60000) {
        state.loading = !CATALOG.length
        loadCatalog()
      }
    },
    unmount: function () {
      stopPicking()
      hidePin()
      if (state.root) state.root.innerHTML = ''
      state.root = null
      state.ctx = null
      state.query = ''
      state.step = 'list'
      state.selectedId = null
      state.values = {}
      state.composing = false
      state.copied = false
      // CATALOG / GROUPS 不清：跨次打开复用，避免每次都白屏等网络
    },
  }
})()
