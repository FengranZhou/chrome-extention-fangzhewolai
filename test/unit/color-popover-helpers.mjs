// Headless test harness for window.__liaisonColorPopover.clamp
// Extracts the LAST IIFE (our appended helper) from bundle.min.js,
// evals it in a vm sandbox, then runs assertions on the pure clamp logic.

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = path.resolve(__dirname, '../../toolbar/bundle.min.js');
const BUNDLE = fs.readFileSync(BUNDLE_PATH, 'utf8');

// Bundle is concatenated: L1 = minified IIFEs (neg + insp + color-popover);
// L2+ = original non-minified liaison code that also references
// window.__liaisonColorPopover (a call-site we injected). We only want the
// IIFE that DEFINES the helper, which lives at the end of L1.
const LINE_1 = BUNDLE.split('\n')[0];
const marker = '__liaisonColorPopover';
const defIdx = LINE_1.lastIndexOf(marker);
if (defIdx === -1) {
  console.error('FAIL: __liaisonColorPopover helper not found in bundle L1');
  process.exit(1);
}
const iifeStart = LINE_1.lastIndexOf('(function()', defIdx);
const iifeEnd = LINE_1.indexOf('})();', defIdx);
if (iifeStart === -1 || iifeEnd === -1) {
  console.error('FAIL: could not extract color-popover IIFE from L1');
  process.exit(1);
}
const helperCode = LINE_1.slice(iifeStart, iifeEnd + 5);

const window = {};
const sandbox = { window, console };
vm.createContext(sandbox);
vm.runInContext(helperCode, sandbox);

let failures = 0;
function assert(label, cond) {
  if (cond) console.log('  ✓ ' + label);
  else { console.log('  ✗ ' + label); failures++; }
}

const CP = sandbox.window.__liaisonColorPopover;

console.log('=== C1: helper exposed on window ===');
assert('window.__liaisonColorPopover is object', CP && typeof CP === 'object');
assert('CP.clamp is function', typeof CP.clamp === 'function');
assert('CP.fit is function (attaches drag + clamp)', typeof CP.fit === 'function');

console.log('\n=== C2: clamp returns original position when popover fits in viewport ===');
{
  const r = CP.clamp(100, 100, 320, 400, 1280, 800, 8);
  assert('left unchanged', r.left === 100);
  assert('top unchanged', r.top === 100);
}

console.log('\n=== C3: clamp pulls in when popover overflows right edge ===');
{
  const r = CP.clamp(1000, 100, 320, 400, 1280, 800, 8);
  assert('left pulled to keep 8px right margin', r.left === 1280 - 320 - 8);
  assert('top unchanged', r.top === 100);
}

console.log('\n=== C4: clamp pulls up when popover overflows bottom edge ===');
{
  const r = CP.clamp(100, 700, 320, 400, 1280, 800, 8);
  assert('left unchanged', r.left === 100);
  assert('top pulled to keep 8px bottom margin', r.top === 800 - 400 - 8);
}

console.log('\n=== C5: clamp matches user screenshot — popover bottom cut off ===');
{
  // 参考截图：视口 1440×900，弹窗 320×400（含 SV 色板），anchor top=540 → 底部 940 超出视口 900
  const r = CP.clamp(1100, 540, 320, 400, 1440, 900, 8);
  assert('top pulled up to keep 8px bottom margin', r.top === 900 - 400 - 8);
  assert('left unchanged (fits horizontally)', r.left === 1100);
}

console.log('\n=== C5b: popover taller than viewport → pinned to top margin ===');
{
  const r = CP.clamp(100, 50, 320, 920, 1280, 800, 8);
  assert('oversized height → top pinned to margin', r.top === 8);
}

console.log('\n=== C6: clamp resists negative left/top ===');
{
  const r = CP.clamp(-50, -30, 320, 400, 1280, 800, 8);
  assert('negative left → margin', r.left === 8);
  assert('negative top → margin', r.top === 8);
}

console.log('\n=== C7: clamp handles popover wider than viewport ===');
{
  const r = CP.clamp(50, 50, 2000, 400, 1280, 800, 8);
  assert('oversized width → left pinned to margin', r.left === 8);
  assert('top unchanged', r.top === 50);
}

console.log('\n=== C8: margin defaults to 8 when omitted ===');
{
  const r = CP.clamp(1000, 100, 320, 400, 1280, 800);
  assert('default margin 8 applied on right overflow', r.left === 1280 - 320 - 8);
}

console.log('\n=== C9: bundle keeps neg + insp IIFEs intact (regression) ===');
assert('neg IIFE present', BUNDLE.includes('window.__liaisonNeg'));
assert('insp IIFE present', BUNDLE.includes('window.__liaisonInsp'));
assert('color popover IIFE is appended AFTER insp', BUNDLE.indexOf('__liaisonColorPopover') > BUNDLE.indexOf('buildPrompt:buildPrompt}})();'));

console.log('\n=== C10: fit() is wired into bindColorPopover only (not refresh path) ===');
{
  // syncColorPopoverDom is the INCREMENTAL refresh — runs on every SV drag /
  // hue slider move. Calling fit there would rewrite style.left/top mid-drag
  // and cause the whole popover to jitter while the user picks a color.
  // So fit must NOT be called from that path.
  const stylePos = BUNDLE.indexOf('this._colorPopoverAnchor?.top||16}px`');
  assert('syncColorPopoverDom entry still present', stylePos !== -1);
  // Take a 200-char window right after the style.top assignment and assert
  // no fit/__liaisonColorPopover call slipped in.
  const windowAfter = BUNDLE.slice(stylePos, stylePos + 200);
  assert('no fit call inside syncColorPopoverDom (prevents SV-drag jitter)', !windowAfter.includes('__liaisonColorPopover'));

  // bindColorPopover (fires on initial mount + every renderPanel) IS where fit runs.
  const bindStart = BUNDLE.indexOf('bindColorPopover(){const e=this.$shadow.querySelector("[data-color-popover]")');
  assert('bindColorPopover entry found', bindStart !== -1);
  const bindCall = BUNDLE.indexOf('window.__liaisonColorPopover', bindStart);
  assert('helper called from bindColorPopover (initial mount path)', bindCall !== -1 && bindCall - bindStart < 300);
}

console.log('\n=== C11: fit() writes back anchor only when clamp actually moved popover ===');
{
  // Build a minimal fake popover element + host and invoke fit directly.
  // If the popover fits inside the viewport, the host's anchor must remain untouched.
  const host = { _colorPopoverAnchor: { left: 100, top: 100 } };
  const fakeEl = {
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 320, height: 400, right: 420, bottom: 500 }),
    style: {},
    querySelector: () => null,
  };
  // Provide viewport-aware window/document for fit
  sandbox.window.innerWidth = 1280;
  sandbox.window.innerHeight = 800;
  sandbox.window.document = { documentElement: { clientWidth: 1280, clientHeight: 800 } };
  CP.fit(fakeEl, host);
  assert('anchor NOT written when popover fits viewport', host._colorPopoverAnchor.left === 100 && host._colorPopoverAnchor.top === 100);
  assert('style.left NOT set when no clamp needed', !('left' in fakeEl.style));
  assert('style.top NOT set when no clamp needed', !('top' in fakeEl.style));

  // Clamp needed: popover bottom-right overflows → anchor should be rewritten
  const host2 = { _colorPopoverAnchor: { left: 1100, top: 600 } };
  const fakeEl2 = {
    getBoundingClientRect: () => ({ left: 1100, top: 600, width: 320, height: 400, right: 1420, bottom: 1000 }),
    style: {},
    querySelector: () => null,
  };
  CP.fit(fakeEl2, host2);
  assert('anchor.left rewritten when right-overflow', host2._colorPopoverAnchor.left === 1280 - 320 - 8);
  assert('anchor.top rewritten when bottom-overflow', host2._colorPopoverAnchor.top === 800 - 400 - 8);
  assert('style.left set when clamp needed', fakeEl2.style.left === (1280 - 320 - 8) + 'px');
  assert('style.top set when clamp needed', fakeEl2.style.top === (800 - 400 - 8) + 'px');
}

console.log('\n' + (failures ? `FAIL (${failures})` : 'PASS'));
if (failures) process.exit(1);
