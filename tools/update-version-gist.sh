#!/bin/bash
# ============================================================================
# 版本广播 gist 维护脚本
# ----------------------------------------------------------------------------
# 妙想扩展的更新提醒机制用一个 public gist 上的 version.json 当版本广播源
# （background 消费端在 liaison.js 的 LIAISON_VERSION_CHECK_URL，两处互相指认）。
# 每次正式发版（把新包发给同事）后必须跑一次本脚本，否则旧版用户的
# 角标 / 弹窗永远不亮。
#
# 首次使用（建 gist + 回填 URL 到 liaison.js）：
#   brew install gh && gh auth login   # 若尚未安装/登录
#   bash tools/update-version-gist.sh --init
#
# 日常发版（版本号默认取 manifest.json）：
#   bash tools/update-version-gist.sh                       # 小版本：只更版本号
#   bash tools/update-version-gist.sh 2.1 --floor 2.1 \
#        --notes-file /tmp/notes.txt                        # 大版本：抬门槛线+换要点
#   bash tools/update-version-gist.sh --download-url 'https://...'  # 换下载页
#
# 与参考实现（UIToolBox）不同：本脚本是**合并式**更新——先读线上现值，
# 只覆盖本次显式传入的字段。发小版本不传 --floor 时，线上门槛线原样保留，
# 不会被清空（原版脚本全量覆盖，漏传即静默弄失效，是最大的运维坑）。
#
# version.json 字段：
#   version      最新版本号；远端 > 本地 → 扩展图标亮 NEW 角标
#   notifyFloor  弹窗门槛线；本地 < 门槛线 → 注入工具栏时弹强提醒
#   notes        弹窗要点（数组）。按「本阶段亮点汇总」写：收益导向、
#                最多 3 条、每条 ≤ 20 字、不写技术名词
#   downloadUrl  弹窗「去更新」跳转的下载页（内网 wiki / 网盘固定外链）
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MANIFEST="$PROJECT_DIR/manifest.json"
CONFIG="$SCRIPT_DIR/version-gist.config"
BACKGROUND_JS="$PROJECT_DIR/liaison.js"
PLACEHOLDER="REPLACE_WITH_GIST_RAW_URL"

# 本机命令行默认不走系统代理，gh/curl 直连 GitHub 会超时。未显式设代理且
# 本机代理端口（privoxy 8118）在监听时自动带上。
if [[ -z "${HTTPS_PROXY:-}" ]] && nc -z 127.0.0.1 8118 2>/dev/null; then
  export HTTPS_PROXY=http://127.0.0.1:8118 HTTP_PROXY=http://127.0.0.1:8118
fi

command -v gh >/dev/null || { echo "✗ 需要 gh CLI：brew install gh && gh auth login" >&2; exit 1; }
command -v jq >/dev/null || { echo "✗ 需要 jq：brew install jq" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "✗ gh 未登录：先 gh auth login" >&2; exit 1; }

manifest_version() { jq -r '.version' "$MANIFEST"; }

# ---------------------------------------------------------------- --init ----
if [[ "${1:-}" == "--init" ]]; then
  if [[ -f "$CONFIG" ]]; then
    echo "✗ $CONFIG 已存在，看起来已经初始化过；要重建请先删掉它" >&2; exit 1
  fi
  VERSION="$(manifest_version)"
  TMP_DIR="$(mktemp -d)"
  jq -n --arg v "$VERSION" '{version: $v}' > "$TMP_DIR/version.json"
  echo "→ 创建 public gist（version=${VERSION}）…"
  GIST_URL_HTML=$(gh gist create --public --desc "妙想扩展版本广播" "$TMP_DIR/version.json")
  GIST_ID="${GIST_URL_HTML##*/}"
  GIST_OWNER=$(gh api user --jq '.login')
  printf 'GIST_ID=%s\nGIST_OWNER=%s\n' "$GIST_ID" "$GIST_OWNER" > "$CONFIG"
  RAW_URL="https://gist.githubusercontent.com/$GIST_OWNER/$GIST_ID/raw/version.json"

  if grep -q "$PLACEHOLDER" "$BACKGROUND_JS"; then
    sed -i '' "s|$PLACEHOLDER|$RAW_URL|" "$BACKGROUND_JS"
    echo "✓ 已回填 liaison.js 的 LIAISON_VERSION_CHECK_URL"
  else
    echo "⚠ liaison.js 里没找到占位符（可能已回填过），请人工确认 URL 为：$RAW_URL"
  fi
  echo "✓ 初始化完成"
  echo "  gist:    $GIST_URL_HTML"
  echo "  raw URL: $RAW_URL"
  echo "  下一步：重新打包分发扩展；以后每次发版跑一次本脚本"
  exit 0
fi

# ---------------------------------------------------------------- 更新 ----
[[ -f "$CONFIG" ]] || { echo "✗ 未初始化：先跑 bash tools/update-version-gist.sh --init" >&2; exit 1; }
# shellcheck source=/dev/null
source "$CONFIG"

VERSION=""; FLOOR=""; NOTES_FILE=""; DOWNLOAD_URL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --floor)        FLOOR="${2:-}"; shift 2 ;;
    --notes-file)   NOTES_FILE="${2:-}"; shift 2 ;;
    --download-url) DOWNLOAD_URL="${2:-}"; shift 2 ;;
    -*) echo "✗ 未知参数：$1" >&2; exit 1 ;;
    *)  VERSION="$1"; shift ;;
  esac
done
[[ -z "$VERSION" ]] && VERSION="$(manifest_version)"
[[ -z "$VERSION" ]] && { echo "✗ 无法确定版本号" >&2; exit 1; }

# 读线上现值（走 API 不走 raw，避开 CDN 缓存），在其上合并本次字段
CURRENT=$(gh api "/gists/$GIST_ID" --jq '.files["version.json"].content' 2>/dev/null || echo '{}')
echo "$CURRENT" | jq -e . >/dev/null 2>&1 || CURRENT='{}'

JQ_ARGS=(--arg v "$VERSION"); JQ_MERGE='. + {version: $v}'
if [[ -n "$FLOOR" ]]; then
  JQ_ARGS+=(--arg f "$FLOOR"); JQ_MERGE="$JQ_MERGE + {notifyFloor: \$f}"
fi
if [[ -n "$NOTES_FILE" ]]; then
  [[ -f "$NOTES_FILE" ]] || { echo "✗ notes 文件不存在：$NOTES_FILE" >&2; exit 1; }
  NOTES_JSON=$(jq -R . "$NOTES_FILE" | jq -s 'map(select(. != ""))')   # 一行一条，去空行
  JQ_ARGS+=(--argjson notes "$NOTES_JSON"); JQ_MERGE="$JQ_MERGE + {notes: \$notes}"
fi
if [[ -n "$DOWNLOAD_URL" ]]; then
  JQ_ARGS+=(--arg d "$DOWNLOAD_URL"); JQ_MERGE="$JQ_MERGE + {downloadUrl: \$d}"
fi

CONTENT=$(echo "$CURRENT" | jq "${JQ_ARGS[@]}" "$JQ_MERGE")
echo "→ 更新 gist version.json："; echo "$CONTENT"

jq -n --arg c "$CONTENT" '{files:{"version.json":{content: $c}}}' \
  | gh api -X PATCH "/gists/$GIST_ID" --input - >/dev/null

# 回读校验（raw 有 ~5 分钟 CDN 缓存，拼时间戳绕过）
sleep 2
GOT=$(curl -s "https://gist.githubusercontent.com/$GIST_OWNER/$GIST_ID/raw/version.json?t=$(date +%s)")
GOT_VER=$(echo "$GOT" | jq -r '.version // empty' 2>/dev/null || true)
if [[ "$GOT_VER" == "$VERSION" ]]; then
  echo "✓ 已同步，线上现为：$GOT"
else
  echo "⚠ 线上 version=${GOT_VER}（CDN 可能尚未刷新，稍后再 curl 确认）"
fi
