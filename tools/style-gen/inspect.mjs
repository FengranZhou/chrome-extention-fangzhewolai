// Probe the current Flow page state via CDP.
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://localhost:9222");
const [ctx] = browser.contexts();

// find the labs.google tab among existing pages
let page;
for (const p of ctx.pages()) {
  const u = p.url();
  if (u.includes("labs.google/fx")) { page = p; break; }
}
if (!page) { console.log("no Flow tab"); process.exit(1); }

console.log("URL:", page.url());
console.log("TITLE:", await page.title());

// Save screenshot to disk
await page.screenshot({ path: "/tmp/flow-state.png", fullPage: false });
console.log("screenshot -> /tmp/flow-state.png");

// Dump all interactive elements' roles + names
const snapshot = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('button, a, input, textarea, [contenteditable], [role="tab"], [role="button"]').forEach((el, i) => {
    if (i > 80) return;
    const r = el.getAttribute("role") || el.tagName.toLowerCase();
    const name = (el.getAttribute("aria-label") || el.innerText || el.placeholder || "").trim().slice(0, 80);
    const visible = el.offsetParent !== null;
    if (!visible) return;
    out.push({ r, name, type: el.type, contenteditable: el.contentEditable });
  });
  return out;
});
console.log(JSON.stringify(snapshot, null, 1).slice(0, 4000));

await browser.close();
