# liaison-patched（妙想）项目契约

分发与版本管理的完整方案见 `DISTRIBUTION-PLAN.md`（定稿，改动机制前先读它）。

## 发版契约（用户说口令，Claude 执行）

- **「push一下，打好 tag 和备注」** = 执行完整 release 流程：`tools/release.sh`（白名单构建 → 同步 miaoxiang 产物仓 → commit + tag + push → 更新 gist 广播）。执行前只问三件事：
  1. 大版本还是小版本？（附建议：同事可感知的新功能 → 大版本 2.x 抬门槛线弹窗；修 bug 微调 → 小版本 2.x.y 只亮角标）
  2. notes 草稿给用户确认（大版本必须；收益导向、≤3 条、每条 ≤20 字、不写技术名词）
  3. 若本次 skills 快照相比上一 tag 有变化，列变更摘要让用户扫一眼再发
- **「回滚到上一个版本」** = forward-fix：用旧版内容发一个**更高**的版本号，绝不把 gist 版本号改回旧号（同事本地版本已高，倒着改不触发更新）。
- miaoxiang 产物仓由脚本全权管理，Claude 与用户都**不手动改**它。
- **`--dry-run` 不是只读演练**：它会把 `manifest.json` 的版本号真的写成目标版本并留在工作区。跑完 dry-run 后必须 `git checkout manifest.json` 还原，否则这个残留会被带进下一个提交，或让正式发版因工作区不干净而中断。

## 功能门控契约

- **新增功能文件时，Claude 必须主动问用户「公开还是私有」**，默认私有。公开 = 文件加进 `tools/release-manifest.txt`；bundle 内部拆不开的功能才用 owner 开关（`window.__liaisonOwnerMode`）。
- 当前私有面：灵感面板「线下库」tab（owner 开关隐藏）；找本地参考 / 找参考 skill、kimi-webbridge、guard-global-styles hook 不分发。

## 代码结构纪律（S0，2026-08-27 起生效）

- **新功能一律写成 `toolbar/` 下的独立模块文件**（照 design-system-ui.js / update-modal.js 的模式），由注入链或 inject.js 挂载。**禁止再往 `bundle.min.js` 追加新 IIFE 功能块**；bundle 只允许「不得不改底座」的 patch。
- 机会主义搬迁（S1）：日后要改 bundle 里某个旧功能块（采集 / 发散 / AI 分析 / 色板浮层等）时，顺手把它搬出成独立文件再改，每次一个，随小版本发布验证。不专门停下来做大重构。

## 动手前先查已有沉淀（2026-08-31，同日两次因此多走弯路）

改**退出 / 清理 / 取选**逻辑前，先读记忆 `project_exit_interaction_browse_path`；改**面板状态**相关逻辑前，先读 `project_panel_autocollapse_desync`。这两条是踩过坑后立的铁律，且都明确写了「别自己拼散装调用」「堵单个触发点是错误方向」。

v2.1.3 修「关闭后页面未复原」时，前两版都在拼散装调用（先删 DOM 节点、再单独调 `exitComponent`），而那条记忆精确描述了本场景——完整退出统一派发 `liaison-top-toolbar-browse` → `activateWorkspace("browse")`，一次完成取选、收面板、teardown（跟随光标的模式提示消失、鼠标复原）、清高亮。**先查沉淀能直接省掉两版返工。**

配套两个易踩点：`tb._activeItem` 要直接置值（setter 不认 `"browse"`）；删 DOM 节点治不了由常驻 `mousemove` 监听驱动的浮层——鼠标一动就重建，必须改状态而非删节点。

## 扩展注入的世界隔离（2026-08-31 v2.1.3）

`executeScript` 注入的脚本（`eject.js` 等）跑在**隔离世界**，`inject.js` 用 `<script src>` 注入的（`bundle.min.js` / `design-system-ui.js`）跑在**页面主世界**，两个 `window` 不互通 —— 隔离世界里读 `window.__liaisonDesignUI` 永远是 `undefined`。要调主世界的东西，必须往主世界注一个脚本文件。

**注入一律用 `src` 加载扩展文件，不要 inline** —— 严格 CSP 的站点会静默拦截 inline script（项目现有 5 处注入都用 `src`）。新增的注入文件记得同时加进 `tools/release-manifest.txt`，否则同事侧 404；`manifest.json` 的 `toolbar/*` 已自动覆盖 web_accessible_resources。

**清理时注意区分「扩展自己的浮层」和「打在宿主页元素上的标记」**：`data-liaison-neg` 是负边距功能打在**用户页面元素**上的 uuid，误删会破坏宿主页；`data-liaison-mode-tip` / `-dist` / `-hover-preview` / `-backdrop` / `data-annotation-marker` 才是扩展自建的浮层。

## 预建 UI 元素必须与事件注册同源（2026-08-31 v2.1 事故）

**规则**：任何地方 `createElement` 一个引擎托管的自定义元素（`liaison-style-panel` 等）并挂进 DOM，都必须走引擎的工厂函数，或在挂载后补上引擎监听。**禁止绕过工厂直接 appendChild**。

**为什么**：v2.1 的 `activateWorkspace` 预建「请先选择对象」空壳面板时直接 `appendChild`，没注册监听；引擎的面板工厂随后发现「已存在 liaison-style-panel」就走复用分支 `return _ex`，把 `t(n).on("liaison-style-change", ...)` 等全部监听注册跳过了。结果面板能渲染、能派发事件（`renderPanel` 是面板自身方法，独立于引擎），但**引擎从未订阅** —— 读路径全通、写路径全断，所有参数改了不生效、清单角标恒为 0。已加 `__liEngineBound` 标记兜底（复用分支只复用带标记的），但根子在「预建绕过工厂」这个模式。

**排查方法论（这次错了八次才定位，代价很大）**：
1. 症状是「新出现的」→ **第一步就做新旧版本对比**，别读代码猜。本次把范围从 90 万字符压到 72 行，是唯一有效的收敛手段。
2. 「读正常 / 写失效」这类分裂症状 → **在可疑 handler 里植入 `console.log` 探针**，让代码自己报告走到哪一步。探针零输出本身就是决定性线索（说明监听没绑，而非守卫拦截）。
3. **不要在 minified 代码里靠阅读推断执行路径** —— 本次连续八次「这段看起来就是元凶」的判断全错。
4. 改任何文件前，先在 `chrome://extensions` 卡片「详情 → 来源」确认 Chrome 实际加载的目录。
5. 单点中和法失效时（逐个禁用嫌疑代码都无效、整块禁用却有效），说明**故障在共同下游或注册时序**，不在被禁的那些语句里。

**动效/视觉类问题的排查法（2026-08-31 v2.1.2「面板推出去又推回来」，又绕了六次）**：

动效问题不能测静止态 —— 静止态测量是在动画**结束后**取的，几何一致不代表过程没动。按这个顺序做：

1. **逐帧采样过程**，而不是测前后两个静止态：
   ```js
   const log=[];let n=0;const t0=performance.now();
   const id=setInterval(()=>{const r=el.getBoundingClientRect();
     log.push([Math.round(performance.now()-t0),Math.round(r.left),Math.round(r.width),getComputedStyle(el).transform.slice(0,28)].join(' '));
     if(++n>60){clearInterval(id);console.log(log.join('\n'))}},16);
   ```
   本次直接给出 `left 807→1059→807` 的位移轨迹，证明「有东西在动」且方向是先推出屏幕外。
2. **`MutationObserver` + `console.trace` 抓「谁改的」** —— 监听目标元素的 `style`/`class` 属性变更，在回调里打调用栈。本次一次点名 `playDockEnter`，此前六次靠读代码的猜测全错。
3. **「看到位移」+「代码里有个滑出动画」= 关联，不是因果。** 本次据此误判为退场动画，探针证明该函数**从未被调用**。任何「这段代码看起来就是元凶」的判断，落地前必须先用探针或调用栈确认它真的执行了。
4. 动画标记要想清楚**何时失效**：粘性属性（`setAttribute`）会一直跟着元素，实例字段（`el.__flag`）随元素销毁而消失。本次先用属性导致入场动画被永久掐死，改用实例字段 + 「播放时才打标记」才对。
5. 改动效必须回归**全部**入场/退场路径（首次唤起、关闭后再唤起、切换态），只验一条必然误伤。

## 其他既有约定

- 面向用户/同事的文档用 UI 真实文案（调整 / 组件 / 分析 / 清单；灵感面板：线上库 / 线下库 / 发散），不用内部代号（「自检」是 AI 深度分析的旧代号）。
- 命令行访问 GitHub 需走本机代理 127.0.0.1:8118（脚本已内置自动检测）。
