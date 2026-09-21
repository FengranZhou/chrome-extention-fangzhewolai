#!/usr/bin/env node
/**
 * 把设计令牌的「内置兜底副本」从源头重新同步一次。
 *
 * ── 为什么需要兜底 ────────────────────────────────────────────────────
 * 令牌正常路径是运行时从 GitHub raw 拉取（见 design-system-ui.js 的
 * TOKENS_URL）。但 raw.githubusercontent.com 在国内并不稳定：拉不到
 * 且本地无缓存时，TOKENS 为 null → 整个增强层首行 return → 一个 token
 * 按钮都不长。同事侧最可能撞上这种情况，而且他们不会意识到「本该有按钮」。
 *
 * ── 为什么这次内联是安全的（上一次内联 catalog 翻过车）────────────────
 * design-system-ui.js 顶部记着那次教训：内联 catalog 手抄副本 → 改了源头
 * 不改它 → 两边漂。本脚本与那次的关键差别有三：
 *   ① **不是手抄**：数据由本脚本从源头 URL 拉取后机器生成，人不碰内容；
 *   ② **不参与正常路径**：仅在「远程拉不到 且 无本地缓存」时启用，
 *      属最后一道防线，不会覆盖或竞争新鲜数据；
 *   ③ **自带时间戳且会出声**：启用时 console.warn 告知正在用内置副本，
 *      漂了看得见，不会静默顶着过时数据装作正常。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────
 *   node tools/sync-token-fallback.mjs
 * 发版前跑一次即可（release.sh 未自动挂钩：兜底数据过时不影响正常路径，
 * 不值得为它卡住发版；真过时了运行时也会自己拉到新的）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const TOKENS_URL =
  'https://raw.githubusercontent.com/FengranZhou/design-system/main/scripts/design-tokens.json'

const HERE = dirname(fileURLToPath(import.meta.url))
const TARGET = join(HERE, '..', 'toolbar', 'design-system-ui.js')

const BEGIN = '  // ==== TOKEN_FALLBACK:BEGIN (generated, do not hand-edit) ===='
const END = '  // ==== TOKEN_FALLBACK:END ===='

// 走 curl 而非 node 的 fetch：undici 不读 HTTP(S)_PROXY 环境变量，
// 在需要代理才能出网的机器上会直接 ETIMEDOUT；curl 读。
let raw
try {
  raw = execFileSync('curl', ['-fsSL', TOKENS_URL + '?t=' + Date.now()], {
    encoding: 'utf8',
    timeout: 60000,
  })
} catch (e) {
  console.error(`✗ 拉取失败（${e.message}）—— 兜底副本未改动`)
  process.exit(1)
}

let data
try {
  data = JSON.parse(raw)
} catch (e) {
  console.error('✗ 源头返回的不是合法 JSON —— 兜底副本未改动')
  process.exit(1)
}

// 结构自检：缺字段的兜底比没兜底更坏（会让 UI 半残而非明确失败）
const REQUIRED = ['semanticColors', 'fontScale', 'spacing', 'radius']
const missing = REQUIRED.filter((k) => !Array.isArray(data[k]) || !data[k].length)
if (missing.length) {
  console.error(`✗ 源头数据缺字段：${missing.join(', ')} —— 兜底副本未改动`)
  process.exit(1)
}

const stamp = new Date().toISOString().slice(0, 10)
const json = JSON.stringify(data, null, 0)

const block = [
  BEGIN,
  `  // 源头：${TOKENS_URL}`,
  `  // 同步于：${stamp}　｜　重新同步：node tools/sync-token-fallback.mjs`,
  `  // ⚠️ 机器生成，勿手改 —— 手改会在下次同步时被覆盖，且失去与源头的可追溯性。`,
  `  const TOKENS_FALLBACK = ${json}`,
  `  const TOKENS_FALLBACK_STAMP = '${stamp}'`,
  END,
].join('\n')

const src = readFileSync(TARGET, 'utf8')
const bi = src.indexOf(BEGIN)
const ei = src.indexOf(END)
if (bi === -1 || ei === -1) {
  console.error('✗ 未找到 TOKEN_FALLBACK 标记块 —— 请先在 design-system-ui.js 里放好 BEGIN/END 标记')
  process.exit(1)
}

const next = src.slice(0, bi) + block + src.slice(ei + END.length)
writeFileSync(TARGET, next)

const counts = REQUIRED.map((k) => `${k}=${data[k].length}`).join(' ')
console.log(`✓ 兜底副本已同步（${stamp}）：${counts}　${(json.length / 1024).toFixed(1)}KB`)
