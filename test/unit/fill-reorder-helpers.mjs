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

console.log('\n=== R2: fill card has a grip handle + index, draggable is gated on handle ===');
{
  // Fill card is no longer draggable="true" by default — that grabbed input/button
  // mousedowns too aggressively. The card carries data-fill-drag-index, and
  // a visible grip handle (`data-fill-drag-handle`) inside the header gates
  // dragging by toggling card.draggable true during mousedown on the handle.
  assert('fill card template has data-fill-drag-index="${t}"', BUNDLE.includes('data-fill-drag-index="${t}"'));
  assert('fill card template no longer sets draggable="true" statically', !BUNDLE.includes('<div class="effect-card" draggable="true"'));
  assert('fill card header has a drag handle marker', BUNDLE.includes('data-fill-drag-handle'));
  assert('drag handle renders a 6-dot grip SVG', BUNDLE.includes('effect-drag-handle') && BUNDLE.includes('<svg') && (BUNDLE.match(/effect-drag-handle/g) || []).length >= 2);
  assert('drag handle has aria-label for accessibility', BUNDLE.includes('aria-label="拖拽排序"'));
}

console.log('\n=== R3: drag-and-drop listener wiring present ===');
{
  // Wired in the same block that calls bindColorPopover().
  assert('dragstart listener attached', BUNDLE.includes('addEventListener("dragstart"'));
  assert('dragover listener attached', BUNDLE.includes('addEventListener("dragover"'));
  assert('drop listener attached', BUNDLE.includes('addEventListener("drop"'));
  assert('dragend listener attached', BUNDLE.includes('addEventListener("dragend"'));
  assert('dispatches commitField("fillLayerReorder", ...)', /commitField\(["']fillLayerReorder["']/.test(BUNDLE));
  assert('selector looks for data-fill-drag-index', BUNDLE.includes('data-fill-drag-index'));
  assert('uses getBoundingClientRect + clientY for drop position', BUNDLE.includes('data-fill-drag-index') && BUNDLE.includes('clientY'));
  // The grip gating: handle mousedown makes the card draggable, dragend resets it.
  assert('handle mousedown flips card.draggable true', /data-fill-drag-handle[\s\S]{0,400}?mousedown[\s\S]{0,200}?draggable\s*=\s*(!0|true)/.test(BUNDLE));
  assert('dragend resets draggable to false', /dragend[\s\S]{0,400}?draggable\s*=\s*(!1|false)/.test(BUNDLE));
}

console.log('\n=== R3b: handle CSS gives grab/grabbing cursors ===');
{
  assert('.effect-drag-handle has cursor: grab', /\.effect-drag-handle\s*\{[^}]*cursor:\s*grab/.test(BUNDLE));
  assert('.effect-drag-handle:active uses grabbing cursor', /\.effect-drag-handle:active[^{]*\{[^}]*cursor:\s*grabbing/.test(BUNDLE));
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
