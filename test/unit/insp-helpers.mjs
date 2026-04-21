// Unit tests for window.__liaisonInsp helpers.
// Page-world code (bundle) talks to content-script bridge via postMessage.
// Sandbox below simulates both worlds.

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = fs.readFileSync(path.resolve(__dirname, '../../toolbar/bundle.min.js'), 'utf8');

const match = BUNDLE.match(/\(function\(\)\{if\(typeof window==="undefined"\|\|window\.__liaisonInsp\)return;[\s\S]*?\}\)\(\);/);
if (!match) {
  console.error('FAIL: could not find __liaisonInsp IIFE');
  process.exit(1);
}
const helperCode = match[0];

// ---- DOM + Element polyfill ----------------------------------------------
class Element {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this.nodeType = 1;
    this.className = '';
    this.innerText = '';
    this.textContent = '';
    this.style = {
      _props: {},
      setProperty(k, v) { this._props[k] = v; },
    };
    this._computed = {};
  }
}

// ---- chrome.storage.local mock -------------------------------------------
const chromeStorage = {
  _data: {},
  local: {
    get(keys, cb) {
      const out = {};
      (Array.isArray(keys) ? keys : [keys]).forEach(k => {
        if (k in chromeStorage._data) out[k] = JSON.parse(JSON.stringify(chromeStorage._data[k]));
      });
      setTimeout(() => cb(out), 0);
    },
    set(payload, cb) {
      Object.assign(chromeStorage._data, JSON.parse(JSON.stringify(payload)));
      setTimeout(() => { if (cb) cb(); }, 0);
    },
  },
};

// ---- postMessage event bus + window polyfill ------------------------------
const messageListeners = [];
const window = {
  addEventListener(type, fn) { if (type === 'message') messageListeners.push(fn); },
  removeEventListener(type, fn) {
    if (type === 'message') {
      const i = messageListeners.indexOf(fn);
      if (i >= 0) messageListeners.splice(i, 1);
    }
  },
  postMessage(data) {
    // Fire to listeners on next tick, mimicking browser behavior
    setTimeout(() => {
      for (const fn of [...messageListeners]) {
        try { fn({ source: window, data }); } catch (e) { console.error('listener threw:', e); }
      }
    }, 0);
  },
};

// ---- Content-script bridge (mirrors inject.js) ----------------------------
window.addEventListener('message', async (event) => {
  if (event.source !== window) return;
  const d = event.data;
  if (!d || d._liaisonInspBridge !== true || !d.id) return;
  try {
    let result;
    if (d.action === 'get') {
      result = await new Promise(resolve => chromeStorage.local.get([d.payload.key], o => resolve(o && o[d.payload.key])));
    } else if (d.action === 'set') {
      await new Promise((resolve) => chromeStorage.local.set({ [d.payload.key]: d.payload.value }, () => resolve()));
      result = true;
    } else return;
    window.postMessage({ _liaisonInspBridgeReply: true, id: d.id, ok: true, result }, '*');
  } catch (err) {
    window.postMessage({ _liaisonInspBridgeReply: true, id: d.id, ok: false, error: String(err) }, '*');
  }
});

// ---- Sandbox setup --------------------------------------------------------
const document = { title: 'Test Page' };
const location = { href: 'https://example.com/path?x=1' };

const sandbox = {
  window,
  document,
  location,
  chrome: { storage: chromeStorage, runtime: {} },
  getComputedStyle: (el) => ({ getPropertyValue: (k) => el._computed[k] || '' }),
  Math, Map, String, Number, parseInt, parseFloat, console,
  Promise, Date, URL,
  setTimeout, clearTimeout, Error,
};
sandbox.window.document = document;
sandbox.window.location = location;
sandbox.window.chrome = sandbox.chrome;
sandbox.window.getComputedStyle = sandbox.getComputedStyle;
sandbox.window.setTimeout = setTimeout;
sandbox.window.Promise = Promise;

vm.createContext(sandbox);
vm.runInContext(helperCode, sandbox);

const insp = sandbox.window.__liaisonInsp;
if (!insp) { console.error('FAIL: __liaisonInsp not on window'); process.exit(1); }

let failures = 0;
function assert(name, cond, actual, expected) {
  if (cond) console.log('  ✓ ' + name);
  else {
    console.log('  ✗ ' + name);
    if (actual !== undefined) console.log('    actual:   ' + JSON.stringify(actual));
    if (expected !== undefined) console.log('    expected: ' + JSON.stringify(expected));
    failures++;
  }
}

console.log('\n=== T1: capture() returns expected snapshot shape ===');
{
  const el = new Element('button');
  el.className = 'btn primary';
  el.innerText = 'Hello world';
  el._computed = {
    'color': 'rgb(255, 255, 255)',
    'background-color': 'rgb(35, 178, 131)',
    'border-radius': '8px',
    'padding-top': '6px',
  };
  const snap = insp.capture(el);
  assert('id present', snap && /^insp-[a-z0-9]{4,}$/.test(snap.id));
  assert('source.hostname', snap.source.hostname === 'example.com');
  assert('element.tagName', snap.element.tagName === 'BUTTON');
  assert('element.textPreview', snap.element.textPreview === 'Hello world');
  assert('style.color', snap.style['color'] === 'rgb(255, 255, 255)');
  assert('style.padding-top', snap.style['padding-top'] === '6px');
}

console.log('\n=== T2: whitelist filters out position, z-index etc. ===');
{
  const el = new Element('div');
  el._computed = { 'color': 'black', 'position': 'absolute', 'top': '10px', 'z-index': '5', 'padding-top': '4px' };
  const snap = insp.capture(el);
  assert('color kept', snap.style['color'] === 'black');
  assert('padding-top kept', snap.style['padding-top'] === '4px');
  assert('position dropped', !('position' in snap.style));
  assert('z-index dropped', !('z-index' in snap.style));
}

console.log('\n=== T3: capture rejects non-elements ===');
{
  assert('capture(null) is null', insp.capture(null) === null);
  assert('capture({}) is null', insp.capture({}) === null);
}

console.log('\n=== T4: list / add / remove roundtrip (via bridge) ===');
await (async () => {
  const before = await insp.list();
  assert('initial list empty', Array.isArray(before) && before.length === 0);

  const el = new Element('div');
  el._computed = { 'color': 'red' };
  const snap = insp.capture(el);
  await insp.add(snap);

  const mid = await insp.list();
  assert('list length 1 after add', mid.length === 1);
  assert('list contains our snap', mid[0].id === snap.id);

  await insp.remove(snap.id);
  const end = await insp.list();
  assert('list empty after remove', end.length === 0);
})();

console.log('\n=== T5: applyTo writes styles to target element ===');
{
  const el = new Element('div');
  const snap = { id: 'x', style: { 'color': 'rgb(0, 0, 0)', 'padding-top': '12px' } };
  const res = insp.applyTo(el, snap);
  assert('applied 2 properties', res && res.applied === 2);
  assert('color set', el.style._props['color'] === 'rgb(0, 0, 0)');
  assert('padding-top set', el.style._props['padding-top'] === '12px');
}

console.log('\n=== T6: add() caps library at 500 entries ===');
await (async () => {
  const current = await insp.list();
  for (const s of current) await insp.remove(s.id);
  for (let i = 0; i < 505; i++) {
    await insp.add({ id: 'insp-test' + i, capturedAt: Date.now(), source: {}, element: {}, style: {} });
  }
  const after = await insp.list();
  assert('list capped at 500', after.length === 500);
})();

console.log('\n' + (failures ? `FAIL (${failures})` : 'PASS'));
process.exit(failures ? 1 : 0);
