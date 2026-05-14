// Unit tests for find-reference V2 helpers (buildPromptV2 + computeCropRect).
// These functions will be inlined into bundle.min.js by Task B3.
// Defining them here first locks behavior down so the bundle patch matches.

import assert from 'node:assert';

// ---- helpers (Task B3 will copy these into bundle as window.__liaisonFindRef) ----

function buildPromptV2({ url, title, ctx, problem, screenshotPath, scopePaths }) {
  const styleLines = Object.entries(ctx.style || {})
    .filter(([k, v]) => v && v !== 'none' && v !== 'normal')
    .map(([k, v]) => `  - ${k}: ${v}`)
    .join('\n');
  const scopeLines = (scopePaths || [
    'UI-网页', 'UI-桌面端', 'UI-移动端/版式', 'UI-移动端/质感'
  ]).map(p => `- ${p}`).join('\n');
  const screenshotLine = screenshotPath
    ? `- 元素截图: ${screenshotPath}`
    : `- 元素截图: (截取失败,纯文本检索)`;
  return `[使用 skill: 找本地参考]

[页面]
- URL: ${url}
- 标题: ${title}

[选中元素]
- 选择器: ${ctx.selector}
- 内容预览: "${ctx.textPreview || ''}"
- 关键样式:
${styleLines || '  (无)'}
${screenshotLine}

[搜索范围]
${scopeLines}

[我的问题]
${problem}
`;
}

function computeCropRect(rect, dpr) {
  return {
    sx: Math.max(0, Math.round(rect.left * dpr)),
    sy: Math.max(0, Math.round(rect.top * dpr)),
    sw: Math.max(1, Math.round(rect.width * dpr)),
    sh: Math.max(1, Math.round(rect.height * dpr)),
  };
}

// ---- Tests ----

function test_buildPrompt_includes_all_sections() {
  const p = buildPromptV2({
    url: 'https://x.test/p',
    title: 'Test Page',
    ctx: {
      selector: 'div.card',
      textPreview: 'hello',
      style: { color: 'rgb(0,0,0)', padding: '12px', display: 'flex' }
    },
    problem: '太单调',
    screenshotPath: '/Users/me/Downloads/liaison-element-1234.jpg',
    scopePaths: null,  // 走默认
  });
  assert.match(p, /\[使用 skill: 找本地参考\]/);
  assert.match(p, /URL: https:\/\/x\.test\/p/);
  assert.match(p, /选择器: div\.card/);
  assert.match(p, /color: rgb\(0,0,0\)/);
  assert.match(p, /元素截图: \/Users\/me\/Downloads\/liaison-element-1234\.jpg/);
  assert.match(p, /UI-网页/);
  assert.match(p, /UI-移动端\/质感/);
  assert.match(p, /我的问题\]\n太单调/);
}

function test_buildPrompt_filters_default_styles() {
  const p = buildPromptV2({
    url: '', title: '',
    ctx: { selector: 'x', style: { color: 'rgb(1,1,1)', border: 'none', font: 'normal' } },
    problem: 'q', screenshotPath: '/x.jpg',
  });
  assert.match(p, /color: rgb\(1,1,1\)/);
  assert.doesNotMatch(p, /border: none/);
  assert.doesNotMatch(p, /font: normal/);
}

function test_buildPrompt_handles_missing_screenshot() {
  const p = buildPromptV2({
    url: '', title: '',
    ctx: { selector: 'x', style: {} },
    problem: 'q', screenshotPath: null,
  });
  assert.match(p, /元素截图: \(截取失败,纯文本检索\)/);
}

function test_buildPrompt_custom_scope() {
  const p = buildPromptV2({
    url: '', title: '',
    ctx: { selector: 'x', style: {} },
    problem: 'q', screenshotPath: '/x.jpg',
    scopePaths: ['UI-移动端/质感'],
  });
  assert.match(p, /搜索范围\]\n- UI-移动端\/质感\n/);
  assert.doesNotMatch(p, /UI-网页/);
}

function test_computeCropRect_dpr2_doubles() {
  const r = computeCropRect({ left: 10, top: 20, width: 100, height: 50 }, 2);
  assert.deepStrictEqual(r, { sx: 20, sy: 40, sw: 200, sh: 100 });
}

function test_computeCropRect_clamps_negative_origin() {
  const r = computeCropRect({ left: -5, top: -10, width: 50, height: 50 }, 1);
  assert.deepStrictEqual(r, { sx: 0, sy: 0, sw: 50, sh: 50 });
}

function test_computeCropRect_min_size_1() {
  const r = computeCropRect({ left: 0, top: 0, width: 0, height: 0 }, 1);
  assert.strictEqual(r.sw, 1);
  assert.strictEqual(r.sh, 1);
}

const tests = [
  test_buildPrompt_includes_all_sections,
  test_buildPrompt_filters_default_styles,
  test_buildPrompt_handles_missing_screenshot,
  test_buildPrompt_custom_scope,
  test_computeCropRect_dpr2_doubles,
  test_computeCropRect_clamps_negative_origin,
  test_computeCropRect_min_size_1,
];

let pass = 0, fail = 0;
for (const t of tests) {
  try { t(); console.log('PASS', t.name); pass++; }
  catch (e) { console.error('FAIL', t.name, '\n', e.message); fail++; }
}
console.log(`\n${pass}/${pass+fail} tests passed`);
process.exit(fail === 0 ? 0 : 1);
