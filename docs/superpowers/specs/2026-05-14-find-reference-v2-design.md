# Find Reference V2 · Design Spec

Date: 2026-05-14
Status: Approved for V2 implementation
Supersedes: 2026-05-13-find-reference-design.md (V0)

## 1. 目标

修复 V0 实装后用户报告的三大痛点:**慢、找的参考图不精准、根据参考图改造的视觉效果不好**。

通过引入「**视觉信号 + 区域级标注作为检索单元**」,把 skill 从「文本到文本检索 + 整图当参考」升级为「**视觉到视觉检索 + 区域/整图同池竞争 + 区域裁切当参考**」。

## 2. V1 与 V0 的关系

V0 的右键菜单方案在实装时被 toolbar tab 方案替代,且加了「上一级 / 上一个·当前·下一个」元素导航。V2 在已实装的 tab 基础上做扩展和 skill 端重写,**不重做 UI**。

| | V0 spec(2026-05-13) | 实装 (current) | V2 (本 spec) |
|---|---|---|---|
| 入口 | 浏览器右键菜单 | toolbar tab | toolbar tab(沿用) |
| 元素信息 | 选择器 + 关键样式 | 同 + 元素导航 | 同 + **元素截图** |
| 检索单元 | 整张图 | 整张图 | **整图 + 每个 comment 区域** |
| 检索方式 | 文本(annotation 索引) | 文本(annotation 索引) | **文本粗筛 + 视觉精筛** |
| Skill 输出 | 3 方向 + Edit + 切换器 | 3 方向 + Edit + 切换器 | 同(Q3 用户保留) |
| Skill 沉淀 | annotation 写回 + cases.md | 同 | **完全砍掉**(Q4 不污染人工数据) |

## 3. 5 条硬约束(用户决策)

V2 设计的不可妥协点,任何实施细节冲突时以这 5 条为准:

1. **不再用整图 annotation 做检索依据**——只用 folder 分类 + comments 区域级标注
2. **搜索范围用户指定**(默认 4 个 folder),范围内未标注图也参与候选,不能只搜带 comments 的
3. **去掉 cases.md**——不维护问题→方案的复用库
4. **Skill 永不写回 Eagle 任何字段**——AI 是元数据消费者,不是贡献者
5. **生成 Prompt 时同步带元素截图**到 CC

## 4. 整体数据流

```
┌──────────────── 浏览器(Liaison 插件)────────────────┐
│  「找参考」tab                                         │
│  ① 选中元素 + 写问题                                   │
│  ② 「生成 Prompt」 按下时同步做:                       │
│     - chrome.tabs.captureVisibleTab → 按元素 rect 裁剪  │
│     - 调 liaison.js 的 download 桥存盘                  │
│     - 拿到本地路径 ~/Downloads/liaison-element-{ts}.jpg │
│  ③ 拼 prompt(含截图路径 + folder 范围 + 元素上下文)   │
│  ④ 写入剪贴板 + toast                                  │
└──────────────────┬─────────────────────────────────────┘
                   │ 用户粘到 CC
                   ▼
┌──────────── ~/.claude/skills/找本地参考/SKILL.md ──────┐
│  Step 1 · 加载 / 刷新 cache(按 SCOPE 内 folder 拉)   │
│  Step 2 · 文本粗筛 → 候选池 top 15                     │
│  Step 3 · 视觉精筛 → top 8(Read 元素截图 + 候选)     │
│  Step 4 · 多样性筛选 → 3 张                            │
│  Step 5 · 出 3 方向 + Edit + 切换器(沿用现 5.2-5.5)  │
│  Step 6 · 反馈处理(无沉淀)                            │
└────────────────────────────────────────────────────────┘
```

## 5. 默认搜索范围

```
SCOPE = ["UI-网页", "UI-桌面端", "UI-移动端/版式", "UI-移动端/质感"]
```

合计约 1043 张(649+90+170+134)。可被 prompt 里 `[搜索范围]` 段临时覆写。

## 6. 缓存结构

`~/.claude/skills/找本地参考/.cache/library_index.jsonl`:每行一张图,**保留 comments 数组结构**(不再 join 成字符串)。

```jsonc
{
  "id":       "MHO6L101T8E2N",
  "folders":  ["UI-移动端/质感"],
  "name":     "VIP权益卡-玻璃感",
  "width":    1242,
  "height":   2688,
  "thumb":    "/Users/.../xxx_thumbnail.png",
  "comments": [
    {"id":"C1", "x":29,  "y":1612, "w":120, "h":140,   "ann":"锁头"},
    {"id":"C2", "x":174, "y":581,  "w":150, "h":117.5, "ann":"玻璃质感的强调标签"}
  ]
}
```

刷新逻辑:
- 范围内只拉 SCOPE 4 个 folder 子树的 item
- 单文件 JSONL,TTL 24h
- 区域裁切**按需即用**——cache 只存坐标,Step 5 用到时才用 `sips` 裁切,结果落 `.cache/regions/{itemId}_{commentId}.jpg`

预估缓存大小:1043 × ~500 字节 ≈ 500KB,秒读。

## 7. 新 Prompt 模板

```
[使用 skill: 找本地参考]

[页面]
- URL: {url}
- 标题: {title}

[选中元素]
- 选择器: {selector}
- 内容预览: "{textPreview}"
- 关键样式:
  - color: {color}
  - background: ...
  - (省略未设置的项)
- 元素截图: {本地路径}

[搜索范围]
- UI-网页
- UI-桌面端
- UI-移动端/版式
- UI-移动端/质感

[我的问题]
{用户输入的一句话}
```

Skill 端读到 `[搜索范围]` 段就用这些 path;没有该段就用 hardcoded 默认。

## 8. SKILL.md 骨架 + 关键算法

### 8.1 SKILL.md 结构(替代现有 648 行,预计 ~250 行)

```
---
name: 找本地参考
description: ...
---

## 输入识别(精简版)
解析 prompt 4 段:[页面] / [选中元素] / [搜索范围] / [我的问题]
缺 [搜索范围] → 用默认 4 路径

## 工作流(5 步,过去 7 步合并)
### Step 1 · 加载 / 刷新 cache
### Step 2 · 文本粗筛 → 候选池 top 15
### Step 3 · 视觉精筛 → top 8(Read 元素截图 + 候选)
### Step 4 · 多样性筛选 → 3 张
### Step 5 · 输出 3 方向 + Edit + 切换器(沿用现 5.2-5.5)
### Step 6 · 反馈处理(无沉淀)

## 不要做的事
- 不写 Eagle annotation
- 不写 cases.md
- 不让用户挑 folder(搜索范围内做完)

## 降级
| Eagle API 不通 | Read metadata.json |
| 截图路径无效   | 跳过视觉精筛,只用文本粗筛 |
| 范围内无命中   | 提示用户扩大范围 |
```

砍掉的:vocabulary.md 关键词体系、cases.md 全套、annotation 写入、Step 0.A/0.B/0.C 三级通道、Step 4.5 渐进标注、Step 7.2-7.4 沉淀。

### 8.2 算法伪码

#### Step 1 · cache 加载 + 刷新

```python
SCOPE = ["UI-网页", "UI-桌面端", "UI-移动端/版式", "UI-移动端/质感"]
cache = "~/.claude/skills/找本地参考/.cache/library_index.jsonl"
if cache 不存在 或 mtime > 24h:
    folders_tree = curl /api/folder/list
    path_to_id   = walk(folders_tree)
    items = []
    for path in SCOPE:
        fid = resolve(path)
        items += curl /api/item/list?folders={fid}&limit=10000
    write_jsonl(items)
```

#### Step 2 · 文本粗筛(候选池构建 + 打分)

```python
kws = tokenize(user_problem)  # 按标点切 + 长度 2-6 的子串

candidates = []
for img in cache:
    # 候选 1:整图条目
    score_full = sum(2 for k in kws if k in img.name) \
               + sum(1 for k in kws if any(k in p for p in img.folders))
    candidates.append({
        "kind": "full", "id": img.id, "score": score_full,
        "thumb": img.thumb, "folders": img.folders, "name": img.name
    })
    # 候选 2..N:每个 comment 区域条目
    for c in img.comments:
        score_region = sum(5 for k in kws if k in c.ann) \
                     + sum(1 for k in kws if any(k in p for p in img.folders)) \
                     + 2  # ★ comment 基础分加权(Q2=b)
        candidates.append({
            "kind": "region", "id": img.id, "comment_id": c.id,
            "rect": (c.x, c.y, c.w, c.h), "ann": c.ann,
            "score": score_region, "folders": img.folders
        })

candidates.sort(by score desc)
top15 = candidates[:15]
```

权重决定:`comment.ann` 命中(×5) >> `folders` 命中(×1)——comments 是用户精炼信号,folder 是粗类。同图同问题如果整图和 region 都命中,region 几乎必胜。

#### Step 3 · 视觉精筛(单轮 batch,15 张图 + 元素截图一起送)

```python
elem_img = Read(prompt.element_screenshot)

# 准备所有候选图
imgs = []
for cand in top15:
    if cand.kind == "region":
        region_path = cache_dir / f"regions/{cand.id}_{cand.comment_id}.jpg"
        if not region_path.exists():
            sips --cropToHeightWidth ... {orig_thumb} -o {region_path}
        imgs.append(Read(region_path))
    else:
        imgs.append(Read(cand.thumb))

# 单次 vision call,一次评 15 张
scores = ask_vision(
    f"用户元素长这样:[elem_img]\n问题:'{user_problem}'\n"
    f"候选 0-14:[imgs]\n"
    f"对每张评 0-3 分(0=不相关 / 1=方向沾边 / 2=有借鉴价值 / 3=精准匹配)"
)
for cand, vs in zip(top15, scores):
    cand.final = cand.score + vs * 3

top8 = sorted(top15, by final desc)[:8]
```

15 张缩略图 + 1 张元素截图,单轮 ~50K tokens,可控。

#### Step 4 · 多样性筛选(替换原 [skill] 7 维度)

```python
def dims(cand):
    """token 集合作为方向指纹"""
    s = set()
    for fp in cand.folders:
        s |= set(seg for seg in fp.split("/") if seg)
    if cand.kind == "region":
        s |= tokenize_zh(cand.ann)
    s |= tokenize_zh(cand.get("name", ""))
    return s

selected = [top8[0]]
for _ in range(2):
    best, best_dist = None, -1
    for c in top8:
        if c in selected: continue
        avg = mean(1 - jaccard(dims(s), dims(c)) for s in selected)
        if avg > best_dist: best, best_dist = c, avg
    selected.append(best)
```

#### Step 5 · 视觉分析 + 3 方向输出

完全沿用现有 SKILL.md §5.2-5.5(Q3 保留):差异化矩阵、保真度自检表、3 方向 + Edit + A/B/C 切换器。

唯一不同:Read 的图换成裁切区域(若 kind=region),信噪比更高。

#### Step 6 · 反馈处理(无沉淀)

```python
if user_msg ~= /用\s*[A-C]/:
    edit_file(remove_other_directions)
elif user_msg ~= /重做|不行|换一下/:
    excluded_ids |= set(last_3.id)
    excluded_dirs |= union(dims(c) for c in last_3)
    # 重走 Step 2-5,Step 4 额外排除 excluded_*
else:
    pass  # 不写任何沉淀
```

## 9. 插件改动

最小化原则:不重构 find-ref tab,只在「生成 Prompt」按钮的 click handler 里**插一段截图逻辑**。bundle 复用现有 `liaisonInspDownload` 桥(`liaison.js:94-131` 已实现)。

| 文件 | 改动 |
|---|---|
| `toolbar/bundle.min.js` | 在「生成 Prompt」click handler(byte 439421 附近)里:① 调 `chrome.runtime.sendMessage({action:'liaisonInspCaptureVisibleTab'})` 拿 viewport dataURL;② 用元素 `getBoundingClientRect` × `devicePixelRatio` 算裁剪框;③ canvas 裁出元素小图 dataURL;④ 调 `liaisonInspDownload` 存盘拿绝对路径;⑤ 把路径插到 prompt `[选中元素]` 段 + 加 `[搜索范围]` 段,再写剪贴板 |
| `liaison.js` | **不动** |
| `manifest.json` | **不动**(`activeTab` + `downloads` 已申请) |

降级:若 bundle 改动定位失败,降级方案 B——写 `toolbar/find-ref-screenshot.js` 作为独立 content script,监听 clipboard write 事件,**追加**截图行到 prompt 末尾。

回退:`bundle.min.js.bak_find_ref_v2` 备份。

## 10. 异常处理

| 情况 | 处理 |
|---|---|
| Eagle API 不通 | Read `~/Desktop/我的知识库/设计灵感.library/metadata.json`;无 thumbnail 路径 → 退化为纯文本打分 + 直接出 top 3 |
| 元素截图获取失败 | prompt 里写 "(截取失败,纯文本检索)";skill 端跳过 Step 3 视觉精筛 |
| 范围内无候选 | 提示扩大范围,给出建议路径 |
| `sips` 裁切失败 | fallback:Read 整张缩略图,prompt 里告诉模型 "看 (x,y,w,h) 区域" |
| Vision 评分返回非数字 | 该候选 visual_score=0 |
| folder 路径解析不到 ID | 报错给用户,列出现有 folder 树前 2 层 |
| 元素截图太小(<50×50) | prompt 加注 "元素本体很小,视觉特征有限",vision 时侧重文本匹配 |
| devicePixelRatio 偏移 | 插件端裁切时统一乘 `window.devicePixelRatio` |

## 11. 测试

### Skill 单元(`~/.claude/skills/找本地参考/test/`)
- `test_scoring.py`:文本打分,期望 region 候选 > full 候选
- `test_dims.py`:dims() 集合提取
- `test_jaccard_diversity.py`:贪心多样性筛选,期望第 2/3 张含跨 folder 候选
- `test_path_resolve.py`:folder 路径 → ID

### 插件单元(`test/unit/find-ref-helpers.mjs`)
- `test_extract_context()`:DOM → context 对象
- `test_build_prompt()`:含所有必需字段
- `test_crop_rect()`:viewport 截图 + BCR + DPR → dataURL 尺寸正确

### 集成(脚本,不进 CI)
- mock Eagle 4 folders × 10 items,3 张带 comments,跑完整 Step 1-4
- mock vision 返回固定分数,验证 final 排序

### 手动 E2E(必做)
1. 装新 bundle → 打开任意页面,激活 Liaison
2. 切「找参考」tab → 选元素 → 写 "这块太单调"
3. 「生成 Prompt」 → 粘到记事本,核对包含 `[元素截图]` + `[搜索范围]`
4. 检查 `~/Downloads/liaison-element-*.jpg` 是裁过的元素图
5. 粘到 CC → skill 应该输出检索路径 + 给 3 个差异化方向 + Edit + 切换器
6. 边界:cache 过期、断 Eagle、元素太小、devicePixelRatio=2

## 12. 落地清单

按依赖顺序串行:

| 步 | 动作 | 文件 |
|---|---|---|
| 1 | 备份 SKILL.md → `SKILL.md.bak_v1_pre_rewrite` | skill 目录 |
| 2 | 备份 bundle → `bundle.min.js.bak_find_ref_v2` | toolbar/ |
| 3 | 重写 SKILL.md(按 §8.1 骨架) | skill 目录 |
| 4 | 写 cache builder Python 脚本(嵌在 SKILL.md 里) | skill 目录 |
| 5 | 删除旧 cache 和 cases.md(`rm -rf .cache cases.md`) | skill 目录 |
| 6 | 写 Skill 单元测试 + 跑通 | skill/test/ |
| 7 | Plan 阶段先 grep 摘 bundle 中「生成 Prompt」handler | toolbar/bundle.min.js |
| 8 | 在 handler 里插截图 + 裁切 + 拼新 prompt 段 | toolbar/bundle.min.js |
| 9 | 写插件单元测试 | test/unit/find-ref-helpers.mjs |
| 10 | 手动 E2E 走通完整流程 | (浏览器 + CC) |
| 11 | vocabulary.md 标"暂不使用"注释(不删) | skill/references/ |

## 13. 风险 & 回退

| 风险 | 处理 |
|---|---|
| bundle 改动定位失败 / 破坏现有功能 | `bundle.min.js.bak_find_ref_v2` 备份;降级方案 B(独立 content script) |
| 视觉精筛 token 成本超预期 | top15 → top10;或对 region 候选直接信任文本分,跳过其视觉评分 |
| 用户 Eagle 库结构改变(folder 重命名/移动) | 路径解析失败时报错列出现有结构,而非静默兜底 |
| 多样性筛选退化(都来自同一 folder) | 监控 selected 的 folders 集合大小,<2 时打警告日志 |
| sips 在某些 macOS 版本上行为差异 | 测试覆盖 macOS 14/15;失败时降级到 Read 整图 |

## 14. V1 → V2 不做的事(待 V3)

- ❌ 灵感库与找参考的数据底盘合并(用户已表示两模块独立共存)
- ❌ 浏览器内回看 skill 跑到哪一步的"进度感"(跨工具同步太重)
- ❌ CC 输出回灌到浏览器(MCP 双向通道)
- ❌ 网络版「找参考」skill 的工作流升级
- ❌ 「插件采集时一并写入 Eagle comments」(降低人工标注成本的探索)
