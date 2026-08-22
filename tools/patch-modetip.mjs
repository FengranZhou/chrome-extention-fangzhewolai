// 一次性补丁：跟随光标的模式提示（liaison-mode-tip）在工具组收起时不该出现。
//
// 背景：bundle.min.js 是压缩产物且没有构建配置，历来直接改它 + 留 .bak。
// _want() 里已有一串「不该显示」的判定（浏览态 / 总览开着 / 已有选中…），
// 但漏了「工具组收起」这一态 —— 收起后工具已经退到一个小圆点，
// 光标旁还挂着「选择调整对象」等于在催用户做一件当前没有入口的事。
//
// 工具条是 closed shadow，_collapsed 只写在 shadow 内部，宿主元素上没有
// 外部可读标记。但 _want() 拿的是宿主实例（_s = 主控），_s.topToolbar 就是
// 工具条实例本身，能直接读它的 _collapsed 属性 —— 与该函数已有的
// _s.workspace_mode / _s.overviewOpen 是同一种跨界读法。
//
// 两处改动：
//   ① _want() 加收起判定 —— 管住「收起后移动光标不再弹」
//   ② setCollapsed 收起时主动隐藏 —— 管住「收起那一刻光标不动，已显示的
//      那条留在屏上」。_want() 只在 mousemove 时求值，光标静止就不会重算。

import { readFileSync, writeFileSync } from 'node:fs'

const FILE = new URL('../toolbar/bundle.min.js', import.meta.url)
let src = readFileSync(FILE, 'utf8')
const before = src.length

// ── ① _want() 里加收起判定 ────────────────────────────────────────────
// 锚点取 _want() 的第一条判定。补丁插在它之前 —— 收起是最外层的前提，
// 比「当前是哪个 tab」更早该被否掉。
const A1 = 'const _want=()=>{try{if("browse"===_s.workspace_mode)return null;'
const G1 = 'try{var _tb=_s.topToolbar;if(_tb&&_tb._collapsed)return null}catch(_){}'

// ── ② setCollapsed 收起时主动隐藏 ─────────────────────────────────────
// setCollapsed 在工具条类里，拿不到主控实例，所以走 window 上的钩子。
// 钩子由提示条那段自己挂（见 ③），这里只负责在收起时叫一声。
// 多条收起路径（点圆点 / 切浏览态 / 程序化）都汇到 setCollapsed，改这一处够了。
//
// ⚠️ 锚点必须落在**完整语句边界**上。第一版取的是 `this._collapsed=e`，
// 它后面紧跟的是逗号表达式（`,t.classList.toggle(…)`），在那里插一条
// try 语句会把后面的 `,` 变成悬空逗号 —— 整个 bundle 语法就废了。
// 换成这条 setAttribute 的结尾 `;`：那是干净的语句边界，且状态此刻已翻到收起。
const A2 = 'o.setAttribute("data-toolbar-count",e?"toggle":"overview");'
const G2 = 'try{if(e&&window.__liaisonHideModeTip)window.__liaisonHideModeTip()}catch(_){}'

// ── ③ 把隐藏钩子暴露到 window ─────────────────────────────────────────
// 原来它只挂在主控实例上（this.__liaisonHideModeTip），工具条类拿不到。
const A3 = '__liaisonHideModeTip=_off;'
const G3 = 'try{window.__liaisonHideModeTip=_off}catch(_){}'

const steps = [
  { name: '_want 收起判定', anchor: A1, guard: G1, place: 'after' },
  { name: 'setCollapsed 主动隐藏', anchor: A2, guard: G2, place: 'after' },
  { name: '钩子暴露到 window', anchor: A3, guard: G3, place: 'after' },
]

for (const s of steps) {
  if (src.includes(s.guard)) { console.log('· %s：已存在，跳过', s.name); continue }
  if (!src.includes(s.anchor)) {
    console.error('✗ %s：找不到锚点，bundle 结构可能已变。已完成的改动保留，未写盘。', s.name)
    process.exit(1)
  }
  // 只替第一处：这些锚点都应当唯一，多处命中说明锚点选得不够具体
  const n = src.split(s.anchor).length - 1
  if (n !== 1) {
    console.error('✗ %s：锚点命中 %d 处（应为 1），拒绝改动', s.name, n)
    process.exit(1)
  }
  src = src.replace(s.anchor, s.anchor + s.guard)
  console.log('✓ %s', s.name)
}

// 写盘前先验语法。bundle 是单行文件，`node --check` 失败时会把整行（近 900KB）
// 喷进 stderr，错误信息被淹没 —— 所以这里自己 new Function 验，只报错误本身。
// 验不过就不写盘，原文件保持可用。
try {
  new Function(src)
} catch (e) {
  console.error('✗ 改动后语法不合法，未写盘：%s', e.message)
  console.error('  常见原因：锚点落在逗号表达式中间，插入语句后逗号悬空。')
  process.exit(1)
}

writeFileSync(FILE, src)
console.log('长度 %d → %d', before, src.length)
