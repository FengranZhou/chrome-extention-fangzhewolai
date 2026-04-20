// Headless test harness for window.__liaisonNeg helpers.
// Extracts the IIFE from the head of bundle.min.js, evals it in a vm
// sandbox with a minimal DOM polyfill, then runs assertions.

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = path.resolve(__dirname, '../../toolbar/bundle.min.js');
const BUNDLE = fs.readFileSync(BUNDLE_PATH, 'utf8');

// Extract the first IIFE only (our injected helper).
const match = BUNDLE.match(/^\(function\(\)\{.*?\}\)\(\);/);
if (!match) {
  console.error('FAIL: could not find injected IIFE');
  process.exit(1);
}
const helperCode = match[0];

// ---- Minimal DOM polyfill --------------------------------------------------
class Element {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this.nodeType = 1;
    this.attrs = {};
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this._text = '';
    this._display = 'block';
    this._flexDirection = 'row';
  }
  get id() { return this.attrs.id || ''; }
  set id(v) { if (v) this.attrs.id = String(v); else delete this.attrs.id; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; }
    return c;
  }
  contains(c) {
    if (c === this) return true;
    for (const ch of this.children) if (ch.contains && ch.contains(c)) return true;
    return false;
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = v; }
}

const document = {
  _head: new Element('head'),
  get head() { return this._head; },
  getElementById(id) {
    const walk = (el) => {
      if (el.attrs && el.attrs.id === id) return el;
      for (const c of el.children || []) {
        const r = walk(c);
        if (r) return r;
      }
      return null;
    };
    return walk(this._head);
  },
  createElement(tag) { return new Element(tag); },
};

const window = {};
const sandbox = {
  window,
  document,
  getComputedStyle: (el) => ({
    display: el._display,
    flexDirection: el._flexDirection,
  }),
  Math,
  Map,
  String,
  Number,
  parseInt,
  parseFloat,
  console,
};
sandbox.window.document = document;
sandbox.window.getComputedStyle = sandbox.getComputedStyle;

vm.createContext(sandbox);
vm.runInContext(helperCode, sandbox);

const neg = sandbox.window.__liaisonNeg;
if (!neg) { console.error('FAIL: __liaisonNeg not on window'); process.exit(1); }

// ---- Assertions -----------------------------------------------------------
let failures = 0;
function assert(name, cond, actual, expected) {
  if (cond) {
    console.log('  ✓ ' + name);
  } else {
    console.log('  ✗ ' + name);
    console.log('    actual:   ' + JSON.stringify(actual));
    console.log('    expected: ' + JSON.stringify(expected));
    failures++;
  }
}

function currentStyleText() {
  const node = document.getElementById('liaison-neg-styles');
  return node ? node._text : null;
}

function resetDom() {
  document._head = new Element('head');
  // reset internal styleNode reference by calling set with 0 on a fresh elem:
  // easier: re-run helper (it is idempotent-guarded by window.__liaisonNeg check, so we need to clear it)
}

console.log('\n=== Test 1: block padding-top negative → first-child margin-top ===');
{
  resetDom();
  // The IIFE uses a closure-scoped styleNode var; we can't reset it externally.
  // But since the CSS is regenerated from registry every call, and we test with
  // fresh uuids per test, the side-effect accumulates but is still testable.
  const el = new Element('div');
  el._display = 'block';
  neg.set(el, 'pt', 8);
  const hasAttr = el.getAttribute('data-liaison-neg');
  assert('element got data-liaison-neg attr', !!hasAttr);
  const css = currentStyleText();
  assert(
    'CSS contains first-child margin-top: -8px',
    css && css.includes(`[data-liaison-neg="${hasAttr}"] > *:first-child { margin-top: -8px !important; }`),
    css
  );
}

console.log('\n=== Test 2: flex-row padding-top negative → all children margin-top ===');
{
  const el = new Element('div');
  el._display = 'flex';
  el._flexDirection = 'row';
  neg.set(el, 'pt', 5);
  const u = el.getAttribute('data-liaison-neg');
  const css = currentStyleText();
  assert(
    'flex-row: > * { margin-top: -5px }',
    css.includes(`[data-liaison-neg="${u}"] > * { margin-top: -5px !important; }`),
    css
  );
}

console.log('\n=== Test 3: flex-row gap negative → :not(:first-child) margin-left ===');
{
  const el = new Element('div');
  el._display = 'flex';
  el._flexDirection = 'row';
  neg.set(el, 'gap', 10);
  const u = el.getAttribute('data-liaison-neg');
  const css = currentStyleText();
  assert(
    'flex-row gap: :not(:first-child) margin-left -10px',
    css.includes(`[data-liaison-neg="${u}"] > *:not(:first-child) { margin-left: -10px !important; }`),
    css
  );
}

console.log('\n=== Test 4: flex-col gap negative → :not(:first-child) margin-top ===');
{
  const el = new Element('div');
  el._display = 'flex';
  el._flexDirection = 'column';
  neg.set(el, 'gap', 6);
  const u = el.getAttribute('data-liaison-neg');
  const css = currentStyleText();
  assert(
    'flex-col gap: :not(:first-child) margin-top -6px',
    css.includes(`[data-liaison-neg="${u}"] > *:not(:first-child) { margin-top: -6px !important; }`),
    css
  );
}

console.log('\n=== Test 5: grid gap negative → both margin-left and margin-top ===');
{
  const el = new Element('div');
  el._display = 'grid';
  neg.set(el, 'gap', 4);
  const u = el.getAttribute('data-liaison-neg');
  const css = currentStyleText();
  assert(
    'grid gap: :not(:first-child) margin-left -4px AND margin-top -4px',
    css.includes(`[data-liaison-neg="${u}"] > *:not(:first-child) { margin-left: -4px !important; margin-top: -4px !important; }`),
    css
  );
}

console.log('\n=== Test 6: set → clear → attr removed, registry empty ===');
{
  const el = new Element('div');
  el._display = 'block';
  neg.set(el, 'pt', 7);
  assert('attr present after set', el.hasAttribute('data-liaison-neg'));
  neg.set(el, 'pt', 0);
  assert('attr removed after clear', !el.hasAttribute('data-liaison-neg'));
}

console.log('\n=== Test 7: read returns negative when registry has value ===');
{
  const el = new Element('div');
  el._display = 'block';
  neg.set(el, 'pt', 15);
  const r = neg.read(el, 'pt', '0px');  // raw CSS value is 0 (we zeroed out)
  assert('read returns -15', r === -15, r, -15);
}

console.log('\n=== Test 8: read falls back to raw css when no registry entry ===');
{
  const el = new Element('div');
  const r = neg.read(el, 'pt', '12px');
  assert('read returns 12 from raw', r === 12, r, 12);
}

console.log('\n=== Test 9: read returns 0 for garbage raw input ===');
{
  const el = new Element('div');
  const r = neg.read(el, 'pt', 'auto');
  assert('read returns 0 for "auto"', r === 0, r, 0);
}

console.log('\n=== Test 10: multiple keys coexist in same registry entry ===');
{
  const el = new Element('div');
  el._display = 'block';
  neg.set(el, 'pt', 3);
  neg.set(el, 'gap', 2);
  const u = el.getAttribute('data-liaison-neg');
  const css = currentStyleText();
  assert(
    'pt rule present',
    css.includes(`[data-liaison-neg="${u}"] > *:first-child { margin-top: -3px !important; }`)
  );
  assert(
    'gap rule present (block falls back to vertical)',
    css.includes(`[data-liaison-neg="${u}"] > *:not(:first-child) { margin-top: -2px !important; }`)
  );
}

console.log('\n' + (failures ? `FAIL (${failures} assertions)` : 'PASS'));
process.exit(failures ? 1 : 0);
