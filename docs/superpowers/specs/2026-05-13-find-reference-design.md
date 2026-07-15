# Find Reference · Design Spec (V0)

Date: 2026-05-13
Status: Approved for V0 implementation

## 1. 目标

让设计师在 Liaison 编辑自己页面时,选中一个不满意的模块,描述问题(例:"这块太单调"),一键生成结构化 prompt 复制到剪贴板,粘到 Claude Code,由 `找本地参考` skill **自动**从用户本地 Eagle 灵感库检索参考图、提炼视觉手法、输出代码改造方案。

把 Liaison 从"看到问题"扩展到"**问题 → 个人沉淀 → 落地代码**"的完整闭环。

## 2. 与现有 Inspiration Library(V0)的关系

| | Inspiration Library V0(2026-04-20) | Find Reference V0(本 spec) |
|---|---|---|
| 数据流 | 网页 → chrome.storage → 自己页面 | 自己页面 → 剪贴板 → CC + Eagle 库 |
| 灵感载体 | 元素的 computed style | 用户本地积累的图片库 |
| 落地方式 | 一键 apply CSS | CC 看图分析后改代码 |
| 用户做的最累的事 | 采集 + 套用 | **只提问题** |

两者**独立共存**,Tab 互不干扰。

## 3. V0 范围

### 3.1 包含

- **入口**: 浏览器**右键菜单**新增"找设计参考"项(任意元素上可用)
- **触发前提**: 无需先激活 Liaison,任意页面任意元素都能用(独立功能)
- **UI**: 点击菜单后弹出**独立 Shadow DOM modal**(textarea + 提交按钮)
- **输出**: 点"生成 Prompt"按钮 → 拼结构化 prompt → 写入剪贴板 → toast 提示
- **不动 Eagle**: 插件本身不调 Eagle API,所有检索/分析在 CC 侧由 skill 完成
- **不动 bundle**: 整个 V0 不修改 `toolbar/bundle.min.js`,与 Liaison 主功能完全解耦

### 3.1.1 为什么放弃"侧栏 tab"方案

- `bundle.min.js` 是 minified 单行密集代码(680 KB / 578 行),精确定位插入点风险高
- "找参考"和 Liaison 的"design / ruler / comment"工具是不同心智(前者一次性、后者持续编辑),硬塞 tab 反而 UX 不统一
- 右键菜单操作路径更短:右键 → 点菜单 → 写问题 → 复制(4 步) vs tab 切换 → 选元素 → 写问题 → 复制(5 步)
- 复用现有 `contextmenu/launcher.js` 的菜单注册模式,跟扩展现有架构一致

### 3.2 不包含(V0 明确不做)

- ❌ 插件内调 Eagle API 预览候选图(CC 端 skill 做这件事,插件不重复)
- ❌ 自动注入到 CC(只复制到剪贴板,用户手动粘贴)
- ❌ 多元素同时找参考(V0 只支持单选)
- ❌ Prompt 模板可配置(V0 硬编码模板)
- ❌ 历史问题记录(每次重新输入)
- ❌ 截图选中元素后送 CC(V0 只送 DOM+style 摘要,V1 加截图)
- ❌ 自动把 CC 输出的代码回灌页面(V0 用户自己改)

## 4. 数据/接口

### 4.1 选中元素信息提取(复用 `__liaisonInsp.capture` 的白名单逻辑)

```ts
type SelectedElementContext = {
  url: string;           // location.href
  title: string;         // document.title
  selector: string;      // 简化的 CSS selector(tagName + class 前 N 字符)
  tagName: string;
  textPreview: string;   // innerText 前 80 字符
  style: Record<string, string>;  // 复用 inspiration-library §5 白名单
};
```

### 4.2 生成的 Prompt 模板

```text
[使用 skill: 找本地参考]

[页面]
- URL: {url}
- 标题: {title}

[选中元素]
- 选择器: {selector}
- 内容预览: "{textPreview}"
- 关键样式:
  - color: {color}
  - background: {background-color}
  - padding: {padding}
  - font: {font-size} / {font-weight} / {line-height}
  - border-radius: {border-radius}
  - box-shadow: {box-shadow}
  - layout: {display} / {flex-direction} / {gap}
  - (省略未设置的项)

[我的问题]
{用户输入的一句话}

请按 `找本地参考` skill 的工作流执行:
1. 调 Eagle API 拿 folder 树
2. 语义匹配 1-3 个最相关 folder
3. 拉候选图,挑 3-5 张最匹配
4. Read 缩略图做视觉分析
5. 输出诊断 + 改造代码
```

## 5. 交互流

1. 用户在任意网页对**不满意的模块右键**(无需先激活 Liaison)
2. 浏览器弹原生菜单,有"找设计参考"项
3. 用户点击 → content script 弹出独立 modal,展示:
   - 顶部:右键元素的简要标识("DIV.card · 课堂预约")
   - 中部:textarea(placeholder: "哪里不满意?例:这块太单调、层级不清、配色平...")
   - 底部:按钮「生成 Prompt」(disabled 直到 textarea 非空)+「关闭」
4. 用户写问题描述 → 点按钮
5. JS:
   - 提取右键元素的上下文 → 拼 prompt 字符串
   - `navigator.clipboard.writeText(prompt)`
   - 关闭 modal,toast: "已复制,粘到 Claude Code"

**关键时序**:contextmenu DOM 事件先触发,我们在捕获阶段记录 `lastContextElement = e.target`;之后 background 的 `contextMenus.onClicked` 触发,向 content script 发 message,content script 用 `lastContextElement` 打开 modal。

## 6. 架构

```
┌──────────────────────────────────────────────┐
│  contextmenu/find-reference.js (新文件)        │
│  - 注册右键菜单 "找设计参考"                    │
│  - onClicked → tabs.sendMessage 到 content    │
└────────┬─────────────────────────────────────┘
         │ message: { action: 'OPEN_FIND_REF_MODAL' }
         ▼
┌──────────────────────────────────────────────┐
│  toolbar/inject.js (改动)                     │
│  + contextmenu 事件监听器:                    │
│      lastContextElement = e.target           │
│  + runtime.onMessage 路由 OPEN_FIND_REF_MODAL │
│      → 调用 openFindRefModal(lastEl)         │
│  + openFindRefModal:Shadow DOM modal         │
│      - textarea + 按钮                       │
│      - 提交时:extractContext(el)             │
│                → buildPrompt(ctx, problem)   │
│                → clipboard.writeText         │
│                → toast                       │
└────────┬─────────────────────────────────────┘
         │ (用户手动) 粘到 CC
         ▼
┌──────────────────────────────────────────────┐
│  ~/.claude/skills/找本地参考/SKILL.md          │
│  调 http://localhost:41595 Eagle API          │
│  → 选 folder → 拉图 → Read 缩略图              │
│  → 视觉分析 → 输出改造代码                     │
└──────────────────────────────────────────────┘
```

## 7. 改动位置(新方案)

| 文件 | 改动类型 | 改动内容 |
|------|--------|---------|
| `contextmenu/find-reference.js` | **新增** | 注册右键菜单 + onClicked → sendMessage(fallback: executeScript 注入) |
| `toolbar/find-reference.js` | **新增** | 常驻 content script:mousedown/contextmenu 跟踪 lastRightClickEl + 监听 OPEN_FIND_REF_MODAL + Shadow DOM modal + extractContext + buildPrompt + 剪贴板 + toast |
| `liaison.js` | 改动 | 顶部 `import './contextmenu/find-reference.js'` |
| `manifest.json` | 改动 | 新增 `content_scripts` 字段,把 `toolbar/find-reference.js` 注入到 `<all_urls>` |
| `toolbar/inject.js` / `toolbar/bundle.min.js` | **不动** | 与 Liaison 主功能完全解耦 |

### 7.1 为什么需要常驻 content script

Chrome 88+ 的 `chrome.contextMenus.getTargetElement(targetElementId)` API 设计上能从右键事件拿到 DOM 元素,但实测在 isolated-world content script 中**返回 null**(用户首次测试时即遇到此问题)。改用**自己的 mousedown/contextmenu 监听器(capture phase)**追踪右键元素,需要监听器在用户右键**之前**已就位 → 必须用 manifest `content_scripts` 注入,而非按需 `executeScript`。

### 7.2 已打开的旧 tab

`content_scripts` 只对扩展加载后新打开或刷新的 tab 生效。旧 tab 上首次右键会走 `executeScript` fallback,但 tracker 刚就位、错过了刚才的右键,modal 顶部会显示"(未识别到元素)"。用户刷新该 tab 后下次就正常。一次性成本,可接受。

## 8. 技术决策

### 8.1 为什么是 tab 不是 tool mode

"找参考"动作发生在**已经选中元素之后**,跟"评论"、"设计"这种"我要在页面上点一下"的 tool mode 不同。它是侧栏的功能,挂 tab 更自然。

### 8.2 为什么不在插件里直接调 Eagle API

- 浏览器扩展 fetch 本地 localhost:41595 涉及 CORS / 权限申请(虽然 manifest 加一下也能解决,但增加复杂度)
- 即使能调,挑图、分析图、生成代码这些事最后还是要 CC 做。让插件干一半 + CC 干一半,职责混乱
- **更重要的**:CC skill 有 LLM 推理能力,语义匹配 folder 的准确度远高于关键词匹配。这件事插件做不好

### 8.3 为什么 V0 不送截图

`html2canvas` 至少 100KB+,bundle 加这个不值。CC 看 DOM + style 摘要已经够诊断绝大多数视觉问题。V1 再加截图(可以用 `chrome.tabs.captureVisibleTab` + 裁剪,无需 lib)。

### 8.4 为什么是剪贴板而非自动注入

- CC 没有"接收剪贴板自动执行"的 API。能做到自动注入需要起本地 server / MCP,V0 太重
- 剪贴板 + 粘贴是设计师已经熟悉的动作,1 秒钟搞定
- 留出"用户在 prompt 里再补一句话"的空间——粘到 CC 前可以加一句"参考时别学它的配色,我要保持品牌色"

### 8.5 为什么 textarea 不清空

用户大概率会"生成 → 看 CC 结果不满意 → 改一个字 → 再生成"。每次清空会让这个循环多 5 秒。

## 9. 验证方案

### 9.1 手动 E2E

1. 装扩展 → 打开任意有内容的网页
2. 激活 Liaison → 切 design → 选一个按钮 / 卡片
3. 切「找参考」tab → 看到元素标识
4. 输入"这块太单调" → 点生成
5. 看到 toast,验证剪贴板内容(粘到记事本看)
6. 打开 CC,粘进去
7. CC 应该:自动触发「找本地参考」skill → 调 Eagle API → 输出含 3-5 张参考图路径的诊断 + 代码 diff

### 9.2 关键边界

- 未选元素时切 tab:看到空状态而不是报错
- Eagle 没开时粘到 CC:skill 应降级到 Read metadata.json,而不是失败

## 10. 风险 & 回退

| 风险 | 处理 |
|------|-----|
| 加新 tab 破坏现有 tab 样式 | Plan 阶段先 grep 验证 tab 架构;备份 bundle.min.js 到 `.bak_find_ref` |
| 用户没装/没启 Eagle | skill 内置降级路径(Read metadata.json) |
| Prompt 太长(选中元素 style 过多) | 白名单已限制 ~20 个属性;V1 可加省略阈值 |
| 剪贴板 API 在某些页面(http、iframe)失败 | catch 异常 → fallback 到选中文本让用户 Ctrl+C |

回退:`bundle.min.js.bak_find_ref` 备份,撤回直接覆盖。

## 11. V1 预备(不属于 V0,但 V0 要预留空间)

- **元素截图**: `chrome.tabs.captureVisibleTab` + 元素坐标裁剪 → 附到 prompt
- **问题快捷标签**: textarea 上方加 "单调 / 层级不清 / 缺重点 / 配色平 / 留白少" 等快捷按钮,点击拼到 textarea
- **历史问题记忆**: chrome.storage.local 存最近 10 条问题,下拉补全
- **多元素**: 支持 shift-多选,prompt 里描述多个元素的关系
- **回灌**: 起本地 MCP server,CC 输出的代码可以"一键 apply 回页面"(V1 大改)

## 12. 成本估计

- 代码量: V0 约 200-300 行(panel 模板 ~100 行 + buildPrompt ~50 行 + tab 接入 ~50 行 + 事件绑定 ~30 行)
- 工期: 集中 2-4 小时可完
