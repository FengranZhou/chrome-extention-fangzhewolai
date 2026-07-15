// Unit tests for window.__liaisonInsp helpers.
// Page-world code (bundle) talks to content-script bridge via postMessage.
// Sandbox below simulates both worlds.

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = fs.readFileSync(path.resolve(__dirname, '../../toolbar/bundle.min.js'), 'utf8');

// Match the full __liaisonInsp IIFE up through its closing })(); — the lazy [\s\S]*?
// otherwise stops at the first inner })(); (e.g. setTimeout(...)(); or a nested IIFE),
// truncating before buildPrompt is even defined. Lookahead for the next module IIFE start
// (or end-of-bundle) anchors the match on the actual module boundary.
const match = BUNDLE.match(/\(function\(\)\{if\(typeof window==="undefined"\|\|window\.__liaisonInsp\)return;[\s\S]*?\}\)\(\);(?=\(function\(\)\{|$)/);
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

// ---- download bridge call log (for assertions) ---------------------------
const downloadCalls = [];

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
    } else if (d.action === 'download') {
      // Simulate chrome.downloads: accept data URL, return a fake absolute path.
      if (!d.payload || !d.payload.dataUrl) throw new Error('missing dataUrl');
      downloadCalls.push(d.payload.dataUrl);
      result = '/Users/test/Downloads/liaison-ref.jpg';
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

console.log('\n=== T2b: whitelist captures extended typography properties ===');
{
  const el = new Element('div');
  el._computed = {
    'white-space': 'nowrap',
    'word-break': 'break-all',
    'overflow-wrap': 'break-word',
    'text-overflow': 'ellipsis',
    'vertical-align': 'middle',
    'text-indent': '24px',
    'word-spacing': '2px',
    'text-decoration': 'underline',
    'text-decoration-color': 'rgb(35, 178, 131)',
    'letter-spacing': '0.5px',
    'text-transform': 'uppercase',
    'font-family': 'DouyinSansBold, sans-serif',
    'font-style': 'italic',
  };
  const snap = insp.capture(el);
  assert('white-space kept', snap.style['white-space'] === 'nowrap');
  assert('word-break kept', snap.style['word-break'] === 'break-all');
  assert('overflow-wrap kept', snap.style['overflow-wrap'] === 'break-word');
  assert('text-overflow kept', snap.style['text-overflow'] === 'ellipsis');
  assert('vertical-align kept', snap.style['vertical-align'] === 'middle');
  assert('text-indent kept', snap.style['text-indent'] === '24px');
  assert('word-spacing kept', snap.style['word-spacing'] === '2px');
  assert('text-decoration kept (root already had)', snap.style['text-decoration'] === 'underline');
  assert('text-decoration-color kept (root already had)', snap.style['text-decoration-color'] === 'rgb(35, 178, 131)');
  assert('letter-spacing kept (root already had)', snap.style['letter-spacing'] === '0.5px');
  assert('text-transform kept (root already had)', snap.style['text-transform'] === 'uppercase');
  assert('font-family kept (root already had)', snap.style['font-family'] === 'DouyinSansBold, sans-serif');
  assert('font-style kept (root already had)', snap.style['font-style'] === 'italic');
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

console.log('\n=== T5b2: parseBgUrls collapses image-set() multi-resolution into ONE entry ===');
{
  // Regression test for the "1 image looks like 2 URLs" confusion.
  // image-set(url(@1x) 1x, url(@2x) 2x) is the SAME image at multiple resolutions —
  // must surface as 1 bgImages entry, not 2.
  const el = new Element('div');
  el.outerHTML = '<div></div>';
  el._computed = {
    'background-image': 'image-set(url("https://x.com/a@1x.png") 1x, url("https://x.com/a@2x.png") 2x)',
  };
  const snap = insp.capture(el);
  const bgs = snap.resources.bgImages;
  assert('image-set collapsed to 1 entry (was 2)', bgs.length === 1, bgs);
  assert('entry contains the primary @1x URL', bgs[0].includes('https://x.com/a@1x.png'));
  assert('entry annotates the @2x variant', bgs[0].includes('2x') && bgs[0].includes('https://x.com/a@2x.png'));
  assert('entry has the "image-set 同图" marker', bgs[0].includes('image-set 同图'));

  // Mixed: image-set PLUS a standalone url() in a layered background-image — should be 2 entries.
  const el2 = new Element('div');
  el2.outerHTML = '<div></div>';
  el2._computed = {
    'background-image': 'image-set(url("https://x.com/hero@1x.png") 1x, url("https://x.com/hero@2x.png") 2x), url("https://x.com/texture.png")',
  };
  const snap2 = insp.capture(el2);
  const bgs2 = snap2.resources.bgImages;
  assert('mixed: image-set + plain url → 2 entries', bgs2.length === 2, bgs2);
  assert('mixed: image-set entry present', bgs2.some(s => s.includes('hero@1x.png') && s.includes('image-set 同图')));
  assert('mixed: plain texture entry present', bgs2.some(s => s === 'https://x.com/texture.png'));

  // Plain url() (no image-set) still works as before — single string entry.
  const el3 = new Element('div');
  el3.outerHTML = '<div></div>';
  el3._computed = {
    'background-image': 'url("https://x.com/plain.png")',
  };
  const snap3 = insp.capture(el3);
  assert('plain url() still one entry', snap3.resources.bgImages.length === 1);
  assert('plain url() entry is exactly the url', snap3.resources.bgImages[0] === 'https://x.com/plain.png');
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
  assert('prompt warns against remote URL in code', prompt.includes('禁止把远程 URL 直接写进代码'));
  assert('prompt forbids silent substitution with local assets', prompt.includes('禁止静默替换') && prompt.includes('不允许默认复用'));
  assert('prompt forbids silent skipping of url() background layers', prompt.includes('禁止静默跳过') && prompt.includes('background-image') && prompt.includes('复刻几层'));
  assert('prompt requires real failure before degrading (not假想 CORS)', prompt.includes('真实失败才降级') && prompt.includes('假想失败'));
  assert('prompt demands ⚠️ row for any asset substitution decision', prompt.includes('单独 ⚠️ 行') && prompt.includes('用本地 X 还是 curl 原图'));
  assert('old soft directive "在真正复用…之前" is removed (was too weak)', !prompt.includes('在真正复用下面任何一张图之前'));
  assert('discipline list contains 资源处置 rule with regen path', prompt.includes('资源处置') && prompt.includes('以往教训') && prompt.includes('按图生重生'));
  // 资产重生决策 block was slimmed on 2026-05-17: cutout 细则 / 并行调度 / 落盘约定 / 尾部播报 4 sections moved into 按图生 SKILL.md. buildPrompt should now only carry the 5-field handoff. These assertions lock the slim shape so a future regression that re-stuffs the cut sections fails loudly.
  assert('资产重生决策 still present (the section itself stays)', prompt.includes('资产重生决策'));
  assert('5-field handoff structure present', prompt.includes('5 个字段') && prompt.includes('参考图路径') && prompt.includes('目标主题') && prompt.includes('cutout') && prompt.includes('落点') && prompt.includes('抠图后处理'));
  assert('explicit hand-off note: SKILL owns the dropped sections', prompt.includes('SKILL 内部已经定好') && prompt.includes('调用方不要再讲一遍'));
  assert('cutout 详细判定细则已下沉 (no full 独立元素叠在父容器底色 paragraph here)', !prompt.includes('需要透明边缘无缝融入'));
  assert('并行调度细则已下沉 (no full "重生资产 ≥ 2 张时" paragraph here)', !prompt.includes('重生资产 ≥ 2 张时') && !prompt.includes('单 agent 内 N 张共享一次 Chrome 连接'));
  assert('落盘 ~/Pictures 实现细节已下沉 (调用方 prompt 不再讲 SKILL 内部输出路径)', !prompt.includes('~/Pictures/style-gen'));
  assert('尾部播报固定模板已下沉 (调用方自由发挥)', !prompt.includes('📦 资产处置'));
  assert('but liaison-original 注释规约仍保留 (这是调用方在源码里加的事，SKILL 管不到)', prompt.includes('liaison-original'));
  // 2026-05-17 流程纪律：线框图输出后不再 gate 用户确认——直接落地，用户有问题自己打断
  assert('workflow does NOT gate on user confirmation after wireframe', !prompt.includes('等我确认') && !prompt.includes('我确认后') && !prompt.includes('等你确认'));
  assert('workflow tells claude to land directly after wireframe', prompt.includes('不要停下来等我') || prompt.includes('便于打断') || prompt.includes('不要等我打字'));
  assert('img meta includes object-fit', prompt.includes('object-fit: contain'));
  assert('img meta includes rendered size', prompt.includes('渲染尺寸 88×88'));
  assert('img meta includes natural size', prompt.includes('原图尺寸 400×712'));
  assert('img meta includes border-radius', prompt.includes('border-radius: 6px'));
  assert('prompt enforces 视觉读图 rule', prompt.includes('视觉读图') && prompt.includes('布局靠数据不靠猜'));
  assert('rule warns against cover default', prompt.includes('不要仅凭缩略图'));
  assert('snap exposes children field', Array.isArray(snap.children) && snap.children.length === 2);
  assert('prompt renders 内部结构 section (default kind: 元素)', prompt.includes('## 参考元素 内部结构'));
  assert('prompt surfaces child bg when differs from parent', prompt.includes('bg: rgb(231, 236, 247)'));
  assert('prompt surfaces child text-align', prompt.includes('text-align: center'));
  assert('prompt enforces 分区背景 rule', prompt.includes('分区背景对比') && prompt.includes('别把根元素 bg 当整个元素统一底色'));
}

console.log('\n=== T5d: snapshotElement emits hi-res JPEG + prompt renders 视觉切图 section ===');
{
  // Bundle-level assertions (string inspection)
  assert('bundle uses JPEG 0.92 encoding for thumbnail (keeps files < API 5MB limit)', BUNDLE.includes('toDataURL("image/jpeg",0.92)'));
  assert('bundle no longer uses lossless PNG (bloated past API limit for complex screenshots)', !BUNDLE.includes('toDataURL("image/png")'));
  assert('bundle no longer uses JPEG 0.78', !BUNDLE.includes('toDataURL("image/jpeg",0.78)'));
  assert('bundle removed aggressive maxW=260 downscale', !BUNDLE.includes('maxW=260,maxH=180'));
  assert('bundle caps thumbnail at longest=1024 device px (pixel count under API recommended 1.15MP)', BUNDLE.includes('longest>1024?1024/longest:1'));

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
  assert('prompt renders 视觉切图 heading when thumbnail is data URI', pDataUri.includes('## 参考元素 视觉切图（高清 JPEG）'));
  assert('prompt embeds bash decode command', pDataUri.includes("base64 -d > /tmp/liaison-ref.jpg <<'B64'"));
  assert('prompt strips data URI prefix (only base64 payload inside heredoc)', pDataUri.includes('iVBORw0KGgoAAAANSUhEUg==') && !pDataUri.includes('data:image/png;base64,iVBORw0'));
  assert('prompt tells CC to Read the local file', pDataUri.includes('Read 打开') && pDataUri.includes('/tmp/liaison-ref.jpg'));
  assert('prompt marks this as mandatory before reply', pDataUri.includes('必须在回复用户之前'));
  assert('视觉切图 section appears before 参考 HTML section', pDataUri.indexOf('## 参考元素 视觉切图') < pDataUri.indexOf('## 参考 HTML'));

  // buildPrompt: plain URL → legacy "缩略图：<url>" line
  const urlSnap = { ...dataUriSnap, thumbnailUrl: 'https://cdn.example/thumb.jpg' };
  const pUrl = insp.buildPrompt(urlSnap, tgt);
  assert('prompt falls back to legacy line for non-data-URI', pUrl.includes('缩略图：https://cdn.example/thumb.jpg'));
  assert('legacy URL case does NOT render 视觉切图 section', !pUrl.includes('视觉切图'));
}

console.log('\n=== T5c2: buildPrompt renders parent-hover → descendant rules (caught by harvestHoverDescendants) ===');
{
  // Bundle-level: the new harvester exists and is wired into capture()
  assert('bundle defines harvestHoverDescendants fn', BUNDLE.includes('function harvestHoverDescendants'));
  assert('capture() attaches selfHoverDescendants to interactions', BUNDLE.includes('selfHoverDescendants:harvestHoverDescendants'));
  assert('harvester regex matches `prefix:hover descSel` form (not just prefix:hover$)', BUNDLE.includes(':(hover|focus|active|focus-visible)\\s+(.+)$'));
  assert('harvester handles child combinator via :scope prefix', BUNDLE.includes('/^[>~+]/.test(descSel)') && BUNDLE.includes('":scope "+descSel'));
  assert('stylesheet scan cap raised to 500 (SPAs like chuangkit exceed the old 30 cap)', BUNDLE.includes('s0<sheets.length&&s0<500') && !BUNDLE.includes('s0<sheets.length&&s0<30'));
  assert('no longer treats every rule.cssRules as "group rule, skip self" (CSS Nesting makes every CSSStyleRule have .cssRules)', !BUNDLE.includes('if(r.cssRules){try{walk(r.cssRules,depth+1)}catch(e){}continue}'));
  assert('recursion into nested cssRules guarded by .length > 0 to avoid stepping into every empty CSSStyleRule.cssRules', BUNDLE.includes('r.cssRules&&r.cssRules.length'));
  assert('per-sheet rule cap raised from 2000 to 20000 (chuangkit app.css has 4100+ rules, hover rules at index 4109)', BUNDLE.includes('Math.min(rules.length,20000)') && !BUNDLE.includes('Math.min(rules.length,2000)'));

  // Prompt rendering: given a manually-populated selfHoverDescendants, buildPrompt emits a new sub-section
  const tgt = new Element('div');
  tgt.outerHTML = '<div>t</div>';
  tgt._computed = {};
  const snap = {
    id: 'insp-hd',
    source: { url: 'u', title: 't', hostname: 'h' },
    element: { tagName: 'DIV', className: 'mcd1-item', textPreview: '' },
    style: {},
    outerHTML: '<div class="mcd1-item"><img class="mcd1-item-img"/></div>',
    interactions: {
      self: {},
      children: [],
      selfHoverDescendants: [
        { pseudo: 'hover', descSel: '.mcd1-item-img', decls: { transform: 'rotate(-6deg)', transition: 'transform 0.3s ease' }, matchCount: 1, sample: { tag: 'img', cls: 'mcd1-item-img', text: '' } },
        { pseudo: 'hover', descSel: '.mcd1-item-button', decls: { 'background-color': 'rgb(235, 110, 60)', transform: 'translateY(-1px)' }, matchCount: 1, sample: { tag: 'div', cls: 'mcd1-item-button', text: 'GO' } },
      ],
    },
  };
  const p = insp.buildPrompt(snap, tgt);
  assert('prompt renders umbrella 交互态 section', p.includes('## 参考元素 交互态'));
  assert('prompt renders hover→子元素 subsection heading', p.includes('### 本体 hover/focus → 内部元素变化'));
  assert('subsection explains parent-state-drives-child pattern', p.includes('父态 → 子元素') && p.includes('不在 child 自己的 :hover 里'));
  assert('renders pseudo + descendant selector on bullet', p.includes(':hover → `.mcd1-item-img`'));
  assert('renders transform rotation declaration', p.includes('transform: rotate(-6deg)'));
  assert('renders transition alongside transform', p.includes('transition: transform 0.3s ease'));
  assert('renders match count hint', p.includes('命中 1 个'));
  assert('renders sample element tag + class', p.includes('<img.mcd1-item-img>'));
  assert('renders second rule (button hover) with both bg and transform', p.includes('background-color: rgb(235, 110, 60)') && p.includes('translateY(-1px)'));
  assert('subsection nests under 交互态 umbrella', p.indexOf('## 参考元素 交互态') >= 0 && p.indexOf('## 参考元素 交互态') < p.indexOf('### 本体 hover/focus'));
  assert('bullet backtick-wraps selector for code emphasis', p.includes('`.mcd1-item-button`'));

  // Empty hoverDesc array should not render the subsection
  const snapNoHover = Object.assign({}, snap, { interactions: { self: {}, children: [], selfHoverDescendants: [] } });
  const p2 = insp.buildPrompt(snapNoHover, tgt);
  assert('no subsection when selfHoverDescendants is empty', !p2.includes('本体 hover/focus → 内部元素变化'));
  assert('no umbrella 交互态 when all interaction fields empty', !p2.includes('## 参考元素 交互态'));
}

console.log('\n=== T5d2: buildPrompt renders path-based section when localRefPath is set ===');
{
  const tgt = new Element('div');
  tgt.outerHTML = '<div>t</div>';
  tgt._computed = {};
  const pathSnap = {
    id: 'insp-p',
    source: { url: 'u', title: 't', hostname: 'h' },
    element: { tagName: 'DIV', className: 'x', textPreview: '' },
    style: {},
    outerHTML: '<div></div>',
    thumbnailUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD==',
    localRefPath: '/Users/test/Downloads/liaison-ref.jpg',
  };
  const p = insp.buildPrompt(pathSnap, tgt);
  assert('prompt renders 视觉切图 heading (no "（高清…）" suffix for path mode)', p.includes('## 参考元素 视觉切图\n'));
  assert('prompt embeds absolute path', p.includes('/Users/test/Downloads/liaison-ref.jpg'));
  assert('prompt mandates Read before reply', p.includes('你必须在回复用户之前用 Read 工具打开'));
  assert('prompt does NOT emit base64 heredoc (the whole point of path mode)', !p.includes("base64 -d > /tmp/liaison-ref"));
  assert('prompt does NOT include raw base64 payload', !p.includes('/9j/4AAQSkZJRgAB'));
  assert('prompt still preserves ground-truth framing', p.includes('真实视觉 ground truth'));
  assert('视觉切图 section still appears before 参考 HTML', p.indexOf('## 参考元素 视觉切图') < p.indexOf('## 参考 HTML'));
}

console.log('\n=== T5d3: buildPromptAsync resolves localRefPath via download bridge ===');
await (async () => {
  downloadCalls.length = 0;
  const tgt = new Element('div');
  tgt.outerHTML = '<div>t</div>';
  tgt._computed = {};
  const dataUriSnap = {
    id: 'insp-a',
    source: { url: 'u', title: 't', hostname: 'h' },
    element: { tagName: 'DIV', className: 'x', textPreview: '' },
    style: {},
    outerHTML: '<div></div>',
    thumbnailUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD==',
  };
  const p = await insp.buildPromptAsync(dataUriSnap, tgt);
  assert('buildPromptAsync triggered the download bridge', downloadCalls.length === 1);
  assert('download bridge received the original data URL', downloadCalls[0] === dataUriSnap.thumbnailUrl);
  assert('async prompt uses path-based section (not base64 heredoc)', !p.includes("base64 -d > /tmp/liaison-ref"));
  assert('async prompt references the path returned by bridge', p.includes('/Users/test/Downloads/liaison-ref.jpg'));
  assert('buildPromptAsync did NOT mutate the original snap', !dataUriSnap.localRefPath);

  // Skip download if snap already has localRefPath cached
  downloadCalls.length = 0;
  const cachedSnap = Object.assign({}, dataUriSnap, { localRefPath: '/already/on/disk.jpg' });
  const p2 = await insp.buildPromptAsync(cachedSnap, tgt);
  assert('buildPromptAsync skips bridge when localRefPath already set', downloadCalls.length === 0);
  assert('async prompt uses the pre-set path', p2.includes('/already/on/disk.jpg'));

  // Non-data-URI thumbnail: should not trigger download bridge
  downloadCalls.length = 0;
  const urlSnap = Object.assign({}, dataUriSnap, { thumbnailUrl: 'https://cdn.example/x.jpg' });
  const p3 = await insp.buildPromptAsync(urlSnap, tgt);
  assert('buildPromptAsync does not download for non-data-URI thumbnails', downloadCalls.length === 0);
  assert('async prompt falls back to legacy 缩略图 line for plain URL', p3.includes('缩略图：https://cdn.example/x.jpg'));
})();

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

console.log('\n=== T5f: grandchildren capture + render extended typography properties ===');
{
  const root = new Element('article');
  root.className = 'card';
  root.outerHTML = '<article class="card"><div class="inner"><span class="label">SUBTITLE</span><h2 class="title">非常非常长的中文标题用来测试省略号处理效果</h2></div></article>';
  root._computed = { 'color': 'black', 'padding-top': '12px' };

  const inner = new Element('div');
  inner.className = 'inner';
  inner._computed = { 'display': 'flex', 'flex-direction': 'column', 'gap': '4px' };

  // Uppercase label — tests text-transform / letter-spacing / font-family / font-style
  const label = new Element('span');
  label.className = 'label';
  label.innerText = 'SUBTITLE';
  label._computed = {
    'color': 'rgb(35, 178, 131)',
    'font-size': '12px',
    'font-weight': '600',
    'font-family': 'DouyinSansBold, sans-serif',
    'font-style': 'italic',
    'letter-spacing': '1.5px',
    'text-transform': 'uppercase',
    'text-decoration': 'underline',
  };

  // Truncated long title — tests white-space / text-overflow / word-break
  const title = new Element('h2');
  title.className = 'title';
  title.innerText = '非常非常长的中文标题用来测试省略号处理效果';
  title._computed = {
    'color': 'rgba(0, 0, 0, 0.85)',
    'font-size': '16px',
    'font-weight': '700',
    'white-space': 'nowrap',
    'overflow': 'hidden',
    'text-overflow': 'ellipsis',
    'word-break': 'break-all',
    'vertical-align': 'middle',
    'text-indent': '8px',
    'word-spacing': '1px',
  };

  inner.children = [label, title];
  root.children = [inner];

  const snap = insp.capture(root);

  // ---- Grandchild SPAN (label) ----
  const labelNode = snap.children[0].children[0];
  assert('grandchild font-family captured', labelNode.style['font-family'] === 'DouyinSansBold, sans-serif');
  assert('grandchild font-style captured', labelNode.style['font-style'] === 'italic');
  assert('grandchild letter-spacing captured', labelNode.style['letter-spacing'] === '1.5px');
  assert('grandchild text-transform captured', labelNode.style['text-transform'] === 'uppercase');
  assert('grandchild text-decoration captured', labelNode.style['text-decoration'] === 'underline');

  // ---- Grandchild H2 (title) ----
  const titleNode = snap.children[0].children[1];
  assert('grandchild white-space captured', titleNode.style['white-space'] === 'nowrap');
  assert('grandchild text-overflow captured', titleNode.style['text-overflow'] === 'ellipsis');
  assert('grandchild word-break captured', titleNode.style['word-break'] === 'break-all');
  assert('grandchild vertical-align captured', titleNode.style['vertical-align'] === 'middle');

  // ---- buildPrompt rendering: high-signal typography hints should surface ----
  const tgt = new Element('div');
  tgt.outerHTML = '<div>t</div>';
  tgt._computed = {};
  const prompt = insp.buildPrompt(snap, tgt);

  // High-signal on label (non-default values only)
  assert('prompt renders font-family for grandchild', prompt.includes('font-family: DouyinSansBold, sans-serif'));
  assert('prompt renders text-transform: uppercase', prompt.includes('text-transform: uppercase'));
  assert('prompt renders letter-spacing: 1.5px', prompt.includes('letter-spacing: 1.5px'));
  assert('prompt renders font-style: italic', prompt.includes('font-style: italic'));
  assert('prompt renders text-decoration: underline', prompt.includes('text-decoration: underline'));

  // High-signal on title (truncation)
  assert('prompt renders white-space: nowrap', prompt.includes('white-space: nowrap'));
  assert('prompt renders text-overflow: ellipsis', prompt.includes('text-overflow: ellipsis'));

  // Noise suppression: default values should NOT be rendered
  const defaultNode = new Element('span');
  defaultNode.innerText = 'x';
  defaultNode._computed = {
    'color': 'black',
    'font-family': 'serif',
    'font-style': 'normal',
    'letter-spacing': 'normal',
    'text-transform': 'none',
    'text-decoration': 'none solid rgb(0, 0, 0)',
    'white-space': 'normal',
    'text-overflow': 'clip',
  };
  const clean = new Element('div');
  clean.outerHTML = '<div></div>';
  clean._computed = {};
  clean.children = [defaultNode];
  const cleanSnap = insp.capture(clean);
  const cleanPrompt = insp.buildPrompt(cleanSnap, tgt);
  assert('default font-style normal suppressed', !cleanPrompt.includes('font-style: normal'));
  assert('default letter-spacing normal suppressed', !cleanPrompt.includes('letter-spacing: normal'));
  assert('default text-transform none suppressed', !cleanPrompt.includes('text-transform: none'));
  assert('default white-space normal suppressed', !cleanPrompt.includes('white-space: normal'));
  assert('default text-overflow clip suppressed', !cleanPrompt.includes('text-overflow: clip'));
}

console.log('\n=== T5g: prompt adapts refKind by tagName / className (not hardcoded "参考卡片") ===');
{
  const tgt = new Element('div');
  tgt.outerHTML = '<div>t</div>';
  tgt._computed = {};

  function snapOf(tag, cls) {
    return {
      id: 'insp-k',
      source: { url: 'u', title: 't', hostname: 'h' },
      element: { tagName: tag, className: cls, textPreview: '' },
      style: {},
      outerHTML: '<div></div>',
    };
  }

  // TABLE → 参考表格
  {
    const p = insp.buildPrompt(snapOf('TABLE', ''), tgt);
    assert('TABLE → 参考表格', p.includes('「参考表格」') && p.includes('# 参考表格'));
    assert('TABLE → no leftover 参考卡片', !p.includes('参考卡片'));
  }

  // BUTTON → 参考按钮
  {
    const p = insp.buildPrompt(snapOf('BUTTON', 'primary'), tgt);
    assert('BUTTON → 参考按钮', p.includes('参考按钮'));
    assert('BUTTON → no leftover 参考卡片', !p.includes('参考卡片'));
  }

  // NAV → 参考导航
  {
    const p = insp.buildPrompt(snapOf('NAV', ''), tgt);
    assert('NAV → 参考导航', p.includes('参考导航'));
  }

  // UL → 参考列表
  {
    const p = insp.buildPrompt(snapOf('UL', ''), tgt);
    assert('UL → 参考列表', p.includes('参考列表'));
  }

  // FORM → 参考表单
  {
    const p = insp.buildPrompt(snapOf('FORM', 'login-form'), tgt);
    assert('FORM → 参考表单', p.includes('参考表单'));
  }

  // IMG → 参考图片
  {
    const p = insp.buildPrompt(snapOf('IMG', ''), tgt);
    assert('IMG → 参考图片', p.includes('参考图片'));
  }

  // DIV with "card" class → 参考卡片 (explicit card hint wins)
  {
    const p = insp.buildPrompt(snapOf('DIV', 'product-card featured'), tgt);
    assert('DIV.product-card → 参考卡片', p.includes('参考卡片'));
  }

  // DIV with "panel" class → 参考卡片
  {
    const p = insp.buildPrompt(snapOf('DIV', 'stat-panel'), tgt);
    assert('DIV.stat-panel → 参考卡片', p.includes('参考卡片'));
  }

  // ARTICLE without card/tile/panel class → 参考区块
  {
    const p = insp.buildPrompt(snapOf('ARTICLE', 'news-item'), tgt);
    assert('ARTICLE w/o card → 参考区块', p.includes('参考区块'));
    assert('ARTICLE w/o card → no 参考卡片', !p.includes('参考卡片'));
  }

  // Plain DIV → 参考元素 (fallback)
  {
    const p = insp.buildPrompt(snapOf('DIV', ''), tgt);
    assert('plain DIV → 参考元素', p.includes('参考元素'));
    assert('plain DIV → no 参考卡片 leakage', !p.includes('参考卡片'));
    // Slimmed 2026-05-17: 分级注入后极简 DIV 可能完全不命中 "整卡"-bearing 长尾规则
    // (分区背景对比 / 定位与层叠 etc)。i18n 替换是 noop 也 OK，只要不漏。这条断言
    // 现在只验「字眼没被遗留」——i18n 真有内容可替换的场景由下方含 children 的卡片测试覆盖。
    assert('plain DIV → 整卡 / 整张卡片 fully replaced (i18n no-leak)', !p.includes('整卡') && !p.includes('整张卡片'));
  }

  // TABLE also rewrites 整卡 / 整张卡片 inline copy to 整个表格
  {
    const p = insp.buildPrompt(snapOf('TABLE', ''), tgt);
    assert('TABLE → 整卡 / 整张卡片 fully replaced (i18n no-leak)', !p.includes('整卡') && !p.includes('整张卡片'));
  }

  // Case insensitive: lowercase tag from toLowerCase-ing input shouldn't break it
  {
    const p = insp.buildPrompt(snapOf('button', 'primary'), tgt);
    assert('lowercase "button" tag → still 参考按钮', p.includes('参考按钮'));
  }
}

console.log('\n=== T5h: capture + buildPrompt surface child border-* (the divider gap) ===');
{
  // Real-world miss this test pins: zhihu 话题卡 head 有 border-bottom: 1px solid xxx
  // 旧版 captureChildren 的 keys 只采 border-top-* 三个字段，导致 border-bottom 永远丢失。
  // _metaFor 也根本没渲染 border-{side} —— 双层盲点。
  const root = new Element('article');
  root.outerHTML = '<article class="card"><div class="head"></div><div class="body"></div></article>';
  root._computed = { 'background-color': 'rgb(248, 248, 250)', 'border-radius': '12px', 'padding-top': '20px', 'padding-right': '20px', 'padding-bottom': '20px', 'padding-left': '20px' };
  const head = new Element('div');
  head.className = 'head';
  head._computed = {
    'display': 'flex',
    'padding-bottom': '20px',
    'border-bottom-width': '1px',
    'border-bottom-style': 'solid',
    'border-bottom-color': 'rgba(0, 0, 0, 0.06)',
  };
  const body = new Element('div');
  body.className = 'body';
  body._computed = {
    'display': 'block',
    'border-top-width': '2px',
    'border-top-style': 'dashed',
    'border-top-color': 'rgb(255, 0, 0)',
    'border-right-width': '2px',
    'border-right-style': 'dashed',
    'border-right-color': 'rgb(255, 0, 0)',
    'border-bottom-width': '2px',
    'border-bottom-style': 'dashed',
    'border-bottom-color': 'rgb(255, 0, 0)',
    'border-left-width': '2px',
    'border-left-style': 'dashed',
    'border-left-color': 'rgb(255, 0, 0)',
  };
  root.children = [head, body];
  const snap = insp.capture(root);

  // ---- capture-stage assertions ----
  const headSnap = snap.children[0];
  assert('child captured border-bottom-width', headSnap.style['border-bottom-width'] === '1px');
  assert('child captured border-bottom-style', headSnap.style['border-bottom-style'] === 'solid');
  assert('child captured border-bottom-color', headSnap.style['border-bottom-color'] === 'rgba(0, 0, 0, 0.06)');
  const bodySnap = snap.children[1];
  assert('child captured border-right-width (was lost in old keys)', bodySnap.style['border-right-width'] === '2px');
  assert('child captured border-left-color (was lost in old keys)', bodySnap.style['border-left-color'] === 'rgb(255, 0, 0)');

  // ---- buildPrompt-stage assertions ----
  const tgt = new Element('div');
  tgt.outerHTML = '<div></div>';
  tgt._computed = {};
  const p = insp.buildPrompt(snap, tgt);
  assert('prompt renders single-side border-bottom on head', p.includes('border-bottom: 1px solid rgba(0, 0, 0, 0.06)'));
  assert('prompt collapses 4-side identical border into shorthand', p.includes('border: 2px dashed rgb(255, 0, 0)'));
  assert('prompt does NOT split shorthand into 4 lines when sides match', !p.includes('border-top: 2px dashed rgb(255, 0, 0)') || !p.includes('border-right: 2px dashed rgb(255, 0, 0)'));
}

console.log('\n=== T5i: form-element padding warning surfaces user-agent default reads ===');
{
  // 复刻微盟课程卡时翻车：buildPrompt 给的 button "padding: 1px 6px" 是参考真实 computed 值，
  // 但参考视觉按钮高 ~28px（远超 1+16+1=18），意味着参考有 min-height/父级 stretch 撑高，
  // computed 抓不到。Claude 照抄就翻车——按钮文字几乎贴边。
  // 现在 buildPrompt 在 form 元素 padding 贴近 UA 默认时追加 ⚠️ 提示，避免下游照抄。
  const root = new Element('div');
  root.outerHTML = '<div><button class="cta">Go</button></div>';
  root._computed = {};
  const btn = new Element('button');
  btn.className = 'cta';
  btn.innerText = 'Go';
  btn._computed = {
    'padding-top': '1px',
    'padding-right': '6px',
    'padding-bottom': '1px',
    'padding-left': '6px',
    'background-color': 'rgb(242, 247, 255)',
    'color': 'rgb(0, 106, 255)',
    'font-size': '14px',
    'line-height': '16.1px',
  };
  root.children = [btn];
  const snap = insp.capture(root);
  const tgt = new Element('div');
  tgt.outerHTML = '<div></div>';
  tgt._computed = {};
  const p = insp.buildPrompt(snap, tgt);
  assert('prompt warns about user-agent-default padding on button', p.includes('user-agent') && p.includes('不反映真实视觉饱满度'));
  assert('prompt names the offending tag', p.includes('该 button 的 padding'));
  assert('prompt cites measured vertical/horizontal totals', p.includes('vertical 2px') && p.includes('horizontal 12px'));
  assert('prompt tells reader not to copy padding verbatim', p.includes('不要照抄 padding'));
  assert('prompt offers modern button padding cheat-sheet', p.includes('font-size 14 → padding 6×12'));

  // Negative: a button with healthy modern padding should NOT trigger the warning
  const goodBtn = new Element('button');
  goodBtn.className = 'cta-modern';
  goodBtn.innerText = 'OK';
  goodBtn._computed = {
    'padding-top': '8px', 'padding-bottom': '8px',
    'padding-left': '16px', 'padding-right': '16px',
    'font-size': '14px',
  };
  const goodRoot = new Element('div');
  goodRoot.outerHTML = '<div><button class="cta-modern">OK</button></div>';
  goodRoot._computed = {};
  goodRoot.children = [goodBtn];
  const goodSnap = insp.capture(goodRoot);
  const goodPrompt = insp.buildPrompt(goodSnap, tgt);
  assert('healthy button (8×16 padding) does NOT trigger warning', !goodPrompt.includes('不反映真实视觉饱满度'));

  // Negative: non-form element with tight padding should NOT trigger the warning
  const tightSpan = new Element('span');
  tightSpan.className = 'tight';
  tightSpan.innerText = 'x';
  tightSpan._computed = { 'padding-top': '1px', 'padding-bottom': '1px', 'padding-left': '6px', 'padding-right': '6px' };
  const spanRoot = new Element('div');
  spanRoot.outerHTML = '<div><span class="tight">x</span></div>';
  spanRoot._computed = {};
  spanRoot.children = [tightSpan];
  const spanSnap = insp.capture(spanRoot);
  const spanPrompt = insp.buildPrompt(spanSnap, tgt);
  assert('non-form span with same padding does NOT trigger warning', !spanPrompt.includes('不反映真实视觉饱满度'));
}

console.log('\n=== T5j: 分级纪律注入 (P1-2) — 长尾规则按参考特征命中才塞 ===');
{
  const tgt = new Element('div');
  tgt.outerHTML = '<div>t</div>';
  tgt._computed = {};

  // -- Scenario A: minimum-feature reference (plain card with h3+p, no children of
  // interest, no pseudos, no motion, no tnum, no sectioned bg). Long-tail rules
  // should ALL be absent. Core rules still present.
  const minRoot = new Element('article');
  minRoot.className = 'card';
  minRoot.outerHTML = '<article class="card"><h3>x</h3><p>y</p></article>';
  minRoot._computed = {
    'background-color': 'rgb(255, 255, 255)',
    'color': 'rgb(17, 17, 17)',
    'padding-top': '20px', 'padding-right': '22px',
    'padding-bottom': '20px', 'padding-left': '22px',
    'border-top-width': '1px',
    'transition': '0.15s',  // 仅 placeholder transition, transform 默认 none
  };
  const minSnap = insp.capture(minRoot);
  const minPrompt = insp.buildPrompt(minSnap, tgt);

  // Core rules always present (regardless of features):
  assert('min: core 视觉读图 present', minPrompt.includes('视觉读图') && minPrompt.includes('布局靠数据不靠猜'));
  assert('min: core 资源处置 present', minPrompt.includes('资源处置') && minPrompt.includes('按图生重生'));
  assert('min: core 间距优先 present', minPrompt.includes('间距优先'));
  // Long-tail rules ALL absent in minimum scenario:
  assert('min: NO 尺寸反推 (no absolute child)', !minPrompt.includes('尺寸反推'));
  assert('min: NO 分区背景对比 (root bg same as cards or no children)', !minPrompt.includes('分区背景对比'));
  assert('min: NO 伪元素优先 (no ::before/::after with content)', !minPrompt.includes('伪元素优先'));
  assert('min: NO 动效复刻 (no real motion)', !minPrompt.includes('transform / transition / animation'));
  assert('min: NO 定位与层叠 (no absolute anywhere)', !minPrompt.includes('定位与层叠'));
  assert('min: NO 数字字体 tnum (no tabular-nums)', !minPrompt.includes('数字字体'));

  // -- Scenario B: feature-rich reference — should trigger ALL long-tail rules.
  const richRoot = new Element('article');
  richRoot.className = 'card';
  richRoot.outerHTML = '<article class="card">x</article>';
  richRoot._computed = {
    'background-color': 'rgba(0, 0, 0, 0)',  // root transparent
    'transform': 'translateY(-2px)',          // real motion (not identity matrix)
    'transition': 'transform 0.3s ease',
  };
  richRoot._pseudos = {
    '::after': { content: '"NEW"', position: 'absolute', top: '8px', right: '8px', 'background-color': 'rgb(255, 80, 80)' },
  };
  const inner = new Element('div');
  inner._computed = {
    'background-color': 'rgb(255, 255, 255)',  // 子 white vs 根 transparent → 分区
    'position': 'absolute',                     // absolute child → _g_abs
    'top': '0', 'right': '0',
  };
  const numChild = new Element('span');
  numChild._computed = {
    'font-feature-settings': '"tnum"',         // tnum → _g_num
    'font-variant-numeric': 'tabular-nums',
  };
  inner.children = [numChild];
  richRoot.children = [inner];
  const richSnap = insp.capture(richRoot);
  const richPrompt = insp.buildPrompt(richSnap, tgt);

  // All long-tail rules present in rich scenario:
  assert('rich: 尺寸反推 present (has absolute child)', richPrompt.includes('尺寸反推'));
  assert('rich: 分区背景对比 present (root transparent vs child white)', richPrompt.includes('分区背景对比'));
  assert('rich: 伪元素优先 present (::after content=NEW)', richPrompt.includes('伪元素优先'));
  assert('rich: 动效复刻 present (transform!=identity)', richPrompt.includes('transform / transition / animation'));
  assert('rich: 定位与层叠 present (has absolute pseudo + absolute child)', richPrompt.includes('定位与层叠'));
  assert('rich: 数字字体 present (grandchild has tnum)', richPrompt.includes('数字字体'));

  // -- Scenario C: pseudo-only absolute (no child absolute) — _g_abs should still fire
  // because the rule is meaningful for badge/ribbon patterns implemented as pseudos.
  const pseudoOnlyRoot = new Element('div');
  pseudoOnlyRoot.className = 'card';
  pseudoOnlyRoot.outerHTML = '<div class="card"></div>';
  pseudoOnlyRoot._computed = { 'background-color': 'rgb(255, 255, 255)' };
  pseudoOnlyRoot._pseudos = {
    '::after': { content: '"HOT"', position: 'absolute', top: '4px', right: '4px' },
  };
  const pseudoOnlySnap = insp.capture(pseudoOnlyRoot);
  const pseudoOnlyPrompt = insp.buildPrompt(pseudoOnlySnap, tgt);
  assert('pseudo-only: 定位与层叠 still fires for pseudo-element absolute', pseudoOnlyPrompt.includes('定位与层叠'));
  assert('pseudo-only: 尺寸反推 also fires (same gate)', pseudoOnlyPrompt.includes('尺寸反推'));

  // -- Scenario D: motion via hover interactions only (no transform on root)
  // Real motion isn't just transform != none — interactions.self with :hover counts too.
  const hoverOnlyRoot = new Element('div');
  hoverOnlyRoot.className = 'card';
  hoverOnlyRoot.outerHTML = '<div class="card"></div>';
  hoverOnlyRoot._computed = { 'background-color': 'rgb(255, 255, 255)' };
  const hoverSnap = insp.capture(hoverOnlyRoot);
  // capture() reads interactions from page CSS — none in sandbox — so inject directly.
  hoverSnap.interactions = {
    self: { hover: { 'transform': 'translateY(-4px)', 'box-shadow': '0 8px 16px rgba(0,0,0,0.1)' } },
    children: [],
    selfHoverDescendants: [],
  };
  const hoverPrompt = insp.buildPrompt(hoverSnap, tgt);
  assert('hover-only: 动效复刻 fires when interactions.self has hover state', hoverPrompt.includes('transform / transition / animation'));
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
