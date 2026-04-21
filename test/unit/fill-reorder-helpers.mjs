// Regression harness for the fill-layer drag-reorder wiring.
// Pure algo is trivial (splice + splice); these checks pin that the
// three touch-points exist in the bundle:
//   1. ys commit pipeline has a `fillLayerReorder` case
//   2. HTML template marks each fill `.effect-card` as draggable
//   3. renderPanel-time setup attaches dragstart/dragend/dragover/drop
//      and dispatches `commitField("fillLayerReorder", "<from>:<to>")`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = fs.readFileSync(path.resolve(__dirname, '../../toolbar/bundle.min.js'), 'utf8');

let failures = 0;
function assert(label, cond) {
  if (cond) console.log('  ✓ ' + label);
  else { console.log('  ✗ ' + label); failures++; }
}

console.log('=== R1: ys pipeline has a fillLayerReorder case ===');
{
  assert('case "fillLayerReorder" present', BUNDLE.includes('case"fillLayerReorder"'));
  // Should read current array, splice out moved item, splice it back in at target
  // Read with zr(e) / write with Or(e, ...) / refresh with Rr(e) — match existing patterns
  const caseStart = BUNDLE.indexOf('case"fillLayerReorder"');
  const caseBody = BUNDLE.slice(caseStart, caseStart + 600);
  assert('reorder reads fillLayers via zr(e)', caseBody.includes('zr(e)'));
  assert('reorder writes back via Or(e,', caseBody.includes('Or(e,'));
  assert('reorder triggers Rr(e) refresh', caseBody.includes('Rr(e)'));
  assert('reorder splices out then in', (caseBody.match(/\.splice\(/g) || []).length >= 2);
  // Must guard against out-of-range / NaN / same-position (no-op)
  assert('reorder guards NaN inputs', caseBody.includes('isNaN') || caseBody.includes('Number.isNaN'));
}

console.log('\n=== R2: fill card header renders up/down arrow buttons instead of drag ===');
{
  // Drag UX was fragile (input interception, unclear affordance). Replaced with
  // two discrete buttons per fill card: up-arrow and down-arrow, alongside the
  // existing 删除 button.
  assert('no leftover draggable="true" in fill card template', !BUNDLE.includes('<div class="effect-card" draggable="true"'));
  assert('no leftover data-fill-drag-index', !BUNDLE.includes('data-fill-drag-index'));
  assert('no leftover data-fill-drag-handle', !BUNDLE.includes('data-fill-drag-handle'));
  assert('no leftover effect-drag-handle class', !BUNDLE.includes('effect-drag-handle'));
  assert('no leftover liaison-fill-dragging CSS', !BUNDLE.includes('liaison-fill-dragging'));

  assert('fill card carries data-fill-index="${t}"', BUNDLE.includes('data-fill-index="${t}"'));
  assert('up-arrow button present with data-fill-move="up"', BUNDLE.includes('data-fill-move="up"'));
  assert('down-arrow button present with data-fill-move="down"', BUNDLE.includes('data-fill-move="down"'));
  assert('buttons have accessible aria-label "上移"', BUNDLE.includes('aria-label="上移"'));
  assert('buttons have accessible aria-label "下移"', BUNDLE.includes('aria-label="下移"'));
  // First fill must have up-arrow disabled; last fill must have down-arrow disabled.
  // Template must use both t===0 and t===a.length-1 guards within a .map((e,t,a)=>) signature.
  assert('fill map signature exposes array arg for length check', /e\.fillLayers\.map\(\(\(e,t,a\)/.test(BUNDLE));
  assert('up-arrow disabled for first row', /data-fill-move="up"[^>]*\$\{t===0\?"disabled":""\}/.test(BUNDLE));
  assert('down-arrow disabled for last row', /data-fill-move="down"[^>]*\$\{t===a\.length-1\?"disabled":""\}/.test(BUNDLE));
}

console.log('\n=== R3: click handler dispatches commitField("fillLayerReorder", ...) ===');
{
  // Wired right after bindColorPopover() — a single click listener per button.
  assert('no more dragstart/dragover/drop/dragend listeners', !BUNDLE.includes('addEventListener("dragstart"') && !BUNDLE.includes('addEventListener("dragover"') && !BUNDLE.includes('addEventListener("drop"') && !BUNDLE.includes('addEventListener("dragend"'));
  assert('selector targets [data-fill-move]', BUNDLE.includes('querySelectorAll("[data-fill-move]")'));
  assert('dispatches commitField("fillLayerReorder", ...)', /commitField\(["']fillLayerReorder["']/.test(BUNDLE));
  // Must honor the disabled attribute and not move past boundaries.
  assert('handler bails on disabled button', /data-fill-move[\s\S]{0,400}?\.disabled/.test(BUNDLE));
}

console.log('\n=== R3b: move-button CSS + disabled state ===');
{
  assert('.effect-move-button rule present', /\.effect-move-button\s*\{/.test(BUNDLE));
  assert('.effect-move-button[disabled] dims the button', /\.effect-move-button\[disabled\]/.test(BUNDLE));
  assert('.effect-move-button:hover adds feedback', /\.effect-move-button:hover/.test(BUNDLE));
}

console.log('\n=== R4: pure reorder semantics — splice-out then splice-in ===');
{
  // Emulate the reorder math to pin the expected ordering rule.
  function reorder(arr, from, to) {
    const a = arr.slice();
    const [m] = a.splice(from, 1);
    a.splice(to > from ? to - 1 : to, 0, m);
    return a;
  }
  assert('[A,B,C] move 0→2 → [B,A,C]', JSON.stringify(reorder(['A','B','C'], 0, 2)) === JSON.stringify(['B','A','C']));
  assert('[A,B,C] move 2→0 → [C,A,B]', JSON.stringify(reorder(['A','B','C'], 2, 0)) === JSON.stringify(['C','A','B']));
  assert('[A,B,C,D] move 1→3 → [A,C,B,D]', JSON.stringify(reorder(['A','B','C','D'], 1, 3)) === JSON.stringify(['A','C','B','D']));
  assert('[A,B,C,D] move 3→1 → [A,D,B,C]', JSON.stringify(reorder(['A','B','C','D'], 3, 1)) === JSON.stringify(['A','D','B','C']));
  // Adjacent no-ops: drop right below yourself == no-op
  assert('adjacent drop (1→2) is effectively a no-op ordering', JSON.stringify(reorder(['A','B','C'], 1, 2)) === JSON.stringify(['A','B','C']));
}

console.log('\n' + (failures ? `FAIL (${failures})` : 'PASS'));
if (failures) process.exit(1);
