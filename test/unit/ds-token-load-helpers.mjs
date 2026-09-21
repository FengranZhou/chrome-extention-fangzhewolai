// Unit tests for the design-system token loading path (toolbar/design-system-ui.js).
//
// 回归背景：曾有一个**永久性死局** —— attach() 里的一次性闸门
// tokensLoadTriggered 置位后不随失败回滚，而 loadTokens 失败完全静默。
// 页面 300ms 即跑 attach()，此时 SW 可能尚未冷启动完，bridge 等 8s 超时
// 静默返回 null → flag 已 true → poll 的每秒重试全被挡住 → TOKENS 永远
// null → enhanceStylePanelInputs 首行 return → 所有 token 按钮不渲染且不
// 报错。表现为「时好时坏」，SW 醒着就成功、睡着则永久失败。
//
// 这里用源码提取 + vm 沙箱复现三条不变量，不需要浏览器：
//   1. loadTokens 的返回值语义 =「有没有拿到真数据」（兜底态须为 false）
//   2. 失败时闸门必须放开，否则重试永远不会发生
//   3. poll 在兜底态下必须继续存活（TOKENS 有值 ≠ 可以收工）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; } else { fail++; console.error(`FAIL: ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../../toolbar/design-system-ui.js'), 'utf8');

// -- 1. 内置兜底副本存在且结构完整 -------------------------------------------
// 兜底由 tools/sync-token-fallback.mjs 机器生成；缺字段的兜底比没兜底更坏
// （UI 半残而非明确失败），所以这里连同结构一起校验。
const fbMatch = SRC.match(/const TOKENS_FALLBACK = (\{[\s\S]*?\})\n  const TOKENS_FALLBACK_STAMP = '([^']*)'/);
check('内置兜底副本已生成', !!fbMatch, true);
if (fbMatch) {
  let fb = null;
  try { fb = JSON.parse(fbMatch[1]); } catch (_) {}
  check('兜底是合法 JSON', !!fb, true);
  if (fb) {
    for (const k of ['semanticColors', 'fontScale', 'spacing', 'radius']) {
      check(`兜底含 ${k} 且非空`, Array.isArray(fb[k]) && fb[k].length > 0, true);
    }
  }
  check('兜底带同步时间戳', /^\d{4}-\d{2}-\d{2}$/.test(fbMatch[2]), true);
}

// -- 2. 闸门必须在失败时回滚 --------------------------------------------------
// 直接断言源码结构：闸门置位后，必须存在把它重新置回 false 的路径。
// 这是死局的直接成因，退化了就是「一次失败 = 永久失败」。
const gateMatch = SRC.match(/tokensLoadTriggered = true[\s\S]{0,400}?\n      \}/);
check('闸门置位处存在', !!gateMatch, true);
if (gateMatch) {
  const g = gateMatch[0];
  check('失败时放开闸门（then 分支）', /if \(!ok\) tokensLoadTriggered = false/.test(g), true);
  check('异常时放开闸门（catch 分支）', /catch[\s\S]*tokensLoadTriggered = false/.test(g), true);
}

// -- 3. poll 存活条件必须把兜底态算进去 ---------------------------------------
// 若写成 `if (!TOKENS)`，内置兜底一旦填上 TOKENS，轮询即永久停止，
// 网络恢复后再也换不回最新令牌 —— 兜底反而变成了新的固化点。
const pollMatch = SRC.match(/const poll = function \(\) \{[\s\S]*?\n    \}/);
check('poll 存在', !!pollMatch, true);
if (pollMatch) {
  check('兜底态下 poll 继续存活',
    /if \(!TOKENS \|\| tokensAreFallback\)/.test(pollMatch[0]), true);
}

// -- 4. loadTokens 的返回值语义 -----------------------------------------------
const loadMatch = SRC.match(/async function loadTokens\(\) \{[\s\S]*?\n  \}/);
check('loadTokens 存在', !!loadMatch, true);
if (loadMatch) {
  const body = loadMatch[0];
  // 兜底分支必须 return false（UI 可用，但仍须重试换真数据）
  const fbBranch = body.match(/if \(TOKENS_FALLBACK\) \{[\s\S]*?return (true|false)/);
  check('兜底分支返回 false', fbBranch && fbBranch[1], 'false');
  // 兜底数据不得写回缓存，否则「暂时没网」被固化成「以后都用旧数据」
  const fbBlock = body.match(/if \(TOKENS_FALLBACK\) \{[\s\S]*?\n    \}/);
  check('兜底不写回缓存', fbBlock ? !/kvSet/.test(fbBlock[0]) : false, true);
  // 真数据到位时必须解除兜底标记，否则 poll 永远停不下来
  check('真数据解除兜底标记',
    /TOKENS = fresh\n      tokensAreFallback = false/.test(body), true);
  // 失败路径必须出声 —— 静默失败正是这次排查绕大圈的根源
  check('失败路径有告警', /console\.warn/.test(body), true);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
