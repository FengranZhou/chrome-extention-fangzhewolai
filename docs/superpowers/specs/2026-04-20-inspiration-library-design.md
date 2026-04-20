# Inspiration Library · Design Spec (V0)

Date: 2026-04-20
Status: Approved for V0 implementation

## 1. 目标

让设计师在浏览任意网页时一键采集"好看的元素"入个人库，并能在 Liaison 编辑自己稿子时，把库里的样式一键套到目标元素上。

把 Liaison 从"页面编辑器"扩展为"**灵感 → 实现**"的完整链路。

## 2. V0 范围

### 2.1 包含

- **采集**：新增 `collect` 工具模式（与 design/ruler/comment 平级），点击任意元素入库
- **存储**：`chrome.storage.local` 持久化，key = `liaison.inspiration.library`
- **库面板**：Liaison 侧栏新增"灵感库" tab（与"样式"、"代码"平级）
- **套用**：库卡片点击 → "应用样式" → 把采集时的 computed style 白名单写入当前选中元素的 inline style
- **删除**：库卡片右上角 × 删除单条

### 2.2 不包含（V0 明确不做）

- ❌ 缩略图渲染（只展示来源 URL + tagName + 时间）
- ❌ 资源内联（不抓图片/字体的 base64；若采集元素有 `background-image: url(...)`，V0 保留原 URL，跨域失效时用户自己处理）
- ❌ AI 自动打标签
- ❌ 搜索 / 过滤 / 收藏夹分类
- ❌ Apply 的 "structure + style" 模式（V0 只有"仅样式"）
- ❌ 云端同步（纯本地）
- ❌ Prompt 导出集成
- ❌ 多子元素结构的样式（只套**根元素**的 computed style，子元素样式 V1 再做）

## 3. 数据结构

```ts
type Snapshot = {
  id: string;              // "insp-" + random 8 chars
  capturedAt: number;      // Date.now()
  source: {
    url: string;           // 来源页 URL
    title: string;         // document.title
    hostname: string;      // 提取自 url
  };
  element: {
    tagName: string;       // "BUTTON" / "DIV" / "ARTICLE" ...
    className: string;     // className.trim() 前 120 字符
    textPreview: string;   // innerText 前 40 字符
  };
  style: Record<string, string>;  // 白名单 computed style（见 §5）
};

type Library = {
  version: 1;
  snapshots: Snapshot[];
};
```

**存储 key**：`liaison.inspiration.library`
**预估大小**：每条 2-5 KB；1000 条 < 5 MB，默认配额内

## 4. 交互流

### 4.1 采集流程

1. 用户在任意页面激活 Liaison（Alt+Shift+D）
2. 工具栏切换到 `collect` 工具（新增一个图标）
3. 鼠标 hover 时元素描红（复用现有 hover-highlight）
4. 点击 → 弹 toast："已收藏 1 项到灵感库"
5. 元素**不**变成选中态（和 design 工具的点击选中区分开）

### 4.2 套用流程

1. 用户打开**自己的**稿子，激活 Liaison
2. 用 design 工具选中一个元素 E
3. 点顶部"灵感库"tab → 展示卡片列表（最新在上）
4. 点一张卡片 → 展开为两个按钮：「应用样式」「删除」
5. 点「应用样式」 → 采集时记录的 style 对象被逐项写成 E.style.xxx 的 inline style
6. 弹 toast："样式已应用到 <div.xxx>"

### 4.3 删除

卡片展开后点「删除」→ 无二次确认（V0 用 undo toast 代替）

## 5. computed style 白名单

只采集视觉相关属性，避免 layout 污染。

```
color, background-color, background-image, background-size, background-position, background-repeat,
border-radius, border-top-left-radius, border-top-right-radius, border-bottom-left-radius, border-bottom-right-radius,
border, border-width, border-style, border-color,
padding, padding-top, padding-right, padding-bottom, padding-left,
margin-top, margin-right, margin-bottom, margin-left,
font-family, font-size, font-weight, font-style, line-height, letter-spacing, text-align, text-decoration, text-transform,
box-shadow, opacity, filter, backdrop-filter,
display, flex-direction, justify-content, align-items, gap,
width, height  /* V0 含 width/height 让套用更直观，若扰乱布局 V1 改白名单 */
```

排除：`position`, `top/left/right/bottom`, `z-index`, `transform` 起点相关（避免把参考的定位信息强加到你稿子）。

## 6. 架构

```
┌──────────────────────────────────────────┐
│  bundle.min.js (Liaison 主逻辑)            │
│                                            │
│  + 工具模式扩展: "collect"                 │
│  + 侧栏 tab 扩展: "灵感库"                 │
│  + renderInspirationPanel()                │
│  + applyInspirationSnapshot(el, snap)     │
└──────────────┬─────────────────────────────┘
               │ 调用
               ▼
┌──────────────────────────────────────────┐
│  window.__liaisonInsp (IIFE helpers)      │
│  — 挂在 bundle 头部，独立闭包              │
│                                            │
│  .capture(el)     → Promise<Snapshot>     │
│  .list()          → Promise<Snapshot[]>   │
│  .delete(id)      → Promise<void>         │
│  .add(snap)       → Promise<void>         │
└──────────────┬─────────────────────────────┘
               │ 读写
               ▼
┌──────────────────────────────────────────┐
│  chrome.storage.local                     │
│  key: liaison.inspiration.library         │
└──────────────────────────────────────────┘
```

## 7. 技术决策

### 7.1 为什么不用 MutationObserver 追踪被采集元素

MVP 只需要快照。动态更新超出 V0 范围。

### 7.2 为什么 computed style 用白名单而非全量

`getComputedStyle(el)` 返回 400+ 个属性，全量粘过去会污染 layout、产生循环引用、拖慢面板渲染。白名单只含视觉维度。

### 7.3 为什么存 DOM 文本预览而非完整 outerHTML

V0 库卡片只需展示用途标识（"BUTTON · 课堂预约"），不需要重构 DOM。V1 加"结构套用"模式时再加。

### 7.4 存储隔离

每个 Chrome profile 独立；同一用户跨设备不同步（V0）。`chrome.storage.sync` 10KB/项上限太严，不合适。

## 8. UI 改动位置（bundle.min.js）

| 位置 | 改动 |
|------|-----|
| bundle 头部 | 新增 `window.__liaisonInsp` IIFE（类似现有 `__liaisonNeg`） |
| 工具栏 tool 列表 | 增加 `collect` 选项 |
| 侧栏 tabs 渲染 | "样式/代码" → "样式/代码/灵感库" |
| panel render switch | 新增 `renderInspirationLibraryPanel()` |
| click handler | collect 模式下点击元素调 `__liaisonInsp.capture` |
| "应用样式" 按钮 handler | 遍历 snapshot.style 写 inline style |

具体锚点在 plan 阶段用 grep 确定。

## 9. 验证方案

### 9.1 手动 E2E

1. 装扩展 → 打开任意网页（如 xiaohongshu.com）
2. 切 collect 工具 → 点一个卡片 → toast 提示入库
3. 打开 test fixture（灵感-playground.html） → 切 design → 选一个空 div
4. 切灵感库 tab → 看到刚才采集的那条 → 点"应用样式"
5. 空 div 应该立刻呈现出采集源的视觉风格

### 9.2 Node 单元测试

- `window.__liaisonInsp.capture(el)` 的 snapshot 结构校验
- 白名单过滤正确（不包含 position 等排除项）
- `chrome.storage.local` 行为用 mock 代替

## 10. 风险 & 回退

| 风险 | 处理 |
|------|-----|
| bundle tab 渲染逻辑耦合深，加第三个 tab 可能破坏样式 | Plan 阶段先 grep 验证 tab 架构；必要时降级为"弹窗 Library"不走 tab |
| computed style 在某些 pseudo / flex / grid 上下文里套过去会塌 | 白名单先保守，V0 发布后收集反馈再调 |
| chrome.storage.local 写入失败（超配额） | 捕获异常 → 提示用户清理老数据 |

回退：`bundle.min.js.bak_inspiration` 备份；`chrome.storage.local.remove('liaison.inspiration.library')` 清数据。

## 11. V1 预备（不属于 V0，但 V0 要预留空间）

- 缩略图：用 `chrome.tabs.captureVisibleTab` + 裁剪
- AI 打标签：Snapshot 加 `tags: string[]` 字段（V0 已预留类型）
- 结构套用：Snapshot 加 `html: string` 字段
- Prompt 导出集成：Liaison 现有 export 路径里加参考注入
- 搜索：本地纯前端 fuzzy match

## 12. 成本估计

- 代码量：V0 约 300-500 行（新增 IIFE 约 150 行 + bundle patch 约 100 行 + panel 渲染模板约 100 行）
- 工期：集中 1 天可完
