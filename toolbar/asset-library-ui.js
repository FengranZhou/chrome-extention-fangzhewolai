// ============================================================================
// 线上参考 · 全屏资产库管理界面（Eagle 风格网格图墙）
// ----------------------------------------------------------------------------
// 只在「线上参考」面板 **全屏态** 使用。非全屏仍走 bundle 里原有的简单时间倒序
// 列表，本模块完全不介入。
//
// 架构：bundle.min.js 的 renderInspirationPanel() 在检测到 data-fullscreen 时，
// 返回一个空的挂载容器 `<div id="liaison-asset-ui-root">`，然后调用
// window.__liaisonAssetUI.mount(rootEl, ctx)。本模块接管该容器内的全部渲染与
// 交互，数据通过 bundle 暴露的 window.__liaisonInsp（list/remove/updateTags/
// buildPromptAsync）读写。ctx.exitFullscreen 用于「退出全屏」按钮。
//
// 交互要点（吸取首版教训）：
//  - 卡片默认只显示缩略图，hover 才淡入信息+操作（动效）。
//  - 搜索只重绘网格、不重建输入框，并监听 composition 事件 → 中文输入法可用。
//  - 打标签用内联输入框，不用 window.prompt（扩展内容脚本里会被浏览器拦截）。
//  - 局部更新为主，避免整体 render() 导致闪屏。
// ============================================================================

;(function () {
  if (typeof window === 'undefined' || window.__liaisonAssetUI) return

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]))

  const state = {
    root: null,
    ctx: null,
    snapshots: [],
    query: '',
    activeTag: null, // null = 全部
    composing: false, // 中文输入法组合中
  }

  const CSS = `
  .lau-root{position:absolute;inset:0;display:flex;flex-direction:column;color:#e8eaed;font-family:-apple-system,"PingFang SC","Segoe UI",sans-serif;}
  .lau-topbar{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:2px 2px 14px;}
  .lau-search{flex:1 1 auto;display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:8px 12px;}
  .lau-search input{flex:1;background:transparent;border:none;outline:none;color:#e8eaed;font-size:14px;}
  .lau-search input::placeholder{color:rgba(232,234,237,.4);}
  .lau-count{flex:0 0 auto;font-size:12px;color:rgba(232,234,237,.5);white-space:nowrap;}
  .lau-exit{flex:0 0 auto;display:inline-flex;align-items:center;gap:5px;font-size:13px;padding:8px 12px;border-radius:10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);color:#e8eaed;cursor:pointer;transition:background .12s;}
  .lau-exit:hover{background:rgba(255,255,255,.14);}
  .lau-body{flex:1 1 auto;display:flex;gap:16px;min-height:0;}
  .lau-side{flex:0 0 176px;overflow:auto;padding-right:4px;border-right:1px solid rgba(255,255,255,.08);}
  .lau-side-title{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:rgba(232,234,237,.4);margin:6px 6px 8px;}
  .lau-tag-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;border-radius:8px;cursor:pointer;font-size:13px;color:#d7d9dc;transition:background .12s;}
  .lau-tag-item:hover{background:rgba(255,255,255,.06);}
  .lau-tag-item.active{background:rgba(120,140,255,.22);color:#fff;}
  .lau-tag-count{font-size:11px;color:rgba(232,234,237,.4);}
  .lau-empty-side{font-size:12px;color:rgba(232,234,237,.35);padding:8px 10px;line-height:1.5;}
  .lau-grid-wrap{flex:1 1 auto;overflow:auto;}
  .lau-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;padding:2px 2px 24px;align-content:start;}

  /* 卡片：等高，缩略图在固定高度区内居中；hover 淡入操作层 */
  .lau-card{position:relative;border-radius:12px;overflow:hidden;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);transition:border-color .18s,transform .18s,box-shadow .18s;}
  .lau-card:hover{border-color:rgba(255,255,255,.32);transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.35);}
  .lau-thumb-box{display:flex;align-items:center;justify-content:center;width:100%;height:240px;background:rgba(0,0,0,.28);overflow:hidden;}
  .lau-thumb{display:block;max-width:100%;max-height:100%;object-fit:contain;}
  .lau-thumb-fallback{display:flex;align-items:center;justify-content:center;width:100%;height:240px;font-size:13px;color:rgba(232,234,237,.4);text-transform:uppercase;}

  .lau-overlay{position:absolute;left:0;right:0;bottom:0;padding:12px 11px 11px;
    background:linear-gradient(to top,rgba(12,14,18,.94) 0%,rgba(12,14,18,.82) 55%,rgba(12,14,18,0) 100%);
    opacity:0;transform:translateY(8px);transition:opacity .2s ease,transform .2s ease;pointer-events:none;}
  .lau-card:hover .lau-overlay,.lau-card.lau-card-pinned .lau-overlay{opacity:1;transform:translateY(0);pointer-events:auto;}
  /* popover 打开时卡片保持"选中"态，鼠标移到 popover 上也不淡出 */
  .lau-card.lau-card-pinned{border-color:rgba(255,255,255,.32);z-index:20;}
  .lau-card-tags{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;align-items:center;}
  .lau-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:2px 7px;border-radius:20px;background:rgba(120,140,255,.28);color:#eef1ff;}
  .lau-chip button{background:none;border:none;color:inherit;cursor:pointer;padding:0;font-size:12px;line-height:1;opacity:.7;}
  .lau-chip button:hover{opacity:1;}
  .lau-tag-add{font-size:11px;padding:2px 8px;border-radius:20px;background:rgba(255,255,255,.1);border:1px dashed rgba(255,255,255,.3);color:rgba(232,234,237,.85);cursor:pointer;}
  .lau-tag-add:hover{background:rgba(255,255,255,.18);color:#fff;}

  /* 打标签下拉：已有标签可选 + 底部输入可新增 */
  .lau-tagpop{position:absolute;z-index:50;min-width:150px;max-width:220px;background:#20242c;border:1px solid rgba(255,255,255,.16);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.5);padding:6px;}
  .lau-tagpop-list{max-height:160px;overflow:auto;display:flex;flex-direction:column;gap:2px;margin-bottom:6px;}
  .lau-tagpop-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border-radius:7px;font-size:12px;color:#dfe1e4;cursor:pointer;}
  .lau-tagpop-item:hover{background:rgba(120,140,255,.22);color:#fff;}
  .lau-tagpop-item.checked{color:#8fa4ff;}
  .lau-tagpop-empty{font-size:11px;color:rgba(232,234,237,.4);padding:4px 8px;}
  .lau-tagpop-input{width:100%;box-sizing:border-box;font-size:12px;padding:6px 8px;border-radius:7px;background:rgba(255,255,255,.08);border:1px solid rgba(120,140,255,.5);color:#fff;outline:none;}
  .lau-card-actions{display:flex;gap:8px;margin-top:9px;}
  .lau-btn{flex:1;font-size:12px;padding:6px 8px;border-radius:7px;cursor:pointer;border:1px solid transparent;transition:background .12s;}
  .lau-btn-primary{background:#3a7d5d;color:#eafff3;}
  .lau-btn-primary:hover{background:#448a68;}
  .lau-btn-ghost{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.2);color:#e8eaed;}
  .lau-btn-ghost:hover{background:rgba(255,255,255,.18);}
  .lau-empty{grid-column:1/-1;text-align:center;color:rgba(232,234,237,.4);font-size:14px;padding:60px 0;}
  `

  function injectCss(rootNode) {
    const sr = rootNode.getRootNode && rootNode.getRootNode()
    const holder = sr instanceof ShadowRoot ? sr : rootNode
    if (holder.querySelector && holder.querySelector('#lau-style')) return
    const style = document.createElement('style')
    style.id = 'lau-style'
    style.textContent = CSS
    holder.appendChild(style)
  }

  // ---- 数据派生 ----
  function allTags(snaps) {
    const m = new Map()
    for (const s of snaps) for (const t of (s.tags || [])) m.set(t, (m.get(t) || 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }

  function filtered() {
    const q = state.query.trim().toLowerCase()
    return state.snapshots.filter((s) => {
      if (state.activeTag && !(s.tags || []).includes(state.activeTag)) return false
      if (!q) return true
      const hay = [
        s.source && s.source.hostname,
        s.element && s.element.textPreview,
        (s.tags || []).join(' '),
      ].join(' ').toLowerCase()
      return hay.includes(q)
    })
  }

  // ---- 卡片 HTML ----
  function cardHtml(s) {
    const tag = (s.element && s.element.tagName || '?').toLowerCase()
    const thumb = s.thumbnailUrl
      ? `<div class="lau-thumb-box"><img class="lau-thumb" src="${esc(s.thumbnailUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('lau-thumb-fallback');this.remove()" /></div>`
      : `<div class="lau-thumb-fallback">${esc(tag)}</div>`
    const chips = (s.tags || []).map((t) =>
      `<span class="lau-chip">${esc(t)}<button data-lau-untag="${esc(s.id)}" data-lau-tagname="${esc(t)}" title="移除">×</button></span>`
    ).join('')
    return `
    <div class="lau-card" data-lau-card="${esc(s.id)}">
      ${thumb}
      <div class="lau-overlay">
        <div class="lau-card-tags" data-lau-tagbar="${esc(s.id)}">${chips}<span class="lau-tag-add" data-lau-addtag="${esc(s.id)}">+ 标签</span></div>
        <div class="lau-card-actions">
          <button class="lau-btn lau-btn-primary" data-lau-copy="${esc(s.id)}">复制 Prompt</button>
          <button class="lau-btn lau-btn-ghost" data-lau-del="${esc(s.id)}">删除</button>
        </div>
      </div>
    </div>`
  }

  // ---- 只重绘网格（搜索/筛选用，不动搜索框，保住中文输入）----
  function refreshGrid() {
    const root = state.root
    if (!root) return
    const list = filtered()
    const grid = root.querySelector('.lau-grid')
    const count = root.querySelector('.lau-count')
    if (count) count.textContent = `${list.length} / ${state.snapshots.length}`
    if (grid) {
      grid.innerHTML = list.length
        ? list.map(cardHtml).join('')
        : `<div class="lau-empty">${state.snapshots.length ? '没有匹配的采集。' : '库为空。退出全屏，选中元素后采集。'}</div>`
      bindCardEvents()
    }
  }

  // ---- 只重绘左侧标签栏 ----
  function refreshSide() {
    const root = state.root
    if (!root) return
    const side = root.querySelector('.lau-side')
    if (!side) return
    side.innerHTML = sideInner()
    bindSideEvents()
  }

  function sideInner() {
    const snaps = state.snapshots
    const tags = allTags(snaps)
    return `
      <div class="lau-side-title">标签</div>
      <div class="lau-tag-item ${state.activeTag === null ? 'active' : ''}" data-lau-tag="__all__">
        <span>全部</span><span class="lau-tag-count">${snaps.length}</span>
      </div>
      ${tags.length
        ? tags.map(([t, c]) => `
          <div class="lau-tag-item ${state.activeTag === t ? 'active' : ''}" data-lau-tag="${esc(t)}">
            <span>${esc(t)}</span><span class="lau-tag-count">${c}</span>
          </div>`).join('')
        : '<div class="lau-empty-side">还没有标签。<br>hover 卡片点「+ 标签」添加。</div>'}`
  }

  // ---- 首次整体渲染（只调用一次）----
  function renderShell() {
    const root = state.root
    if (!root) return
    root.innerHTML = `
      <div class="lau-root">
        <div class="lau-topbar">
          <div class="lau-search">
            <span style="opacity:.5">🔍</span>
            <input type="text" placeholder="搜索域名 / 文字 / 标签…" data-lau-search />
          </div>
          <span class="lau-count"></span>
          <button class="lau-exit" data-lau-exit title="退出全屏">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v5H3M4 4l4 4M16 3v5h5M20 4l-4 4M8 21v-5H3M4 20l4-4M16 21v-5h5M20 20l-4-4"/></svg>
            退出全屏
          </button>
        </div>
        <div class="lau-body">
          <div class="lau-side">${sideInner()}</div>
          <div class="lau-grid-wrap"><div class="lau-grid"></div></div>
        </div>
      </div>`
    bindShellEvents()
    bindSideEvents()
    refreshGrid()
  }

  // ---- 事件绑定 ----
  function bindShellEvents() {
    const root = state.root
    const search = root.querySelector('[data-lau-search]')
    if (search) {
      search.addEventListener('compositionstart', () => { state.composing = true })
      search.addEventListener('compositionend', (e) => {
        state.composing = false
        state.query = e.target.value
        refreshGrid()
      })
      search.addEventListener('input', (e) => {
        if (state.composing) return // 组合输入中不筛选，避免打断中文输入法
        state.query = e.target.value
        refreshGrid()
      })
    }
    const exit = root.querySelector('[data-lau-exit]')
    if (exit) exit.onclick = () => { if (state.ctx && state.ctx.exitFullscreen) state.ctx.exitFullscreen() }
  }

  function bindSideEvents() {
    const root = state.root
    root.querySelectorAll('[data-lau-tag]').forEach((el) => {
      el.onclick = () => {
        const t = el.getAttribute('data-lau-tag')
        state.activeTag = t === '__all__' ? null : t
        refreshSide()   // 更新 active 高亮
        refreshGrid()   // 更新网格
      }
    })
  }

  function bindCardEvents() {
    const root = state.root

    root.querySelectorAll('[data-lau-del]').forEach((el) => {
      el.onclick = async (ev) => {
        ev.stopPropagation()
        const id = el.getAttribute('data-lau-del')
        if (window.__liaisonInsp) { try { await window.__liaisonInsp.remove(id) } catch (e) {} }
        state.snapshots = state.snapshots.filter((s) => s.id !== id)
        if (state.ctx && state.ctx.onDataChanged) state.ctx.onDataChanged()
        refreshSide(); refreshGrid()
      }
    })

    root.querySelectorAll('[data-lau-copy]').forEach((el) => {
      el.onclick = async (ev) => {
        ev.stopPropagation()
        const id = el.getAttribute('data-lau-copy')
        const snap = state.snapshots.find((s) => s.id === id)
        if (!snap || !window.__liaisonInsp) return
        const orig = el.textContent
        try {
          const prompt = await window.__liaisonInsp.buildPromptAsync(snap, state.ctx && state.ctx.target)
          await navigator.clipboard.writeText(prompt)
          el.textContent = '已复制 ✓'
        } catch (e) { el.textContent = '复制失败' }
        setTimeout(() => { el.textContent = orig }, 1500)
      }
    })

    // 打标签：下拉选择器（已有标签点选 + 底部输入新增）
    root.querySelectorAll('[data-lau-addtag]').forEach((el) => {
      el.onclick = (ev) => {
        ev.stopPropagation()
        openTagPopover(el, el.getAttribute('data-lau-addtag'))
      }
    })

    root.querySelectorAll('[data-lau-untag]').forEach((el) => {
      el.onclick = async (ev) => {
        ev.stopPropagation()
        const id = el.getAttribute('data-lau-untag')
        const t = el.getAttribute('data-lau-tagname')
        await applyTag(id, t, false)
        if (state.activeTag === t && !allTags(state.snapshots).some(([tt]) => tt === t)) state.activeTag = null
        updateCardTagbar(id); refreshSide()
      }
    })
  }

  // 属性选择器里的 id 转义（id 是 uuid，通常安全，但稳妥起见）
  function cssEsc(s) {
    return String(s).replace(/["\\]/g, '\\$&')
  }

  // 给某条采集加/去标签并持久化
  async function applyTag(id, name, add) {
    const snap = state.snapshots.find((s) => s.id === id)
    if (!snap) return
    snap.tags = snap.tags || []
    if (add) { if (!snap.tags.includes(name)) snap.tags.push(name) }
    else { snap.tags = snap.tags.filter((x) => x !== name) }
    if (window.__liaisonInsp) { try { await window.__liaisonInsp.updateTags(id, snap.tags) } catch (e) {} }
  }

  // 只重绘某张卡片的标签栏（不动网格、不破坏 hover）
  function updateCardTagbar(id) {
    const root = state.root
    if (!root) return
    const bar = root.querySelector(`[data-lau-tagbar="${cssEsc(id)}"]`)
    if (!bar) return
    const snap = state.snapshots.find((s) => s.id === id)
    const chips = ((snap && snap.tags) || []).map((t) =>
      `<span class="lau-chip">${esc(t)}<button data-lau-untag="${esc(id)}" data-lau-tagname="${esc(t)}" title="移除">×</button></span>`
    ).join('')
    bar.innerHTML = `${chips}<span class="lau-tag-add" data-lau-addtag="${esc(id)}">+ 标签</span>`
    // 重绑该标签栏内的事件
    const add = bar.querySelector('[data-lau-addtag]')
    if (add) add.onclick = (ev) => { ev.stopPropagation(); openTagPopover(add, id) }
    bar.querySelectorAll('[data-lau-untag]').forEach((el) => {
      el.onclick = async (ev) => {
        ev.stopPropagation()
        const t = el.getAttribute('data-lau-tagname')
        await applyTag(id, t, false)
        updateCardTagbar(id); refreshSide()
      }
    })
  }

  // 新建标签后刷新 popover 的已有标签列表
  function rebuildPopoverList(pop, id) {
    const snap = state.snapshots.find((s) => s.id === id)
    const own = new Set((snap && snap.tags) || [])
    const all = allTags(state.snapshots).map(([t]) => t)
    const listEl = pop.querySelector('.lau-tagpop-list')
    if (!listEl) return
    listEl.innerHTML = all.length
      ? all.map((t) =>
          `<div class="lau-tagpop-item ${own.has(t) ? 'checked' : ''}" data-tp-toggle="${esc(t)}">
             <span>${esc(t)}</span><span>${own.has(t) ? '✓' : ''}</span>
           </div>`).join('')
      : '<div class="lau-tagpop-empty">还没有标签，下方输入新建</div>'
    listEl.querySelectorAll('[data-tp-toggle]').forEach((it) => {
      it.onclick = async (e) => {
        e.stopPropagation()
        const name = it.getAttribute('data-tp-toggle')
        const willAdd = !own.has(name)
        await applyTag(id, name, willAdd)
        updateCardTagbar(id); refreshSide(); rebuildPopoverList(pop, id)
      }
    })
  }

  let openPop = null // 当前打开的 popover（同一时刻只一个）
  function closeTagPopover() {
    if (openPop && openPop.el) openPop.el.remove()
    if (openPop && openPop.onDoc) document.removeEventListener('mousedown', openPop.onDoc, true)
    // 取消所有卡片的 pinned 态
    if (state.root) state.root.querySelectorAll('.lau-card-pinned').forEach((c) => c.classList.remove('lau-card-pinned'))
    openPop = null
  }

  // 在锚点附近打开标签选择器：已有标签可勾选、底部输入可新增
  function openTagPopover(anchor, id) {
    closeTagPopover()
    const root = state.root
    if (!root) return
    const snap = state.snapshots.find((s) => s.id === id)
    const own = new Set((snap && snap.tags) || [])
    const all = allTags(state.snapshots).map(([t]) => t)

    const pop = document.createElement('div')
    pop.className = 'lau-tagpop'
    const listHtml = all.length
      ? all.map((t) =>
          `<div class="lau-tagpop-item ${own.has(t) ? 'checked' : ''}" data-tp-toggle="${esc(t)}">
             <span>${esc(t)}</span><span>${own.has(t) ? '✓' : ''}</span>
           </div>`).join('')
      : '<div class="lau-tagpop-empty">还没有标签，下方输入新建</div>'
    pop.innerHTML = `
      <div class="lau-tagpop-list">${listHtml}</div>
      <input class="lau-tagpop-input" type="text" placeholder="新建标签，回车添加" />`

    // 关键：popover 打开时给卡片加 pinned 类，强制 overlay 保持可见。否则鼠标从
    // +标签 移向下方列表项时会离开 .lau-card:hover 区域 → overlay 淡出 → popover
    // 视觉上「一闪就消失」，根本点不到列表项（这是真正的病根）。
    const card = anchor.closest ? anchor.closest('.lau-card') : null
    if (card) card.classList.add('lau-card-pinned')

    // 定位：挂到 .lau-root（position:absolute，稳定定位上下文），viewport 坐标差换算。
    const lauRoot = root.querySelector('.lau-root') || root
    lauRoot.appendChild(pop)
    const ar = anchor.getBoundingClientRect()
    const rr = lauRoot.getBoundingClientRect()
    let left = ar.left - rr.left
    let top = ar.bottom - rr.top + 6
    const pw = 200
    if (left + pw > rr.width) left = Math.max(4, rr.width - pw - 4)
    pop.style.left = left + 'px'
    pop.style.top = top + 'px'

    // 勾选/取消已有标签 —— 局部更新，不重绘网格（否则卡片重建、hover 丢失、popover 被清）
    pop.querySelectorAll('[data-tp-toggle]').forEach((it) => {
      it.onclick = async (e) => {
        e.stopPropagation()
        const name = it.getAttribute('data-tp-toggle')
        const willAdd = !own.has(name)
        await applyTag(id, name, willAdd)
        // 同步 popover 内的勾选态
        if (willAdd) own.add(name); else own.delete(name)
        it.classList.toggle('checked', willAdd)
        const mark = it.querySelector('span:last-child')
        if (mark) mark.textContent = willAdd ? '✓' : ''
        // 只更新该卡片的标签栏 + 左侧标签统计，不动网格与 hover
        updateCardTagbar(id)
        refreshSide()
        // popover 保持打开，可连续勾选
      }
    })

    // 新建标签
    const input = pop.querySelector('.lau-tagpop-input')
    let composing = false
    input.addEventListener('compositionstart', () => { composing = true })
    input.addEventListener('compositionend', () => { composing = false })
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && !composing) {
        const name = input.value.trim()
        if (!name) return
        await applyTag(id, name, true)
        input.value = ''
        // 局部更新：重建 popover 列表（含新标签）+ 卡片标签栏 + 左侧栏
        updateCardTagbar(id)
        refreshSide()
        rebuildPopoverList(pop, id)
      } else if (e.key === 'Escape') {
        closeTagPopover()
      }
    })
    setTimeout(() => input.focus(), 0)

    // 点外部关闭 —— 用几何命中判断，不用 composedPath/contains。
    // 关键：本面板的 shadow 是 closed mode，事件 composedPath 不暴露内部节点（顶层
    // 只到 host liaison-style-panel），所以 path.indexOf(pop) 永远 -1 → 每次 mousedown
    // 都误判为「外部」把 popover 关掉。这正是「一点就关」的真正病根。
    // 改判：点击坐标是否落在 popover 或 anchor 的矩形内。
    const inRect = (el, x, y) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
    }
    const onDoc = (e) => {
      if (!inRect(pop, e.clientX, e.clientY) && !inRect(anchor, e.clientX, e.clientY)) closeTagPopover()
    }
    setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0)
    openPop = { el: pop, onDoc }
  }

  // ---- 对外接口 ----
  window.__liaisonAssetUI = {
    async mount(rootEl, ctx) {
      state.root = rootEl
      state.ctx = ctx || {}
      state.query = ''
      state.activeTag = null
      injectCss(rootEl)
      try {
        state.snapshots = window.__liaisonInsp ? await window.__liaisonInsp.list() : []
      } catch (e) { state.snapshots = [] }
      renderShell()
    },
    unmount() {
      closeTagPopover()
      if (state.root) state.root.innerHTML = ''
      state.root = null
      state.query = ''
      state.activeTag = null
      state.composing = false
    },
  }
})()
