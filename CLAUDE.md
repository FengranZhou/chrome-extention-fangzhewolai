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

## 其他既有约定

- 面向用户/同事的文档用 UI 真实文案（调整 / 组件 / 分析 / 清单；灵感面板：线上库 / 线下库 / 发散），不用内部代号（「自检」是 AI 深度分析的旧代号）。
- 命令行访问 GitHub 需走本机代理 127.0.0.1:8118（脚本已内置自动检测）。
