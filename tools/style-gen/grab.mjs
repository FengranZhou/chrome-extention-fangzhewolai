// Snatch all visible result-sized images from the current Flow tab.
import { chromium } from "playwright-core";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "./out");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP("http://localhost:9222");
const [ctx] = browser.contexts();
let page;
for (const p of ctx.pages()) if (p.url().includes("labs.google/fx")) { page = p; break; }
if (!page) { console.error("no Flow tab"); process.exit(1); }

// Find all <img> on the page that are large enough to be results.
const imgs = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll("img")) {
    const r = el.getBoundingClientRect();
    if (r.width < 150 || r.height < 150) continue;     // skip chips/avatars
    if (!el.src) continue;
    if (/avatar|profile/i.test(el.src)) continue;
    out.push({ src: el.src, w: r.width, h: r.height, nw: el.naturalWidth, nh: el.naturalHeight });
  }
  return out;
});
console.log(`found ${imgs.length} candidate image(s):`);
for (const i of imgs) console.log(`  ${i.w}×${i.h} (nat ${i.nw}×${i.nh}) ${i.src.slice(0, 100)}`);

let saved = 0;
for (let i = 0; i < imgs.length; i++) {
  try {
    const buf = await page.evaluate(async (url) => {
      const r = await fetch(url);
      const b = await r.arrayBuffer();
      return Array.from(new Uint8Array(b));
    }, imgs[i].src);
    const path = join(OUT, `result-${Date.now()}-${i}.png`);
    writeFileSync(path, Buffer.from(buf));
    console.log(`saved ${path} (${buf.length} bytes)`);
    saved++;
  } catch (e) {
    console.log(`save failed for ${i}:`, e.message);
  }
}
console.log(`done — ${saved}/${imgs.length} saved`);
await browser.close().catch(() => {});
