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
    this._pseudos = {}; // e.g. { '::before': { content: '""', ... } }
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
  getComputedStyle: (el, pseudo) => ({
    getPropertyValue: (k) => {
      if (pseudo) return (el._pseudos && el._pseudos[pseudo] && el._pseudos[pseudo][k]) || '';
      return el._computed[k] || '';
    },
  }),
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

console.log('\n=== T2: whitelist captures expanded property set (position/z-index/transform included) ===');
{
  const el = new Element('div');
  el._computed = {
    'color': 'black', 'padding-top': '4px',
    'position': 'absolute', 'top': '10px', 'z-index': '5',
    'transform': 'rotate(3deg)', 'transition': 'all 0.3s ease',
    'flex-grow': '1', 'aspect-ratio': '16 / 9',
    'clip-path': 'polygon(0 0, 100% 0, 100% 90%, 0 100%)',
    'font-feature-settings': '"tnum"',
  };
  const snap = insp.capture(el);
  assert('color kept', snap.style['color'] === 'black');
  assert('padding-top kept', snap.style['padding-top'] === '4px');
  assert('position kept (was dropped before)', snap.style['position'] === 'absolute');
  assert('top offset kept', snap.style['top'] === '10px');
  assert('z-index kept', snap.style['z-index'] === '5');
  assert('transform kept', snap.style['transform'] === 'rotate(3deg)');
  assert('transition kept', snap.style['transition'] === 'all 0.3s ease');
  assert('flex-grow kept', snap.style['flex-grow'] === '1');
  assert('aspect-ratio kept', snap.style['aspect-ratio'] === '16 / 9');
  assert('clip-path kept', snap.style['clip-path'].includes('polygon'));
  assert('font-feature-settings kept', snap.style['font-feature-settings'].includes('tnum'));
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

console.log('\n=== T5: buildPrompt packages source + target + workflow for CC ===');
{
  const tgt = new Element('div');
  tgt.className = 'target-card other-class';
  tgt.outerHTML = '<div class="target-card other-class">hi</div>';
  tgt._computed = { 'color': 'rgb(0, 0, 0)', 'font-size': '14px' };
  const snap = {
    id: 'insp-abc',
    source: { url: 'https://example.com/foo', title: 'T', hostname: 'example.com' },
    element: { tagName: 'DIV', className: 'src-card', textPreview: 'hello' },
    style: { 'background-color': 'rgb(99, 95, 242)', 'border-radius': '12px' },
    outerHTML: '<div class="src-card"><img src="x.jpg"/>hello</div>',
    thumbnailUrl: 'https://example.com/x.jpg',
  };
  const prompt = insp.buildPrompt(snap, tgt);
  assert('prompt is string', typeof prompt === 'string' && prompt.length > 100);
  assert('contains hostname', prompt.includes('example.com'));
  assert('contains thumbnail url', prompt.includes('https://example.com/x.jpg'));
  assert('contains source html', prompt.includes('<div class="src-card">'));
  assert('contains target html', prompt.includes('<div class="target-card'));
  assert('asks for clarifying questions first', prompt.includes('澄清问题') && prompt.includes('先不要写'));
  assert('no hard cap on question count', !prompt.includes('2~3 个澄清问题') && prompt.includes('问到和我沟通清楚为止'));
  assert('warns against !important patches', prompt.includes('!important'));
  assert('tells CC to edit source .less', prompt.includes('.less'));
  assert('surfaces main class hint', prompt.includes('target-card'));
  assert('requires ASCII wireframe in alignment step', prompt.includes('线框图') && prompt.includes('ASCII'));
  assert('wireframe has its own heading with icon', prompt.includes('📐 线框图'));
  assert('wireframe required before change notes', prompt.indexOf('📐 线框图') < prompt.indexOf('改动要点'));
  assert('wireframe must be annotated with arrows', prompt.includes('`←` 箭头') && prompt.includes('尺寸 / 颜色 / 间距'));
  assert('wireframe example is annotated (not blank box)', prompt.includes('← 浅蓝灰') && prompt.includes('← 图出血'));
  assert('allows HTML edits with confirmation', prompt.includes('调整 HTML 结构') && !prompt.includes('❌ 改 HTML'));
  assert('enforces spacing-first discipline', prompt.includes('间距优先') && prompt.includes('绝不压间距'));
  assert('forbids decoration touching container edge', prompt.includes('装饰元素不贴容器边') && prompt.includes('≥ 8px'));
  assert('warns about margin-top: auto pitfall', prompt.includes('margin-top: auto') && prompt.includes('显式'));
  assert('requires spacing budget before listing changes', prompt.includes('列要点前先做间距预算'));
}

console.log('\n=== T5b: capture includes outerHTML and picks up img thumbnail ===');
{
  const el = new Element('div');
  el.outerHTML = '<div class="card"><img src="https://cdn/x.png"/></div>';
  // Inline a child <img> that findThumbnail can discover
  const img = new Element('img');
  img.src = 'https://cdn/x.png';
  img.tagName = 'IMG';
  // Simple children walk — sandbox Element has no querySelector; stub it
  el.querySelector = (sel) => (sel.includes('img') ? img : null);
  el._computed = { 'color': 'black' };
  const snap = insp.capture(el);
  assert('outerHTML preserved', snap.outerHTML && snap.outerHTML.includes('card'));
  assert('thumbnail from child img', snap.thumbnailUrl === 'https://cdn/x.png');
}

console.log('\n=== T5c: capture() returns resources + interactions fields ===');
{
  const el = new Element('div');
  el.outerHTML = '<div class="card"><img src="https://cdn.example/cover.png" alt="cover"/></div>';
  const img = new Element('img');
  img.src = 'https://cdn.example/cover.png';
  img.alt = 'cover';
  img.tagName = 'IMG';
  img.children = [];
  el.children = [img];
  el.querySelector = (sel) => (sel.includes('img') ? img : null);
  el.querySelectorAll = () => [];
  el.matches = () => false;
  el._computed = { 'color': 'black', 'background-image': 'url("https://cdn.example/bg.jpg"), linear-gradient(red, blue)', 'background-color': 'rgb(245, 247, 253)' };
  img._computed = { 'object-fit': 'contain', 'object-position': '50% 50%', 'border-radius': '6px' };
  img.naturalWidth = 400;
  img.naturalHeight = 712;
  img.getBoundingClientRect = () => ({ width: 88, height: 88 });
  // Add a text-area child with a DIFFERENT background — parent-vs-child contrast test
  const textArea = new Element('div');
  textArea.className = 'text-area';
  textArea.innerText = '手机海报';
  textArea._computed = { 'background-color': 'rgb(231, 236, 247)', 'padding-top': '10px', 'padding-bottom': '10px', 'padding-left': '16px', 'padding-right': '16px', 'text-align': 'center', 'color': 'rgba(0, 0, 0, 0.85)', 'font-size': '14px' };
  el.children = [img, textArea];
  const snap = insp.capture(el);
  assert('resources present', !!snap.resources);
  assert('resources.images captures child img', snap.resources.images.length === 1 && snap.resources.images[0].src === 'https://cdn.example/cover.png');
  assert('resources.bgImages parses url() from computed', snap.resources.bgImages.includes('https://cdn.example/bg.jpg'));
  assert('interactions present', !!snap.interactions && snap.interactions.hasOwnProperty('self') && snap.interactions.hasOwnProperty('children'));
  assert('interactions.self empty when no matching :hover rules', Object.keys(snap.interactions.self).length === 0);
  // buildPrompt should render resource section when present
  const tgt = new Element('div');
  tgt.outerHTML = '<div>t</div>';
  tgt._computed = {};
  const prompt = insp.buildPrompt(snap, tgt);
  assert('prompt contains 视觉资源 heading', prompt.includes('视觉资源'));
  assert('prompt lists bg image url', prompt.includes('https://cdn.example/bg.jpg'));
  assert('prompt lists child img src', prompt.includes('https://cdn.example/cover.png'));
  assert('prompt tells CC to curl images to local', prompt.includes('curl') && prompt.includes('本地相对路径'));
  assert('prompt warns against remote URL in code', prompt.includes('不要直接把远程 URL 写进代码'));
  assert('img meta includes object-fit', prompt.includes('object-fit: contain'));
  assert('img meta includes rendered size', prompt.includes('渲染尺寸 88×88'));
  assert('img meta includes natural size', prompt.includes('原图尺寸 400×712'));
  assert('img meta includes border-radius', prompt.includes('border-radius: 6px'));
  assert('prompt enforces 视觉读图 rule', prompt.includes('视觉读图') && prompt.includes('布局靠数据不靠猜'));
  assert('rule warns against cover default', prompt.includes('不要仅凭缩略图'));
  assert('snap exposes children field', Array.isArray(snap.children) && snap.children.length === 2);
  assert('prompt renders 内部结构 section', prompt.includes('## 参考卡片 内部结构'));
  assert('prompt surfaces child bg when differs from parent', prompt.includes('bg: rgb(231, 236, 247)'));
  assert('prompt surfaces child text-align', prompt.includes('text-align: center'));
  assert('prompt enforces 分区背景 rule', prompt.includes('分区背景对比') && prompt.includes('别把根元素 bg 当整卡统一底色'));
}

console.log('\n=== T5d: snapshotElement emits hi-res PNG + prompt renders 视觉切图 section ===');
{
  // Bundle-level assertions (string inspection)
  assert('bundle uses PNG encoding for thumbnail', BUNDLE.includes('toDataURL("image/png")'));
  assert('bundle no longer uses JPEG 0.78', !BUNDLE.includes('toDataURL("image/jpeg",0.78)'));
  assert('bundle removed aggressive maxW=260 downscale', !BUNDLE.includes('maxW=260,maxH=180'));
  assert('bundle caps thumbnail at longest=1200 device px', BUNDLE.includes('longest>1200?1200/longest:1'));

  // buildPrompt: data URI → hi-res section
  const tgt = new Element('div');
  tgt.outerHTML = '<div>t</div>';
  tgt._computed = {};
  const dataUriSnap = {
    id: 'insp-d',
    source: { url: 'u', title: 't', hostname: 'h' },
    element: { tagName: 'DIV', className: 'x', textPreview: '' },
    style: {},
    outerHTML: '<div></div>',
    thumbnailUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
  };
  const pDataUri = insp.buildPrompt(dataUriSnap, tgt);
  assert('prompt renders 视觉切图 heading when thumbnail is data URI', pDataUri.includes('## 参考卡片 视觉切图（高清 PNG 无损）'));
  assert('prompt embeds bash decode command', pDataUri.includes("base64 -d > /tmp/liaison-ref.png <<'B64'"));
  assert('prompt strips data URI prefix (only base64 payload inside heredoc)', pDataUri.includes('iVBORw0KGgoAAAANSUhEUg==') && !pDataUri.includes('data:image/png;base64,iVBORw0'));
  assert('prompt tells CC to Read the local file', pDataUri.includes('Read 打开') && pDataUri.includes('/tmp/liaison-ref.png'));
  assert('prompt marks this as mandatory before reply', pDataUri.includes('必须在回复用户之前'));
  assert('视觉切图 section appears before 参考 HTML section', pDataUri.indexOf('## 参考卡片 视觉切图') < pDataUri.indexOf('## 参考 HTML'));

  // buildPrompt: plain URL → legacy "缩略图：<url>" line
  const urlSnap = { ...dataUriSnap, thumbnailUrl: 'https://cdn.example/thumb.jpg' };
  const pUrl = insp.buildPrompt(urlSnap, tgt);
  assert('prompt falls back to legacy line for non-data-URI', pUrl.includes('缩略图：https://cdn.example/thumb.jpg'));
  assert('legacy URL case does NOT render 视觉切图 section', !pUrl.includes('视觉切图'));
}

console.log('\n=== T5e: pseudo-element capture + deep descendants + expanded props ===');
{
  // ---- 1. Root with ::before and ::after ----
  const root = new Element('article');
  root.className = 'card';
  root.outerHTML = '<article class="card"><div class="inner"><h2>title</h2></div></article>';
  root._computed = {
    'color': 'black',
    'position': 'relative',
    'transform': 'translateY(-2px)',
    'transition': 'transform 0.3s ease',
    'aspect-ratio': '16 / 9',
  };
  root._pseudos = {
    '::before': {
      'content': '""',
      'position': 'absolute',
      'top': '0px', 'left': '0px',
      'width': '4px', 'height': '100%',
      'background-color': 'rgb(35, 178, 131)',
      'border-radius': '4px 0 0 4px',
    },
    '::after': {
      'content': '"NEW"',
      'position': 'absolute',
      'top': '8px', 'right': '8px',
      'background-color': 'rgb(255, 80, 80)',
      'color': 'rgb(255, 255, 255)',
      'font-size': '10px',
      'border-radius': '4px',
      'z-index': '2',
    },
  };
  // Inner wrapper (direct child) with its own grandchildren
  const inner = new Element('div');
  inner.className = 'inner';
  inner._computed = {
    'display': 'flex',
    'flex-direction': 'column',
    'padding-top': '14px', 'padding-right': '16px', 'padding-bottom': '14px', 'padding-left': '16px',
    'gap': '6px',
  };
  const h2 = new Element('h2');
  h2.innerText = '标题文字';
  h2._computed = {
    'font-size': '16px',
    'font-weight': '600',
    'line-height': '1.3',
    'color': 'rgba(0, 0, 0, 0.85)',
    'font-feature-settings': '"tnum"',
  };
  inner.children = [h2];
  root.children = [inner];

  const snap = insp.capture(root);

  // ---- snap-level assertions ----
  assert('snap exposes pseudos field on root', !!snap.pseudos && Object.keys(snap.pseudos).length === 2);
  assert('pseudos[::before].content captured', snap.pseudos['::before'].content === '""');
  assert('pseudos[::before].position captured', snap.pseudos['::before'].position === 'absolute');
  assert('pseudos[::after].content captured', snap.pseudos['::after'].content === '"NEW"');
  assert('pseudos skipped when content none (none test)', (() => {
    const el = new Element('div');
    el._pseudos = { '::before': { content: 'none' }, '::after': { content: 'normal' } };
    const snap2 = insp.capture(el);
    return !snap2.pseudos['::before'] && !snap2.pseudos['::after'];
  })());

  // ---- children/grandchildren ----
  assert('children captured at depth 1', Array.isArray(snap.children) && snap.children.length === 1);
  assert('grandchildren captured at depth 2', snap.children[0].children && snap.children[0].children.length === 1);
  assert('grandchild tagName captured', snap.children[0].children[0].tagName === 'H2');
  assert('grandchild font-size captured', snap.children[0].children[0].style['font-size'] === '16px');
  assert('grandchild font-feature-settings captured', snap.children[0].children[0].style['font-feature-settings'] === '"tnum"');

  // ---- buildPrompt rendering ----
  const tgt = new Element('div');
  tgt.outerHTML = '<div>t</div>';
  tgt._computed = {};
  const prompt = insp.buildPrompt(snap, tgt);

  // 伪元素 section
  assert('prompt renders 伪元素 section', prompt.includes('## 参考卡片 伪元素（::before / ::after）'));
  assert('伪元素 section explains 80% are pseudos', prompt.includes('80% 都是伪元素'));
  assert('伪元素 rendered with content', prompt.includes('::before') && prompt.includes('content: '));
  assert('伪元素 rendered with position + offset', prompt.includes('position: absolute') && prompt.includes('top: 0px'));
  assert('伪元素 with content=none when absent', (() => {
    const el = new Element('div');
    el.outerHTML = '<div></div>';
    el._computed = {};
    const snap2 = insp.capture(el);
    const p2 = insp.buildPrompt(snap2, tgt);
    return !p2.includes('## 参考卡片 伪元素');
  })());

  // 内部结构: grandchildren rendered nested
  assert('prompt renders 内部结构 with grandchild hint', prompt.includes('直接子元素 + 孙子的关键 style'));
  assert('prompt renders grandchild H2', prompt.includes('**H2**'));
  assert('grandchild nested indentation (2+ spaces before bullet)', /\n {2,}- \*\*H2\*\*/.test(prompt));
  assert('grandchild font-feature-settings surfaced', prompt.includes('font-feature-settings: "tnum"'));

  // Expanded root meta: transform / aspect-ratio / transition would render via _metaFor
  // But root meta isn't rendered through renderNode — root is rendered via 参考 computed style.
  // Check 参考 computed style JSON contains them:
  assert('root transform in computed style JSON', prompt.includes('"transform": "translateY(-2px)"'));
  assert('root transition in computed style JSON', prompt.includes('"transition": "transform 0.3s ease"'));
  assert('root aspect-ratio in computed style JSON', prompt.includes('"aspect-ratio": "16 / 9"'));

  // Regression: helper functions must be var-declared (strict-mode safe)
  assert('bundle: _renderPseudos is var-declared (strict-mode safe)', BUNDLE.includes('var _renderPseudos=function'));
  assert('bundle: _renderNode is var-declared (strict-mode safe)', BUNDLE.includes('var _renderNode=function'));
  assert('bundle: _fmtPx is var-declared', BUNDLE.includes('var _fmtPx=function'));
  assert('bundle: _metaFor is var-declared', BUNDLE.includes('var _metaFor=function'));

  // 4 new discipline rules
  assert('discipline rule: 伪元素优先', prompt.includes('伪元素优先') && prompt.includes('`::before` / `::after`'));
  assert('discipline rule: 动效全复刻或明确不做', prompt.includes('transform / transition / animation') && prompt.includes('明确决策'));
  assert('discipline rule: 定位与层叠', prompt.includes('定位与层叠') && prompt.includes('position: relative') && prompt.includes('z-index'));
  assert('discipline rule: 数字字体', prompt.includes('数字字体') && prompt.includes('tabular-nums') && prompt.includes('tnum'));
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
