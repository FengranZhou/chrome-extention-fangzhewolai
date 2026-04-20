# Pseudo-element Inspection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add read-only viewing of `::before` / `::after` pseudo-element computed styles to Liaison, with canvas highlighting on hover, and include those styles in the AI prompt export.

**Architecture:** All new logic lives in a single standalone file `toolbar/pseudo-inspect.js` that exposes a `window.__liaisonPseudo` namespace. `toolbar/inject.js` is modified to load this file before the bundle. `toolbar/bundle.min.js` receives two tiny glue patches (each ≤ 80 chars) that call into the namespace — one near the panel render flow, one near the prompt export flow. No reverse-engineering of the minified bundle is required; anchor strings are located by grep.

**Tech Stack:** Vanilla JS, Custom Elements (Shadow DOM), Chrome Extension MV3, `window.getComputedStyle(el, pseudo)` API. No build, no bundler, no test runner — verification is manual via the loaded extension + browser devtools.

**Spec:** [docs/superpowers/specs/2026-04-20-pseudo-element-inspect-design.md](../specs/2026-04-20-pseudo-element-inspect-design.md)

**Verification convention:** Instead of TDD with a test runner (there is none in this project), each task follows a "manual TDD" variant:
1. Define a concrete observable behavior
2. Verify the current code does NOT yet exhibit it (the "fail")
3. Make the change
4. Verify the code now exhibits it (the "pass")
5. Commit

---

## Task 0 (Optional, Recommended): Initialize git & archive `.bak*` backups

Project is not currently under version control. All subsequent tasks assume `git commit` works. If you skip this task, treat every "commit" step as "save manually / your own version control."

**Files:**
- Create: `/Users/iflyhedUED/CC-project/liaison-patched/.git/` (implicitly via `git init`)
- Create: `/Users/iflyhedUED/CC-project/liaison-patched-bak-archive.zip` (outside repo)

- [ ] **Step 1: Initialize git repo**

```bash
cd /Users/iflyhedUED/CC-project/liaison-patched
git init
git add .
git status
```

Expected: working tree shows all files staged, including all `.bak*` files.

- [ ] **Step 2: Archive `.bak*` files outside the repo before first commit**

```bash
cd /Users/iflyhedUED/CC-project/liaison-patched
zip -r ../liaison-patched-bak-archive.zip toolbar/*.bak*
ls -la ../liaison-patched-bak-archive.zip
```

Expected: a single zip ~10MB outside the project directory.

- [ ] **Step 3: Remove `.bak*` from repo, write `.gitignore`**

```bash
cd /Users/iflyhedUED/CC-project/liaison-patched
rm toolbar/*.bak*
printf '*.bak*\n.DS_Store\n' > .gitignore
git add -A
```

- [ ] **Step 4: Commit baseline**

```bash
git commit -m "chore: initial import, archive legacy .bak backups"
git log --oneline
```

Expected: one commit shown.

---

## Task 1: Locate the two anchor points in `bundle.min.js`

Before writing any code, find the exact strings we will insert glue next to. **Do not modify the bundle yet.** Record the findings as comments in the plan document (or a scratch file).

**Files:**
- Read: `/Users/iflyhedUED/CC-project/liaison-patched/toolbar/bundle.min.js`

- [ ] **Step 1: Locate panel render anchor**

Known from spec: the panel meta is built via `xs(l.target)` and assigned to `n.meta` around column 16836 of line 176. Use Grep to confirm:

```
Grep pattern: meta=\{\.\.\.xs\(l\.target\)
path: toolbar/bundle.min.js
output_mode: content
-n: true
```

Expected: one match. Record the ~200-char context. The insertion point will be **immediately after `n.meta={...xs(l.target)...}` is assigned** (before the next statement).

- [ ] **Step 2: Locate prompt export anchor**

The prompt export function builds a text payload containing selected-element styles. Grep for likely markers:

```
Grep pattern: (Element:|Styles:|Selected|prompt)
path: toolbar/bundle.min.js
output_mode: content
-n: true
head_limit: 30
```

If those don't hit, try these alternatives in order: `clipboard`, `writeText`, `copyPrompt`, `exportPrompt`, `\\nStyles`, `"\\n\\n"`.

Expected: find the function that concatenates per-element style strings into the prompt. Record the exact 200-char context. Insertion point will be **immediately after per-element styles are appended, before the next element begins or before the final payload is returned**.

- [ ] **Step 3: Record anchors**

Append a short note to the plan file or a scratch file with:

```
# Anchor A (panel render)
Context: ...<80 chars before>... n.meta={...xs(l.target),sharedScopeEnabled:... ...<80 chars after>...

# Anchor B (prompt export)
Context: ...<200 char snippet>...
```

- [ ] **Step 4: Commit findings**

```bash
git add docs/superpowers/plans/
git commit -m "docs(plan): record anchor points in bundle.min.js"
```

---

## Task 2: Create `pseudo-inspect.js` with constants and stylesheet

Single-file module, attached to `window.__liaisonPseudo`. Start by defining the allowlist and the default-value table. Expose only the namespace stub for now.

**Files:**
- Create: `/Users/iflyhedUED/CC-project/liaison-patched/toolbar/pseudo-inspect.js`

- [ ] **Step 1: Define failing behavior**

In Chrome DevTools console on any page:

```js
window.__liaisonPseudo
```

Expected: `undefined` (the module is not loaded yet).

- [ ] **Step 2: Create the file with constants**

```js
// toolbar/pseudo-inspect.js
// Liaison addon: read-only inspection of ::before / ::after pseudo-elements
// See docs/superpowers/specs/2026-04-20-pseudo-element-inspect-design.md
;(function () {
  'use strict'

  const PSEUDO_ALLOWLIST = [
    'content',
    'display',
    'position', 'top', 'right', 'bottom', 'left', 'z-index',
    'width', 'height',
    'margin', 'padding', 'border',
    'border-radius',
    'background',
    'color',
    'opacity',
    'font-size', 'font-weight',
    'transform',
    'pointer-events',
  ]

  // Returns true if the computed value for `prop` is the browser default and should be hidden.
  function isDefault(prop, value, el) {
    if (value == null || value === '') return true
    switch (prop) {
      case 'content':         return value === 'none'
      case 'display':         return value === 'inline'
      case 'position':        return value === 'static'
      case 'top':
      case 'right':
      case 'bottom':
      case 'left':            return value === 'auto'
      case 'z-index':         return value === 'auto'
      case 'width':
      case 'height':          return value === 'auto' || value === '0px'
      case 'margin':
      case 'padding':         return value === '0px'
      case 'border':          return /^0px/.test(value) || value === 'none' || value.includes(' 0px ')
      case 'border-radius':   return value === '0px'
      case 'background':      return value === 'rgba(0, 0, 0, 0)' || value.startsWith('rgba(0, 0, 0, 0) none')
      case 'color':           {
        if (!el) return false
        const parentColor = window.getComputedStyle(el).color
        return value === parentColor
      }
      case 'opacity':         return value === '1'
      case 'transform':       return value === 'none'
      case 'pointer-events':  return value === 'auto'
      case 'font-size':
      case 'font-weight':     {
        if (!el) return false
        const parentVal = window.getComputedStyle(el).getPropertyValue(prop)
        return value === parentVal
      }
    }
    return false
  }

  window.__liaisonPseudo = {
    PSEUDO_ALLOWLIST,
    isDefault,
    // Filled in by later tasks:
    getPseudoStyles: null,
    renderPseudoSection: null,
    serializePseudoStylesForPrompt: null,
  }
})();
```

- [ ] **Step 3: Verify the file is syntactically valid**

```bash
cd /Users/iflyhedUED/CC-project/liaison-patched
node -c toolbar/pseudo-inspect.js && echo OK
```

Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add toolbar/pseudo-inspect.js
git commit -m "feat(pseudo): add module skeleton with allowlist and default filter"
```

---

## Task 3: Implement `getPseudoStyles(el, pseudo)`

Read computed styles for a given pseudo-element, filter through the allowlist and default filter, return an ordered array.

**Files:**
- Modify: `toolbar/pseudo-inspect.js`

- [ ] **Step 1: Define failing behavior**

In console (after loading the module manually via `<script>` in devtools):

```js
const testEl = document.createElement('div')
testEl.style.position = 'relative'
testEl.innerHTML = ''
const style = document.createElement('style')
style.textContent = '.test-pe::before { content: ""; height: 40px; background: red; position: absolute; top: 0; }'
document.head.appendChild(style)
testEl.className = 'test-pe'
document.body.appendChild(testEl)
window.__liaisonPseudo.getPseudoStyles(testEl, '::before')
```

Expected: `undefined is not a function` / `getPseudoStyles is null`.

- [ ] **Step 2: Add `getPseudoStyles` implementation**

Replace the `getPseudoStyles: null,` line in `window.__liaisonPseudo` with the full implementation. Insert this function **inside the IIFE, above the `window.__liaisonPseudo = {...}` assignment**:

```js
  function getPseudoStyles(el, pseudo) {
    if (!el || !el.nodeType) return []
    const cs = window.getComputedStyle(el, pseudo)
    const content = cs.getPropertyValue('content')
    // If content is 'none', the browser did not generate the pseudo-element; skip entirely.
    if (content === 'none') return []

    const out = []
    for (const prop of PSEUDO_ALLOWLIST) {
      const raw = cs.getPropertyValue(prop)
      if (isDefault(prop, raw, el)) continue
      out.push({ prop, value: raw })
    }
    return out
  }
```

Then update the namespace assignment:

```js
  window.__liaisonPseudo = {
    PSEUDO_ALLOWLIST,
    isDefault,
    getPseudoStyles,
    renderPseudoSection: null,
    serializePseudoStylesForPrompt: null,
  }
```

- [ ] **Step 3: Verify behavior manually**

Save the file, then in Chrome go to any page, open DevTools console, and run:

```js
// Load the module manually for testing
const s = document.createElement('script')
s.src = 'file:///Users/iflyhedUED/CC-project/liaison-patched/toolbar/pseudo-inspect.js'
document.head.appendChild(s)
// If file:// is blocked, paste the file content into the console instead.

// Create a test pseudo-element:
const style = document.createElement('style')
style.textContent = '.__pe_test::before { content: "X"; height: 40px; background: red; position: absolute; top: 0; width: 100px; }'
document.head.appendChild(style)
const el = document.createElement('div')
el.className = '__pe_test'
el.style.position = 'relative'
document.body.appendChild(el)

// Check:
window.__liaisonPseudo.getPseudoStyles(el, '::before')
```

Expected output (ordering may vary slightly on browser):

```
[
  { prop: 'content', value: '"X"' },
  { prop: 'position', value: 'absolute' },
  { prop: 'top', value: '0px' },
  { prop: 'width', value: '100px' },
  { prop: 'height', value: '40px' },
  { prop: 'background', value: 'rgb(255, 0, 0) none repeat scroll 0% 0% / auto padding-box border-box' },
]
```

And:

```js
// Negative case: element without any pseudo:
const plain = document.createElement('div')
document.body.appendChild(plain)
window.__liaisonPseudo.getPseudoStyles(plain, '::before')
```

Expected: `[]`.

- [ ] **Step 4: Commit**

```bash
git add toolbar/pseudo-inspect.js
git commit -m "feat(pseudo): implement getPseudoStyles with default filtering"
```

---

## Task 4: Implement `LiaisonPseudoHighlight` custom element

Dashed-outline overlay with a corner label, positioned with `position: fixed`. Includes the rect-calculation helper.

**Files:**
- Modify: `toolbar/pseudo-inspect.js`

- [ ] **Step 1: Define failing behavior**

```js
document.createElement('liaison-pseudo-highlight').constructor.name
```

Expected: `HTMLElement` (unregistered — behaves as generic element).

- [ ] **Step 2: Register the custom element**

Insert this block inside the IIFE, above the `window.__liaisonPseudo = {...}` assignment:

```js
  function parsePx(v) {
    if (typeof v !== 'string') return 0
    const n = parseFloat(v)
    return isNaN(n) ? 0 : n
  }

  function findPositionedAncestor(el) {
    let cur = el.parentElement
    while (cur) {
      const p = window.getComputedStyle(cur).position
      if (p === 'relative' || p === 'absolute' || p === 'fixed' || p === 'sticky') return cur
      cur = cur.parentElement
    }
    return null
  }

  function getPseudoRect(el, pseudo) {
    const cs = window.getComputedStyle(el, pseudo)
    const elRect = el.getBoundingClientRect()
    const position = cs.position

    if (position === 'absolute' || position === 'fixed') {
      const anchor = findPositionedAncestor(el) || document.documentElement
      const ar = position === 'fixed'
        ? { left: 0, top: 0 }
        : anchor.getBoundingClientRect()
      const width  = parsePx(cs.width)  || elRect.width
      const height = parsePx(cs.height) || elRect.height
      const leftCs = cs.left
      const topCs  = cs.top
      return {
        left:   leftCs !== 'auto' ? ar.left + parsePx(leftCs) : elRect.left,
        top:    topCs  !== 'auto' ? ar.top  + parsePx(topCs)  : elRect.top,
        width,
        height,
      }
    }

    // static / relative: approximate with host element rect + pseudo's width/height if set
    return {
      left: elRect.left,
      top:  elRect.top,
      width:  parsePx(cs.width)  || elRect.width,
      height: parsePx(cs.height) || elRect.height,
    }
  }

  class LiaisonPseudoHighlight extends HTMLElement {
    constructor() {
      super()
      const root = this.attachShadow({ mode: 'open' })
      root.innerHTML = `
        <style>
          :host {
            position: fixed;
            pointer-events: none;
            z-index: 2147483646;
            box-sizing: border-box;
            border: 1.5px dashed #4a9eff;
            background: rgba(74, 158, 255, 0.06);
          }
          .label {
            position: absolute;
            top: -18px; left: 0;
            padding: 1px 6px;
            font: 500 10px/14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            color: #4a9eff;
            background: #fff;
            border: 1px solid #4a9eff;
            border-radius: 3px;
            white-space: nowrap;
          }
        </style>
        <div class="label"></div>
      `
      this._label = root.querySelector('.label')
    }
    showFor(el, pseudo) {
      const r = getPseudoRect(el, pseudo)
      if (!r.width || !r.height) { this.hide(); return }
      this.style.left   = r.left + 'px'
      this.style.top    = r.top  + 'px'
      this.style.width  = r.width  + 'px'
      this.style.height = r.height + 'px'
      this.style.display = 'block'
      this._label.textContent = pseudo
    }
    hide() {
      this.style.display = 'none'
    }
  }
  if (!customElements.get('liaison-pseudo-highlight')) {
    customElements.define('liaison-pseudo-highlight', LiaisonPseudoHighlight)
  }

  // Singleton instance lazily appended to <body>
  let _highlight = null
  function getHighlight() {
    if (!_highlight || !_highlight.isConnected) {
      _highlight = document.createElement('liaison-pseudo-highlight')
      _highlight.style.display = 'none'
      document.body.appendChild(_highlight)
    }
    return _highlight
  }
```

Extend the namespace:

```js
  window.__liaisonPseudo = {
    PSEUDO_ALLOWLIST,
    isDefault,
    getPseudoStyles,
    getPseudoRect,
    getHighlight,
    renderPseudoSection: null,
    serializePseudoStylesForPrompt: null,
  }
```

- [ ] **Step 3: Verify manually**

Reload the test page, paste the file contents (or auto-load via Task 7 if already wired) and run:

```js
const el = document.querySelector('.__pe_test')
window.__liaisonPseudo.getHighlight().showFor(el, '::before')
```

Expected: a dashed blue rectangle with a `::before` label appears overlaying the element's pseudo area.

```js
window.__liaisonPseudo.getHighlight().hide()
```

Expected: rectangle disappears.

- [ ] **Step 4: Commit**

```bash
git add toolbar/pseudo-inspect.js
git commit -m "feat(pseudo): add LiaisonPseudoHighlight custom element with rect calc"
```

---

## Task 5: Implement `renderPseudoSection(el)` — panel UI fragment

Returns an `HTMLElement` containing collapsible `::before` / `::after` sections. Handles expand/collapse, hover→highlight, click→copy. Returns `null` when neither pseudo has any styles.

**Files:**
- Modify: `toolbar/pseudo-inspect.js`

- [ ] **Step 1: Define failing behavior**

```js
window.__liaisonPseudo.renderPseudoSection
```

Expected: `null`.

- [ ] **Step 2: Implement**

Insert inside the IIFE, above the `window.__liaisonPseudo = {...}` assignment:

```js
  function renderOneSection(el, pseudo) {
    const styles = getPseudoStyles(el, pseudo)
    if (styles.length === 0) return null

    const section = document.createElement('div')
    section.className = 'liaison-pseudo-section'
    section.dataset.pseudo = pseudo
    section.style.cssText = `
      border-top: 1px solid rgba(0,0,0,0.08);
      padding: 8px 10px;
      font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    `

    const head = document.createElement('div')
    head.className = 'liaison-pseudo-head'
    head.style.cssText = 'cursor: pointer; user-select: none; display: flex; justify-content: space-between; color: #333;'
    head.innerHTML = `
      <span><span class="caret">▸</span> <b>${pseudo}</b></span>
      <span style="color:#888;">${styles.length} prop${styles.length > 1 ? 's' : ''}</span>
    `

    const body = document.createElement('div')
    body.className = 'liaison-pseudo-body'
    body.style.cssText = 'display: none; margin-top: 6px;'
    for (const { prop, value } of styles) {
      const row = document.createElement('div')
      row.className = 'liaison-pseudo-row'
      row.style.cssText = 'display: flex; padding: 2px 0; cursor: pointer;'
      row.innerHTML = `
        <span style="color:#666; min-width: 110px;">${prop}</span>
        <span style="color:#111; flex:1; word-break: break-all;">${escapeHtml(value)}</span>
      `
      row.addEventListener('mouseenter', () => getHighlight().showFor(el, pseudo))
      row.addEventListener('mouseleave', () => getHighlight().hide())
      row.addEventListener('click', () => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(`${prop}: ${value};`)
        }
      })
      body.appendChild(row)
    }

    let expanded = false
    head.addEventListener('click', () => {
      expanded = !expanded
      body.style.display = expanded ? 'block' : 'none'
      head.querySelector('.caret').textContent = expanded ? '▾' : '▸'
    })

    section.appendChild(head)
    section.appendChild(body)
    return section
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  function renderPseudoSection(el) {
    if (!el || !el.nodeType) return null
    const wrap = document.createElement('div')
    wrap.className = 'liaison-pseudo-wrap'
    const before = renderOneSection(el, '::before')
    const after  = renderOneSection(el, '::after')
    if (!before && !after) return null
    if (before) wrap.appendChild(before)
    if (after)  wrap.appendChild(after)
    return wrap
  }
```

Update the namespace:

```js
  window.__liaisonPseudo = {
    PSEUDO_ALLOWLIST,
    isDefault,
    getPseudoStyles,
    getPseudoRect,
    getHighlight,
    renderPseudoSection,
    serializePseudoStylesForPrompt: null,
  }
```

- [ ] **Step 3: Verify manually**

```js
const el = document.querySelector('.__pe_test')
const frag = window.__liaisonPseudo.renderPseudoSection(el)
document.body.appendChild(frag)
```

Expected:
- A collapsed `▸ ::before  5 props` section appears at bottom of page
- Clicking the head expands it, caret flips to `▾`
- Hovering any row shows the dashed blue rectangle on the element
- Clicking a row puts `content: "X";` (or similar) in clipboard; paste somewhere to confirm

For negative case:

```js
const plain = document.createElement('div')
document.body.appendChild(plain)
window.__liaisonPseudo.renderPseudoSection(plain)
```

Expected: `null`.

- [ ] **Step 4: Commit**

```bash
git add toolbar/pseudo-inspect.js
git commit -m "feat(pseudo): implement renderPseudoSection with hover highlight and copy"
```

---

## Task 6: Implement `serializePseudoStylesForPrompt(el)`

Produce a text block to append to the AI prompt. Empty string when neither pseudo has styles.

**Files:**
- Modify: `toolbar/pseudo-inspect.js`

- [ ] **Step 1: Define failing behavior**

```js
window.__liaisonPseudo.serializePseudoStylesForPrompt
```

Expected: `null`.

- [ ] **Step 2: Implement**

Insert inside the IIFE:

```js
  function serializePseudoStylesForPrompt(el) {
    if (!el || !el.nodeType) return ''
    const parts = []
    for (const pseudo of ['::before', '::after']) {
      const styles = getPseudoStyles(el, pseudo)
      if (styles.length === 0) continue
      const lines = styles.map(({ prop, value }) => `  ${prop}: ${value}`).join('\n')
      parts.push(`${pseudo}:\n${lines}`)
    }
    if (parts.length === 0) return ''
    return '\n\n' + parts.join('\n\n')
  }
```

Update namespace to its final form:

```js
  window.__liaisonPseudo = {
    PSEUDO_ALLOWLIST,
    isDefault,
    getPseudoStyles,
    getPseudoRect,
    getHighlight,
    renderPseudoSection,
    serializePseudoStylesForPrompt,
  }
```

- [ ] **Step 3: Verify manually**

```js
const el = document.querySelector('.__pe_test')
console.log(window.__liaisonPseudo.serializePseudoStylesForPrompt(el))
```

Expected output (example):

```


::before:
  content: "X"
  position: absolute
  top: 0px
  width: 100px
  height: 40px
  background: rgb(255, 0, 0) none repeat scroll 0% 0% / auto padding-box border-box
```

And:

```js
const plain = document.createElement('div')
document.body.appendChild(plain)
window.__liaisonPseudo.serializePseudoStylesForPrompt(plain)
```

Expected: `""` (empty string).

- [ ] **Step 4: Commit**

```bash
git add toolbar/pseudo-inspect.js
git commit -m "feat(pseudo): implement serializePseudoStylesForPrompt"
```

---

## Task 7: Load `pseudo-inspect.js` from `inject.js`

Wire the new file into the extension's injection pipeline so it runs on every tab where Liaison activates.

**Files:**
- Modify: `toolbar/inject.js`

- [ ] **Step 1: Define failing behavior**

1. Open `chrome://extensions`, ensure Developer Mode is on, reload the Liaison extension
2. Open any webpage, press Alt+Shift+D to activate
3. In console: `window.__liaisonPseudo`

Expected: `undefined`.

- [ ] **Step 2: Update `inject.js`**

Replace the current content of `toolbar/inject.js` with:

```js
var platform = typeof browser === 'undefined'
  ? chrome
  : browser

const pseudoScript = document.createElement('script')
pseudoScript.src = platform.runtime.getURL('toolbar/pseudo-inspect.js')
document.documentElement.appendChild(pseudoScript)

const script = document.createElement('script')
script.type = 'module'
script.src = platform.runtime.getURL('toolbar/bundle.min.js')
document.body.appendChild(script)

const liaison = document.createElement('liaison-app')

document.body.prepend(liaison)

platform.runtime.onMessage.addListener(request => {
  if (request.action === 'COLOR_MODE')
    liaison.setAttribute('color-mode', request.params.mode)
  else if (request.action === 'COLOR_SCHEME')
    liaison.setAttribute("color-scheme", request.params.mode)
})
```

- [ ] **Step 3: Verify behavior**

1. `chrome://extensions` → reload extension
2. Reload test page, press Alt+Shift+D
3. Console: `window.__liaisonPseudo`

Expected: an object with keys `PSEUDO_ALLOWLIST`, `isDefault`, `getPseudoStyles`, `getPseudoRect`, `getHighlight`, `renderPseudoSection`, `serializePseudoStylesForPrompt`.

- [ ] **Step 4: Commit**

```bash
git add toolbar/inject.js
git commit -m "feat(pseudo): load pseudo-inspect.js before bundle in inject pipeline"
```

---

## Task 8: Patch `bundle.min.js` to attach pseudo sections to the panel

Hook into the panel render flow using Anchor A from Task 1. Because `bundle.min.js` is minified, the patch is a short glue block that runs **after** the existing panel meta is computed.

**Files:**
- Modify: `toolbar/bundle.min.js` (surgical)

- [ ] **Step 1: Define failing behavior**

1. Reload extension, activate on a test page (e.g. the user's AntD tree dialog)
2. Select an element known to have a `::before` (like `.ant-tree-node-content-wrapper`)
3. Observe the Liaison panel

Expected: panel shows element styles as usual but **no `::before` / `::after` section** appears.

- [ ] **Step 2: Locate Anchor A and design the insert**

From Task 1, the anchor looks similar to:

```
n.meta={...xs(l.target),sharedScopeEnabled:l.sharedScopeEnabled,sharedCandidateCount:$(l.target).length}
```

The glue we want to run immediately after this (or after similar assignments on `liaison-panel-scope`) is:

```js
;(function(){try{var p=window.__liaisonPseudo;if(!p||!l.target||!n.$shadow)return;var old=n.$shadow.querySelector('.liaison-pseudo-wrap');if(old)old.remove();var frag=p.renderPseudoSection(l.target);if(frag)n.$shadow.appendChild(frag);}catch(e){console.warn('[liaison-pseudo]',e);}})();
```

**Important:** verify that `n` is the panel element and has a `$shadow` property in this scope. In the grepped context, `n.$shadow` is referenced right before the `on('liaison-panel-close')` line — confirming `n` is a custom element with a Shadow DOM. If not, adjust to `n.shadowRoot` or `n` itself.

- [ ] **Step 3: Apply the patch**

Use Edit tool with `replace_all: false` (must be unique). The `old_string` should be the 200-char anchor context found in Task 1; the `new_string` is the same context with the IIFE appended **after the `n.meta = {...}` assignment and its terminating semicolon, before the next statement**.

Because the exact string depends on Task 1's findings, use this template: find the semicolon terminating the `n.meta = {...};` assignment and the next expression starts with `t(n).on(...)` or `P()`. Insert the IIFE between them.

Concrete example substitution (verify actual string first via Grep):

- `old_string`: `n.meta={...xs(l.target),sharedScopeEnabled:l.sharedScopeEnabled,sharedCandidateCount:$(l.target).length}),P()`
- `new_string`: `n.meta={...xs(l.target),sharedScopeEnabled:l.sharedScopeEnabled,sharedCandidateCount:$(l.target).length}),((function(){try{var p=window.__liaisonPseudo;if(!p||!l.target||!n.$shadow)return;var old=n.$shadow.querySelector('.liaison-pseudo-wrap');if(old)old.remove();var frag=p.renderPseudoSection(l.target);if(frag)n.$shadow.appendChild(frag);}catch(e){console.warn('[liaison-pseudo]',e);}})()),P()`

The extra `(...)` wrapper turns the IIFE into a comma-expression compatible with the surrounding `,P()` chain.

If the actual anchor context differs, adjust `old_string` / `new_string` to match while preserving the rule "insert the IIFE directly after the `n.meta = {...}` assignment completes."

- [ ] **Step 4: Verify behavior**

1. Reload extension
2. Open any page that has pseudo-elements (e.g. load the user's AntD tree dialog)
3. Activate Liaison, select `.ant-tree-node-content-wrapper`
4. Observe panel

Expected: panel now shows a collapsed `▸ ::before N props` section. Clicking expands it. Hovering any row draws a blue dashed rectangle at the pseudo's location.

Negative case: select a plain `<div>` without pseudo-elements — no pseudo section appears.

If the panel or bundle broke entirely, revert with `git checkout toolbar/bundle.min.js` and re-locate the anchor.

- [ ] **Step 5: Commit**

```bash
git add toolbar/bundle.min.js
git commit -m "feat(pseudo): wire renderPseudoSection into liaison-panel render flow"
```

---

## Task 9: Patch `bundle.min.js` to append pseudo styles to prompt export

Using Anchor B from Task 1.

**Files:**
- Modify: `toolbar/bundle.min.js`

- [ ] **Step 1: Define failing behavior**

1. Select an element with `::before` styles
2. Trigger Liaison's "export prompt" action (whatever UI it has — likely a button on the dock/toolbar)
3. Paste clipboard content to a scratch area

Expected: the prompt contains the element's own styles but **no `::before:` section**.

- [ ] **Step 2: Design the insert**

Anchor B is "where the function that builds the prompt concatenates per-element style text." The goal: append `window.__liaisonPseudo.serializePseudoStylesForPrompt(el)` to the element's styles block.

If the prompt is built by a function like `formatStyles(el)` returning a string, wrap or append to its return site. The glue is:

```js
+(function(e){try{var p=window.__liaisonPseudo;return p?p.serializePseudoStylesForPrompt(e):'';}catch(_){return '';}})(VAR_FOR_ELEMENT)
```

where `VAR_FOR_ELEMENT` is whatever local holds the element being serialized (from Task 1's grep context — likely `e`, `t`, or `l.target`).

- [ ] **Step 3: Apply the patch**

Use Edit tool with the actual 200-char context from Task 1 and append the glue. Example template (adjust to real strings):

- `old_string`: `t+=n.name+": "+n.value+"\n"})),t`  *(hypothetical — replace with actual)*
- `new_string`: `t+=n.name+": "+n.value+"\n"})),t+(function(e){try{var p=window.__liaisonPseudo;return p?p.serializePseudoStylesForPrompt(e):'';}catch(_){return '';}})(e)`

The inserted expression must evaluate to a string and be concatenated at the right point (typically just before the function returns or just after a per-element styles block).

- [ ] **Step 4: Verify behavior**

1. Reload extension
2. Select `.ant-tree-node-content-wrapper` (or your `__pe_test` div)
3. Trigger export prompt
4. Paste clipboard

Expected: the prompt now contains, after the element's own styles, a block like:

```
::before:
  content: ""
  height: 40px
  background: ...
```

Negative case: select a plain `<div>` — no `::before:` section in the prompt.

- [ ] **Step 5: Commit**

```bash
git add toolbar/bundle.min.js
git commit -m "feat(pseudo): append pseudo-element styles to exported AI prompt"
```

---

## Task 10: End-to-end verification on the user's real scenario

Use the exact AntD tree dialog that motivated the feature.

**Files:**
- None (verification only)

- [ ] **Step 1: Prepare the scenario**

1. Reload the Liaison extension
2. Open the project page where `.ant-tree-node-content-wrapper::before` creates the 40px gray row background (the screenshot scenario)
3. Open the "我的文档" dialog (or whatever dialog contains the tree)

- [ ] **Step 2: Inspect**

1. Press Alt+Shift+D to activate Liaison
2. Click on a tree node row (the span that has the tree-node-content-wrapper class)
3. Scroll to the bottom of the Liaison panel

Expected:
- A collapsed `▸ ::before` section is visible at the bottom of the panel
- Property count shown on the right is at least 3 (content + height + background, possibly more)
- Clicking the header expands; rows appear
- Hovering the `height` row draws a dashed blue rectangle over the 40px-tall row area in the page
- Hovering the `background` row draws the same box (same pseudo)
- Clicking on the `height` value puts `height: 40px;` in clipboard

- [ ] **Step 3: Export prompt**

1. Trigger prompt export
2. Paste to a scratch area

Expected: the pasted text includes a `::before:` block listing content, height, background, position, and any other set properties.

- [ ] **Step 4: If any expected behavior fails**

Do NOT commit. Describe the failure and go back to the relevant task:
- No `::before` section in panel → bug in Task 8 (anchor mismatch or shadow root wrong)
- Highlight misaligned → bug in Task 4 (`getPseudoRect` for absolute positioning)
- Prompt missing the block → bug in Task 9 (anchor mismatch)
- `__liaisonPseudo` is undefined → bug in Task 7 (script load order)

- [ ] **Step 5: Commit verification evidence**

Take a screenshot of the panel showing the `::before` section expanded, save to `docs/superpowers/plans/screenshots/2026-04-20-e2e-before.png`, and commit:

```bash
mkdir -p docs/superpowers/plans/screenshots
# save screenshot into the folder
git add docs/superpowers/plans/screenshots/
git commit -m "docs(plan): attach E2E screenshot for pseudo-element inspection"
```

---

## Task 11: Regression verification

Confirm existing Liaison behavior is unaffected on pages without pseudo-elements.

**Files:**
- None (verification only)

- [ ] **Step 1: Plain element selection**

Open any plain HTML page (e.g. a simple blog post). Activate Liaison. Select a `<p>` or `<div>` with no pseudo-elements.

Expected:
- Panel looks exactly as before (no `::before` / `::after` sections visible, nothing extra at the bottom)
- Selecting, dragging handles, editing margin — all work unchanged
- Export prompt produces the same format it used to, with no trailing `::before:` or `::after:` block

- [ ] **Step 2: Console error check**

In DevTools console, run the selection flow a few times. Watch for `[liaison-pseudo]` warnings or other new errors.

Expected: no new errors. A single expected log: if you select a pseudo-bearing element, no warnings should appear. If `console.warn('[liaison-pseudo]', ...)` fires repeatedly, something is broken — go back to Task 8 or Task 4.

- [ ] **Step 3: Deactivation**

Press Alt+Shift+D twice to toggle Liaison off then on, in quick succession. Select another element. Verify the pseudo section still appears correctly (no stale state).

Expected: clean toggle, no orphaned highlight rectangles left on screen.

- [ ] **Step 4: Commit final state**

```bash
git tag pseudo-inspect-v1
git log --oneline
```

Expected: you see the full chain of commits from Task 0 through Task 10, tagged.

---

## Summary of Deliverables

| File | Change | Purpose |
|---|---|---|
| `toolbar/pseudo-inspect.js` | **New** (~220 lines) | All new logic — allowlist, style reader, custom element, panel fragment, prompt serializer |
| `toolbar/inject.js` | Modified | Load new script before bundle |
| `toolbar/bundle.min.js` | Patched (2 glue blocks, each ~200 chars) | Call into `__liaisonPseudo` at panel render + prompt export |
| `docs/superpowers/specs/2026-04-20-pseudo-element-inspect-design.md` | Already exists | Spec (reference) |
| `docs/superpowers/plans/2026-04-20-pseudo-element-inspect.md` | Already exists | This plan (reference) |
| `.gitignore` (if Task 0 done) | **New** | Ignore `.bak*` and `.DS_Store` |
