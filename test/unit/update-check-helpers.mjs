// Unit tests for the version-update mechanism's pure logic:
//   1. liaisonIsNewerVersion  (liaison.js, background)  — segment-wise compare
//   2. decide                 (toolbar/update-modal.js) — modal gating
// Both are extracted from source and run in a vm sandbox, no browser needed.

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; } else { fail++; console.error(`FAIL: ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};

// -- 1. liaisonIsNewerVersion ------------------------------------------------
const BG = fs.readFileSync(path.resolve(__dirname, '../../liaison.js'), 'utf8');
const fnMatch = BG.match(/function liaisonIsNewerVersion\(latest, current\) \{[\s\S]*?\n\}/);
if (!fnMatch) { console.error('FAIL: liaisonIsNewerVersion not found in liaison.js'); process.exit(1); }
const bgCtx = {};
vm.createContext(bgCtx);
vm.runInContext(fnMatch[0] + '; this.isNewer = liaisonIsNewerVersion', bgCtx);
const isNewer = bgCtx.isNewer;

check('2.1 > 2.0',            isNewer('2.1', '2.0'), true);
check('2.0 not > 2.0',        isNewer('2.0', '2.0'), false);
check('2.0 not > 2.1',        isNewer('2.0', '2.1'), false);
check('0.10.0 > 0.9.0',       isNewer('0.10.0', '0.9.0'), true);   // 字符串比较会翻车的用例
check('2.0.1 > 2.0（补位）',   isNewer('2.0.1', '2.0'), true);
check('2.0 not > 2.0.0',      isNewer('2.0', '2.0.0'), false);

// -- 2. decide (modal gating) ------------------------------------------------
const MODAL = fs.readFileSync(path.resolve(__dirname, '../../toolbar/update-modal.js'), 'utf8');
// Run the whole IIFE with a minimal sandbox: storage.get rejects so run() exits
// before touching DOM; decide is grabbed off the fake window.
const win = {};
const modalCtx = {
  window: win,
  document: { visibilityState: 'visible', addEventListener() {}, createElement() { throw new Error('unreachable') } },
  chrome: { storage: { local: { get: () => Promise.reject(new Error('sandbox')) } }, runtime: {} },
  setTimeout,
};
vm.createContext(modalCtx);
vm.runInContext(MODAL, modalCtx);
const decide = win.__liaisonUpdateDecide;
if (typeof decide !== 'function') { console.error('FAIL: __liaisonUpdateDecide not exposed'); process.exit(1); }

const base = {
  liaisonUpdateAvailable: true,
  liaisonUpdateModalEligible: true,
  liaisonUpdateNotifyFloor: '2.1',
  liaisonUpdateModalDismissedFloor: null,
  liaisonUpdateModalLastShownDate: null,
};
const today = '2026-08-27';

check('最新版用户不弹',      decide({ ...base, liaisonUpdateAvailable: false }, today).reason, 'no-update');
check('过了门槛线只红点',    decide({ ...base, liaisonUpdateModalEligible: false }, today).reason, 'below-floor');
check('低于门槛线弹',        decide(base, today), { show: true, reason: 'show' });
check('已静音同一门槛线不弹', decide({ ...base, liaisonUpdateModalDismissedFloor: '2.1' }, today).reason, 'dismissed');
check('静音旧门槛线仍弹',    decide({ ...base, liaisonUpdateModalDismissedFloor: '2.0' }, today).show, true);
check('今天已弹过不弹',      decide({ ...base, liaisonUpdateModalLastShownDate: today }, today).reason, 'shown-today');
check('昨天弹过今天再弹',    decide({ ...base, liaisonUpdateModalLastShownDate: '2026-08-26' }, today).show, true);

console.log(`update-check-helpers: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
