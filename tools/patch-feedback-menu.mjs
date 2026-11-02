// 一次性补丁：工具条末尾加「更多」按钮（…）+ 下拉菜单，菜单里放「用户反馈」入口。
//
// 背景：bundle 里本来就有一套「更多」菜单的残骸 —— 开关逻辑（_moreOpen、
// [data-toolbar-more] 点击）、浮层定位（syncFloatingMoreMenu）、样式
// （moreMenu / moreMenuItem）、tooltip 文案（Us.more = 更多）都还在，
// 只是模板里的按钮和浮层被删了。所以这里尽量复用，只补缺的部分：
//
//   ① 模板：冻结按钮之后加「…」按钮（独立 buttonWrapper，打 data-more-wrap）
//   ② 模板：浮层菜单 + 一段局部样式（收起态隐藏「…」，避免改变收起时的几何）
//   ③ 菜单项「用户反馈」点击 → 关菜单 + 派发 liaison-feedback-open（composed，
//      穿出 closed shadow），弹窗本体在 toolbar/feedback.js；顺带挂「点外面关菜单」
//   ④ 点「…」打开菜单时收掉 tooltip（tooltip 和菜单都在按钮同侧，会叠在一起）
//   ⑤ 菜单定位：残留的 syncFloatingMoreMenu 是旧横向工具条的上下弹出逻辑，
//      改成与 tooltip 一致的左右弹出（工具条在左 → 菜单在右，反之亦然），
//      菜单底边对齐按钮底边向上长 —— 「…」是最后一个按钮，往下长会出屏
//
// 弹窗、提交、上报都不在 bundle 里（S0 纪律：新功能写独立文件）。

import { readFileSync, writeFileSync } from 'node:fs'

const FILE = new URL('../toolbar/bundle.min.js', import.meta.url)
let src = readFileSync(FILE, 'utf8')
const before = src.length

const DOTS = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
  + '<circle cx="5.5" cy="12" r="1.5" fill="currentColor"/>'
  + '<circle cx="12" cy="12" r="1.5" fill="currentColor"/>'
  + '<circle cx="18.5" cy="12" r="1.5" fill="currentColor"/></svg>'

// ── ① 「…」按钮 ─────────────────────────────────────────────────────────
// 模板是压缩后的模板字符串，换行以字面量 \n 存在文件里，锚点要带上
const A1 = '${LiIcons.freeze}</button>\\n              </div>'
const G1 = '<div class="styles-module__buttonWrapper___rBcdv" data-more-wrap>'
  + '<button class="styles-module__controlButton___8Q0jc" data-toolbar-more data-tooltip-key="more" aria-label="更多">'
  + DOTS + '</button></div>'

// ── ② 浮层菜单 + 局部样式 ───────────────────────────────────────────────
// 放在 floatingTooltip 旁边：必须在 toolbarClip（overflow:hidden）外面，否则被裁
const A2 = '<div class="styles-module__floatingTooltip___Pz8nA" data-floating-tooltip></div>'
const G2 = '<div class="styles-module__moreMenu___B4n6V" data-floating-more-menu role="menu">'
  + '<button class="styles-module__moreMenuItem___P9m2f" data-more-feedback role="menuitem">用户反馈</button></div>'
  + '<style>[data-more-wrap]{margin-top:4px}'
  // 「…」常驻纯白（其余按钮默认 .7）；两个选择器权重与 :hover 持平、靠后出现，悬停也不回落
  + '.styles-module__controlButton___8Q0jc[data-toolbar-more]{color:#fff}'
  + '.styles-module__collapsed___Rydsn [data-more-wrap]{display:none}</style>'

// ── ③ 菜单项点击 + 点外面关菜单 ─────────────────────────────────────────
// 锚点后面是逗号表达式（`,this.$shadow.querySelectorAll("[data-tooltip-key]")`），
// 所以插入的也必须是「表达式 + 逗号」，不能是语句
const A3 = 'window.open(n,"_blank","noopener,noreferrer")})))),'
const G3 = 'this.$shadow.querySelectorAll("[data-more-feedback]").forEach((e=>e.addEventListener("click",(t=>{'
  + 't.preventDefault(),t.stopPropagation(),this._moreOpen=!1,this.syncStateToDom(),'
  + 'this.dispatchEvent(new CustomEvent("liaison-feedback-open",{bubbles:!0,composed:!0}))})))),'
  + '(this._moreOutside||(this._moreOutside=t=>{if(!this._moreOpen)return;'
  + 'const p=t.composedPath?t.composedPath():[];p.includes(this)||(this._moreOpen=!1,this.syncStateToDom())},'
  + 'document.addEventListener("pointerdown",this._moreOutside,!0))),'

// ── ④ 打开菜单时收 tooltip ──────────────────────────────────────────────
const A4 = 'this._moreOpen=!this._moreOpen,this.syncStateToDom()'
const R4 = 'this._moreOpen=!this._moreOpen,this._moreOpen&&(clearTimeout(this._tooltipShowTimer),this.hideFloatingTooltip()),this.syncStateToDom()'

// ── ⑤ 菜单左右弹出 ──────────────────────────────────────────────────────
const A5_START = 'const n=t.getBoundingClientRect(),o=this.getBoundingClientRect(),a="bottom"===this._dock.vertical?"top":"bottom"'
const A5_END = 'e.setAttribute("data-placement",a),e.setAttribute("data-visible","true")}'
const R5 = 'const n=t.getBoundingClientRect(),o=this.getBoundingClientRect(),a="left"===this._dock.vertical?"right":"left";'
  + 'e.style.left="right"===a?n.right-o.left+8+"px":n.left-o.left-8+"px",'
  + 'e.style.top=n.bottom-o.top+"px",'
  + 'e.style.transform="right"===a?"translateY(-100%)":"translate(-100%,-100%)",'
  + A5_END

const fail = (msg, ...args) => {
  console.error('✗ ' + msg + '。未写盘。', ...args)
  process.exit(1)
}
const once = (name, anchor) => {
  const n = src.split(anchor).length - 1
  if (n !== 1) fail('%s：锚点命中 %d 处（应为 1），bundle 结构可能已变', name, n)
}

const inserts = [
  { name: '「…」按钮', anchor: A1, guard: G1 },
  { name: '浮层菜单', anchor: A2, guard: G2 },
  { name: '菜单项点击', anchor: A3, guard: G3 },
]
for (const s of inserts) {
  if (src.includes(s.guard)) { console.log('· %s：已存在，跳过', s.name); continue }
  once(s.name, s.anchor)
  src = src.replace(s.anchor, () => s.anchor + s.guard)
  console.log('✓ %s', s.name)
}

if (src.includes(R4)) console.log('· 打开菜单收 tooltip：已存在，跳过')
else {
  once('打开菜单收 tooltip', A4)
  src = src.replace(A4, () => R4)
  console.log('✓ 打开菜单收 tooltip')
}

if (src.includes(R5)) console.log('· 菜单左右弹出：已存在，跳过')
else {
  once('菜单定位起点', A5_START)
  const i = src.indexOf(A5_START)
  const j = src.indexOf(A5_END, i)
  // 起止之间应当只是 syncFloatingMoreMenu 的定位体，过长说明匹配到了别处
  if (j < 0 || j - i > 600) fail('菜单定位：找不到结尾锚点或跨度异常（%d）', j - i)
  src = src.slice(0, i) + R5 + src.slice(j + A5_END.length)
  console.log('✓ 菜单左右弹出')
}

try {
  new Function(src)
} catch (e) {
  fail('改动后语法不合法：%s', e.message)
}

writeFileSync(FILE, src)
console.log('长度 %d → %d', before, src.length)
