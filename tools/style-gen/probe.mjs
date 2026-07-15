import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://localhost:9222");
const [ctx] = browser.contexts();
let page;
for (const p of ctx.pages()) if (p.url().includes("labs.google/fx")) { page = p; break; }
if (!page) { console.log("no Flow tab"); process.exit(1); }
await page.screenshot({ path: "/tmp/flow-probe.png", fullPage: false });

const info = await page.evaluate(() => {
  const out = { url: location.href, candidates: [] };
  // look for prompt-like inputs near the bottom of the page
  document.querySelectorAll('textarea, input[type=text], [contenteditable="true"], [contenteditable=""]').forEach((el) => {
    if (!el.offsetParent) return;
    const r = el.getBoundingClientRect();
    if (r.width < 50 || r.height < 10) return;
    out.candidates.push({
      tag: el.tagName.toLowerCase(),
      placeholder: el.placeholder || el.getAttribute("data-placeholder") || el.getAttribute("aria-placeholder") || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      role: el.getAttribute("role") || "",
      ce: el.contentEditable,
      classes: (el.className || "").slice(0, 80),
      rectY: Math.round(r.top),
      rectH: Math.round(r.height),
      text: (el.value || el.innerText || "").slice(0, 40),
    });
  });
  return out;
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
