# 首次分发 · 同事真机验收清单

找一位同事（最好没装过任何相关东西的"干净"Mac）走一遍。每一项打勾；任何一步卡住，
把终端输出 / 截图发回来，修进下一版安装器即可——首位用户暴露环境边角问题是预期内的。

## A. 安装（同事自己操作，你只旁观不搭手）

- [ ] 打开 https://github.com/FengranZhou/miaoxiang → Code → Download ZIP → 解压
- [ ] **右键** `install.command` → 打开 → 「打开」（考察 README 提示是否足够让他自己想到右键）
- [ ] 脚本全程无红色报错跑完；`~/.miaoxiang/` 目录生成
- [ ] Chrome 扩展页自动弹出 + 图文引导页自动打开
- [ ] 他能照引导独立完成「加载已解压的扩展程序」（路径粘贴自剪贴板）
- [ ] 点扩展图标（或 Alt+Shift+D），开屏动画 + 工具栏出现

## B. 功能逐项（同事机器）

- [ ] 调整 / 组件 / 分析（基础信息）/ 清单：全部可用
- [ ] **灵感面板只有「线上库」「发散」两个 tab——没有「线下库」**（owner 门控核心验证）
- [ ] 采集一个元素入库，资产库里能看到
- [ ] 线上库选参考 + 写不满 → 「复制到 CC 并清空」→ 粘进他自己的 Claude Code 能正常执行
- [ ] AI 深度分析：前提 `claude -p 你好` 通 → 点按钮约 1 分钟出问题清单
- [ ] 发散：首次弹出的专用 Chrome 里登录 Variant → 投递成功
- [ ] 按图生：在他的 CC 里跑一次 → 专用 Chrome（9333）弹出 → 登录豆包 → 全流程出图 → **终稿确认浮窗（Confirm.app）能弹出**
- [ ] 抠图：`~/.claude/skills/按图生/.venv/bin/python3 ~/.claude/skills/按图生/cutout.py <图> /tmp/out.png` → stderr 显示回退 `rembg birefnet-general`（他没有 Eagle 插件）→ 出透明底图
- [ ] 去水印 skill 可用（venv 已建）

## C. 更新链路（你发一个测试小版本配合）

- [ ] 你这边：随便改一行注释 → 「push一下」→ 发 2.0.x
- [ ] 同事双击 `~/.miaoxiang/update.command` → 拉到新版，skills 立即生效
- [ ] 扩展文件有变化时收到系统通知「重启 Chrome 后生效」→ 重启后版本号变了
- [ ] （可选，验自动器）`launchctl start com.miaoxiang.updater` 手动触发一次静默更新，看 `~/.miaoxiang/update.log`

## D. 提醒链路（角标 / 弹窗，可在你自己机器模拟或等真实大版本）

- [ ] 同事本地版本落后时：图标红色 NEW 角标出现
- [ ] 落后于门槛线时：唤起工具栏弹更新弹窗，「去更新」跳 miaoxiang 仓库页

## E. 已知会出现、不算 bug 的现象

- 首次安装 npm / venv / 模型下载合计可能要 5-15 分钟（网络差更久），日志在 `~/.miaoxiang/update.log`
- 模型下载失败只影响抠图，重跑 update.command 可补
- Confirm.app 首次可能被 Gatekeeper 拦 → README FAQ 的 build-confirm.sh 重编路径
- 同事没有 Eagle 时抠图速度慢于你（rembg CPU 推理），质量一致
