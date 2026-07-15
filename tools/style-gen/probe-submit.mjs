// Find the actual submit button at bottom-right of the prompt bar.
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://localhost:9222");
const [ctx] = browser.contexts();
let page;
for (const p of ctx.pages()) if (p.url().includes("labs.google/fx")) { page = p; break; }
if (!page) { console.error("no Flow tab"); process.exit(1); }

const info = await page.evaluate(() => {
  const tb = document.querySelector('div[role="textbox"][contenteditable="true"]');
  const tbRect = tb?.getBoundingClientRect();
  const buttons = [];
  for (const btn of document.querySelectorAll("button")) {
    if (!btn.offsetParent) continue;
    const r = btn.getBoundingClientRect();
    // Look for buttons near the prompt bar
    if (tbRect && Math.abs((r.top + r.bottom) / 2 - (tbRect.top + tbRect.bottom) / 2) > 100) continue;
    buttons.push({
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
      text: btn.innerText.slice(0, 40),
      aria: btn.getAttribute("aria-label") || "",
      cls: (btn.className || "").slice(0, 60),
      iconText: [...btn.querySelectorAll("span")].map(s => s.innerText).filter(Boolean).slice(0, 3),
      svg: !!btn.querySelector("svg"),
    });
  }
  return { tbRect, buttons };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
