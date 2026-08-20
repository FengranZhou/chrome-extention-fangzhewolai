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
      'position:absolute;padding:5px 12px;background:#23b283;color:#fff;font-size:14px;' +
      'line-height:20px;border-radius:999px;white-space:nowrap;display:none;' +
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
  // 就地浮层：打完点在原地选组件、配参数
  // --------------------------------------------------------------------------
  // 为什么不放侧边栏：打点时眼睛盯着页面，跑去侧边栏选组件要来回跳视线，
  // 而且选完还得再回页面确认位置对不对。就地弹层让整个动作在一处完成。
  // 配置项多的组件（Input 5 项、Dialog 6 项）靠最大高度 + 内部滚动兜住，
  // 不做「回面板配置」的分支——多一条路径就多一份认知负担。
  // ══════════════════════════════════════════════════════════════════════════

  let popEl = null
  let popPin = null
  let popQuery = ''
  let popComposing = false

  const POP_CSS = `
    .dsp{position:absolute;z-index:2147483646;width:268px;border-radius:8px;
      background:#1f2430;border:1px solid rgba(255,255,255,.12);
      box-shadow:0 8px 28px rgba(0,0,0,.42);color:rgba(255,255,255,.92);
      font:12px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
      display:flex;flex-direction:column;max-height:min(420px,70vh);overflow:hidden;}
    .dsp-head{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:8px 10px 6px;}
    .dsp-n{width:18px;height:18px;border-radius:50%;background:#0077ff;color:#fff;
      font-size:11px;display:flex;align-items:center;justify-content:center;flex:0 0 auto;}
    .dsp-title{flex:1 1 auto;font-size:12px;font-weight:600;overflow:hidden;
      text-overflow:ellipsis;white-space:nowrap;}
    .dsp-x{flex:0 0 auto;width:18px;height:18px;line-height:17px;text-align:center;
      border-radius:4px;color:rgba(255,255,255,.45);cursor:pointer;font-size:14px;}
    .dsp-x:hover{background:rgba(255,255,255,.12);color:#fff;}
    .dsp-search{flex:0 0 auto;padding:0 10px 6px;}
    .dsp-search input{width:100%;box-sizing:border-box;height:26px;padding:0 8px;
      border-radius:5px;border:1px solid rgba(255,255,255,.14);
      background:rgba(255,255,255,.06);color:#fff;font-size:12px;outline:none;}
    .dsp-search input:focus{border-color:rgba(0,119,255,.7);}
    .dsp-search input::placeholder{color:rgba(255,255,255,.32);}
    .dsp-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:0 10px 10px;}
    .dsp-group{margin-top:6px;font-size:10px;color:rgba(255,255,255,.35);padding:0 2px 3px;}
    .dsp-item{padding:6px 8px;border-radius:5px;cursor:pointer;border:1px solid transparent;}
    .dsp-item:hover{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.1);}
    .dsp-item-n{font-size:12px;font-weight:500;}
    .dsp-item-d{font-size:10px;color:rgba(255,255,255,.42);}
    .dsp-empty{padding:16px 0;text-align:center;color:rgba(255,255,255,.3);font-size:11px;}
    .dsp-f{margin-bottom:8px;}
    .dsp-f-l{display:block;font-size:11px;color:rgba(255,255,255,.6);margin-bottom:3px;}
    .dsp-f input[type=text],.dsp-f input[type=number],.dsp-f select{width:100%;
      box-sizing:border-box;height:25px;padding:0 7px;border-radius:5px;
      border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);
      color:#fff;font-size:12px;outline:none;}
    .dsp-f select option{background:#2b2b2b;}
    .dsp-f input:focus,.dsp-f select:focus{border-color:rgba(0,119,255,.7);}
    .dsp-sug{display:flex;flex-wrap:wrap;gap:3px;margin-top:3px;}
    .dsp-sug button{height:19px;padding:0 6px;border-radius:9px;font-size:10px;cursor:pointer;
      border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.05);
      color:rgba(255,255,255,.6);white-space:nowrap;}
    .dsp-sug button:hover{background:rgba(255,255,255,.12);color:#fff;}
    .dsp-sug button.on{background:rgba(0,119,255,.25);border-color:rgba(0,119,255,.6);color:#8fc5ff;}
    .dsp-sw{display:flex;align-items:center;justify-content:space-between;gap:8px;}
    .dsp-sw-t{width:30px;height:17px;border-radius:9px;background:rgba(255,255,255,.16);
      position:relative;cursor:pointer;transition:background .15s;flex:0 0 auto;}
    .dsp-sw-t.on{background:#0077ff;}
    .dsp-sw-b{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;
      background:#fff;transition:transform .15s;}
    .dsp-sw-t.on .dsp-sw-b{transform:translateX(13px);}
    .dsp-hint{margin-top:2px;font-size:10px;line-height:1.4;color:rgba(255,255,255,.35);}
    .dsp-foot{flex:0 0 auto;padding:7px 10px;border-top:1px solid rgba(255,255,255,.1);
      display:flex;gap:6px;}
    .dsp-foot button{flex:1 1 0;height:26px;border-radius:5px;font-size:11px;cursor:pointer;
      border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#fff;}
    .dsp-foot button:hover{background:rgba(255,255,255,.13);}
    .dsp-foot button.pri{background:#0077ff;border-color:#0077ff;font-weight:600;}
    .dsp-foot button.pri:hover{background:#0069e0;}
  `

  function ensurePopStyle() {
    if (document.getElementById('liaison-dsp-style')) return
    const st = document.createElement('style')
    st.id = 'liaison-dsp-style'
    st.textContent = POP_CSS
    document.documentElement.appendChild(st)
  }

  function openPopover(pin) {
    closePopover()
    popPin = pin
    popQuery = ''
    ensurePopStyle()
    popEl = document.createElement('div')
    popEl.className = 'dsp'
    popEl.setAttribute('data-liaison-ds-pop', '')
    document.documentElement.appendChild(popEl)
    renderPopover()
    positionPopover()
  }

  function closePopover() {
    if (popEl && popEl.parentNode) popEl.parentNode.removeChild(popEl)
    popEl = null
    popPin = null
  }

  /** 定位：优先放在点的右下，越界则翻到左 / 上 */
  function positionPopover() {
    if (!popEl || !popPin) return
    const w = popEl.offsetWidth || 268
    const h = popEl.offsetHeight || 300
    const vx = popPin.x - window.scrollX
    const vy = popPin.y - window.scrollY
    let left = vx + 18
    let top = vy + 12
    if (left + w > window.innerWidth - 12) left = vx - w - 18
    if (left < 12) left = 12
    if (top + h > window.innerHeight - 12) top = Math.max(12, vy - h - 12)
    popEl.style.left = (left + window.scrollX) + 'px'
    popEl.style.top = (top + window.scrollY) + 'px'
  }

  function popMatched() {
    const q = popQuery.trim().toLowerCase()
    if (!q) return CATALOG
    return CATALOG.filter(function (c) {
      if (c.name.toLowerCase().indexOf(q) >= 0) return true
      if (c.desc && c.desc.toLowerCase().indexOf(q) >= 0) return true
      return (c.keywords || []).some(function (k) { return k.toLowerCase().indexOf(q) >= 0 })
    })
  }

  function renderPopover() {
    if (!popEl || !popPin) return
    const comp = popPin.componentId ? findComponent(popPin.componentId) : null
    let html = ''

    html += '<div class="dsp-head"><span class="dsp-n">' + popPin.n + '</span>' +
      '<span class="dsp-title">' + (comp ? esc(comp.name) : '选择组件') + '</span>' +
      '<span class="dsp-x" data-dsp-close title="关闭">×</span></div>'

    if (!comp) {
      html += '<div class="dsp-search"><input type="text" data-dsp-search placeholder="搜索组件…" value="' +
        esc(popQuery) + '" /></div>'
      html += '<div class="dsp-body">'
      const list = popMatched()
      if (!CATALOG.length) html += '<div class="dsp-empty">正在获取组件库…</div>'
      else if (!list.length) html += '<div class="dsp-empty">没有匹配的组件</div>'
      else {
        GROUPS.forEach(function (g) {
          const items = list.filter(function (c) { return c.group === g.key })
          if (!items.length) return
          html += '<div class="dsp-group">' + esc(g.label) + '</div>'
          items.forEach(function (c) {
            html += '<div class="dsp-item" data-dsp-pick="' + esc(c.id) + '">' +
              '<div class="dsp-item-n">' + esc(c.name) + '</div>' +
              '<div class="dsp-item-d">' + esc(c.desc || '') + '</div></div>'
          })
        })
      }
      html += '</div>'
    } else {
      html += '<div class="dsp-body">'
      ;(comp.fields || []).forEach(function (f) { html += renderPopField(f) })
      if (!comp.fields || !comp.fields.length) {
        html += '<div class="dsp-empty">该组件无需额外配置</div>'
      }
      html += '</div>'
      html += '<div class="dsp-foot">' +
        '<button data-dsp-change>换组件</button>' +
        '<button class="pri" data-dsp-done>完成</button></div>'
    }

    popEl.innerHTML = html
    bindPopover()
  }

  function renderPopField(f) {
    const v = popPin.values[f.key]
    let inner = ''
    if (f.type === 'text') {
      inner = '<input type="text" data-dsp-field="' + esc(f.key) + '" value="' + esc(v == null ? '' : v) +
        '" placeholder="' + esc(f.placeholder || '') + '" />'
    } else if (f.type === 'number') {
      inner = '<input type="number" data-dsp-field="' + esc(f.key) + '" value="' + esc(v == null ? '' : v) + '" />'
      if (f.suggestions && f.suggestions.length) {
        inner += '<div class="dsp-sug">'
        f.suggestions.forEach(function (sg) {
          inner += '<button type="button" data-dsp-sug="' + esc(f.key) + '" data-dsp-sv="' + esc(sg.value) +
            '" class="' + (String(sg.value) === String(v) ? 'on' : '') + '">' +
            esc(String(sg.label).split(' ·')[0]) + '</button>'
        })
        inner += '</div>'
      }
    } else if (f.type === 'select') {
      inner = '<select data-dsp-field="' + esc(f.key) + '">'
      ;(f.options || []).forEach(function (o) {
        inner += '<option value="' + esc(o.value) + '"' + (String(o.value) === String(v) ? ' selected' : '') +
          '>' + esc(o.label) + '</option>'
      })
      inner += '</select>'
    } else if (f.type === 'switch') {
      return '<div class="dsp-f"><div class="dsp-sw">' +
        '<span class="dsp-f-l" style="margin:0;">' + esc(f.label) + '</span>' +
        '<span class="dsp-sw-t' + (v ? ' on' : '') + '" data-dsp-sw="' + esc(f.key) + '">' +
        '<span class="dsp-sw-b"></span></span></div>' +
        (f.hint ? '<div class="dsp-hint">' + esc(f.hint) + '</div>' : '') + '</div>'
    }
    return '<div class="dsp-f"><label class="dsp-f-l">' + esc(f.label) + '</label>' + inner +
      (f.hint ? '<div class="dsp-hint">' + esc(f.hint) + '</div>' : '') + '</div>'
  }

  /** 浮层内的改动直接写进 pin，并刷新标记与清单 */
  function popSync() {
    if (!popPin) return
    const comp = findComponent(popPin.componentId)
    if (!comp) return
    if (popPin.el) {
      popPin.el.dataset.dsSummary = '新增组件：' + comp.name + summarizeValues(comp, popPin.values)
    }
    // 拖拽中不重建标记：renderPins 会销毁重建 DOM，正在拖的那个元素被移除后
    // 事件监听就指向了孤儿节点，拖到一半失灵。
    if (!draggingAny) renderPins()
    render()
  }

  function bindPopover() {
    if (!popEl) return

    const sc = popEl.querySelector('[data-dsp-search]')
    if (sc) {
      sc.addEventListener('compositionstart', function () { popComposing = true })
      sc.addEventListener('compositionend', function (e) {
        popComposing = false; popQuery = e.target.value; renderPopover()
        const n = popEl.querySelector('[data-dsp-search]')
        if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length) }
      })
      sc.addEventListener('input', function (e) {
        if (popComposing) return
        popQuery = e.target.value
        const pos = e.target.selectionStart
        renderPopover()
        const n = popEl.querySelector('[data-dsp-search]')
        if (n) { n.focus(); try { n.setSelectionRange(pos, pos) } catch (err) {} }
      })
      // 打完点直接能搜——省一次点击
      setTimeout(function () { try { sc.focus() } catch (e) {} }, 30)
    }

    popEl.querySelectorAll('[data-dsp-pick]').forEach(function (it) {
      it.addEventListener('click', function () {
        const c = findComponent(it.getAttribute('data-dsp-pick'))
        if (!c || !popPin) return
        popPin.componentId = c.id
        popPin.values = {}
        ;(c.fields || []).forEach(function (f) {
          popPin.values[f.key] = f.default !== undefined ? f.default : ''
        })
        renderPopover()
        positionPopover()
        popSync()
      })
    })

    popEl.querySelectorAll('[data-dsp-field]').forEach(function (inp) {
      const key = inp.getAttribute('data-dsp-field')
      const handler = function (e) {
        let v = e.target.value
        if (inp.type === 'number') v = v === '' ? '' : Number(v)
        popPin.values[key] = v
        popSync()
      }
      if (inp.tagName === 'SELECT') inp.addEventListener('change', function (e) { handler(e); renderPopover() })
      else {
        inp.addEventListener('compositionstart', function () { popComposing = true })
        inp.addEventListener('compositionend', function (e) { popComposing = false; handler(e) })
        inp.addEventListener('input', function (e) { if (!popComposing) handler(e) })
      }
    })

    popEl.querySelectorAll('[data-dsp-sug]').forEach(function (b) {
      b.addEventListener('click', function () {
        popPin.values[b.getAttribute('data-dsp-sug')] = Number(b.getAttribute('data-dsp-sv'))
        renderPopover(); popSync()
      })
    })

    popEl.querySelectorAll('[data-dsp-sw]').forEach(function (sw) {
      sw.addEventListener('click', function () {
        const k = sw.getAttribute('data-dsp-sw')
        popPin.values[k] = !popPin.values[k]
        renderPopover(); popSync()
      })
    })

    const ch = popEl.querySelector('[data-dsp-change]')
    if (ch) ch.addEventListener('click', function () {
      popPin.componentId = null
      popPin.values = {}
      popQuery = ''
      renderPopover(); positionPopover(); popSync()
    })

    const dn = popEl.querySelector('[data-dsp-done]')
    if (dn) dn.addEventListener('click', function () { closePopover(); render() })

    const cl = popEl.querySelector('[data-dsp-close]')
    if (cl) cl.addEventListener('click', function () {
      // 关掉未选组件的点＝放弃这个点
      if (popPin && !popPin.componentId) {
        const i = state.pins.indexOf(popPin)
        if (i >= 0) state.pins.splice(i, 1)
        closePopover(); renderPins(); render()
      } else { closePopover(); render() }
    })
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 面板状态与渲染
  // ══════════════════════════════════════════════════════════════════════════

  const state = {
    root: null,
    ctx: null,
    // 多点：一次页面改造往往要在好几处加东西（这儿加筛选、那儿加按钮、
    // 底下加分页），逐个复制粘贴太碎。pins 里每项 = 一个打点 + 它配的组件。
    //   { n, x, y, nearText, url, componentId, values, el }
    pins: [],
    editingPin: -1,      // 正在配置第几个点（-1 = 新建）
    picking: false,
    copied: false,
    shooting: false,
    shotError: '',
    syncedAt: 0,
    syncError: '',
    loading: true,
  }

  /** 已配好组件的点（未配的不进清单、不出现在 prompt 里） */
  function configuredPins() {
    return state.pins.filter(function (p) { return p.componentId })
  }

  /**
   * 与页面上的标记对账，丢掉已失效的点。
   *
   * 为什么需要：宿主「清单」tab 的「清空」会把页面上带 data-liaison-modified
   * 的元素全部重置（含我们的标记），但它不知道 state.pins 的存在。不对账就会
   * 留下"面板里还列着、页面上已经没有"的幽灵点，复制时截图拍不到标记。
   */
  // 正在重画标记时跳过对账：renderPins() 会先 hidePin() 清空再逐个重建，
  // 中途所有 pin.el 都处于 isConnected=false 的瞬间——此时对账会把全部点误杀。
  let repainting = false
  let draggingAny = false

  function reconcilePins() {
    if (repainting) return false
    const before = state.pins.length
    state.pins = state.pins.filter(function (p) {
      if (!p.el) return true          // 尚未渲染的新点，保留
      return p.el.isConnected         // 渲染过的：还在文档里才算有效
    })
    if (state.pins.length !== before) {
      state.pins.forEach(function (p, i) { p.n = i + 1 })
      if (state.editingPin >= state.pins.length) state.editingPin = -1
      renderPins()
      return true
    }
    return false
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
    .ds-pins{display:flex;flex-direction:column;gap:3px;margin-bottom:6px;}
    .ds-pin{display:flex;align-items:center;gap:6px;padding:3px 5px;border-radius:4px;
      background:rgba(0,0,0,.18);}
    .ds-pin.is-editing{background:rgba(0,119,255,.22);}
    .ds-pin-n{flex:0 0 auto;color:#5aa9ff;font-size:12px;}
    .ds-pin-body{flex:1 1 auto;min-width:0;cursor:pointer;display:flex;flex-direction:column;gap:1px;}
    .ds-pin-body:hover b{text-decoration:underline;}
    .ds-pin-near{font-size:10px;color:rgba(255,255,255,.4);overflow:hidden;
      text-overflow:ellipsis;white-space:nowrap;}
    .ds-pin-del{flex:0 0 auto;width:16px;height:16px;line-height:15px;text-align:center;
      border-radius:3px;color:rgba(255,255,255,.4);cursor:pointer;font-size:13px;}
    .ds-pin-del:hover{background:rgba(255,80,80,.25);color:#fff;}
    .ds-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:0 10px 10px;}
    .ds-tip{flex:0 0 auto;margin:8px 10px;padding:6px 8px;border-radius:6px;font-size:11px;
      line-height:1.5;background:rgba(0,119,255,.14);border:1px solid rgba(0,119,255,.3);
      color:rgba(255,255,255,.8);}
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

  const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮'
  function circled(n) { return CIRCLED[n - 1] || '(' + n + ')' }

  function render() {
    if (!state.root) return
    reconcilePins()
    state.root.innerHTML = renderRecord()
    bind()
  }

  /**
   * 侧边面板 = 纯记录视图。
   *
   * 选组件、配参数全在页面上的就地浮层里完成（打点时眼睛在页面上，
   * 视线不该来回跳）。这里只负责：列出已打的点、点条目回去改、删除、
   * 一起复制。职责单一，不再是第二个配置入口。
   */
  function renderRecord() {
    const pins = state.pins
    let html = '<div class="ds-wrap">'

    html += '<div class="ds-tip">' +
      (state.picking
        ? '在页面上点击即可打点 · 点完就地选组件'
        : '切到本 tab 即可开始打点') +
      '</div>'

    html += '<div class="ds-list">'
    if (!pins.length) {
      html += '<div class="ds-empty">还没有打点<br><span style="opacity:.6">在页面上点一下试试</span></div>'
    } else {
      html += '<div class="ds-pins">'
      pins.forEach(function (p, i) {
        const comp = p.componentId ? findComponent(p.componentId) : null
        html += '<div class="ds-pin">' +
          '<span class="ds-pin-n">' + circled(p.n) + '</span>' +
          '<span class="ds-pin-body" data-ds-pin-edit="' + i + '">' +
            (comp ? '<b>' + esc(comp.name) + '</b>' : '<span style="opacity:.55">待选组件</span>') +
            (p.nearText ? '<span class="ds-pin-near">' + esc(p.nearText) + '</span>' : '') +
          '</span>' +
          '<span class="ds-pin-del" data-ds-pin-del="' + i + '" title="删除">×</span>' +
          '</div>'
      })
      html += '</div>'
    }
    html += '</div>'

    const n = configuredPins().length
    const btnLabel = state.shooting ? '正在逐个截图…'
      : state.copied ? '✓ 已复制，去 CC 窗口粘贴'
      : n > 1 ? '复制全部 ' + n + ' 处到 CC'
      : '复制到 CC 使用'
    html += '<div class="ds-foot">' +
      '<button class="ds-copy' + (state.copied ? ' is-copied' : '') + '" data-ds-copy' +
      (state.shooting || !n ? ' disabled' : '') + '>' + btnLabel + '</button>' +
      '<div class="ds-foot-note"' + (state.shotError ? ' style="color:#ff9d9d;"' : '') + '>' +
      (state.shotError ? '⚠ ' + esc(state.shotError)
        : n > 1 ? '每处各截一张图，一起复制、CC 一趟做完'
        : n ? '截图会自动保存到下载目录，路径已写进 prompt'
        : '打点后在浮层里选组件') +
      '</div></div>'

    if (CATALOG.length) {
      const when = state.syncedAt
        ? new Date(state.syncedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        : ''
      html += '<div class="ds-sync">' + CATALOG.length + ' 个组件' +
        (when ? ' · 已同步 ' + when : ' · 使用缓存') + '</div>'
    }
    html += '</div>'
    return html
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
  /**
   * 事件是否发生在扩展自己的 UI 上（不该触发打点）。
   *
   * 两个坑：
   * ① 扩展的 UI 不止 liaison-app —— 侧边面板 liaison-style-panel、悬浮工具条
   *    liaison-top-toolbar、清单 liaison-page-overview-panel 等都是**独立的
   *    自定义元素**，不是 liaison-app 的后代，closest('liaison-app') 判不到。
   * ② 这些元素都是 Shadow DOM，e.target 会被重定向成宿主元素本身，
   *    在 shadow 内部点击时 closest 也不可靠 —— 必须走 composedPath()。
   */
  const EXT_TAGS = [
    'liaison-app', 'liaison-style-panel', 'liaison-top-toolbar',
    'liaison-comment-panel', 'liaison-comment-list-panel',
    'liaison-page-overview-panel', 'liaison-metatip', 'liaison-ally',
    'liaison-handles', 'liaison-handle', 'liaison-label', 'liaison-offscreen-label',
    'liaison-hover', 'liaison-corners', 'liaison-gridlines', 'liaison-distance',
    'liaison-boxmodel', 'liaison-overlay', 'liaison-grip', 'hotkey-map',
  ]

  function isExtensionUI(e) {
    const path = (e.composedPath && e.composedPath()) || []
    for (const node of path) {
      if (!node || node.nodeType !== 1) continue
      const tag = node.tagName && node.tagName.toLowerCase()
      if (tag && EXT_TAGS.indexOf(tag) >= 0) return true
      if (node.hasAttribute &&
        (node.hasAttribute('data-liaison-ds-pop') ||
         node.hasAttribute('data-liaison-ds-pick') ||
         node.hasAttribute('data-liaison-ds-pin'))) return true
    }
    // composedPath 拿不到时（极少）退回 closest 兜底
    const t = e.target
    if (t && t.closest) {
      for (const tag of EXT_TAGS) if (t.closest(tag)) return true
      if (t.closest('[data-liaison-ds-pop]')) return true
    }
    return false
  }

  function startPicking() {
    if (state.picking) { stopPicking(); return }
    state.picking = true
    ensurePickLayer()
    render()

    // 打点模式下十字线跟随，提示"点哪儿就标哪儿"
    onMove = function (e) {
      if (!pickLine || !pickLabel) return
      // 鼠标在扩展自己的 UI 上时不提示"点击添加组件"——那里点了不会打点
      if (isExtensionUI(e)) {
        pickLabel.style.display = 'none'
        return
      }
      pickOutline.style.display = 'none'
      pickLine.style.display = 'none'
      pickLabel.style.display = 'block'
      pickLabel.textContent = '点击添加组件'
      pickLabel.style.left = (e.clientX + 12) + 'px'
      pickLabel.style.top = (e.clientY + 12) + 'px'
    }

    onClick = function (e) {
      // 点在扩展自己的 UI 上＝在操作工具，不是在页面上打点
      if (isExtensionUI(e)) return
      e.preventDefault()
      e.stopPropagation()

      // 追加一个点（不覆盖已有的）。记录页面绝对坐标（含滚动量），
      // 截图时换算回视口坐标画标记。
      const pin = {
        n: state.pins.length + 1,
        x: e.clientX + window.scrollX,
        y: e.clientY + window.scrollY,
        url: location.href,
        // 打点处元素的文本，仅作辅助线索——不参与方位推断
        nearText: visibleText(document.elementFromPoint(e.clientX, e.clientY)),
        componentId: null,
        values: {},
        el: null,
      }
      // 打新点前先清掉上一个"打了但没选组件"的空点——那多半是误点，
      // 留着只会让清单变脏（用户得逐个去删）
      state.pins = state.pins.filter(function (p) { return p.componentId })

      state.pins.push(pin)
      // 先建标记（填上 pin.el）再做别的：render 前的 reconcilePins 按
      // pin.el.isConnected 判存活，el 还是 null 的新 pin 会被当场过滤掉。
      state.editingPin = state.pins.length - 1
      renderPins()
      // 不退出打点态——连续打点是常态。就地弹浮层选组件，
      // 眼睛不用在页面和侧边栏之间来回跳。
      openPopover(pin)
      render()
    }

    onKey = function (e) { if (e.key === 'Escape') stopPicking() }

    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKey, true)
  }

  // ── 打点标记（留在页面上，截图时一并拍进去）─────────────────────────────

  /**
   * 渲染全部打点标记。
   *
   * 标记同时挂 `data-liaison-modified="true"` —— 这是宿主 buildOverviewItems()
   * 扫描的属性，挂上它，每个点就会自动作为一条记录出现在「清单」tab 里，
   * 与样式变更、评论并列。复用宿主整套渲染/清空/定位逻辑，不另造一套。
   */
  function renderPins() {
    repainting = true
    try {
      hidePin()
      state.pins.forEach(function (pin, i) { pin.n = i + 1; createPinEl(pin) })
    } finally {
      repainting = false
    }
    notifyOverview()
  }

  /**
   * 通知宿主刷新「清单」。
   *
   * 挂了 data-liaison-modified 只是让 buildOverviewItems() **能**扫到，
   * 但那个函数只在宿主自己的操作后（改样式、加评论、选中元素）才被调用——
   * 我们在 page world 里创建标记，宿主完全不知道，清单永远不刷新。
   * 所以必须主动喊它一声。
   */
  function notifyOverview() {
    try {
      const app = document.querySelector('liaison-app')
      if (app && typeof app.syncOverviewPanel === 'function') app.syncOverviewPanel()
    } catch (e) {}
  }

  function createPinEl(pin) {
    const comp = pin.componentId ? findComponent(pin.componentId) : null
    const pinEl = document.createElement('div')
    pinEl.className = 'ds-pin-' + pin.n
    pinEl.setAttribute('data-liaison-ds-pin', '')
    // 让宿主的清单扫到它（buildOverviewItems 找的就是这个属性）
    pinEl.setAttribute('data-liaison-modified', 'true')
    pinEl.setAttribute('data-ds-pin-n', String(pin.n))
    if (comp) pinEl.setAttribute('data-ds-pin-comp', comp.name)
    // 给清单显示的人话描述（bundle 优先读它，而不是把定位 style 当配置列出来）
    pinEl.dataset.dsSummary = comp
      ? '新增组件：' + comp.name + summarizeValues(comp, pin.values)
      : '待选组件（' + circled(pin.n) + ' 已打点，尚未选择）'
    pinEl.style.cssText =
      'position:absolute;z-index:2147483645;width:26px;height:26px;border-radius:50%;' +
      'background:#0077ff;color:#fff;font:600 13px/1 -apple-system,BlinkMacSystemFont,' +
      '"PingFang SC",sans-serif;cursor:grab;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.28);transform:translate(-50%,-50%);' +
      'border:2px solid #fff;box-sizing:border-box;' +
      'display:flex;align-items:center;justify-content:center;user-select:none;'
    pinEl.textContent = String(pin.n)
    pinEl.style.left = pin.x + 'px'
    pinEl.style.top = pin.y + 'px'
    // 挂 documentElement 不挂 body：body 若有 position/transform 会成为包含块，
    // 绝对定位坐标就会偏。挂 html 上配页面绝对坐标，任何页面都对得准。
    document.documentElement.appendChild(pinEl)
    pin.el = pinEl

    // 已配组件的点加一个小标签，页面上一眼看出这个点要插什么
    let tag = null
    if (comp) {
      tag = document.createElement('div')
      tag.setAttribute('data-liaison-ds-pin', '')
      tag.style.cssText =
        'position:absolute;z-index:2147483645;padding:2px 6px;border-radius:4px;' +
        'background:#0077ff;color:#fff;font:500 11px/16px -apple-system,BlinkMacSystemFont,' +
        '"PingFang SC",sans-serif;white-space:nowrap;pointer-events:none;' +
        'box-shadow:0 2px 6px rgba(0,0,0,.22);transform:translateY(-50%);'
      tag.textContent = comp.name
      tag.style.left = (pin.x + 18) + 'px'
      tag.style.top = pin.y + 'px'
      document.documentElement.appendChild(tag)
      pin.tagEl = tag
    }

    bindPinInteraction(pin, pinEl, tag)
  }

  /**
   * 标记的交互：拖拽移位 + 点击唤起浮层。
   *
   * 两者共用 mousedown，靠**移动距离**区分：超过 4px 判为拖拽，否则算点击。
   * 不用 dblclick 之类区分——打点本身就是单击操作，再引入双击会让手感割裂。
   *
   * 拖拽时同步移动组件名标签，松手后更新 pin 坐标并刷新浮层位置。
   */
  function bindPinInteraction(pin, pinEl, tag) {
    let dragging = false
    let moved = 0
    let startX = 0
    let startY = 0
    let originX = 0
    let originY = 0

    const onDown = function (e) {
      // 只响应左键；阻止冒泡免得触发页面自身的点击和打点逻辑
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      dragging = true
      draggingAny = true
      moved = 0
      startX = e.clientX
      startY = e.clientY
      originX = pin.x
      originY = pin.y
      pinEl.style.cursor = 'grabbing'
      document.addEventListener('mousemove', onMoveDrag, true)
      document.addEventListener('mouseup', onUp, true)
    }

    const onMoveDrag = function (e) {
      if (!dragging) return
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      moved = Math.max(moved, Math.abs(dx) + Math.abs(dy))
      pin.x = originX + dx
      pin.y = originY + dy
      pinEl.style.left = pin.x + 'px'
      pinEl.style.top = pin.y + 'px'
      if (tag) {
        tag.style.left = (pin.x + 18) + 'px'
        tag.style.top = pin.y + 'px'
      }
      // 拖动时浮层跟着走，不然会指向旧位置
      if (popPin === pin) positionPopover()
    }

    const onUp = function (e) {
      if (!dragging) return
      dragging = false
      draggingAny = false
      pinEl.style.cursor = 'grab'
      document.removeEventListener('mousemove', onMoveDrag, true)
      document.removeEventListener('mouseup', onUp, true)
      e.preventDefault()
      e.stopPropagation()

      if (moved <= 4) {
        // 没怎么动＝点击：唤起浮层调整（已开着则关掉，可反复切换）
        if (popPin === pin) closePopover()
        else openPopover(pin)
      } else {
        // 真的拖了：位置变了，附近文本线索要重新采
        const el = document.elementFromPoint(
          pin.x - window.scrollX, pin.y - window.scrollY)
        if (el && !isExtensionUIEl(el)) pin.nearText = visibleText(el)
        popSyncPin(pin)
      }
      render()
    }

    pinEl.addEventListener('mousedown', onDown, true)
    // mousedown 阻止冒泡不影响 click 的派发（两者是独立事件）。
    // isExtensionUI 已把标记排除在打点之外，这里再显式拦一道：
    // 点标记的语义是"调整这个点"，绝不能又打出一个新点。
    pinEl.addEventListener('click', function (e) {
      e.preventDefault()
      e.stopPropagation()
    }, true)
  }

  /** 元素是否属于扩展自己的 UI（拖拽落点判断用，非事件版） */
  function isExtensionUIEl(el) {
    if (!el || !el.closest) return false
    for (const tag of EXT_TAGS) if (el.closest(tag)) return true
    return !!(el.closest('[data-liaison-ds-pop]') || el.closest('[data-liaison-ds-pin]'))
  }

  /** 更新某个点的清单摘要并通知宿主（拖拽后用，不重画标记免得打断交互） */
  function popSyncPin(pin) {
    const comp = pin.componentId ? findComponent(pin.componentId) : null
    if (pin.el) {
      pin.el.dataset.dsSummary = comp
        ? '新增组件：' + comp.name + summarizeValues(comp, pin.values)
        : '待选组件（' + circled(pin.n) + ' 已打点，尚未选择）'
    }
    notifyOverview()
  }

  /** 清掉页面上所有打点标记（含组件名小标签） */
  function hidePin() {
    document.querySelectorAll('[data-liaison-ds-pin]').forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el)
    })
  }

  /** 把配置压成一行摘要，只取用户实际填/开过的，避免清单里一长串默认值 */
  function summarizeValues(comp, values) {
    const parts = []
    ;(comp.fields || []).forEach(function (f) {
      const v = values[f.key]
      if (v === undefined || v === '' || v === null) return
      if (f.type === 'switch') { if (v) parts.push(f.label); return }
      if (f.type === 'select') {
        const opt = (f.options || []).filter(function (o) { return String(o.value) === String(v) })[0]
        parts.push(opt ? opt.label.split(' ·')[0] : v)
        return
      }
      parts.push(f.label + ' ' + v)
    })
    return parts.length ? '（' + parts.slice(0, 4).join('、') + '）' : ''
  }

  /** 按 id 找组件 */
  function findComponent(id) {
    return CATALOG.filter(function (c) { return c.id === id })[0] || null
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
    closePopover()
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

    // 记录视图只有三件事：点条目回浮层改、点 × 删、底部复制。
    // 搜索和配置全在页面上的就地浮层里，这里不再是第二个配置入口。

    root.querySelectorAll('[data-ds-pin-edit]').forEach(function (el) {
      el.addEventListener('click', function () {
        const i = parseInt(el.getAttribute('data-ds-pin-edit'), 10)
        const pin = state.pins[i]
        if (!pin) return
        // 滚到该点再开浮层——否则浮层会开在视口外看不见
        const inView = pin.y >= window.scrollY + 60 &&
          pin.y <= window.scrollY + window.innerHeight - 60
        if (!inView) {
          window.scrollTo({ top: Math.max(0, pin.y - window.innerHeight / 2), behavior: 'smooth' })
          setTimeout(function () { openPopover(pin) }, 260)
        } else {
          openPopover(pin)
        }
        state.copied = false
      })
    })

    root.querySelectorAll('[data-ds-pin-del]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation()
        const i = parseInt(el.getAttribute('data-ds-pin-del'), 10)
        const pin = state.pins[i]
        if (popPin === pin) closePopover()
        state.pins.splice(i, 1)
        renderPins()   // 重新编号并重画页面标记
        state.copied = false
        render()
      })
    })

    const copy = root.querySelector('[data-ds-copy]')
    if (copy) copy.addEventListener('click', async function () {
      const pins = configuredPins()
      if (!pins.length) { state.shotError = '还没有配好组件的点'; render(); return }

      state.shotError = ''
      state.shooting = true
      render()

      // 逐点各截一张：多个点可能分散在长页面的不同位置，一张可视区图盖不全。
      // 慢一点（每点约 1 秒）但可靠，prompt 里能一一对应「① 见图1、② 见图2」。
      const shots = await captureEachPin(pins)
      state.shooting = false

      const text = buildMultiPrompt(pins, shots)
      state.copied = ok
      render()
      if (ok) setTimeout(function () {
        state.copied = false; state.shotError = ''; render()
      }, 3200)
    })
  }

  /**
   * 逐点截图。每次把该点滚进视口中央 → 藏扩展 UI → 截图 → 存盘。
   *
   * 为什么不截一张全景：captureVisibleTab 只能拍当前可视区，滚动拼接实现复杂
   * 且容易在固定头部/懒加载处出错。逐点截图慢一点但每张都确定包含目标标记。
   */
  async function captureEachPin(pins) {
    const host = document.querySelector('liaison-app')
    const prevVis = host ? host.style.visibility : ''
    const prevScroll = window.scrollY
    const out = []

    for (const pin of pins) {
      // 滚到该点居中（不判断是否已在视口——多点场景下几乎总要滚）
      window.scrollTo({ top: Math.max(0, pin.y - window.innerHeight / 2), behavior: 'instant' })
      await new Promise(function (r) { setTimeout(r, 140) })

      if (host) host.style.visibility = 'hidden'
      try { document.documentElement.classList.add('liaison-shot-hide') } catch (e) {}
      // 浮层是我们自己建的普通 div，不在宿主的 shot-hide 清单里，得单独藏
      if (popEl) popEl.style.visibility = 'hidden'
      await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r) }) })

      let path = ''
      try {
        const dataUrl = await captureScreenshot()
        if (dataUrl) path = (await downloadShot(dataUrl)) || ''
      } catch (e) {}
      if (!path && !state.shotError) state.shotError = '部分截图失败'

      if (host) host.style.visibility = prevVis
      try { document.documentElement.classList.remove('liaison-shot-hide') } catch (e) {}
      if (popEl) popEl.style.visibility = ''
      out.push(path)
    }

    window.scrollTo({ top: prevScroll, behavior: 'instant' })
    return out
  }

  /**
   * 合并 prompt：一次输出全部点位，让 CC 一趟做完。
   *
   * 单点时退化成原来的格式（不加"共 N 处"的噪音）；多点时每处一节，
   * 各带自己的截图、配置、骨架，末尾汇总所有涉及的硬约束（去重）。
   */
  function buildMultiPrompt(pins, shots) {
    if (pins.length === 1) {
      const c = findComponent(pins[0].componentId)
      return buildPrompt(c, pins[0].values, pins[0], shots[0])
    }

    const L = []
    L.push('在页面上插入 ' + pins.length + ' 个组件，均来自 xiaoya 设计系统。')
    L.push('')
    L.push('每处的位置见对应截图里的**蓝色圆点**（编号与下面小节一一对应）。')
    L.push('')
    L.push('---')

    const allRules = new Map()
    const allRefs = new Set()

    pins.forEach(function (pin, i) {
      const c = findComponent(pin.componentId)
      if (!c) return
      L.push('')
      L.push('## ' + circled(pin.n) + ' ' + c.name)
      L.push('')
      if (shots[i]) L.push('- **截图**：`' + shots[i] + '`（图中蓝色圆点 ' + circled(pin.n) + ' 即插入位置）')
      else L.push('- ⚠️ 本处截图未能保存，请手动补一张')
      if (pin.nearText) L.push('- **打点处附近的内容**：「' + pin.nearText + '」')
      L.push('')

      const filled = []
      ;(c.fields || []).forEach(function (f) {
        const v = pin.values[f.key]
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
      if (filled.length) { L.push('**配置**'); L.push(''); filled.forEach(function (x) { L.push(x) }); L.push('') }

      if (c.snippet) {
        L.push('**可照抄骨架**')
        L.push('')
        L.push('```vue')
        try { L.push(c.snippet(pin.values)) } catch (e) { L.push('（骨架生成失败）') }
        L.push('```')
        L.push('')
      }
      ;(c.mustRules || []).forEach(function (r) { allRules.set(r, c.name) })
      ;(c.readRefs || []).forEach(function (r) { allRefs.add(r) })
    })

    if (allRules.size) {
      L.push('---')
      L.push('')
      L.push('## 硬约束（不读细则也必须遵守）')
      L.push('')
      allRules.forEach(function (compName, rule) { L.push('- 【' + compName + '】' + rule) })
      L.push('')
    }
    if (allRefs.size) {
      L.push('## 需要展开时读这些')
      L.push('')
      L.push('> 路径相对你项目根 `CLAUDE.md` 里 `@` 指向的 design-spec 目录')
      L.push('')
      allRefs.forEach(function (r) { L.push('- `' + r + '`') })
      L.push('')
    }
    L.push('---')
    L.push('')
    L.push('骨架里的 `form.field` / `handleClick` 等占位命名请按实际业务改；样式值一律走设计令牌，不要写裸值。')
    if (pins[0] && pins[0].url) { L.push(''); L.push('页面地址：' + pins[0].url) }
    return L.join('\n')
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 对外契约（与 asset-library-ui.js 一致：mount / unmount）
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * 打点态必须跟着工具的存活状态走。
   *
   * 收起有两条路径，都不会调用 unmount：
   *   ① 收起侧边面板 → 滑出动画后 `panel.remove()`，摘掉 liaison-style-panel
   *   ② 收起整个工具（eject.js）→ `liaison-app.remove()`
   * 判据取 **liaison-style-panel 在不在**：它在 ① ② 两种情况下都会消失，
   * 而 liaison-app 只在 ② 消失（① 时猫头图标还留着）。盯 liaison-app 会漏掉 ①。
   */
  let lifeTimer = null

  function watchHostLifecycle() {
    if (lifeTimer) return
    // 用轮询而非 MutationObserver：面板挂在哪一层、经过几次动画后才 remove、
    // 是否被移进别的容器 —— 这些都是宿主内部实现，猜错一次就整条链路失效
    // （已经猜错两次：先盯 hidden 属性、再盯 liaison-app 的移除）。
    // 每 400ms 查一次 querySelector 的成本可以忽略，但判据是"实际存在与否"，
    // 不依赖任何关于 DOM 结构的假设。
    lifeTimer = setInterval(function () {
      const alive = !!document.querySelector('liaison-style-panel')
      if (alive) return
      // 条件不能只看 state.picking：浮层开着、或标记还在页面上时，
      // picking 可能已是 false（比如刚点完"完成"），那些痕迹同样要清。
      if (state.picking || popEl) shutdown()
    }, 400)
  }

  /**
   * 收工：工具被收起时把痕迹清干净。
   *
   * 标记也要清——工具都收起来了，页面上还飘着蓝色圆点和组件名标签，
   * 用户会以为没退出。pins 数据保留，重新打开工具切回「组件」tab 时能恢复。
   */
  function shutdown() {
    stopPicking()
    closePopover()
    // **不清标记**。两个理由：
    // ① 工具条上的计数读的是 buildOverviewItems()，它扫 DOM 里带
    //    data-liaison-modified 的元素——清了标记，计数就归零，
    //    用户看到"0"会以为打的点全丢了。
    // ② 语义上标记是"这里要加东西"的记号，工具收起不代表记号作废；
    //    真要清空有「清单」tab 的清空按钮。
    // 停打点 + 关浮层就够了：那两个才是"正在操作"的状态。
  }

  // 模块加载即开始盯着宿主存活状态。不能等 mount 才绑：用户可能从没进过
  // 「组件」tab 就收起工具，那样 observer 根本没启动过，收起时也就不会清理。
  if (document.body) watchHostLifecycle()
  else document.addEventListener('DOMContentLoaded', watchHostLifecycle, { once: true })

  window.__liaisonDesignUI = {
    /**
     * 供宿主「清空」调用。
     *
     * 宿主的 clearSelectedState 只重置带 data-liaison-modified 的元素——
     * 碰不到组件名小标签（没有该属性），更不知道 state.pins 的存在。
     * 所以清空必须由我们自己做全套：清数据、清标记、关浮层、重绘面板。
     */
    clearAll() {
      state.pins = []
      state.editingPin = -1
      state.copied = false
      state.shotError = ''
      closePopover()
      hidePin()
      render()
    },

    /**
     * 供宿主「清单」tab 的复制调用：把已配好的组件点拼成一段，
     * 追加在 Page Feedback 之后。没有已配点则返回空串（宿主会跳过）。
     *
     * 会在这里逐点截图——清单复制是"一次性交付全部改动"的动作，
     * 组件的落点图也该在这时生成。
     */
    async buildOverviewSection() {
      const pins = configuredPins()
      if (!pins.length) return ''
      const shots = await captureEachPin(pins)
      return buildMultiPrompt(pins, shots)
    },

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
      // 先进打点态再渲染——提示文案要读 state.picking，顺序反了会显示成
      // "切到本 tab 即可开始打点"（而此刻已经可以打了）。
      // 进入「组件」tab 即进入打点态：既然来了这个 tab，下一步必然是打点。
      // 退出靠切走 tab（unmount 会停），不需要额外的退出操作。
      // 标记若因故缺失（如页面导航重载）则补建回来
      if (state.pins.length && state.pins.some(function (p) { return !p.el || !p.el.isConnected })) renderPins()
      if (!state.picking) startPicking()
      else render()
      // 每次打开面板都后台同步一次：缓存先渲染、拉到新的再刷新。
      // 不做「同步按钮」——用户不该需要记得点它。
      if (!CATALOG.length || Date.now() - state.syncedAt > 60000) {
        state.loading = !CATALOG.length
        loadCatalog()
      }
    },
    unmount: function () {
      stopPicking()
      // 切走 tab 时清掉没选组件的空点（同"打新点前"的理由：多半是误点）
      const before = state.pins.length
      state.pins = state.pins.filter(function (p) { return p.componentId })
      if (state.pins.length !== before) renderPins()
      // 不调 hidePin()：pins 要保留（切走再回来点还在），而 reconcilePins
      // 按 el.isConnected 判存活——清了标记就等于把所有点判成失效。
      // 标记留在页面上也符合直觉：那是"这里要加东西"的记号，不该因为
      // 切了个 tab 就消失。
      if (state.root) state.root.innerHTML = ''
      state.root = null
      state.ctx = null
      state.copied = false
      // pins 不清：切走再回来，已打的点和配好的组件还在（页面标记也还在）。
      // 真要清空由用户点 × 逐个删，或清单 tab 的「清空」。
      // CATALOG / GROUPS 同样不清：跨次打开复用，避免每次都白屏等网络
    },
  }
})()
