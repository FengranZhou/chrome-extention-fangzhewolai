# Pseudo-element Inspection（伪元素查看）

- Date: 2026-04-20
- Status: Draft · 待用户 review
- Plugin: Liaison（`liaison-patched`）
- Scope: 只读查看 `::before` / `::after`，并随 AI Prompt 一起导出

## 1. Why

Liaison 当前完全基于**真实 DOM 节点**工作——选元素 → 读 `getBoundingClientRect()` → 改 `element.style.*`。这导致一类常见场景失灵：

> 页面里**看起来是元素本身**的视觉（背景条、角标、分隔线、额外高度等），实际是通过 `::before` / `::after` 伪元素实现的。Liaison 选中真实元素后看到的样式与视觉对不上，AI Prompt 导出也丢失了这部分关键上下文——AI 拿到 Prompt 后会尝试修改真实元素，结果"改不到点上"。

典型例子（用户现场截图）：Ant Design `ant-tree-node-content-wrapper::before` 用 `height: 40px !important; background: var(--bg-gray) !important` 撑起了整行背景。用户在 Liaison 里选中 span，只能看到 span 的 0 height 样式，无从下手。

## 2. Scope

### 2.1 In Scope

- 面板（`liaison-panel`）下方新增 `::before` / `::after` 两个折叠段，展示过滤后的关键 CSS 属性
- 鼠标悬停折叠段中某条属性时，在画布上绘制虚线框高亮该伪元素的真实矩形区域（类似 Chrome DevTools 的行为）
- Prompt 导出函数在序列化选中元素时，自动附加非默认伪元素样式块

### 2.2 Out of Scope（明确不做）

- **不支持编辑伪元素样式**（需要注入 CSS rule，属于高复杂度工程，未来单独迭代）
- **不支持其他伪元素**：`::first-letter`、`::selection`、`::placeholder`、`::marker` 等暂不处理
- **不展示 computed styles 全量**：只展示定义好的"关键属性清单"
- **不解析 `!important` 冲突 / 层叠来源**：只读最终 computed value
- **不做面板 Tab 化切换**（用户决策已排除）

## 3. Feature Spec

### 3.1 属性允许清单（Allowlist）

固定展示以下属性（共 21 条），按分组顺序显示：

```
[内容]       content
[布局]       display, position, top, right, bottom, left, z-index
[尺寸]       width, height
[盒模型]     margin, padding, border
[外观]       border-radius, background, color, opacity
[文字]       font-size, font-weight
[变换]       transform
[交互]       pointer-events
```

**过滤规则**：只要**该属性的 computed value 等于浏览器默认值**，就隐藏该条目。典型默认值：

| 属性 | 隐藏条件 |
|---|---|
| `content` | `"none"` |
| `display` | `"inline"`（伪元素默认值） |
| `position` | `"static"` |
| `top/right/bottom/left` | `"auto"` |
| `z-index` | `"auto"` |
| `width/height` | `"auto"` 或 `"0px"` |
| `margin/padding` | `"0px"` |
| `border` | 0 宽度或 `"none"` |
| `border-radius` | `"0px"` |
| `background` | `"rgba(0,0,0,0)"` 且 `background-image: none` |
| `color` | 继承自父元素时不显示（与 parent 的 color 相同） |
| `opacity` | `"1"` |
| `transform` | `"none"` |
| `pointer-events` | `"auto"` |

**整段隐藏条件**：若该伪元素的 `content` 计算值为 `"none"`（即浏览器未真正创建伪元素），则**整个折叠段不展示**。

### 3.2 面板 UI

在 `liaison-panel` 当前样式区下方追加：

```
┌────────────────────────────────┐
│ ...（现有元素样式区）            │
├────────────────────────────────┤
│ ▸ ::before            3 props  │   ← 折叠/展开头，右侧显示属性条数
└────────────────────────────────┘
```

**展开后**：

```
│ ▾ ::before            3 props  │
│   content     ""               │
│   height      40px             │
│   background  var(--bg-gray)   │   ← hover 此行触发画布高亮
└────────────────────────────────┘
```

**交互**：

- 点击折叠头展开/收起（默认**收起**，不占太多空间）
- hover 任意属性行 → 画布绘制 `liaison-pseudo-highlight`
- 离开属性行 → 高亮消失
- 点击属性值 → 复制到剪贴板（复用 Liaison 已有的复制工具函数；如果没有就新建一个简单 `navigator.clipboard.writeText`）

**仅展示有内容的伪元素**：若 `::before` 或 `::after` 的 `content` 计算值为 `"none"`，**该折叠段完全不出现**（不显示 empty state）。两个都没有时，面板中看不到任何 pseudo 相关区块——保持干净。

### 3.3 画布高亮（`liaison-pseudo-highlight`）

新建 Custom Element，Shadow DOM 结构：

```html
<liaison-pseudo-highlight>
  #shadow-root
    <div class="outline"></div>
    <div class="label">::before</div>
</liaison-pseudo-highlight>
```

**样式**：

- `position: fixed`，脱离文档流
- 外框虚线：`border: 1.5px dashed #4a9eff`（区别于 Liaison 已有的实线选择框）
- 角落标签：小徽章 `::before` 或 `::after`，白底蓝字
- `pointer-events: none`，不拦截用户交互
- `z-index`: 比 `liaison-handles` 高 1（查看时需要能盖过选择框，但低于 toolbar）

**定位计算**（核心难点）：

```js
function getPseudoRect(el, pseudo) {
  const cs = getComputedStyle(el, pseudo)
  const elRect = el.getBoundingClientRect()
  const position = cs.position

  if (position === 'absolute' || position === 'fixed') {
    // 取该伪元素的 offset parent（已定位祖先）
    // 由于 pseudo 的 offsetParent 无法直接访问，用最近 position !== static 的祖先近似
    const anchor = findPositionedAncestor(el) || document.documentElement
    const ar = anchor.getBoundingClientRect()
    return {
      left: ar.left + parsePx(cs.left),
      top:  ar.top  + parsePx(cs.top),
      width:  parsePx(cs.width)  || elRect.width,
      height: parsePx(cs.height) || elRect.height,
    }
  }

  // static / relative：伪元素在 flow 中。近似取 el 的 rect 作为覆盖区域
  return {
    left: elRect.left,
    top:  elRect.top,
    width:  parsePx(cs.width)  || elRect.width,
    height: parsePx(cs.height) || elRect.height,
  }
}
```

**已知精度限制**（spec 里声明，不伪装完美）：

- `::before` 与后续兄弟元素的 flow 顺序在 static/relative 下无法精确推算。MVP 只在 `position: absolute/fixed` 时提供准确定位，其他情况**近似**画在宿主元素 rect 上
- 若伪元素使用 `transform`、`flex` 参与布局，定位会有偏差——这是已知 tradeoff，不在本期解决

### 3.4 Prompt 导出扩展

定位 Liaison 现有的"序列化选中元素 → 结构化 prompt"函数，在元素样式段后追加伪元素块。

**格式**（遵循 Liaison 现有 prompt 风格）：

```
Element: <span class="ant-tree-node-content-wrapper">
Styles:
  height: auto
  padding: 0
  color: rgb(33, 33, 33)

::before:
  content: ""
  height: 40px
  background: var(--bg-gray)

::after:
  (no content)  ← 若 ::after 有非默认样式则列出，否则整段省略
```

**规则**：

- 使用与面板**同一份** Allowlist + 默认值过滤逻辑，保证一致性
- 两个伪元素都无非默认样式时，整个 pseudo 块不出现在 prompt 里
- 只在**最内层选中元素**上输出（不对所有祖先循环，避免 prompt 膨胀）

## 4. Architecture / Integration

### 4.1 代码组织

由于 `toolbar/bundle.min.js` 是 624KB 压缩代码，**不做反压缩重构**。改动分三层：

**Layer 1 — 新独立模块（纯新增，不碰旧代码）**

创建 `toolbar/pseudo-inspect.js`（普通 JS 文件，非模块），内含：

- `PSEUDO_ALLOWLIST`（属性清单常量）
- `PSEUDO_DEFAULTS`（默认值判断表）
- `getPseudoStyles(el, pseudo)` → 返回过滤后的 `[{prop, value}]`
- `renderPseudoSection(el)` → 返回 DOM 片段，供面板挂载
- `LiaisonPseudoHighlight` Custom Element 定义 + `customElements.define()`
- `serializePseudoStylesForPrompt(el)` → 返回附加到 prompt 的字符串
- 暴露到 `window.__liaisonPseudo`（命名空间）供后续 patch 点调用

在 `manifest.json` 暂**不新增文件**——把它作为 inject 阶段的附加脚本。具体做法：修改 `toolbar/inject.js`，注入 bundle.css 后追加注入 pseudo-inspect.js。

**Layer 2 — bundle.min.js 补丁点（最小侵入）**

定位并修改以下锚点（具体字符串以实际代码为准）：

1. **面板渲染**：在 `liaison-panel` 的渲染/更新函数返回前，找一个 hook 点调用 `window.__liaisonPseudo.renderPseudoSection(target)` 并挂到面板末尾。
   - 锚点线索：`xs(l.target)` 这个 meta 构造处（已在 grep 中定位，line 176 around @16836）
2. **Prompt 导出**：在序列化选中元素的 styles 块之后，拼接 `window.__liaisonPseudo.serializePseudoStylesForPrompt(el)` 的返回值。
   - 锚点需在 bundle 中进一步定位（grep 关键字：`Styles:` 或 `getComputedStyle` 的导出端），作为实现计划的第一个任务

**Layer 3 — inject.js 改动**

`toolbar/inject.js` 当前只是注入 bundle。改为：

```js
// 先注入新模块，后注入 bundle（让 window.__liaisonPseudo 先就绪）
const s1 = document.createElement('script')
s1.src = chrome.runtime.getURL('toolbar/pseudo-inspect.js')
document.documentElement.appendChild(s1)
// ...原有 bundle 注入
```

`manifest.json` `web_accessible_resources` 已经是 `toolbar/*`，新文件自动可访问，无需改。

### 4.2 数据流

```
用户选中元素
  ↓
liaison-panel 触发 render(target)
  ↓
[新] renderPseudoSection(target) → 返回折叠段 DOM → 挂到 panel 末尾
  ↓
用户 hover 折叠段内某行
  ↓
[新] 创建 <liaison-pseudo-highlight>，计算 rect 并定位
  ↓
用户离开 / 切换选中元素
  ↓
[新] 移除 highlight
```

```
用户点击"导出 Prompt"
  ↓
原有序列化逻辑生成 prompt 文本
  ↓
[新] serializePseudoStylesForPrompt(target) 返回非空时拼到元素段后
  ↓
输出 prompt
```

### 4.3 与已有补丁的关系

`bundle.min.js.bak*` 共 15+ 个历史快照反映了这个 bundle 长期靠打补丁迭代。本次改动**遵循同样的打补丁模式**，但：

- 主逻辑放到 `pseudo-inspect.js` 独立文件中，方便未来 review / 调试 / 撤销
- 打到 bundle 上的补丁点**尽可能短**——只做"调用外部暴露的函数"的胶水
- 这样即便下次 bundle 再被重新打包，patch 也只需要重新定位两个锚点，不需要重做功能本体

## 5. Edge Cases

| Case | 处理 |
|---|---|
| 页面有 `<iframe>`，选中跨域 iframe 内元素 | 已是 Liaison 现有限制，本期不变 |
| 元素 `display: none` 但仍有 `::before` | `getComputedStyle` 仍能读到，照常展示；但 rect 为 0，高亮不绘制（skip） |
| `::before` 的 `content` 是 `attr(data-x)` 这种函数值 | 直接原样显示函数表达式文本 |
| 用户同时选中多个元素 | 本期只对**最后一个选中的元素**展示伪元素段，避免面板炸裂 |
| 伪元素 computed `position: absolute` 但祖先全 `static` | `findPositionedAncestor` 回落到 `<html>`，高亮可能偏，打日志但不报错 |
| bundle 被用户更新 / 二次打包后锚点失效 | 补丁注入前做字符串探测，找不到锚点则 console.warn 并跳过——**不要让功能崩溃波及原有 Liaison** |

## 6. 验证方式

1. **手工测试页面**：用户的原始场景（`ant-tree-node-content-wrapper::before` height 40px 背景）必须能正确显示 + 高亮到位
2. **退化测试**：选中一个完全没有伪元素的普通 `<div>`——面板应**看不到**伪元素段，prompt 导出也不该带这块
3. **Prompt 回路测试**：把导出的 prompt 粘给 AI，AI 应能理解"要改的是 ::before 的 height"而不是元素本身
4. **Chrome 开发者模式**手动加载扩展即可，无构建流程

## 7. 非功能要求

- 新模块单文件 **< 300 行**，可读
- 对 bundle 的补丁**不增加** `.bak*` 备份（改用 git 版本管理——见 §9）
- 不引入任何第三方依赖

## 8. 实现顺序（给 writing-plans 用）

1. 在 bundle 中定位 prompt 导出函数的锚点（grep + 读 120-200 字符上下文）
2. 写 `pseudo-inspect.js` 独立模块（Allowlist、过滤、渲染、高亮、prompt 序列化）
3. 改 `inject.js`，让其注入新脚本
4. 在 bundle 的两个锚点插入调用胶水
5. 手动加载扩展验证用户截图场景
6. 退化验证 + prompt 回路验证

## 9. 仓库维护建议（与功能无关但建议一起做）

项目目前不在 git 下，`.bak*` 文件 10MB，属于脏状态。建议先 `git init` → 首次 commit → 删除所有 `.bak*`（见之前对话）。**这不是本 spec 的交付内容**，但在开始实现前完成会让后续任何改动都可回滚，避免继续堆积 `.bak`。
