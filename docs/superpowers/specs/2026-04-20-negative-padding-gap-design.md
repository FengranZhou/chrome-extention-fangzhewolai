# Negative padding / gap support — Design

Date: 2026-04-20
Status: Approved, pending implementation plan

## 1. 目标

让 Liaison 面板里的 `margin` / `padding` / `gap` 控件能输入负数，并且页面上**看得到**负值效果（而非仅写入 inline style 被浏览器忽略）。

`margin` 在数据层已支持负值（现有 `br(…,{allowFloat:!0})` 无 `min:0`），本次改造主要解决 **padding** 和 **gap**。

## 2. 需求

| 控件 | 现状 | 目标 |
|------|------|------|
| `margin-{top/right/bottom/left}` | 已支持负值 | 保持；只要排查 UI 层无 input `min=0` 拦截（见 §12） |
| `padding-{top/right/bottom/left}` | 数据层 clamp `min:0`；浏览器对负 padding 也会忽略 | 输入可负，负值通过等效机制落到渲染 |
| `gap`（单值） | 数据层 clamp `min:0`；浏览器对负 gap 也会忽略 | 输入可负，负值通过等效机制落到渲染 |

## 3. 非目标（YAGNI）

- **不**拆分出独立的 `row-gap` / `column-gap` 控件。扩展当前 UI 只有单值 `gap`，保持不变；负值时行列对称应用（与正值 `gap` 行为对称）。
- **不**处理 grid 2D 中"第 N 行第 M 列首子元素"这种精细定位（CSS 无法在不加类的情况下区分，见 §10）。
- **不**引入 MutationObserver 侦听动态子元素 —— 方案基于 CSS 选择器，天然对动态子元素生效，无需 JS 观察。
- **不**处理 `padding` / `gap` 以百分比或 `calc()` 形式输入的负值（扩展当前 UI 仅支持 px）。
- **不**修改 DOM 结构（不插 wrapper、不改子元素 inline style）。

## 4. 架构总览

```
┌─────────────────────────────────────────────┐
│ Liaison 面板（用户输入 -Npx）               │
└──────────────────┬──────────────────────────┘
                   │ dispatch
                   ▼
┌─────────────────────────────────────────────┐
│ bundle.min.js 写入路径 switch-case           │
│   case "paddingTop" / "layoutGap" / …        │
└──────────────────┬──────────────────────────┘
                   │ n<0 ?
          ┌────────┴────────┐
          ▼                 ▼
  正值：e.style.x=Npx   负值：e.style.x=0
                         + liaisonNegSet(e,key,|N|)
                                │
                                ▼
            ┌──────────────────────────────────┐
            │ Registry: Map<uuid, NegState>    │
            │  NegState = {pt,pr,pb,pl,gap,    │
            │              layoutMode}         │
            └──────────────────┬───────────────┘
                               │ renderNegStyles()
                               ▼
            ┌──────────────────────────────────┐
            │ <style id="liaison-neg-styles">  │
            │  [data-liaison-neg="X"]{…}       │
            │  [data-liaison-neg="X"] >        │
            │     *:first-child{margin:-Npx!…} │
            └──────────────────────────────────┘
```

核心不变量：
- **目标元素** 只承担 `data-liaison-neg="uuid"` 属性 + `padding/gap` 归零（正值）；不写负值 inline style。
- **子元素** 完全不被 JS 触碰；负 margin 效果通过注入的 `<style>` 规则下沉。
- **Registry** 是唯一事实源；`<style>` 节点每次全量 rebuild（简单可靠）。

## 5. 核心数据结构

```js
// 全局闭包内（挂到 window.__liaisonNeg 便于 bundle 内外调用）
const registry = new Map()
// key:   uuid string (e.g. "a3f9k2")
// value: NegState

// NegState:
// {
//   pt:  number,   // 绝对值（px），0 表示未设置
//   pr:  number,
//   pb:  number,
//   pl:  number,
//   gap: number,
//   layoutMode: 'block' | 'flex-row' | 'flex-col' | 'grid'
// }
```

`layoutMode` 在每次 `liaisonNegSet` 时基于 `getComputedStyle(el)` 重算并缓存到 NegState（下次 render 用）。

UUID 生成：`'neg-' + Math.random().toString(36).slice(2, 10)`（不用 `crypto.randomUUID`，避免老浏览器/file:// 场景兼容问题，且无需安全强度）。

## 6. CSS 规则生成器（核心映射表）

所有规则都带 `!important`，选择器形如 `[data-liaison-neg="X"]`。

### 6.1 padding 映射（按 layoutMode 分支）

| 负值 | block / flex-col | flex-row | grid |
|------|-----------------|----------|------|
| `pt: -N` | `> *:first-child { margin-top: -N }` | `> * { margin-top: -N }` | `> * { margin-top: -N }` |
| `pb: -N` | `> *:last-child { margin-bottom: -N }` | `> * { margin-bottom: -N }` | `> * { margin-bottom: -N }` |
| `pl: -N` | `> * { margin-left: -N }` | `> *:first-child { margin-left: -N }` | `> * { margin-left: -N }` |
| `pr: -N` | `> * { margin-right: -N }` | `> *:last-child { margin-right: -N }` | `> * { margin-right: -N }` |

**语义解释**：padding 等效于"父级内容框向外扩"。
- 块轴（竖向）起始/终止边 → 在块轴上只影响第一个 / 最后一个子元素
- 行内轴（横向）边 → 在块轴布局下所有子元素都受影响（因为它们各自从左边开始排）；在行轴布局下只有首/末子元素

grid 2D 无法用纯选择器区分"第 N 行"，采用**保守退化**：所有子元素都施加负 margin（等价于父级整体偏移）。

### 6.2 gap 映射（单值对称，应用到两个轴）

gap 是"子元素之间的间距"。对 `gap: -N`（单值，扩展 UI 统一出口），按 `layoutMode` 应用：

| `layoutMode` | 生成规则 |
|-------------|---------|
| flex-row | `> *:not(:first-child) { margin-left: -N }` |
| flex-col | `> *:not(:first-child) { margin-top: -N }` |
| grid | `> *:not(:first-child) { margin-left: -N; margin-top: -N }` |
| block | `> *:not(:first-child) { margin-top: -N }`（退化为"子元素之间垂直重叠"，与块流方向一致） |

### 6.3 示例输出

用户对 `<div class="card">` 设 `padding-top: -8, gap: -12`，display=flex-col：

```css
[data-liaison-neg="a3f9k2"] > *:first-child { margin-top: -8px !important; }
[data-liaison-neg="a3f9k2"] > *:not(:first-child) { margin-top: -12px !important; }
```

元素上标记：`<div class="card" data-liaison-neg="a3f9k2" style="padding-top: 0px; gap: 0px;">`

## 7. 写入路径改造（bundle.min.js）

目标改动位置（基于当前 grep 位置定位，实际由 plan 阶段落到具体字符区间）：

### 7.1 padding 写入（~line 12, col 253764）

```js
// BEFORE
case "paddingTop": case "paddingRight": case "paddingBottom": case "paddingLeft": {
  const o = br(n, { min: 0 });
  return null !== o && (e.style[t] = `${o}px`, !0);
}

// AFTER
case "paddingTop": case "paddingRight": case "paddingBottom": case "paddingLeft": {
  const o = br(n, {});
  if (null === o) return !1;
  const k = { paddingTop:'pt', paddingRight:'pr', paddingBottom:'pb', paddingLeft:'pl' }[t];
  if (o < 0) { e.style[t] = '0px'; window.__liaisonNeg.set(e, k, -o); }
  else       { e.style[t] = `${o}px`; window.__liaisonNeg.set(e, k, 0); }
  return !0;
}
```

### 7.2 gap 写入（~line 12, col 254776）

```js
// BEFORE
case "layoutGap": {
  const t = br(n, { min: 0 });
  return null !== t && (e.style.gap = `${t}px`, !0);
}

// AFTER
case "layoutGap": {
  const v = br(n, {});
  if (null === v) return !1;
  if (v < 0) { e.style.gap = '0px'; window.__liaisonNeg.set(e, 'gap', -v); }
  else       { e.style.gap = `${v}px`; window.__liaisonNeg.set(e, 'gap', 0); }
  return !0;
}
```

## 8. 读取路径改造

### 8.1 padding / gap 读取（~line 12, col 248350）

```js
// BEFORE
layoutGap:    br(ae(e,"gap"),           { min:0 }) || 0,
paddingTop:   br(ae(e,"paddingTop"),    { min:0 }) || 0,
paddingRight: br(ae(e,"paddingRight"),  { min:0 }) || 0,
paddingBottom:br(ae(e,"paddingBottom"), { min:0 }) || 0,
paddingLeft:  br(ae(e,"paddingLeft"),   { min:0 }) || 0,

// AFTER
layoutGap:     window.__liaisonNeg.read(e, 'gap', ae(e,"gap")),
paddingTop:    window.__liaisonNeg.read(e, 'pt',  ae(e,"paddingTop")),
paddingRight:  window.__liaisonNeg.read(e, 'pr',  ae(e,"paddingRight")),
paddingBottom: window.__liaisonNeg.read(e, 'pb',  ae(e,"paddingBottom")),
paddingLeft:   window.__liaisonNeg.read(e, 'pl',  ae(e,"paddingLeft")),
```

`read(e, key, rawCssValue)` 语义：
- 若元素有 `data-liaison-neg` 且 registry 中该 key > 0 → 返回 `-value`（展示为负数）
- 否则 → 用原 `br(rawCssValue, {}) || 0` 逻辑（允许正值）

### 8.2 margin 读取（保持不变）

`marginTop/marginRight/marginBottom/marginLeft` 现有 `br(...,{allowFloat:!0})||0` 已允许负数，不改。

## 9. 生命周期与初始化

### 9.1 `window.__liaisonNeg` API

```js
window.__liaisonNeg = {
  set(el, key, absValue) { /* 写入 registry + 重渲染 style */ },
  read(el, key, rawCssValue) { /* 读取优先级 registry → raw */ },
  // 内部
  _uuid(), _ensureStyleNode(), _renderAll(), _dropIfEmpty(el)
}
```

### 9.2 挂载时机

在 bundle.min.js 的**最开头**（IIFE 执行之前）插入一段独立 IIFE 初始化 `window.__liaisonNeg`。这样保证 bundle 里任何 case 代码执行前 API 已就绪。

### 9.3 StyleNode 懒创建

首次 `set` 且 value>0 时：
```js
let n = document.getElementById('liaison-neg-styles')
if (!n) {
  n = document.createElement('style')
  n.id = 'liaison-neg-styles'
  document.head.appendChild(n)
}
```

registry 变空时删除 `<style>` 节点。

### 9.4 元素销毁 / 页面卸载

不主动 GC。元素从 DOM 移除后，其 uuid 仍留在 registry，但对应选择器找不到元素，CSS 无副作用。下次 `set` 写入时通过 uuid 匹配。简单、无需 MutationObserver。

## 10. 边界情况与限制

| 情况 | 处理 |
|------|------|
| 用户切换 `display`（e.g. flex-row → flex-col） | 下次 `set` 时重算 `layoutMode`；老规则在 rebuild 时被覆盖 |
| 父元素 `overflow: hidden` | 负 margin 导致子元素溢出被裁剪，**用户自行负责**（与原生负 margin 行为一致）|
| 子元素已有 inline `margin` | 注入规则带 `!important`，优先级胜出；revert 后子元素回到原有 inline margin |
| 子元素是 `position:absolute` / `fixed` | 负 margin 对绝对定位子元素无效。用户感知为"没生效"，记入 §13 验证 checklist |
| 目标元素没有子元素 | 规则无匹配，无副作用；正值 padding 归零照样生效（虽然视觉没区别） |
| grid 2D 精细定位 | 退化为"所有子元素都施加负 margin"，不完美但可接受 |
| `display: contents` 子元素 | `> *` 选择器仍匹配，但 `margin` 对 `display:contents` 元素无效。已知限制 |
| 嵌套：父子都用本特性 | 各自独立 uuid 和 data-attr，`> *` 选择器只作用于直接子元素，无交叉干扰 |
| 页面 SPA 切路由 | registry 在内存中存活；若目标元素被销毁重建，uuid 仍在，但新元素没有 data-attr，需用户重新操作。可接受 |

## 11. 对 Prompt Export 的影响

扩展的核心功能是把修改"导出为给 AI 的 Prompt"。

**策略**：**显示意图，不显示实现**。即 prompt 中继续展示 `padding-top: -8px; gap: -12px;`（用户输入了什么就导出什么），**不暴露** `<style id="liaison-neg-styles">` 的内容 / `data-liaison-neg` 属性。

理由：
- 意图明确，AI 更好消费
- `data-liaison-neg` 是实现细节，不应泄漏到交付产物
- AI 收到 `padding: -8px` 后自会按标准做法实现（如直接用负 margin）

**实现要点**：export 逻辑走的是 §8 的读取路径 —— registry 已还原为负值，现有 export 逻辑无需改造。只需确认 export 时**不**把 `data-liaison-neg` 属性当作 diff 的一部分输出（grep 验证没有通用 `outerHTML` 导出即可）。

## 12. 实现落地步骤（概览，细节由 plan 文档承接）

1. **备份**：`cp bundle.min.js bundle.min.js.bak_neg_padding`
2. **插入 helpers**：在 bundle 最前面注入一段 IIFE，定义 `window.__liaisonNeg = {...}`
3. **Patch 写入路径 × 2 处**：padding case（§7.1）+ layoutGap case（§7.2）
4. **Patch 读取路径 × 5 行**：padding 4 + gap 1（§8.1）
5. **排查 UI input `min=0` 拦截**：grep bundle 内 `min="0"`、`minimum:0`、`<input[^>]+min`，必要时一并放开（margin 可能需要此步）
6. **验证**：§13

## 13. 验证方案（E2E）

**测试页面**：一个简单 HTML，含 3 种典型场景：
- block 容器 + 3 个块级子元素
- flex-row 容器 + 3 个子元素，显式 gap
- grid 容器 2×2

**测试矩阵**（每个场景都做）：

| # | 操作 | 预期 |
|---|------|------|
| 1 | 面板改 padding-top = -10 | `<style>` 里出现对应规则；首（或全部，按 layoutMode）子元素视觉上移 10px |
| 2 | 面板改 padding-top = 0 | 对应规则消失；若所有 key 都为 0，`data-liaison-neg` 属性也被删除 |
| 3 | 面板改 padding-top = 5（正值） | style 节点里无负规则；`e.style.paddingTop = 5px` 正常生效 |
| 4 | 改 gap = -8 | 子元素间距重叠；符合 §6.2 表格对应行为 |
| 5 | 改 margin-top = -10 | 直接写 inline style，无 `<style>` 注入 |
| 6 | 同时 padding-top = -5 和 gap = -10 | 两条规则共存，各自生效 |
| 7 | reload 页面 | registry 清空，状态归零（预期行为：负值修改不持久化，和其他 local modifications 同级） |
| 8 | 切换 `display` 后再改负 padding | 规则按新 layoutMode 生成 |
| 9 | Prompt export | 输出 `padding-top: -5px` 字样，不包含 `data-liaison-neg` 或 `<style>` 内容 |

## 14. 回滚方案

bundle 修改仅限单文件 patch + 一段 IIFE 前置插入。若出问题：

```bash
cd toolbar
mv bundle.min.js.bak_neg_padding bundle.min.js
```

恢复后扩展行为完全回到改造前。registry 是内存数据，重新加载后自动消失，无持久污染。

---

## 附：与 margin 的一致性

本方案**不改** margin 相关代码路径。验证时需确认：

1. margin 输入框能接收 `-` 号（无 UI input `min=0`）
2. 输入负数后 `e.style.marginTop = -Npx` 正常生效
3. 读回面板显示负数

若发现 UI 层有 input `min` 拦截，§12 步骤 5 一并处理。
