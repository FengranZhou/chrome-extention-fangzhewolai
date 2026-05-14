# Find Reference V2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 重写「找本地参考」skill 的检索算法,引入元素截图 + comments 区域级候选 + 视觉精筛,把插件端「生成 Prompt」按钮改为同步附带元素截图。

**Architecture:**
- Skill 侧:把过去内嵌在 SKILL.md 里的 Python 脚本提取到 `~/.claude/skills/找本地参考/lib/` 下作为可测的模块,SKILL.md 改写为「调用这些模块的指挥棒」。
- 插件侧:在现有 `toolbar/bundle.min.js` 的「生成 Prompt」click handler 里插入截图 + 裁切 + 拼新 prompt 的逻辑,复用 `liaison.js` 已有的 `liaisonInspCaptureVisibleTab` / `liaisonInspDownload` 桥。
- 测试:Skill 用 `python3 -m unittest`(零依赖);插件复用现有 `node test/unit/*.mjs` 模式(从 bundle 抽 IIFE 进 vm 跑)。

**Tech Stack:** Python 3 (stdlib only), Node.js ESM (test runner), macOS `sips` (区域裁切), Eagle HTTP API (`localhost:41595`), Chrome MV3 APIs.

**Reference docs:**
- 设计稿: `docs/superpowers/specs/2026-05-14-find-reference-v2-design.md`
- 现有 skill: `~/.claude/skills/找本地参考/SKILL.md`
- 插件主入口: `liaison.js`(service worker + 桥接 message)
- 插件 bundle: `toolbar/bundle.min.js`(minified,find-ref tab 在 byte 439K-482K)

---

## Phase A · Skill 后端重写

### Task A1: 备份现有 skill 与清理旧 cache

**Files:**
- Backup: `~/.claude/skills/找本地参考/SKILL.md` → `SKILL.md.bak_v1_pre_rewrite`
- Backup: `~/.claude/skills/找本地参考/cases.md` → `cases.md.bak_v1`
- Delete: `~/.claude/skills/找本地参考/.cache/` (整个目录)

**Step 1: 备份**

```bash
cd ~/.claude/skills/找本地参考
cp SKILL.md SKILL.md.bak_v1_pre_rewrite
cp cases.md cases.md.bak_v1 2>/dev/null || true
```

**Step 2: 清掉旧 cache(新结构不兼容)**

```bash
rm -rf ~/.claude/skills/找本地参考/.cache
```

**Step 3: 确认备份在位、cache 已清**

```bash
ls -la ~/.claude/skills/找本地参考/SKILL.md.bak_v1_pre_rewrite
test ! -d ~/.claude/skills/找本地参考/.cache && echo "cache 已清"
```

Expected: 备份文件存在,cache 不存在。

**Step 4: skill 不在 git 仓库内,无需 commit**

(skip)

---

### Task A2: 建立 skill 测试脚手架

**Files:**
- Create: `~/.claude/skills/找本地参考/lib/__init__.py`(空文件)
- Create: `~/.claude/skills/找本地参考/test/__init__.py`(空文件)
- Create: `~/.claude/skills/找本地参考/test/run_all.sh`

**Step 1: 建目录结构**

```bash
mkdir -p ~/.claude/skills/找本地参考/lib
mkdir -p ~/.claude/skills/找本地参考/test
touch ~/.claude/skills/找本地参考/lib/__init__.py
touch ~/.claude/skills/找本地参考/test/__init__.py
```

**Step 2: 写 test runner 脚本**

文件:`~/.claude/skills/找本地参考/test/run_all.sh`

```bash
#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
python3 -m unittest discover -s test -p 'test_*.py' -v
```

```bash
chmod +x ~/.claude/skills/找本地参考/test/run_all.sh
```

**Step 3: 验证 runner 工作(此时无测试,期望 OK 0 tests)**

```bash
~/.claude/skills/找本地参考/test/run_all.sh
```

Expected: `Ran 0 tests in 0.000s` `OK`

---

### Task A3: 实现 folder 路径解析器(TDD)

**Files:**
- Create: `~/.claude/skills/找本地参考/lib/folders.py`
- Test: `~/.claude/skills/找本地参考/test/test_folders.py`

**Step 1: 写失败的测试**

文件:`~/.claude/skills/找本地参考/test/test_folders.py`

```python
import unittest
from lib.folders import resolve_paths, walk_tree

class TestFolderResolve(unittest.TestCase):
    def setUp(self):
        # mock /api/folder/list 返回结构
        self.tree = [
            {"id": "A1", "name": "UI-网页", "children": []},
            {"id": "A2", "name": "UI-桌面端", "children": []},
            {"id": "A3", "name": "UI-移动端", "children": [
                {"id": "B1", "name": "版式", "children": []},
                {"id": "B2", "name": "质感", "children": []},
            ]},
        ]

    def test_walk_tree_flat(self):
        m = walk_tree(self.tree)
        self.assertEqual(m["UI-网页"], "A1")
        self.assertEqual(m["UI-移动端/版式"], "B1")
        self.assertEqual(m["UI-移动端/质感"], "B2")

    def test_resolve_paths_all_found(self):
        m = walk_tree(self.tree)
        ids = resolve_paths(m, ["UI-网页", "UI-移动端/版式"])
        self.assertEqual(ids, ["A1", "B1"])

    def test_resolve_paths_missing_raises(self):
        m = walk_tree(self.tree)
        with self.assertRaises(KeyError) as cm:
            resolve_paths(m, ["UI-不存在"])
        self.assertIn("UI-不存在", str(cm.exception))
        # 错误里应列出现有路径前几个
        self.assertIn("UI-网页", str(cm.exception))

if __name__ == "__main__":
    unittest.main()
```

**Step 2: 跑测试,确认失败**

```bash
cd ~/.claude/skills/找本地参考 && python3 -m unittest test.test_folders -v
```

Expected: `ModuleNotFoundError: No module named 'lib.folders'`

**Step 3: 实现 lib/folders.py**

文件:`~/.claude/skills/找本地参考/lib/folders.py`

```python
"""Eagle folder 树工具:把 /api/folder/list 返回的嵌套树拍平成 path→id。"""

def walk_tree(tree, parent=""):
    """tree: list of {id, name, children}.
    返回 dict: 'path/with/slashes' -> folder_id"""
    out = {}
    for node in tree:
        path = f"{parent}/{node['name']}" if parent else node['name']
        out[path] = node['id']
        children = node.get('children') or []
        if children:
            out.update(walk_tree(children, path))
    return out


def resolve_paths(path_to_id, paths):
    """paths: list of folder path strings.
    返回 list of ids,若任一找不到抛 KeyError 含可用路径示例。"""
    out = []
    for p in paths:
        if p not in path_to_id:
            existing = sorted(path_to_id.keys())[:8]
            raise KeyError(
                f"folder 路径 '{p}' 解析失败。"
                f"现有 folders 示例: {', '.join(existing)}..."
            )
        out.append(path_to_id[p])
    return out
```

**Step 4: 跑测试,确认通过**

```bash
cd ~/.claude/skills/找本地参考 && python3 -m unittest test.test_folders -v
```

Expected: `OK`(3 tests passed)

---

### Task A4: 实现文本打分(TDD)

**Files:**
- Create: `~/.claude/skills/找本地参考/lib/scoring.py`
- Test: `~/.claude/skills/找本地参考/test/test_scoring.py`

**Step 1: 写失败的测试**

文件:`~/.claude/skills/找本地参考/test/test_scoring.py`

```python
import unittest
from lib.scoring import tokenize, score_full, score_region

class TestTokenize(unittest.TestCase):
    def test_split_by_punct(self):
        toks = tokenize("这块太单调、层级不清")
        self.assertIn("这块太单调", toks)
        self.assertIn("层级不清", toks)
        # 不再做更细的切词

    def test_dedup(self):
        toks = tokenize("色,色,色")
        self.assertEqual(len([t for t in toks if t == "色"]), 1)


class TestScoring(unittest.TestCase):
    def test_full_score_matches_name_and_folder(self):
        img = {"name": "VIP权益卡-玻璃感", "folders": ["UI-移动端/质感"]}
        s = score_full(["质感"], img)
        # name 含「质感」+2,folder 路径含「质感」+1 = 3
        self.assertEqual(s, 3)

    def test_region_score_higher_than_full_for_same_keyword(self):
        img = {"name": "x", "folders": ["UI-网页"]}
        comment = {"ann": "玻璃质感的强调标签"}
        full_s = score_full(["质感"], img)        # 0
        region_s = score_region(["质感"], img, comment)  # ann +5, base +2 = 7
        self.assertGreater(region_s, full_s)
        self.assertEqual(region_s, 7)

    def test_region_no_keyword_still_has_base(self):
        img = {"name": "x", "folders": ["UI-网页"]}
        comment = {"ann": "完全无关的标注"}
        s = score_region(["质感"], img, comment)
        self.assertEqual(s, 2)  # 仅 base bonus

if __name__ == "__main__":
    unittest.main()
```

**Step 2: 跑测试,确认失败**

```bash
cd ~/.claude/skills/找本地参考 && python3 -m unittest test.test_scoring -v
```

Expected: `ModuleNotFoundError: No module named 'lib.scoring'`

**Step 3: 实现 lib/scoring.py**

文件:`~/.claude/skills/找本地参考/lib/scoring.py`

```python
"""文本打分:对候选(整图 / region)按用户问题关键词打分。"""

import re

_PUNCT = re.compile(r'[\s,，、。.;；:：?？!！/|\-_()()\[\]【】]+')

def tokenize(text):
    """按标点切分,保留长度 >= 2 的子串,去重保序。"""
    if not text:
        return []
    seen = set()
    out = []
    for tok in _PUNCT.split(text):
        tok = tok.strip()
        if len(tok) >= 2 and tok not in seen:
            seen.add(tok)
            out.append(tok)
    return out


def score_full(kws, img):
    """整图候选打分:name 命中 +2,folder 路径命中 +1。"""
    s = 0
    name = img.get("name", "")
    folders = img.get("folders", [])
    for k in kws:
        if k in name:
            s += 2
        if any(k in p for p in folders):
            s += 1
    return s


def score_region(kws, img, comment):
    """Region 候选打分:ann 命中 +5,folder 路径 +1,基础分 +2(comment 信号优先)。"""
    s = 2  # base bonus for being a user-curated region
    ann = comment.get("ann", "")
    folders = img.get("folders", [])
    for k in kws:
        if k in ann:
            s += 5
        if any(k in p for p in folders):
            s += 1
    return s
```

**Step 4: 跑测试,确认通过**

```bash
cd ~/.claude/skills/找本地参考 && python3 -m unittest test.test_scoring -v
```

Expected: `OK`(4 tests passed)

---

### Task A5: 实现多样性筛选(TDD)

**Files:**
- Create: `~/.claude/skills/找本地参考/lib/diversity.py`
- Test: `~/.claude/skills/找本地参考/test/test_diversity.py`

**Step 1: 写失败的测试**

文件:`~/.claude/skills/找本地参考/test/test_diversity.py`

```python
import unittest
from lib.diversity import dims, jaccard, select_diverse

class TestDims(unittest.TestCase):
    def test_full_candidate_dims_from_folder_and_name(self):
        c = {"kind": "full", "folders": ["UI-移动端/质感"], "name": "玻璃 卡片"}
        d = dims(c)
        # folder 切 "UI-移动端" "质感",name 切 "玻璃" "卡片"
        for w in ["UI-移动端", "质感", "玻璃", "卡片"]:
            self.assertIn(w, d)

    def test_region_candidate_dims_include_ann_tokens(self):
        c = {"kind": "region", "folders": ["UI-网页"], "name": "",
             "ann": "玻璃质感的强调标签"}
        d = dims(c)
        # ann 切 "玻璃质感的强调标签"(整体长度 8 > 6,期望被切)
        # 当前实现按标点切,无标点的整段会被保留,只要 len 2-8 都纳入
        self.assertIn("UI-网页", d)
        self.assertIn("玻璃质感的强调标签", d)

class TestJaccard(unittest.TestCase):
    def test_identical_sets_jaccard_1(self):
        self.assertEqual(jaccard({"a","b"}, {"a","b"}), 1.0)

    def test_disjoint_sets_jaccard_0(self):
        self.assertEqual(jaccard({"a"}, {"b"}), 0.0)

    def test_partial(self):
        self.assertAlmostEqual(jaccard({"a","b"}, {"b","c"}), 1/3)


class TestSelectDiverse(unittest.TestCase):
    def test_picks_cross_folder_for_diversity(self):
        # 5 个 UI-网页 候选 + 1 个 UI-桌面端 候选,期望 selected 含跨 folder 那个
        cands = [
            {"id": f"a{i}", "kind": "full", "folders": ["UI-网页"],
             "name": f"web {i}", "final": 10 - i}
            for i in range(5)
        ] + [
            {"id": "b1", "kind": "full", "folders": ["UI-桌面端"],
             "name": "desk", "final": 4}
        ]
        sel = select_diverse(cands, k=3)
        # 第一个一定是 final 最高的(a0)
        self.assertEqual(sel[0]["id"], "a0")
        # 后两个里至少有一个是跨 folder 的 b1
        ids = {s["id"] for s in sel}
        self.assertIn("b1", ids)

    def test_excluded_dirs_filters_out(self):
        cands = [
            {"id": "a", "kind": "full", "folders": ["UI-网页"], "name": "x", "final": 10},
            {"id": "b", "kind": "full", "folders": ["UI-网页"], "name": "y", "final": 9},
        ]
        sel = select_diverse(cands, k=2, excluded_dirs={"UI-网页"})
        # 排除 UI-网页 后无候选 → 期望返回空或抛错。当前选返回空
        self.assertEqual(sel, [])

if __name__ == "__main__":
    unittest.main()
```

**Step 2: 跑测试,确认失败**

```bash
cd ~/.claude/skills/找本地参考 && python3 -m unittest test.test_diversity -v
```

Expected: `ModuleNotFoundError: No module named 'lib.diversity'`

**Step 3: 实现 lib/diversity.py**

文件:`~/.claude/skills/找本地参考/lib/diversity.py`

```python
"""候选多样性筛选:贪心选 k 个 dims 集合最分散的候选。"""

import re

_PUNCT = re.compile(r'[\s,，、。.;；:：?？!！/|\-_()()\[\]【】]+')

def dims(cand):
    """候选的方向指纹:folder 段 + name token + (region) ann token,长度 2-8。"""
    s = set()
    for fp in cand.get("folders", []):
        for seg in fp.split("/"):
            seg = seg.strip()
            if seg:
                s.add(seg)
    name = cand.get("name", "")
    for tok in _PUNCT.split(name):
        tok = tok.strip()
        if 2 <= len(tok) <= 8:
            s.add(tok)
    if cand.get("kind") == "region":
        ann = cand.get("ann", "")
        for tok in _PUNCT.split(ann):
            tok = tok.strip()
            if 2 <= len(tok) <= 12:
                s.add(tok)
    return s


def jaccard(a, b):
    if not a and not b:
        return 1.0
    return len(a & b) / max(len(a | b), 1)


def select_diverse(cands, k=3, excluded_dirs=None):
    """贪心多样性选择。
    cands: list of dict,需含 'final' 排序键。已按 final desc 排好序。
    excluded_dirs: 一个 set,候选 dims 与之 jaccard > 0.7 则跳过。"""
    excluded_dirs = excluded_dirs or set()

    def is_excluded(c):
        if not excluded_dirs:
            return False
        return jaccard(dims(c), excluded_dirs) > 0.7

    pool = [c for c in cands if not is_excluded(c)]
    if not pool:
        return []
    selected = [pool[0]]
    while len(selected) < k:
        best, best_dist = None, -1.0
        for c in pool:
            if c in selected:
                continue
            avg = sum(1 - jaccard(dims(s), dims(c)) for s in selected) / len(selected)
            if avg > best_dist:
                best, best_dist = c, avg
        if best is None:
            break
        selected.append(best)
    return selected
```

**Step 4: 跑测试,确认通过**

```bash
cd ~/.claude/skills/找本地参考 && python3 -m unittest test.test_diversity -v
```

Expected: `OK`(6 tests passed)

---

### Task A6: 实现 cache 构建器(TDD,mock Eagle)

**Files:**
- Create: `~/.claude/skills/找本地参考/lib/build_index.py`
- Test: `~/.claude/skills/找本地参考/test/test_build_index.py`

**Step 1: 写失败的测试(用 mock urlopen 注入假 Eagle 响应)**

文件:`~/.claude/skills/找本地参考/test/test_build_index.py`

```python
import unittest
import json
import tempfile
import os
from unittest.mock import patch, MagicMock
from io import BytesIO

from lib.build_index import build_index, _fetch_json


class _FakeResp:
    def __init__(self, payload):
        self._b = json.dumps(payload).encode('utf-8')
    def read(self):
        return self._b
    def __enter__(self): return self
    def __exit__(self, *a): pass


def fake_urlopen(url, *args, **kwargs):
    if "/api/folder/list" in url:
        return _FakeResp({"status":"success","data":[
            {"id":"A1","name":"UI-网页","children":[]},
            {"id":"A2","name":"UI-移动端","children":[
                {"id":"B1","name":"质感","children":[]},
            ]},
        ]})
    if "folders=A1" in url:
        return _FakeResp({"status":"success","data":[
            {"id":"i1","name":"web shot","folders":["A1"],"width":100,"height":200,
             "annotation":"","comments":[]}
        ]})
    if "folders=B1" in url:
        return _FakeResp({"status":"success","data":[
            {"id":"i2","name":"glass card","folders":["B1"],"width":300,"height":400,
             "annotation":"","comments":[
                 {"id":"c1","x":10,"y":20,"width":50,"height":60,"annotation":"玻璃强调标签"}
             ]}
        ]})
    raise AssertionError(f"unexpected url: {url}")


class TestBuildIndex(unittest.TestCase):
    def test_build_index_writes_jsonl_with_paths(self):
        with tempfile.TemporaryDirectory() as td:
            cache_path = os.path.join(td, "library_index.jsonl")
            with patch("lib.build_index.urlopen", side_effect=fake_urlopen):
                with patch("lib.build_index._thumb_path",
                           side_effect=lambda iid: f"/fake/{iid}_thumb.png"):
                    build_index(["UI-网页", "UI-移动端/质感"], cache_path)
            with open(cache_path) as f:
                lines = [json.loads(l) for l in f]
            self.assertEqual(len(lines), 2)
            ids = {l["id"] for l in lines}
            self.assertEqual(ids, {"i1", "i2"})
            # i2 应该带 1 条 comment,且 ann 字段保留(rename 自 annotation)
            i2 = next(l for l in lines if l["id"] == "i2")
            self.assertEqual(len(i2["comments"]), 1)
            c = i2["comments"][0]
            self.assertEqual(c["ann"], "玻璃强调标签")
            self.assertEqual(c["x"], 10)
            self.assertEqual(c["w"], 50)  # rename 自 width
            # folders 字段是路径而非 ID
            self.assertEqual(i2["folders"], ["UI-移动端/质感"])

    def test_build_index_raises_on_missing_path(self):
        with tempfile.TemporaryDirectory() as td:
            cache_path = os.path.join(td, "library_index.jsonl")
            with patch("lib.build_index.urlopen", side_effect=fake_urlopen):
                with self.assertRaises(KeyError):
                    build_index(["不存在的 folder"], cache_path)


if __name__ == "__main__":
    unittest.main()
```

**Step 2: 跑测试,确认失败**

```bash
cd ~/.claude/skills/找本地参考 && python3 -m unittest test.test_build_index -v
```

Expected: `ModuleNotFoundError: No module named 'lib.build_index'`

**Step 3: 实现 lib/build_index.py**

文件:`~/.claude/skills/找本地参考/lib/build_index.py`

```python
"""V2 cache 构建:按 SCOPE 内 folder 拉 item,写 JSONL,保留 comments 数组结构。"""

import json
import os
import sys
from urllib.request import urlopen
from urllib.parse import urlencode

from lib.folders import walk_tree, resolve_paths

EAGLE = "http://localhost:41595"


def _fetch_json(path, params=None):
    qs = ("?" + urlencode(params)) if params else ""
    with urlopen(f"{EAGLE}{path}{qs}", timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))


def _thumb_path(item_id):
    """调 /api/item/thumbnail?id=X 拿本地路径。失败返回空字符串。"""
    try:
        r = _fetch_json("/api/item/thumbnail", {"id": item_id})
        return r.get("data", "") if r.get("status") == "success" else ""
    except Exception:
        return ""


def build_index(scope_paths, cache_path):
    """根据 SCOPE 路径列表,拉 Eagle item,写 JSONL 到 cache_path。
    每行 schema:
      { id, folders[], name, width, height, thumb,
        comments: [{ id, x, y, w, h, ann }] }
    folders 字段是路径(非 ID)。"""
    tree = _fetch_json("/api/folder/list").get("data", [])
    path_to_id = walk_tree(tree)
    id_to_path = {v: k for k, v in path_to_id.items()}
    fids = resolve_paths(path_to_id, scope_paths)  # raises KeyError 若缺

    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    seen = set()
    with open(cache_path, "w") as out:
        for fid in fids:
            r = _fetch_json("/api/item/list", {"folders": fid, "limit": "10000"})
            for it in r.get("data", []):
                if it["id"] in seen:
                    continue
                seen.add(it["id"])
                folder_paths = [id_to_path.get(f) for f in it.get("folders", [])
                                if id_to_path.get(f)]
                cms = []
                for c in (it.get("comments") or []):
                    cms.append({
                        "id":  c.get("id", ""),
                        "x":   c.get("x", 0),
                        "y":   c.get("y", 0),
                        "w":   c.get("width", 0),
                        "h":   c.get("height", 0),
                        "ann": c.get("annotation", ""),
                    })
                out.write(json.dumps({
                    "id":       it["id"],
                    "folders":  folder_paths,
                    "name":     it.get("name", ""),
                    "width":    it.get("width", 0),
                    "height":   it.get("height", 0),
                    "thumb":    _thumb_path(it["id"]),
                    "comments": cms,
                }, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    # CLI:python3 -m lib.build_index <cache_path> <path1> <path2> ...
    if len(sys.argv) < 3:
        print("usage: python3 -m lib.build_index <cache_path> <folder_path>...",
              file=sys.stderr)
        sys.exit(2)
    build_index(sys.argv[2:], sys.argv[1])
```

**Step 4: 跑测试,确认通过**

```bash
cd ~/.claude/skills/找本地参考 && python3 -m unittest test.test_build_index -v
```

Expected: `OK`(2 tests passed)

---

### Task A7: 实现区域裁切(TDD,带真图 fixture)

**Files:**
- Create: `~/.claude/skills/找本地参考/lib/crop.py`
- Test: `~/.claude/skills/找本地参考/test/test_crop.py`
- Test fixture: `~/.claude/skills/找本地参考/test/fixtures/sample.jpg`(200×200 测试图)

**Step 1: 准备 fixture 图(用 sips 生成空图)**

```bash
mkdir -p ~/.claude/skills/找本地参考/test/fixtures
# 用 sips 把任意系统图片 resize 成 200×200 当 fixture
sips -z 200 200 /System/Library/Desktop\ Pictures/Solid\ Colors/Stone.png \
  --out ~/.claude/skills/找本地参考/test/fixtures/sample.jpg \
  --setProperty format jpeg 2>/dev/null \
  || cp /System/Library/Desktop\ Pictures/Solid\ Colors/Stone.png \
        ~/.claude/skills/找本地参考/test/fixtures/sample.jpg
ls -la ~/.claude/skills/找本地参考/test/fixtures/sample.jpg
```

(不同 macOS 版本系统图片路径可能不同;实在没合适来源就用 `sips` 生成 1×1 占位:
`sips -z 200 200 -s formatOptions normal -s format jpeg /tmp/blank.jpg --out test/fixtures/sample.jpg`)

**Step 2: 写失败的测试**

文件:`~/.claude/skills/找本地参考/test/test_crop.py`

```python
import unittest
import os
import tempfile
import subprocess

from lib.crop import crop_region

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "sample.jpg")


class TestCrop(unittest.TestCase):
    def setUp(self):
        if not os.path.exists(FIXTURE):
            self.skipTest(f"fixture not found: {FIXTURE}")

    def test_crop_returns_jpg_at_target_size(self):
        with tempfile.TemporaryDirectory() as td:
            out = os.path.join(td, "region.jpg")
            crop_region(FIXTURE, x=10, y=10, w=50, h=60, out_path=out)
            self.assertTrue(os.path.exists(out))
            # sips -g pixelWidth/pixelHeight 验证尺寸
            r = subprocess.run(
                ["sips", "-g", "pixelWidth", "-g", "pixelHeight", out],
                capture_output=True, text=True, check=True)
            self.assertIn("pixelWidth: 50", r.stdout)
            self.assertIn("pixelHeight: 60", r.stdout)

    def test_crop_idempotent_skip_if_exists(self):
        with tempfile.TemporaryDirectory() as td:
            out = os.path.join(td, "region.jpg")
            crop_region(FIXTURE, x=10, y=10, w=50, h=60, out_path=out)
            mtime1 = os.path.getmtime(out)
            crop_region(FIXTURE, x=10, y=10, w=50, h=60, out_path=out)
            mtime2 = os.path.getmtime(out)
            self.assertEqual(mtime1, mtime2)  # 没重新裁

    def test_crop_failure_raises(self):
        with tempfile.TemporaryDirectory() as td:
            out = os.path.join(td, "region.jpg")
            with self.assertRaises(RuntimeError):
                crop_region("/nonexistent/file.jpg", 0, 0, 10, 10, out)


if __name__ == "__main__":
    unittest.main()
```

**Step 3: 跑测试,确认失败**

```bash
cd ~/.claude/skills/找本地参考 && python3 -m unittest test.test_crop -v
```

Expected: `ModuleNotFoundError: No module named 'lib.crop'`

**Step 4: 实现 lib/crop.py**

文件:`~/.claude/skills/找本地参考/lib/crop.py`

```python
"""按 (x,y,w,h) 裁切图片到指定输出路径(macOS sips)。"""

import os
import subprocess


def crop_region(src_path, x, y, w, h, out_path):
    """sips 裁切。已有同路径输出则跳过(idempotent)。
    失败抛 RuntimeError 含 sips stderr。"""
    if os.path.exists(out_path):
        return out_path
    if not os.path.exists(src_path):
        raise RuntimeError(f"source image not found: {src_path}")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    # sips --crop H W -s formatOptions normal --setProperty format jpeg
    # 但 sips --crop 是「从中心裁」,无法指定 x/y 起点。
    # 改用 -c WIDTH HEIGHT 配合先 padToHeightWidth 不行——它也是中心。
    # macOS 没有原生命令行 x/y 裁切。最稳是 sips 的 cropOffset 私有标志或 AppleScript。
    # 用 Python 的 PIL? Python 标配没 PIL。
    # 折中:用 sips 配合 `--padToHeightWidth` 不行。
    # 最终方案:直接用 stdlib 的内联 base64+ascii85 不行。
    # 用 Python 调系统 `sips -c h w` 是中心裁,不满足。
    # 退回方案:用 Python `PIL.Image` 若可用,否则 fallback shell 调用 ffmpeg(若装了)。
    # 为了零依赖 + 准 x/y 裁:直接用 `python3 -c "from PIL import Image; ..."` 假定已装,失败再降级。
    # 但 PIL 不一定有。所以这里改用 Quartz 通过 Python 自带的 CoreGraphics 桥(macOS only)。
    cmd = [
        "python3", "-c",
        "import sys, Quartz, AppKit\n"
        "src, x, y, w, h, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), "
        "int(sys.argv[4]), int(sys.argv[5]), sys.argv[6]\n"
        "img = Quartz.CIImage.imageWithContentsOfURL_(AppKit.NSURL.fileURLWithPath_(src))\n"
        "if img is None: raise SystemExit('CIImage load failed')\n"
        "ext = img.extent()\n"
        "ih = ext.size.height\n"
        "# CoreImage 坐标系原点在左下,转换成左上原点的 (x,y)\n"
        "rect = Quartz.CGRectMake(x, max(0, ih - y - h), w, h)\n"
        "cropped = img.imageByCroppingToRect_(rect)\n"
        "ctx = Quartz.CIContext.contextWithOptions_(None)\n"
        "ns_url = AppKit.NSURL.fileURLWithPath_(out)\n"
        "color = Quartz.CGColorSpaceCreateDeviceRGB()\n"
        "ok = ctx.writeJPEGRepresentationOfImage_toURL_colorSpace_options_error_("
        "cropped, ns_url, color, None, None)\n"
        "if not ok[0]: raise SystemExit(f'write failed: {ok}')\n",
        src_path, str(int(x)), str(int(y)), str(int(w)), str(int(h)), out_path,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"crop failed: {r.stderr.strip() or r.stdout.strip()}")
    if not os.path.exists(out_path):
        raise RuntimeError(f"crop produced no file at {out_path}")
    return out_path
```

**注意 — 实现说明给执行者:**
- macOS 自带 `sips` 不支持 x/y 起点裁切(只能从中心)。所以本实现用 macOS 自带的 PyObjC + CoreImage 桥。Mac 系统 Python 通常带 PyObjC;如不可用,降级路径是装 Pillow(`pip install Pillow`)然后用 `PIL.Image.open(src).crop((x,y,x+w,y+h)).save(out, "JPEG")`。
- 测试 `test_crop_returns_jpg_at_target_size` 里期望 sips 报告尺寸 50×60;CoreImage 输出可能因像素对齐有 ±1 误差,如失败容忍 `pixelWidth: (49|50|51)`,但先按严格写,出问题再放宽。

**Step 5: 跑测试,确认通过**

```bash
cd ~/.claude/skills/找本地参考 && python3 -m unittest test.test_crop -v
```

Expected: `OK`(3 tests,允许 fixture 缺失时 skip)。如果 PyObjC 路径报错,改用 Pillow 方案。

---

### Task A8: 重写 SKILL.md

**Files:**
- Modify: `~/.claude/skills/找本地参考/SKILL.md`(完全重写)

**Step 1: 写新 SKILL.md**

完整新版内容(替换旧文件):

````markdown
---
name: 找本地参考
description: 从用户本地 Eagle 灵感库（~/Desktop/我的知识库/设计灵感.library/）中按指定范围检索参考图,基于 comments 区域级标注 + 视觉精筛挑出高相关候选,输出可落地的 3 方向设计改造方案。当用户粘贴来自 liaison Chrome 扩展「找参考」功能生成的结构化 prompt(含 `[使用 skill: 找本地参考]` 标签 + `[选中元素]` + `[搜索范围]` + `[我的问题]`)时自动触发。也在用户说"从我自己的灵感库找参考"时触发。与「找参考」skill(网络版)配对,本 skill 专走本地 Eagle 库。
---

# 找本地参考 Skill (V2)

## 输入识别

标准输入(来自 liaison 扩展)4 段:

```
[使用 skill: 找本地参考]
[页面] - URL ... - 标题 ...
[选中元素]
  - 选择器: ...
  - 内容预览: "..."
  - 关键样式: ...
  - 元素截图: <本地路径>
[搜索范围]
  - UI-网页
  - UI-桌面端
  - UI-移动端/版式
  - UI-移动端/质感
[我的问题] <一句话>
```

- 缺 `[搜索范围]` → 用默认 `["UI-网页", "UI-桌面端", "UI-移动端/版式", "UI-移动端/质感"]`
- 缺 `[元素截图]` 或路径无效 → 跳过 Step 3 视觉精筛(只用文本打分出 top 3)
- 缺 `[我的问题]` → 反问一次:"你对它具体哪里不满意?"

---

## 工作流(5 步)

### Step 1 · 加载 / 刷新 cache

```bash
CACHE="$HOME/.claude/skills/找本地参考/.cache/library_index.jsonl"
SKILL_DIR="$HOME/.claude/skills/找本地参考"
NOW=$(date +%s)
MT=$(stat -f %m "$CACHE" 2>/dev/null || echo 0)
if [[ ! -s "$CACHE" ]] || [[ $((NOW - MT)) -gt 86400 ]]; then
  cd "$SKILL_DIR"
  python3 -m lib.build_index "$CACHE" \
    "UI-网页" "UI-桌面端" "UI-移动端/版式" "UI-移动端/质感"
fi
```

(若 prompt 里指定了非默认范围,把这 4 个路径换成 prompt 给的)

### Step 2 · 文本粗筛 → top 15

```bash
cd ~/.claude/skills/找本地参考
python3 << PY
import json
from lib.scoring import tokenize, score_full, score_region

CACHE = "$CACHE"
problem = """{用户问题原文}"""
kws = tokenize(problem)

cands = []
for line in open(CACHE):
    img = json.loads(line)
    cands.append({
        "kind":"full","id":img["id"],"score":score_full(kws,img),
        "thumb":img["thumb"],"folders":img["folders"],"name":img["name"]
    })
    for c in img["comments"]:
        cands.append({
            "kind":"region","id":img["id"],"comment_id":c["id"],
            "rect":(c["x"],c["y"],c["w"],c["h"]),"ann":c["ann"],
            "score":score_region(kws,img,c),
            "folders":img["folders"],"name":img["name"],
            "thumb":img["thumb"]
        })

cands.sort(key=lambda c: -c["score"])
top15 = cands[:15]
print(json.dumps(top15, ensure_ascii=False))
PY
```

### Step 3 · 视觉精筛 → top 8

把 top15 的图(region 候选先用 `python3 -m lib.crop`-like 调用裁出小图,full 候选直接用缩略图)和元素截图一起 Read 进 vision 上下文。

```bash
# 对每个 region 候选裁切
cd ~/.claude/skills/找本地参考
python3 -c "
from lib.crop import crop_region
import json, sys
for c in json.loads(sys.argv[1]):
    if c['kind'] != 'region': continue
    src = c['thumb']  # TODO 这里用 thumb 还是原图?见说明
    x,y,w,h = c['rect']
    out = f'.cache/regions/{c[\"id\"]}_{c[\"comment_id\"]}.jpg'
    try: crop_region(src, x, y, w, h, out)
    except Exception as e: print(f'crop fail {c[\"id\"]}: {e}', file=sys.stderr)
" "$TOP15_JSON"
```

**关于 thumb vs 原图**:Eagle 的 thumbnail 一般是缩到 ~512px 长边,坐标在原图上。如果直接用 thumb + 原图坐标会偏。**正确做法是按 (原图 width / thumb width) 缩放坐标**,或干脆裁原图(`/api/item/info?id=X` → `data.filePath`)。实施时确认这一步,不行就退化为「不裁切,Read 整张缩略图」。

然后 Read 元素截图 + 候选图(region 裁切后的小图 / full 缩略图),一次性问 vision:

```
用户元素长这样:[Read element_screenshot]
用户问题:"{problem}"
候选 0-{N}:[Read 各候选]
对每张评 0-3 分(0=不相关 / 1=方向沾边 / 2=有借鉴价值 / 3=精准匹配),
按候选编号顺序回 JSON 数组,如 [2,0,3,1,...]
```

得到 scores 后:

```python
for cand, vs in zip(top15, scores):
    cand["final"] = cand["score"] + vs * 3
top8 = sorted(top15, key=lambda c: -c["final"])[:8]
```

### Step 4 · 多样性筛选 → 3 张

```python
from lib.diversity import select_diverse
selected = select_diverse(top8, k=3, excluded_dirs=getattr(state, "excluded_dirs", set()))
```

(`state.excluded_dirs` 仅在「重做」路径下从上轮 selected 累加,见 Step 6)

### Step 5 · 视觉分析 + 3 方向输出

**沿用 V1 SKILL.md §5.2-5.5 的所有规则**(从 SKILL.md.bak_v1_pre_rewrite 里复制过来):
- 5.2 三方向硬性差异化禁令(主色/背景/结构/字号/装饰)
- 5.3 每方案 4 项输出(命名 / 改动点 / 完整代码 / 绑定参考)
- 5.4 必须 Edit 到用户真实文件 + 加 A/B/C 切换器(参考 reading-switcher 模式)
- 5.5 视觉手法保真度自检(防止安全化打折)

### Step 6 · 反馈处理(无沉淀)

```python
if re.search(r"用\s*[A-Ca-c]|应用\s*[A-Ca-c]", user_msg):
    # 留下用户选的方向,Edit 删除其他两个 article + 切换器
    pass
elif re.search(r"重做|不行|换一下|没差异|都差不多", user_msg):
    excluded_ids |= set(s["id"] for s in selected)
    excluded_dirs |= set().union(*(dims(s) for s in selected))
    # 重走 Step 2-5,Step 4 传入 excluded_dirs
elif re.search(r"应用|改文件|Edit|直接改", user_msg):
    # 等价"用 当前 active 方向"
    pass
# 任何情况都不再写 Eagle annotation,不再写 cases.md
```

---

## 不要做的事

- ❌ 不要写回 Eagle 任何字段(annotation / comments)
- ❌ 不要让用户挑 folder(用 prompt 给的 [搜索范围],或默认 4 路径)
- ❌ 不要返回超过 5 张参考图
- ❌ 不要泛泛说"层级清晰、配色和谐",要落到具体数值/手法
- ❌ 不要把视觉分析跟代码改造分开成两次回答
- ❌ 不要再维护 cases.md / vocabulary.md 关键词体系

---

## 降级与失败处理

| 情况 | 处理 |
|---|---|
| Eagle API 不通 | Read `~/Desktop/我的知识库/设计灵感.library/metadata.json`;无 thumbnail 路径时退化纯文本打分,直接出 top 3 |
| 元素截图无效/缺失 | 跳过 Step 3 视觉精筛 |
| 范围内无命中 | 提示"在 [范围] 里没找到,要不要扩大到全 UI-移动端?" |
| sips/CoreImage 裁切失败 | 不裁切,Read 整张缩略图,prompt 加注 "看 (x,y,w,h) 区域" |
| Vision 评分返回非数字 | 该候选 visual_score=0 |
| folder 路径解析失败 | KeyError 包含可用路径示例,告诉用户 |

---

## 与「找参考」skill 的分工

| | 找参考(网络版) | 找本地参考(本 skill) |
|---|---|---|
| 数据源 | Pinterest / Dribbble / 精选网站 | 用户自己的 Eagle 库 |
| 何时用 | 探索新方向、储备审美 | 已有积累的方向,要快速落地 |
| 触发关键词 | "找参考"、"找灵感" | "从我的灵感库"、liaison 扩展生成的 prompt |
````

**Step 2: 跑全部测试**

```bash
~/.claude/skills/找本地参考/test/run_all.sh
```

Expected: `OK`(15 tests passed across 5 modules)。

---

### Task A9: Skill 端 smoke 测试(对真 Eagle 跑一次)

**前提:Eagle 客户端在跑(`pgrep -fl Eagle`)**

**Step 1: 触发 cache 刷新**

```bash
rm -rf ~/.claude/skills/找本地参考/.cache
cd ~/.claude/skills/找本地参考
python3 -m lib.build_index .cache/library_index.jsonl \
  "UI-网页" "UI-桌面端" "UI-移动端/版式" "UI-移动端/质感"
wc -l .cache/library_index.jsonl
```

Expected: 千余行(~1043 张图,实际数取决于库大小)。

**Step 2: 看一下 cache 内容长啥样**

```bash
head -1 ~/.claude/skills/找本地参考/.cache/library_index.jsonl | python3 -m json.tool
```

Expected: 含 `id`, `folders`(路径,不是 ID), `comments[]`(可能空)。

**Step 3: 不 commit(skill 不在 git 仓库)**

(skip)

---

## Phase B · 插件端扩展

### Task B1: 备份 bundle + 摘出「生成 Prompt」handler

**Files:**
- Backup: `toolbar/bundle.min.js` → `toolbar/bundle.min.js.bak_find_ref_v2`
- Recon (no edits): 把 byte 439K-455K 一段提到 `/tmp/find_ref_handler_recon.txt` 供分析

**Step 1: 备份**

```bash
cd /Users/iflytek/CC-project/liaison-patched
cp toolbar/bundle.min.js toolbar/bundle.min.js.bak_find_ref_v2
ls -la toolbar/bundle.min.js.bak_find_ref_v2
```

**Step 2: 摘出 handler 代码段**

```bash
# 从 byte 439000 开始摘 16 KB,应包含「哪里不满意」「生成 Prompt」「无子元素」全部
dd if=toolbar/bundle.min.js bs=1 skip=439000 count=16000 2>/dev/null > /tmp/find_ref_handler_recon.txt
wc -c /tmp/find_ref_handler_recon.txt
grep -c "生成 Prompt" /tmp/find_ref_handler_recon.txt
```

Expected: 16000 字节,`生成 Prompt` 出现 ≥ 1 次。

**Step 3: 在文件里找「生成 Prompt」附近的 click handler 模式**

```bash
# 印出 "生成 Prompt" 前后各 800 字符,方便人肉看
python3 -c "
with open('toolbar/bundle.min.js','rb') as f:
    data = f.read()
i = data.find('生成 Prompt'.encode('utf-8'))
print(data[max(0,i-800):i+1500].decode('utf-8', errors='replace'))
"
```

Expected: 看到 `addEventListener('click', ...)` 或类似的 onclick 绑定,以及 prompt 字符串拼装代码(含 `[使用 skill: 找本地参考]` 等模板字面量)。

**这一步是 Plan 阶段最关键的人肉判断**:
- 找到拼 prompt 的 template literal/string concat 起点和终点
- 找到 `navigator.clipboard.writeText(...)` 调用的位置
- 在这两者之间插入截图逻辑

**输出**:在执行者的工作笔记里记下 click handler 在 byte XXXXX 附近,prompt 拼装在 byte YYYYY,clipboard 调用在 byte ZZZZZ。

**Step 4: 还不修改 bundle,先 commit 备份**

```bash
git add toolbar/bundle.min.js.bak_find_ref_v2
git commit -m "chore(find-ref): backup bundle before V2 patch"
```

---

### Task B2: 写 prompt 构造器单元测试(TDD,纯函数先行)

**Files:**
- Test: `test/unit/find-ref-helpers.mjs`(新建)

理由:bundle 改动前,先把要插入的 helper(buildPromptV2、computeCropRect)以**独立可测函数**的形式确定下来,然后再去 bundle 里插。

**Step 1: 写 test 文件**

文件:`test/unit/find-ref-helpers.mjs`

```javascript
// Unit tests for find-reference V2 helpers (buildPromptV2 + computeCropRect).
// Helpers will be inlined into bundle.min.js; here we extract & test them
// independently before patching bundle.

import assert from 'node:assert';

// ---- 把 helper 直接 inline 在测试文件里,确保实现版本固定 ----
// (执行者:在 Task B3 patch bundle 时,把这两个函数原样贴进 bundle handler)

function buildPromptV2({ url, title, ctx, problem, screenshotPath, scopePaths }) {
  const styleLines = Object.entries(ctx.style || {})
    .filter(([k, v]) => v && v !== 'none' && v !== 'normal')
    .map(([k, v]) => `  - ${k}: ${v}`)
    .join('\n');
  const scopeLines = (scopePaths || [
    'UI-网页', 'UI-桌面端', 'UI-移动端/版式', 'UI-移动端/质感'
  ]).map(p => `- ${p}`).join('\n');
  const screenshotLine = screenshotPath
    ? `- 元素截图: ${screenshotPath}`
    : `- 元素截图: (截取失败,纯文本检索)`;
  return `[使用 skill: 找本地参考]

[页面]
- URL: ${url}
- 标题: ${title}

[选中元素]
- 选择器: ${ctx.selector}
- 内容预览: "${ctx.textPreview || ''}"
- 关键样式:
${styleLines || '  (无)'}
${screenshotLine}

[搜索范围]
${scopeLines}

[我的问题]
${problem}
`;
}

function computeCropRect(rect, dpr) {
  return {
    sx: Math.max(0, Math.round(rect.left * dpr)),
    sy: Math.max(0, Math.round(rect.top * dpr)),
    sw: Math.max(1, Math.round(rect.width * dpr)),
    sh: Math.max(1, Math.round(rect.height * dpr)),
  };
}

// ---- Tests ----

function test_buildPrompt_includes_all_sections() {
  const p = buildPromptV2({
    url: 'https://x.test/p',
    title: 'Test Page',
    ctx: {
      selector: 'div.card',
      textPreview: 'hello',
      style: { color: 'rgb(0,0,0)', padding: '12px', display: 'flex' }
    },
    problem: '太单调',
    screenshotPath: '/Users/me/Downloads/liaison-element-1234.jpg',
    scopePaths: null,  // 走默认
  });
  assert.match(p, /\[使用 skill: 找本地参考\]/);
  assert.match(p, /URL: https:\/\/x\.test\/p/);
  assert.match(p, /选择器: div\.card/);
  assert.match(p, /color: rgb\(0,0,0\)/);
  assert.match(p, /元素截图: \/Users\/me\/Downloads\/liaison-element-1234\.jpg/);
  assert.match(p, /UI-网页/);
  assert.match(p, /UI-移动端\/质感/);
  assert.match(p, /我的问题\]\n太单调/);
}

function test_buildPrompt_filters_default_styles() {
  const p = buildPromptV2({
    url: '', title: '',
    ctx: { selector: 'x', style: { color: 'rgb(1,1,1)', border: 'none', font: 'normal' } },
    problem: 'q', screenshotPath: '/x.jpg',
  });
  assert.match(p, /color: rgb\(1,1,1\)/);
  assert.doesNotMatch(p, /border: none/);
  assert.doesNotMatch(p, /font: normal/);
}

function test_buildPrompt_handles_missing_screenshot() {
  const p = buildPromptV2({
    url: '', title: '',
    ctx: { selector: 'x', style: {} },
    problem: 'q', screenshotPath: null,
  });
  assert.match(p, /元素截图: \(截取失败,纯文本检索\)/);
}

function test_buildPrompt_custom_scope() {
  const p = buildPromptV2({
    url: '', title: '',
    ctx: { selector: 'x', style: {} },
    problem: 'q', screenshotPath: '/x.jpg',
    scopePaths: ['UI-移动端/质感'],
  });
  assert.match(p, /搜索范围\]\n- UI-移动端\/质感\n/);
  assert.doesNotMatch(p, /UI-网页/);
}

function test_computeCropRect_dpr2_doubles() {
  const r = computeCropRect({ left: 10, top: 20, width: 100, height: 50 }, 2);
  assert.deepStrictEqual(r, { sx: 20, sy: 40, sw: 200, sh: 100 });
}

function test_computeCropRect_clamps_negative_origin() {
  const r = computeCropRect({ left: -5, top: -10, width: 50, height: 50 }, 1);
  assert.deepStrictEqual(r, { sx: 0, sy: 0, sw: 50, sh: 50 });
}

function test_computeCropRect_min_size_1() {
  const r = computeCropRect({ left: 0, top: 0, width: 0, height: 0 }, 1);
  assert.strictEqual(r.sw, 1);
  assert.strictEqual(r.sh, 1);
}

const tests = [
  test_buildPrompt_includes_all_sections,
  test_buildPrompt_filters_default_styles,
  test_buildPrompt_handles_missing_screenshot,
  test_buildPrompt_custom_scope,
  test_computeCropRect_dpr2_doubles,
  test_computeCropRect_clamps_negative_origin,
  test_computeCropRect_min_size_1,
];

let pass = 0, fail = 0;
for (const t of tests) {
  try { t(); console.log('PASS', t.name); pass++; }
  catch (e) { console.error('FAIL', t.name, '\n', e.message); fail++; }
}
console.log(`\n${pass}/${pass+fail} tests passed`);
process.exit(fail === 0 ? 0 : 1);
```

**Step 2: 跑测试**

```bash
cd /Users/iflytek/CC-project/liaison-patched
node test/unit/find-ref-helpers.mjs
```

Expected: `7/7 tests passed`,exit 0。

**Step 3: commit 测试**

```bash
git add test/unit/find-ref-helpers.mjs
git commit -m "test(find-ref): add unit tests for V2 prompt builder + crop rect"
```

---

### Task B3: Patch bundle.min.js 注入截图 + 新 prompt 拼装

**Files:**
- Modify: `toolbar/bundle.min.js`(在 Task B1 定位的 click handler 处插入新逻辑)

这是本计划**最易出错的一步**。建议执行者按以下顺序:

**Step 1: 写一个 helper 字符串(纯 JS,IIFE 风格,挂 window)**

在 bundle 头部(选个稳定锚点,比如 `__liaisonInsp` IIFE 之后)插入:

```javascript
;(function(){
  if (typeof window === "undefined" || window.__liaisonFindRef) return;
  function buildPromptV2({url,title,ctx,problem,screenshotPath,scopePaths}){
    var styleLines = Object.entries(ctx.style||{})
      .filter(function(kv){return kv[1]&&kv[1]!=="none"&&kv[1]!=="normal";})
      .map(function(kv){return "  - "+kv[0]+": "+kv[1];}).join("\n");
    var scope = (scopePaths||["UI-网页","UI-桌面端","UI-移动端/版式","UI-移动端/质感"])
      .map(function(p){return "- "+p;}).join("\n");
    var sline = screenshotPath ? "- 元素截图: "+screenshotPath
                               : "- 元素截图: (截取失败,纯文本检索)";
    return "[使用 skill: 找本地参考]\n\n"
      +"[页面]\n- URL: "+url+"\n- 标题: "+title+"\n\n"
      +"[选中元素]\n- 选择器: "+ctx.selector
      +"\n- 内容预览: \""+(ctx.textPreview||"")+"\""
      +"\n- 关键样式:\n"+(styleLines||"  (无)")+"\n"+sline+"\n\n"
      +"[搜索范围]\n"+scope+"\n\n[我的问题]\n"+problem+"\n";
  }
  function computeCropRect(rect,dpr){
    return {
      sx:Math.max(0,Math.round(rect.left*dpr)),
      sy:Math.max(0,Math.round(rect.top*dpr)),
      sw:Math.max(1,Math.round(rect.width*dpr)),
      sh:Math.max(1,Math.round(rect.height*dpr))
    };
  }
  async function captureElementScreenshot(el){
    var dpr = window.devicePixelRatio || 1;
    var rect = el.getBoundingClientRect();
    var crop = computeCropRect(rect, dpr);
    // 1. 拿 viewport dataURL
    var dataUrl = await new Promise(function(resolve,reject){
      chrome.runtime.sendMessage({action:"liaisonInspCaptureVisibleTab"},function(r){
        if(!r||!r.ok) return reject(new Error((r&&r.error)||"capture failed"));
        resolve(r.dataUrl);
      });
    });
    // 2. canvas 裁切
    var img = await new Promise(function(resolve,reject){
      var im = new Image(); im.onload=function(){resolve(im);}; im.onerror=reject; im.src=dataUrl;
    });
    var c = document.createElement("canvas");
    c.width = crop.sw; c.height = crop.sh;
    var cx = c.getContext("2d");
    cx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);
    var croppedUrl = c.toDataURL("image/jpeg", 0.85);
    // 3. download bridge 存盘
    var path = await new Promise(function(resolve,reject){
      chrome.runtime.sendMessage({action:"liaisonInspDownload",dataUrl:croppedUrl},function(r){
        if(!r||!r.ok) return reject(new Error((r&&r.error)||"download failed"));
        resolve(r.path);
      });
    });
    return path;
  }
  window.__liaisonFindRef = { buildPromptV2: buildPromptV2,
                              computeCropRect: computeCropRect,
                              captureElementScreenshot: captureElementScreenshot };
})();
```

**插入位置**:bundle 顶部 `__liaisonInsp` IIFE 紧后面(grep `}\)\(\);` 找到 IIFE 收尾,在它下一字节插入)。

**Step 2: 改写「生成 Prompt」click handler**

在 Task B1 找到的 handler 里,把原本的 prompt 拼装逻辑 + clipboard 调用 替换为:

```javascript
// 在原 handler 内部,把同步拼 prompt 改成 async:
async function onGenerateClick(/*...原签名...*/){
  var ctx = /*...原本提取选中元素 ctx 的代码...*/;
  var problem = /*...原本读 textarea 内容...*/;
  var url = location.href, title = document.title;
  var screenshotPath = null;
  try {
    if (window.__liaisonFindRef && /*选中元素的 DOM 节点*/) {
      screenshotPath = await window.__liaisonFindRef.captureElementScreenshot(/*el*/);
    }
  } catch(e) { console.warn("screenshot failed:", e); }
  var prompt = window.__liaisonFindRef.buildPromptV2({
    url:url, title:title, ctx:ctx, problem:problem,
    screenshotPath:screenshotPath, scopePaths:null
  });
  await navigator.clipboard.writeText(prompt);
  /*...原本的 toast / 关闭 modal 代码...*/
}
```

**注意**:
- 原 handler 可能不是 async。改成 async 后,事件绑定如果用 `.then().catch()` 包一层,避免 Chrome 报 unhandled rejection
- 选中元素的 DOM 引用可能是模块内闭包变量(如 `state.selectedEl`),按 bundle 实际命名替换占位符

**Step 3: 验证 bundle 仍能加载**

```bash
cd /Users/iflytek/CC-project/liaison-patched
node -e "
const fs = require('fs');
const code = fs.readFileSync('toolbar/bundle.min.js','utf8');
new Function(code);  // 不执行,只 parse
console.log('parse OK');
"
```

Expected: `parse OK`。如果报 SyntaxError,说明 patch 引入了语法错误,回退到 `bundle.min.js.bak_find_ref_v2` 重来。

**Step 4: 把 helper IIFE 也用 vm 跑一下基本调用(借测试文件验证)**

更新 `test/unit/find-ref-helpers.mjs`,加一段从 bundle 抽 IIFE 的检查(类似 `insp-helpers.mjs:13-18` 的 regex 抽 IIFE):

在文件顶部追加:

```javascript
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = fs.readFileSync(path.resolve(__dirname,'../../toolbar/bundle.min.js'),'utf8');
const m = BUNDLE.match(/\(function\(\)\{if\(typeof window==="undefined"\|\|window\.__liaisonFindRef\)return;[\s\S]*?\}\)\(\);/);
if (!m) { console.error('FAIL: __liaisonFindRef IIFE not in bundle'); process.exit(1); }

// 把 IIFE 跑在 sandbox 里验证 export
const sandbox = { window: {}, document: { createElement: ()=>({getContext:()=>({drawImage:()=>{}}),toDataURL:()=>"x"}) }, Image: function(){}, chrome: { runtime: { sendMessage: ()=>{} } } };
vm.createContext(sandbox);
vm.runInContext(m[0], sandbox);
if (!sandbox.window.__liaisonFindRef || typeof sandbox.window.__liaisonFindRef.buildPromptV2 !== 'function') {
  console.error('FAIL: buildPromptV2 not on window.__liaisonFindRef'); process.exit(1);
}
console.log('IIFE check PASS');
```

**Step 5: 跑全部测试**

```bash
node test/unit/find-ref-helpers.mjs
```

Expected: `IIFE check PASS` + `7/7 tests passed`。

**Step 6: commit bundle patch**

```bash
git add toolbar/bundle.min.js
git commit -m "feat(find-ref): V2 prompt with element screenshot + search scope"
```

---

### Task B4: 手动 E2E 验证

**前提**:
- Eagle 客户端在跑
- ~/.claude/skills/找本地参考/ 已按 Phase A 重写完毕
- bundle 已按 B3 patch 完毕,Chrome 重新加载扩展

**Step 1: 浏览器端**

1. 打开任意一张 UI 页面(比如自己的测试 fixture)
2. Alt+Shift+D 激活 Liaison
3. 切「找参考」tab,选一个元素
4. textarea 写 "这块太单调"
5. 点「生成 Prompt」
6. 看 toast:"已复制,粘到 Claude Code"

**Step 2: 验证剪贴板内容**

打开记事本/任意文本编辑器,Cmd+V。期望看到:

```
[使用 skill: 找本地参考]

[页面]
- URL: ...
- 标题: ...

[选中元素]
- 选择器: ...
- 内容预览: "..."
- 关键样式: ...
- 元素截图: /Users/iflytek/Downloads/liaison-ref.jpg     ← 关键

[搜索范围]
- UI-网页
- UI-桌面端
- UI-移动端/版式
- UI-移动端/质感

[我的问题]
这块太单调
```

**Step 3: 验证截图文件**

```bash
ls -la ~/Downloads/liaison-ref.jpg
sips -g pixelWidth -g pixelHeight ~/Downloads/liaison-ref.jpg
open ~/Downloads/liaison-ref.jpg
```

Expected: 文件存在,尺寸约等于元素 BCR × DPR,**只裁出选中元素**(不是整屏)。

**Step 4: CC 端**

1. 把上面剪贴板内容粘到 Claude Code
2. CC 应该自动触发「找本地参考」skill
3. 期望看到输出:
   - "检索路径: 范围内 N 张候选,用了关键词 [这块太单调];命中 region X 个 / full Y 个"
   - 3 个差异化方向 + Edit 进 demo 文件 + A/B/C 切换器
   - 末尾:"切换看看哪个对路。回 用 A/B/C..."

**Step 5: 边界 — Eagle 不通**

```bash
osascript -e 'quit app "Eagle"'
```

再粘一次刚才的 prompt 到 CC。期望:skill 走降级路径,不崩溃。

**Step 6: 边界 — cache 强制刷新**

```bash
touch -t 202401010000 ~/.claude/skills/找本地参考/.cache/library_index.jsonl
```

(把 mtime 改到去年)再触发一次 skill。期望:看到 cache 重建。

**Step 7: 没东西 commit**(E2E 验证产物)

(skip)

---

### Task B5: 收尾 + 文档化已知不做

**Files:**
- Modify: `~/.claude/skills/找本地参考/references/vocabulary.md`(标"暂不使用")

**Step 1: vocabulary.md 加注**

在 vocabulary.md 文件最顶部加一行:

```markdown
> **状态(2026-05-14)**: V2 重写后,本词表暂不参与检索流程。保留以备未来训练分类器或恢复关键词体系。
```

**Step 2: 不在 git 仓库,无需 commit**

(skip)

---

## 总览:任务依赖图

```
Phase A (skill,纯 Python)
  A1 备份/清理
   └─→ A2 测试脚手架
        ├─→ A3 folders         ┐
        ├─→ A4 scoring         │
        ├─→ A5 diversity       ├─→ A8 重写 SKILL.md ─→ A9 真 Eagle smoke
        ├─→ A6 build_index     │
        └─→ A7 crop            ┘

Phase B (插件)
  B1 备份 bundle + recon
   └─→ B2 写 helper 单元测试 ─→ B3 patch bundle ─→ B4 手动 E2E ─→ B5 收尾
```

A 与 B 彼此独立(A 不依赖 B,B 也不依赖 A),可以并行,但 B4 手动 E2E 需要 A8 重写完成才能完整跑通。

## 完成标准 (DoD)

- [ ] `~/.claude/skills/找本地参考/test/run_all.sh` 全 PASS
- [ ] `node test/unit/find-ref-helpers.mjs` 全 PASS
- [ ] 手动 E2E 完整走通(B4 全 6 步)
- [ ] 旧 cache.md / 旧 .cache 已清
- [ ] bundle 备份在位 `bundle.min.js.bak_find_ref_v2`
- [ ] 设计文档 `docs/superpowers/specs/2026-05-14-find-reference-v2-design.md` 已 commit
- [ ] 实施过程产物(测试 + bundle patch)已 commit
