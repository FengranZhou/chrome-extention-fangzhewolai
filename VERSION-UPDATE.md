# 版本更新提醒机制（发版必读）

内部分发不走应用商店，没有自动更新。这套机制用一个 public gist 上的
`version.json` 当版本广播源，让装了旧版的同事被两级提醒捞回来：

| 级别 | 表现 | 触发条件 |
|---|---|---|
| 弱提醒 | 扩展图标亮红色 NEW 角标 | 远端 `version` > 本地 manifest 版本 |
| 强提醒 | 点图标唤起工具栏时弹更新弹窗（要点 + 去更新） | 本地版本 < 远端门槛线 `notifyFloor` |

打扰频率三道闸：低于门槛线只亮角标不弹窗；弹窗全局每天最多一次；
用户点「跳过此版本」后，直到下个大版本抬高门槛线才会再弹。

## 代码落点

| 内容 | 位置 |
|---|---|
| 后台轮询 + 角标（每日闹钟 / 启动 / 点图标 30s 节流） | `liaison.js` 末尾「版本更新检查」段 |
| 强提醒弹窗（storage 门闸 + UI） | `toolbar/update-modal.js`，由 toggleIn 注入链带入 |
| 发版脚本（合并式更新 gist） | `tools/update-version-gist.sh` |
| gist ID / owner 配置 | `tools/version-gist.config`（--init 生成） |

状态全在 `chrome.storage.local`（`liaisonUpdate*` 前缀），SW 的 DevTools
console 里直接改就能构造任意场景调试，不必真装旧版。

## 首次启用（一次性，两步）

```bash
brew install gh && gh auth login        # 已有则跳过
bash tools/update-version-gist.sh --init
```

`--init` 会创建 public gist、把 raw URL 自动回填进 `liaison.js` 的
`LIAISON_VERSION_CHECK_URL`（初始占位符未回填时整个检查静默停用，
不影响任何现有功能）。之后重新打包分发即可。

## 每次发版（最后一步，别忘）

```bash
# 小版本（修 bug / 内部优化）：只更版本号，旧用户只亮角标
bash tools/update-version-gist.sh

# 大版本：抬门槛线 + 换一批弹窗要点（低于门槛线的用户会被弹窗捞回）
printf '第一条亮点\n第二条亮点\n第三条亮点\n' > /tmp/notes.txt
bash tools/update-version-gist.sh 2.1 --floor 2.1 --notes-file /tmp/notes.txt

# 设置 / 更换「去更新」跳转的下载页（内网 wiki / 网盘固定外链）
bash tools/update-version-gist.sh --download-url 'https://...'
```

脚本是**合并式**更新：不传的字段保留线上现值，发小版本不会误清门槛线。
`downloadUrl` 一次设好长期有效；没设时弹窗降级为「请向工具分发者获取
最新安装包」+「知道了」。

发版心智：
- 大版本 → `--floor` 抬到新版本号，`notes` 按「本阶段亮点汇总」重写
  （收益导向、最多 3 条、每条 ≤ 20 字、不写技术名词）
- 小版本 → 什么都不用传，门槛线自动保留，停在上个大版本的人不会被再弹

## 发版后人工验证

- [ ] `curl 'https://gist.githubusercontent.com/<owner>/<id>/raw/version.json?t=1'` 返回新版本号
- [ ] 旧版扩展在 `chrome://extensions` 点刷新 → 图标出现 NEW 角标
- [ ] 旧版（低于门槛线）点图标唤起工具栏 → 弹窗出现，notes 正确
- [ ] 点「跳过此版本」→ 重开页面不再弹
- [ ] 最新版 → 角标与弹窗都不出现

## 坑位速查（继承自 UIToolBox 移植指南）

- gist raw 有 ~5min CDN 缓存 → 客户端与脚本回读都拼 `?t=时间戳`
- MV3 SW 顶层无条件 `alarms.create` 会把每日闹钟清零重排 → 已用先 `get` 再 `create`
- 版本比较不能用字符串 `>`（`"0.10.0" < "0.9.0"`）→ 已逐段转数字
- gist URL 在 `liaison.js` 与 `tools/version-gist.config` 两处，换归属时一起改
