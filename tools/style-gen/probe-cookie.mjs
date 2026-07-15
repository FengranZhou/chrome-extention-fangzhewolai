import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://localhost:9222");
const [ctx] = browser.contexts();
let page;
for (const p of ctx.pages()) if (p.url().includes("labs.google/fx")) { page = p; break; }
if (!page) { console.log("no Flow tab"); process.exit(1); }
const info = await page.evaluate(() => {
  const bar = document.querySelector('#glue-cookie-notification-bar-1');
  if (!bar) return { found: false };
  return {
    found: true,
    text: bar.innerText.slice(0, 200),
    buttons: [...bar.querySelectorAll('button, a')].map(b => ({
      text: b.innerText.slice(0, 40),
      aria: b.getAttribute('aria-label') || '',
      id: b.id || '',
    }))
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
