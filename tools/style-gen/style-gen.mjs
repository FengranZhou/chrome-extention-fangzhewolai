#!/usr/bin/env node
// style-gen.mjs — drive Google Labs Flow via CDP
// Usage: node style-gen.mjs --ref <image> --prompt "<text>" [--aspect 1:1] [--batch x4] [--out ./out]

import { chromium } from "playwright-core";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const argv = Object.fromEntries(
  process.argv.slice(2).reduce((acc, tok, i, arr) => {
    if (tok.startsWith("--")) acc.push([tok.slice(2), arr[i + 1] ?? true]);
    return acc;
  }, [])
);

const REF    = resolve(argv.ref);
const PROMPT = String(argv.prompt);
const ASPECT = argv.aspect ?? "1:1";
const BATCH  = String(argv.batch ?? "x4");
const OUT    = resolve(argv.out ?? "./out");
const CDP    = argv.cdp ?? "http://localhost:9222";
const DEBUG  = argv.debug ? true : false;

const ASPECT_INDEX = { "16:9": 0, "4:3": 1, "1:1": 2, "3:4": 3, "9:16": 4 }[ASPECT] ?? 2;
const BATCH_INDEX  = { "1x": 0, "x2": 1, "x3": 2, "x4": 3 }[BATCH] ?? 3;

if (!existsSync(REF)) { console.error(`reference not found: ${REF}`); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const shot = async (page, tag) => {
  if (!DEBUG) return;
  const p = `/tmp/sg-${tag}.png`;
  await page.screenshot({ path: p });
  log(`  📸 ${p}`);
};

log("connecting to", CDP);
const browser = await chromium.connectOverCDP(CDP);
const [ctx] = browser.contexts();

const page = await ctx.newPage();
log("opening Flow");
await page.goto("https://labs.google/fx/zh/tools/flow", { waitUntil: "domcontentloaded" });
await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

// Dismiss Google cookie consent bar if present — it overlays and intercepts clicks
const cookieOk = page.getByRole("button", { name: /OK,?\s*got it|接受|同意|Accept all/i }).first();
if (await cookieOk.isVisible({ timeout: 2000 }).catch(() => false)) {
  log("dismissing cookie consent");
  await cookieOk.click().catch(() => {});
  await page.waitForTimeout(500);
}

// Marketing landing → Create with Flow
const cta = page.getByRole("button", { name: /Create with Flow/i }).first();
if (await cta.isVisible({ timeout: 3000 }).catch(() => false)) {
  log("clicking 'Create with Flow'");
  await cta.click();
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
}
if (/accounts\.google|signin/i.test(page.url())) {
  console.error("sign-in required in automation Chrome — open the window and log in, then re-run");
  process.exit(4);
}
await shot(page, "01-after-landing");

// Create new project
log("creating project");
await page.getByRole("button", { name: /新建项目|new project|add_2/i }).first().click();
await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
await shot(page, "02-project");

// Open the model/aspect/batch menu (toolbar pill near prompt box)
log("opening model menu");
await page.locator('button:has-text("Nano Banana")').last().click();
await page.waitForTimeout(600);
await shot(page, "03-menu-open");

// Select aspect tab by index (more reliable than name)
log(`aspect: ${ASPECT} (index ${ASPECT_INDEX})`);
const aspectTabs = page.locator('[role="tab"]:has-text(":")');     // tabs that contain ":" — these are aspects
await aspectTabs.nth(ASPECT_INDEX).click();
await page.waitForTimeout(200);

// Select batch tab by index
log(`batch: ${BATCH} (index ${BATCH_INDEX})`);
const batchTabs = page.locator('[role="tab"]').filter({ hasText: /^[x1-4]+$/ });
await batchTabs.nth(BATCH_INDEX).click();
await page.waitForTimeout(200);
await shot(page, "04-menu-set");

// Close menu by clicking the empty workspace area (top center, far from menu)
log("closing menu");
await page.mouse.click(640, 200);
await page.waitForTimeout(500);
await shot(page, "05-menu-closed");

// Focus the prompt textbox first — the correct upload path is to paste the image
// directly into the contenteditable, which creates a small chip in the top-left of
// the input bar. Using the "+" / file-input goes into the canvas reference flow instead.
log("focusing prompt textbox");
await page.locator('div[role="textbox"][contenteditable="true"]').last().click();
await page.waitForTimeout(400);

// Paste reference image via synthetic ClipboardEvent with a DataTransfer carrying the file.
log(`pasting ${REF} into textbox`);
const REF_B64 = readFileSync(REF).toString("base64");
const REF_MIME = /\.png$/i.test(REF) ? "image/png" : /\.gif$/i.test(REF) ? "image/gif" : "image/jpeg";
await page.evaluate(({ b64, mime }) => {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const blob = new Blob([buf], { type: mime });
  const file = new File([blob], "ref.png", { type: mime, lastModified: Date.now() });
  const dt = new DataTransfer();
  dt.items.add(file);
  const tb = document.querySelector('div[role="textbox"][contenteditable="true"]');
  tb.focus();
  const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
  // some browsers don't honor the constructor option — force it onto the event
  try { Object.defineProperty(ev, "clipboardData", { value: dt }); } catch {}
  tb.dispatchEvent(ev);
}, { b64: REF_B64, mime: REF_MIME });

// Wait for the chip (~50×50 div) to appear in the prompt input bar.
log("waiting for reference chip to appear in prompt area");
const chipStart = Date.now();
let chipSeen = false;
while (Date.now() - chipStart < 60_000) {
  chipSeen = await page.evaluate(() => {
    const tb = document.querySelector('div[role="textbox"][contenteditable="true"]');
    if (!tb) return false;
    const tbRect = tb.getBoundingClientRect();
    const tbCenterY = (tbRect.top + tbRect.bottom) / 2;
    for (const el of document.querySelectorAll('div, img')) {
      if (el === tb) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 35 || r.width > 80) continue;
      if (r.height < 35 || r.height > 80) continue;
      const cy = (r.top + r.bottom) / 2;
      if (Math.abs(cy - tbCenterY) > 200) continue;
      if (r.left < tbRect.left - 80 || r.left > tbRect.left + 200) continue;
      if (el.tagName === 'IMG') {
        if (el.complete && el.naturalWidth >= 30) return true;
      } else {
        const cs = getComputedStyle(el);
        if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
        const im = el.querySelector('img');
        if (im && im.complete && im.naturalWidth >= 30) return true;
      }
    }
    return false;
  });
  if (chipSeen) { log("  reference chip detected"); break; }
  await page.waitForTimeout(1500);
}
if (!chipSeen) {
  console.error("reference chip never appeared — paste likely failed");
  process.exit(6);
}
await page.waitForTimeout(2000);
await shot(page, "06-uploaded");

// Handle consent dialog ("我同意" / agree) that may pop up on the automation account
const agreeBtn = page.getByRole("button", { name: /我同意|^同意$|agree|accept/i }).first();
if (await agreeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
  log("clicking '我同意' consent");
  await agreeBtn.click();
  await page.waitForTimeout(1500);
  await shot(page, "06b-consented");
}

// Fill prompt — DO NOT use page.keyboard.type():
//   Flow's contenteditable treats Enter as submit. type() translates "\n" in the
//   prompt to Enter keypresses, so a 5-line prompt fires 5 submits before we even
//   reach the explicit submit click below. This was the source of the May 17
//   "8 unusual-activity failures" cascade: the rate-limiter flagged the burst,
//   and every subsequent batch returned the风控 page.
// Instead: collapse any newlines defensively, then write the full string via
// execCommand('insertText') which fires beforeinput/input but never Enter.
log("filling prompt");
const SAFE_PROMPT = PROMPT.replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trim();
const promptBox = page.locator('div[role="textbox"][contenteditable="true"]').last();
await promptBox.click();
await page.waitForTimeout(200);
const filled = await page.evaluate((text) => {
  const tb = document.querySelector('div[role="textbox"][contenteditable="true"]');
  if (!tb) return false;
  tb.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(tb);
  sel.removeAllRanges();
  sel.addRange(range);
  return document.execCommand("insertText", false, text);
}, SAFE_PROMPT);
if (!filled) {
  console.error("insertText failed — refusing to fall back to keyboard.type() because it would fire Enter on newlines");
  process.exit(8);
}
await page.waitForTimeout(500);
await shot(page, "07-prompt-filled");

// Snapshot existing 1024×1024 image URLs BEFORE submit so we only save new ones.
const existingUrls = await page.evaluate(() => {
  const urls = [];
  for (const el of document.querySelectorAll("img")) {
    if (el.naturalWidth >= 800) urls.push(el.src);
  }
  return urls;
});
log(`existing result images: ${existingUrls.length}`);

// Submit — the bottom-right arrow button containing the material-symbols span "arrow_forward".
log("submitting");
const submitBtn = page.locator('button:has-text("arrow_forward")').first();
if (!(await submitBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
  console.error("submit button not found");
  await shot(page, "08-no-submit");
  process.exit(7);
}
await submitBtn.click();
await shot(page, "08-submitted");

// Wait for NEW results. Generation takes ~30-90s for x4 batch.
// Loop until we have BATCH_INDEX+1 new images OR count stays stable for 15s.
log(`waiting for ${BATCH_INDEX + 1} new result image(s) (up to 3 min)`);
const start = Date.now();
const expected = BATCH_INDEX + 1;
let images = [];
let stableSince = null;
let lastCount = 0;
while (Date.now() - start < 180_000) {
  images = await page.evaluate((existing) => {
    const ex = new Set(existing);
    const out = [];
    for (const el of document.querySelectorAll("img")) {
      if (el.naturalWidth < 800) continue;
      if (ex.has(el.src)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 150 || r.height < 150) continue;
      const src = el.src || "";
      if (!/labs\.google\/fx\/api\/trpc\/media|lh3|googleusercontent|storage\.googleapis|blob:/i.test(src)) continue;
      if (/avatar|profile|user/i.test(src)) continue;
      out.push({ src, w: el.naturalWidth, h: el.naturalHeight });
    }
    return out;
  }, existingUrls);
  if (images.length !== lastCount) {
    log(`  ${images.length} new image(s) so far`);
    lastCount = images.length;
    stableSince = Date.now();
  }
  if (images.length >= expected) break;
  if (images.length > 0 && stableSince && Date.now() - stableSince > 15_000) {
    log(`  count stable at ${images.length} for 15s — done`);
    break;
  }
  await page.waitForTimeout(2000);
}
await shot(page, "09-after-wait");

if (images.length === 0) {
  console.error("no result images appeared within 3 min");
  process.exit(5);
}

// Save each image
log(`saving ${images.length} image(s)`);
let saved = 0;
for (let i = 0; i < images.length; i++) {
  try {
    const buf = await page.evaluate(async (url) => {
      const r = await fetch(url);
      const b = await r.arrayBuffer();
      return Array.from(new Uint8Array(b));
    }, images[i].src);
    const path = join(OUT, `result-${Date.now()}-${i}.png`);
    writeFileSync(path, Buffer.from(buf));
    saved++;
    log(`  saved ${path} (${buf.length} bytes, ${images[i].w}×${images[i].h})`);
  } catch (e) {
    log("  save failed:", e.message);
  }
}

log(`done — ${saved}/${images.length} saved to ${OUT}`);
await browser.close().catch(() => {});
