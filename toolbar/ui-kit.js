/**
 * ui-kit.html 的渲染逻辑。
 *
 * 硬规矩：**不硬编码任何令牌值**，全部从 ui-tokens.js 读出来渲染。
 * 所以改了令牌、刷新这一页就是最新的，规范和实现不可能漂移。
 */
(function () {
  var T = window.__liaisonUITokens
  if (!T) {
    document.getElementById('main').innerHTML =
      '<p style="color:#FF6B6B">ui-tokens.js 没加载上，检查同目录下文件是否存在。</p>'
    return
  }

  var main = document.getElementById('main')
  var nav = document.getElementById('nav')
  var secs = []

  function el(tag, cls, html) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (html != null) n.innerHTML = html
    return n
  }

  /** 建一个章节，自动登记进左侧导航 */
  function section(id, title, note, warn) {
    var s = el('section')
    s.id = id
    s.appendChild(el('h2', null, title))
    if (note) s.appendChild(el('div', 'note', note))
    if (warn) s.appendChild(el('div', 'warn', warn))
    main.appendChild(s)
    secs.push({ id: id, title: title })
    return s
  }

  /** 一行令牌：左样例 + 右名字/值/用途 */
  function row(parent, demoNode, key, val, use) {
    var r = el('div', 'row')
    var d = el('div', 'demo')
    if (demoNode) d.appendChild(demoNode)
    r.appendChild(d)
    var m = el('div', 'meta')
    m.appendChild(el('div', 'k', key))
    m.appendChild(el('div', 'v', val))
    if (use) m.appendChild(el('div', 'use', use))
    r.appendChild(m)
    parent.appendChild(r)
    return r
  }

  function rows(parent) {
    var w = el('div', 'rows')
    parent.appendChild(w)
    return w
  }

  // ── 1. 颜色 ──────────────────────────────────────────────
  // 用途文案在这里维护：令牌文件里是注释（给读代码的人），
  // 这里是给看规范的人，两处都指向同一个语义。
  var COLOR_USE = {
    'surface': '面板 / 浮层的底色，唯一的不透明底',
    'surface-raised': '在面板上抬起一层：列表项 hover、内嵌小块',
    'surface-sunken': '在面板上凹陷一层：代码块、预览区',
    'line': '常规分隔线、面板边框',
    'line-subtle': '弱分隔：同一组内部的行与行之间',
    'line-strong': '强调边框：聚焦、选中',
    'text': '正文、标题',
    'text-sub': '次要说明、辅助信息',
    'text-weak': '弱化信息：占位符、单位、时间戳',
    'text-disabled': '禁用态文字',
    'primary': '主操作按钮、选中态、链接',
    'primary-hover': '主按钮 hover',
    'primary-weak': '选中底色、弱强调背景',
    'accent': '组件标记专用（与主色区分开，避免和交互态混淆）',
    'accent-weak': '组件标记的弱底',
    'danger': '危险操作、错误文案',
    'danger-weak': '错误提示的底色',
    'success': '成功反馈',
    'warning': '警示、待处理'
  }

  var sc = section(
    'color', '颜色',
    '工具浮在别人的页面之上，所以底色只能是<b>深色不透明</b>——半透明会透出宿主页面的内容，' +
      '文字立刻不可读。除 <code>surface</code> 外全部是<b>白色/黑色的透明叠加</b>，' +
      '这样同一套值在任何深浅的宿主页上叠出来的层级关系都一致。',
    '⚠ 不要新增第二个不透明底色。需要“更亮一层 / 更暗一层”时用 ' +
      '<code>surface-raised</code> / <code>surface-sunken</code> 叠，而不是另调一个 hex。'
  )
  var cw = rows(sc)
  Object.keys(T.color).forEach(function (k) {
    var sw = el('div', 'sw')
    var i = el('i')
    i.style.background = T.color[k]
    sw.appendChild(i)
    row(cw, sw, 'color.' + k, T.color[k], COLOR_USE[k] || '')
  })

  // ── 2. 圆角 ──────────────────────────────────────────────
  var RADIUS_USE = {
    sm: '小控件：按钮、输入框、列表项、标签',
    md: '中等块：内嵌卡片、代码块、下拉项',
    lg: '容器：面板、浮层、弹层',
    xl: '大容器：整块卡片',
    pill: '胶囊：徽标、状态点、跟随提示'
  }
  var sr = section(
    'radius', '圆角',
    '五档，按<b>被圆角包住的东西有多大</b>选，不按“想要多圆”选。' +
      '嵌套时外层必须大于内层，否则内层的角会顶到外层的弧上。',
    '⚠ 只有这五档。历史上出现过 4/5/7/9px 这些中间值——那是随手调出来的，' +
      '已统一并入 sm/md/lg，不要再引入新档。'
  )
  var rw = rows(sr)
  Object.keys(T.radius).forEach(function (k) {
    var b = el('div')
    b.style.cssText =
      'width:84px;height:44px;background:' + T.color['surface-raised'] +
      ';border:1px solid ' + T.color.line + ';border-radius:' + T.radius[k]
    row(rw, b, 'radius.' + k, T.radius[k], RADIUS_USE[k] || '')
  })

  // ── 3. 间距 ──────────────────────────────────────────────
  var SPACE_USE = {
    xxs: '紧贴：图标与其紧随的文字',
    xs: '同一元素内部：标签的左右内边距、徽标内距',
    sm: '同组元素之间：一排按钮、表单项内部',
    md: '控件内边距、相邻两组之间',
    lg: '面板内边距、区块之间',
    xl: '大分区之间（面板尺寸有限，很少用到）'
  }
  var ss = section(
    'space', '间距',
    '6 档，<b>4 的倍数</b>（2 是唯一例外，只用于图标贴字）。' +
      '间距是这套界面里最主要的分组手段——先靠间距把东西分开，分不开才考虑加线。'
  )
  var sw2 = rows(ss)
  Object.keys(T.space).forEach(function (k) {
    var b = el('div')
    b.style.cssText =
      'height:20px;background:' + T.color['primary-weak'] +
      ';border-left:2px solid ' + T.color.primary +
      ';border-right:2px solid ' + T.color.primary +
      ';width:' + T.space[k]
    row(sw2, b, 'space.' + k, T.space[k], SPACE_USE[k] || '')
  })

  // ── 4. 字体 ──────────────────────────────────────────────
  // 字号只有 10/11/12/13/14 五个值，字重只有 400/500/600。
  // 每一档都是「字号+行高+字重」打包好的整档，取用时整档取，不许拆开自拼。
  var FONT_USE = {
    body: '默认正文：列表项、说明文字、按钮文案',
    bodyStrong: '正文里需要强调的部分：当前项、字段名',
    small: '辅助信息：时间、计数、单位、次要说明',
    smallStrong: '小字里的强调：状态词、标签文案',
    title: '面板标题、分组标题',
    titleLg: '浮层的主标题（面板里最大的字）',
    mono: '代码 / 选择器 / 令牌名'
  }
  var sf = section(
    'font', '字体',
    '7 档语义字阶。字号只有 <code>10/11/12/13/14</code> 五个值、字重只有 ' +
      '<code>400/500/600</code>——工具界面挤在别人页面的一角，字阶再多就分不出层级了。',
    '⚠ <b>整档取用</b>。像 <code>font-size:12px</code> 单独写一行、行高交给继承，' +
      '是这套界面最常见的翻车：行高会塌，同一行里的图标和文字立刻错位。' +
      '字体族名含空格（PingFang SC），所以只能用完整 <code>font:</code> 简写或全部拆开写，不能只写一半。'
  )
  var fw = rows(sf)
  Object.keys(T.font).forEach(function (k) {
    var b = el('div', null, '效率工具 Aa 123')
    b.style.font = T.font[k]
    b.style.color = T.color.text
    row(fw, b, 'font.' + k, T.font[k], FONT_USE[k] || '')
  })

  // ── 5. 阴影 ──────────────────────────────────────────────
  var SHADOW_USE = {
    sm: '轻微抬起：跟随提示、小徽标',
    md: '浮层：下拉、气泡',
    lg: '主面板：脱离页面最远的那一层'
  }
  var sh = section(
    'shadow', '投影',
    '3 档，<b>离页面越远、投影越大越散</b>。深色界面里投影同时承担“和宿主页面拉开距离”的职责，' +
      '所以比常见的浅色设计系统要重一些。'
  )
  var hw = rows(sh)
  Object.keys(T.shadow).forEach(function (k) {
    var b = el('div')
    b.style.cssText =
      'width:96px;height:48px;background:' + T.color.surface +
      ';border-radius:' + T.radius.lg + ';box-shadow:' + T.shadow[k]
    row(hw, b, 'shadow.' + k, T.shadow[k], SHADOW_USE[k] || '')
  })

  // ── 6. 层级 ──────────────────────────────────────────────
  var Z_USE = {
    pick: '拾取高亮 / 区域框——最底层，会被标记盖住',
    mark: '页面标记：编号圆点、组件名标签',
    panel: '面板 / 浮层 / 跟随提示',
    top: '下拉、确认弹层——必须盖住面板自己'
  }
  var sz = section(
    'z', '层级',
    '4 档，全部贴着 <code>2147483647</code>（int32 上限）往下排。' +
      '因为宿主页面可能自己就用了很大的 z-index，工具必须无条件浮在最上面。',
    '⚠ 不要写 <code>z-index: 9999</code> 这类“看起来够大”的值——真实站点里 99999 都见过。' +
      '需要新层级时在这 4 档之间选，不够用再来加档。'
  )
  var zw = rows(sz)
  Object.keys(T.z).forEach(function (k) {
    var b = el('div', null, String(T.z[k]))
    b.style.cssText =
      'font:' + T.font.mono + ';color:' + T.color['text-sub'] +
      ';background:' + T.color['surface-sunken'] + ';padding:6px 10px' +
      ';border-radius:' + T.radius.sm
    row(zw, b, 'z.' + k, String(T.z[k]), Z_USE[k] || '')
  })

  // ── 7. 动效 ──────────────────────────────────────────────
  var MOTION_USE = {
    fast: '状态色变化：hover、按下——快到几乎察觉不到',
    base: '常规过渡：展开、位移、显隐',
    slow: '入场 / 退场：面板打开关闭'
  }
  var sm2 = section(
    'motion', '动效',
    '3 档。工具是<b>安静的助手</b>，动效只用来交代“东西从哪来到哪去”，不做表演。' +
      '鼠标悬到下面的方块上看效果。'
  )
  var mw = rows(sm2)
  Object.keys(T.motion).forEach(function (k) {
    var b = el('div', null, 'hover')
    b.style.cssText =
      'width:84px;height:34px;display:flex;align-items:center;justify-content:center' +
      ';font:' + T.font.small + ';color:' + T.color['text-sub'] +
      ';background:' + T.color['surface-raised'] +
      ';border-radius:' + T.radius.sm +
      ';transition:all ' + T.motion[k]
    b.addEventListener('mouseenter', function () {
      b.style.background = T.color['primary-weak']
      b.style.transform = 'translateX(28px)'
    })
    b.addEventListener('mouseleave', function () {
      b.style.background = T.color['surface-raised']
      b.style.transform = 'none'
    })
    row(mw, b, 'motion.' + k, T.motion[k], MOTION_USE[k] || '')
  })

  // ── 8. 控件 ──────────────────────────────────────────────
  // 上面七章是“取什么值”，这一章是“值凑在一起长什么样”。
  // 每个控件只由上面的令牌拼出来，不引入任何新值——所以这一章同时也是
  // 一份可对照的验收样张：扩展里的同名控件长得不一样，就是那边写了私货。
  var sk = section(
    'controls', '控件',
    '扩展界面里反复出现的几种控件。<b>全部只由上面的令牌拼成</b>，' +
      '没有一个新值。扩展里的同名控件若与这里不一致，是那边写了裸值，应改回令牌。'
  )

  function demoBlock(sec, label, node) {
    var w = el('div')
    w.style.cssText = 'margin-bottom:' + T.space.lg
    var t = el('div', null, label)
    t.style.cssText =
      'font:' + T.font.small + ';color:' + T.color['text-weak'] +
      ';margin-bottom:' + T.space.sm
    w.appendChild(t)
    var box = el('div')
    // 样例统一放在面板底色上——控件的对比关系只在这个底色上成立
    box.style.cssText =
      'background:' + T.color.surface + ';border:1px solid ' + T.color.line +
      ';border-radius:' + T.radius.lg + ';padding:' + T.space.lg +
      ';display:flex;align-items:center;flex-wrap:wrap;gap:' + T.space.sm
    box.appendChild(node)
    w.appendChild(box)
    sec.appendChild(w)
  }

  function frag() { return document.createDocumentFragment() }

  /** 按钮：主 / 次 / 危险 / 禁用 */
  function btn(text, kind) {
    var b = el('button', null, text)
    var bg = T.color['surface-raised'], fg = T.color.text, bd = T.color.line
    if (kind === 'primary') { bg = T.color.primary; fg = '#fff'; bd = T.color.primary }
    if (kind === 'danger') { bg = T.color['danger-weak']; fg = T.color.danger; bd = 'transparent' }
    if (kind === 'disabled') { bg = T.color['surface-raised']; fg = T.color['text-disabled'] }
    b.style.cssText =
      'font:' + T.font.bodyStrong + ';color:' + fg + ';background:' + bg +
      ';border:1px solid ' + bd + ';border-radius:' + T.radius.sm +
      ';padding:' + T.space.xs + ' ' + T.space.md +
      ';height:28px;cursor:' + (kind === 'disabled' ? 'not-allowed' : 'pointer') +
      ';transition:background ' + T.motion.fast
    if (kind === 'disabled') b.disabled = true
    else b.addEventListener('mouseenter', function () {
      b.style.background = kind === 'primary' ? T.color['primary-hover'] : T.color['line-subtle']
    })
    b.addEventListener('mouseleave', function () { b.style.background = bg })
    return b
  }
  var bf = frag()
  bf.appendChild(btn('生成', 'primary'))
  bf.appendChild(btn('取消'))
  bf.appendChild(btn('删除', 'danger'))
  bf.appendChild(btn('不可用', 'disabled'))
  demoBlock(sk, '按钮 · 高度 28，圆角 sm，主按钮唯一', bf)

  /** 输入框 */
  var inp = el('input')
  inp.placeholder = '输入组件名…'
  inp.style.cssText =
    'font:' + T.font.body + ';color:' + T.color.text +
    ';background:' + T.color['surface-sunken'] +
    ';border:1px solid ' + T.color.line + ';border-radius:' + T.radius.sm +
    ';padding:0 ' + T.space.sm + ';height:28px;width:200px;outline:none' +
    ';transition:border-color ' + T.motion.fast
  inp.addEventListener('focus', function () { inp.style.borderColor = T.color['line-strong'] })
  inp.addEventListener('blur', function () { inp.style.borderColor = T.color.line })
  demoBlock(sk, '输入框 · 与按钮同高，底色用 sunken 表示“可写入”', inp)

  /** 列表项：默认 / hover / 选中 */
  function item(text, state) {
    var r = el('div')
    var bg = 'transparent', fg = T.color['text-sub']
    if (state === 'hover') { bg = T.color['surface-raised']; fg = T.color.text }
    if (state === 'on') { bg = T.color['primary-weak']; fg = T.color.primary }
    r.style.cssText =
      'font:' + T.font.body + ';color:' + fg + ';background:' + bg +
      ';border-radius:' + T.radius.sm + ';padding:' + T.space.sm + ' ' + T.space.md +
      ';display:flex;align-items:center;gap:' + T.space.xxs
    r.appendChild(el('span', null, text))
    if (state) {
      var tag = el('span', null, state === 'on' ? '选中' : 'hover')
      tag.style.cssText =
        'font:' + T.font.mono + ';color:' + T.color['text-weak'] + ';margin-left:auto'
      r.appendChild(tag)
    }
    return r
  }
  var lw = el('div')
  lw.style.cssText = 'display:flex;flex-direction:column;gap:2px;width:280px'
  lw.appendChild(item('Button 按钮'))
  lw.appendChild(item('Table 表格', 'hover'))
  lw.appendChild(item('Dialog 弹窗', 'on'))
  demoBlock(sk, '列表项 · 三态靠底色区分，行间 2px（靠圆角自然分开，不加线）', lw)

  /** 标签 / 徽标 */
  var tf = frag()
  ;[['组件', 'accent'], ['已标记', 'success'], ['待处理', 'warning'], ['冲突', 'danger']]
    .forEach(function (p) {
      var t = el('span', null, p[0])
      t.style.cssText =
        'font:' + T.font.smallStrong + ';color:' + T.color[p[1]] +
        ';background:' + (T.color[p[1] + '-weak'] || T.color['surface-raised']) +
        ';border-radius:' + T.radius.pill +
        ';padding:' + T.space.xxs + ' ' + T.space.sm
      tf.appendChild(t)
    })
  demoBlock(sk, '标签 · 胶囊圆角，文字用语义色、底用同色 weak 档', tf)

  /** 浮层 */
  var pop = el('div')
  pop.style.cssText =
    'background:' + T.color.surface + ';border:1px solid ' + T.color.line +
    ';border-radius:' + T.radius.lg + ';box-shadow:' + T.shadow.md +
    ';padding:' + T.space.lg + ';width:260px'
  var pt = el('div', null, '组件信息')
  pt.style.cssText = 'font:' + T.font.title + ';color:' + T.color.text +
    ';margin-bottom:' + T.space.xs
  var pd = el('div', null, '浮层 = surface 底 + line 描边 + shadow.md，圆角 lg。')
  pd.style.cssText = 'font:' + T.font.small + ';color:' + T.color['text-sub'] +
    ';margin-bottom:' + T.space.md
  var pa = el('div')
  pa.style.cssText = 'display:flex;gap:' + T.space.sm + ';justify-content:flex-end'
  pa.appendChild(btn('取消'))
  pa.appendChild(btn('确定', 'primary'))
  pop.appendChild(pt); pop.appendChild(pd); pop.appendChild(pa)
  demoBlock(sk, '浮层 · 主按钮贴右边缘（按钮组右对齐 → 主按钮在最右）', pop)

  // ── 左侧导航：按已登记的章节生成 ─────────────────────────
  secs.forEach(function (s) {
    var a = el('a', null, s.title)
    a.href = '#' + s.id
    a.dataset.for = s.id
    nav.appendChild(a)
  })

  // 滚动高亮：取当前滚过顶部的最后一个章节
  var links = nav.querySelectorAll('a')
  function sync() {
    var cur = secs[0] && secs[0].id
    secs.forEach(function (s) {
      var n = document.getElementById(s.id)
      if (n && n.getBoundingClientRect().top <= 80) cur = s.id
    })
    links.forEach(function (a) { a.classList.toggle('on', a.dataset.for === cur) })
  }
  window.addEventListener('scroll', sync, { passive: true })
  sync()

  // 点令牌名复制，省得手抄
  main.addEventListener('click', function (e) {
    var k = e.target.closest && e.target.closest('.k')
    if (!k) return
    navigator.clipboard && navigator.clipboard.writeText(k.textContent.trim())
    var old = k.textContent
    k.textContent = '已复制'
    setTimeout(function () { k.textContent = old }, 700)
  })
})()
