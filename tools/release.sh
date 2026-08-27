#!/bin/bash
# ============================================================================
# 妙想一键发版 —— 「push一下，打好 tag 和备注」背后的执行体
# ----------------------------------------------------------------------------
# 用法：
#   bash tools/release.sh                       # 版本号取 manifest.json
#   bash tools/release.sh 2.1 --floor 2.1 --notes-file /tmp/notes.txt   # 大版本
#   bash tools/release.sh 2.0.1                 # 小版本（门槛线自动保留）
#   可选：--download-url U / --skip-tests / --dry-run（只构建不推送不广播）
#
# 流程：
#   1) 版本号写回 manifest.json（传了参数时）
#   2) 门禁：test/unit 全绿（--skip-tests 跳过）
#   3) 源码仓必须已提交（源码 commit/push 由「push一下」流程负责，本脚本不越权）
#   4) 按 tools/release-manifest.txt 白名单构建 staging
#   5) 同步 miaoxiang 产物仓克隆（extension/ bridge/ skills/ 用 --delete 精确镜像，
#      distribution/ 的安装器文件平铺到仓库根）→ commit + tag v<版本> + push
#   6) 调 update-version-gist.sh 更新版本广播（透传 --floor/--notes-file/--download-url）
#
# 契约提醒（CLAUDE.md）：发版前 Claude 需确认 大/小版本、notes 草稿、skills 变更摘要。
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MANIFEST_JSON="$PROJECT_DIR/manifest.json"
WHITELIST="$SCRIPT_DIR/release-manifest.txt"
SKILLS_SRC="$HOME/.claude/skills"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/release.config"

# 命令行代理自动检测（同 update-version-gist.sh：git push 走 SSH 不受影响，
# 但克隆缺仓库时的 https 探测与 gist 更新需要）
if [[ -z "${HTTPS_PROXY:-}" ]] && nc -z 127.0.0.1 8118 2>/dev/null; then
  export HTTPS_PROXY=http://127.0.0.1:8118 HTTP_PROXY=http://127.0.0.1:8118
fi

command -v jq >/dev/null || { echo "✗ 需要 jq" >&2; exit 1; }
command -v rsync >/dev/null || { echo "✗ 需要 rsync" >&2; exit 1; }

# ----------------------------------------------------------- 参数 ----
VERSION=""; FLOOR=""; NOTES_FILE=""; DOWNLOAD_URL=""; SKIP_TESTS=0; DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --floor)        FLOOR="${2:-}"; shift 2 ;;
    --notes-file)   NOTES_FILE="${2:-}"; shift 2 ;;
    --download-url) DOWNLOAD_URL="${2:-}"; shift 2 ;;
    --skip-tests)   SKIP_TESTS=1; shift ;;
    --dry-run)      DRY_RUN=1; shift ;;
    -*) echo "✗ 未知参数：$1" >&2; exit 1 ;;
    *)  VERSION="$1"; shift ;;
  esac
done

# ------------------------------------------- 1) 净土检查 + 版本号 ----
# 功能改动必须先走「push一下」流程提交；本脚本只允许自己产生并提交
# 「版本号 bump」这一个改动。
if [[ $DRY_RUN -eq 0 ]] && [[ -n "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then
  echo "✗ 源码仓有未提交改动。先提交源码，再跑本脚本。" >&2
  git -C "$PROJECT_DIR" status --short >&2
  exit 1
fi
CURRENT_VER=$(jq -r '.version' "$MANIFEST_JSON")
if [[ -n "$VERSION" && "$VERSION" != "$CURRENT_VER" ]]; then
  jq --arg v "$VERSION" '.version = $v' "$MANIFEST_JSON" > "$MANIFEST_JSON.tmp" \
    && mv "$MANIFEST_JSON.tmp" "$MANIFEST_JSON"
  if [[ $DRY_RUN -eq 0 ]]; then
    git -C "$PROJECT_DIR" add manifest.json
    git -C "$PROJECT_DIR" commit -m "chore(release): bump version to v$VERSION" >/dev/null
    git -C "$PROJECT_DIR" push origin main
    echo "→ manifest 版本 $CURRENT_VER → $VERSION（已提交推送）"
  fi
else
  VERSION="$CURRENT_VER"
fi
echo "→ 发版 v${VERSION}"

# ----------------------------------------------------- 2) 测试门禁 ----
if [[ $SKIP_TESTS -eq 0 ]]; then
  echo "→ 单测门禁…"
  for t in "$PROJECT_DIR"/test/unit/*.mjs; do
    node "$t" >/dev/null 2>&1 || { echo "✗ 单测失败：$t（先修再发，或 --skip-tests 强行跳过）" >&2; exit 1; }
  done
  echo "✓ 单测全绿"
fi

# ------------------------------------------------- 3) 构建 staging ----
STAGING=$(mktemp -d /tmp/miaoxiang-release.XXXXXX)
trap 'rm -rf "$STAGING"' EXIT
mkdir -p "$STAGING/extension" "$STAGING/bridge" "$STAGING/skills"

# 解析白名单：section 驱动
section=""
SKILL_LIST=()
SKILL_EXCLUDES=()
while IFS= read -r raw; do
  line="${raw%%#*}"; line="$(echo "$line" | xargs)" ; [[ -z "$line" ]] && continue
  if [[ "$line" =~ ^\[(.+)\]$ ]]; then section="${BASH_REMATCH[1]}"; continue; fi
  case "$section" in
    extension)
      src="$PROJECT_DIR/$line"
      [[ -e "$src" ]] || { echo "✗ 白名单文件不存在：$line" >&2; exit 1; }
      mkdir -p "$STAGING/extension/$(dirname "$line")"
      if [[ -d "$src" ]]; then
        rsync -a --exclude=.DS_Store --exclude='_backup*' --exclude='*.bak_*' \
          "$src/" "$STAGING/extension/$line/"
      else cp "$src" "$STAGING/extension/$line"; fi ;;
    bridge)
      src="$PROJECT_DIR/$line"
      [[ -e "$src" ]] || { echo "✗ 白名单文件不存在：$line" >&2; exit 1; }
      cp "$src" "$STAGING/bridge/$(basename "$line")" ;;
    skills)
      SKILL_LIST+=("$line") ;;
    skills-exclude)
      SKILL_EXCLUDES+=("--exclude=$line") ;;
    *) echo "✗ 白名单里有未知 section：[$section]" >&2; exit 1 ;;
  esac
done < "$WHITELIST"

for s in "${SKILL_LIST[@]}"; do
  src="$SKILLS_SRC/$s"
  [[ -d "$src" ]] || { echo "✗ skill 不存在：$src" >&2; exit 1; }
  rsync -a "${SKILL_EXCLUDES[@]}" "$src/" "$STAGING/skills/$s/"
done

# 白名单防呆：私有文件绝不允许出现在 staging
for banned in "extension/toolbar/owner-mode.js" "skills/找本地参考" "skills/找参考"; do
  [[ -e "$STAGING/$banned" ]] && { echo "✗ 私有内容混入分发包：$banned" >&2; exit 1; }
done

echo "✓ staging 构建完成：$(du -sh "$STAGING" | cut -f1)"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "→ dry-run：staging 内容如下（不推送、不广播）"
  find "$STAGING" -maxdepth 3 | sed "s|$STAGING|.|" | head -60
  exit 0
fi

# --------------------------------------------- 5) 同步 miaoxiang ----
if [[ ! -d "$MIAOXIANG_DIR/.git" ]]; then
  echo "→ 首次使用：克隆 $MIAOXIANG_SSH → $MIAOXIANG_DIR"
  git clone "$MIAOXIANG_SSH" "$MIAOXIANG_DIR"
fi
git -C "$MIAOXIANG_DIR" fetch origin 2>/dev/null || true
git -C "$MIAOXIANG_DIR" checkout -B main 2>/dev/null
git -C "$MIAOXIANG_DIR" pull --ff-only origin main 2>/dev/null || true

if git -C "$MIAOXIANG_DIR" rev-parse "v$VERSION" >/dev/null 2>&1; then
  echo "✗ tag v$VERSION 已存在——这个版本发过了，请抬版本号" >&2; exit 1
fi

rsync -a --delete "$STAGING/extension/" "$MIAOXIANG_DIR/extension/"
rsync -a --delete "$STAGING/bridge/"    "$MIAOXIANG_DIR/bridge/"
rsync -a --delete "$STAGING/skills/"    "$MIAOXIANG_DIR/skills/"
# 安装器与指引（distribution/ 平铺到仓库根；不 --delete，根目录还有 .git 等）
if [[ -d "$PROJECT_DIR/distribution" ]]; then
  rsync -a "$PROJECT_DIR/distribution/" "$MIAOXIANG_DIR/"
else
  echo "⚠ 缺 distribution/（安装器目录），本次发版不含安装器更新"
fi

if [[ -z "$(git -C "$MIAOXIANG_DIR" status --porcelain)" ]]; then
  echo "⚠ 产物无变化（与上一版完全相同），仍打 tag 并广播"
else
  git -C "$MIAOXIANG_DIR" add -A
  git -C "$MIAOXIANG_DIR" commit -m "release v$VERSION" >/dev/null
fi
git -C "$MIAOXIANG_DIR" tag "v$VERSION"
echo "→ 推送 miaoxiang…"
git -C "$MIAOXIANG_DIR" push origin main --tags

# --------------------------------------------------- 6) 版本广播 ----
GIST_ARGS=("$VERSION")
[[ -n "$FLOOR" ]]        && GIST_ARGS+=(--floor "$FLOOR")
[[ -n "$NOTES_FILE" ]]   && GIST_ARGS+=(--notes-file "$NOTES_FILE")
[[ -n "$DOWNLOAD_URL" ]] && GIST_ARGS+=(--download-url "$DOWNLOAD_URL")
bash "$SCRIPT_DIR/update-version-gist.sh" "${GIST_ARGS[@]}"

echo ""
echo "✓ v$VERSION 发版完成"
echo "  产物仓: $MIAOXIANG_WEB_URL (tag v$VERSION)"
echo "  同事侧: 每日自动更新器将拉平；角标/弹窗按门槛线提醒"
