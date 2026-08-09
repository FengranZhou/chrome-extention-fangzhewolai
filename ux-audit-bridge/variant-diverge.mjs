#!/usr/bin/env node
/**
 * 妙想「发散」· Variant 自动化投递
 *
 * 用法：node variant-diverge.mjs <图片绝对路径> <提示词>
 * 退出码：0 成功；非 0 失败（stderr 有原因）
 *
 * 流程（对应用户描述的七步）：
 *   连上专属调试端口的 Chrome → 开 variant.com/community → 点 + 号
 *   → 用 filechooser 直接 setFiles（等价于系统选择器选文件+打开，但稳定得多）
 *   → 等输入框出现图片缩略图 → focus 输入区 → 键入提示词 → 回车提交
 *
 * 端口/profile 独立于按图生（豆包用 9333），避免互抢：见 DEBUG_PORT。
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync, spawn } from "node:child_process";
import { createRequire } from "node:module";

const IMG = process.argv[2];
const PROMPT = process.argv[3] || "帮我优化一下这个地方";
const URL_TARGET = "https://variant.com/community";
const DEBUG_PORT = Number(process.env.VARIANT_DEBUG_PORT || 9334);
const PROFILE = process.env.VARIANT_PROFILE
  || join(homedir(), ".liaison-variant-profile");
const HEADLESS_TIMEOUT = 45_000;

const die = (msg, code = 1) => { console.error(msg); process.exit(code); };

if (!IMG || !existsSync(IMG)) die(`找不到截图文件：${IMG}`, 2);

// playwright-core 复用按图生 skill 已装好的那份，避免重复安装 11MB
const PW_CANDIDATES = [
  join(homedir(), ".claude/skills/按图生/node_modules/playwright-core/index.js"),
  join(homedir(), ".claude/skills/按图生/node_modules/playwright-core"),
];
let chromium = null;
for (const p of PW_CANDIDATES) {
  try {
    const require0 = createRequire(import.meta.url);
    ({ chromium } = require0(p));
    if (chromium) break;
  } catch (_) {}
}
if (!chromium) {
  die("找不到 playwright-core。请确认 ~/.claude/skills/按图生/node_modules 存在，或设置 PLAYWRIGHT_CORE 指向它。", 3);
}

// Chrome 可执行文件：按平台探测，允许环境变量覆盖
const chromePath = () => {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cands = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
  ];
  return cands.find((p) => existsSync(p)) || null;
};

const wsEndpoint = async () => {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
  const j = await res.json();
  return j.webSocketDebuggerUrl;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureBrowser() {
  // 已有实例就直接连
  try { return await chromium.connectOverCDP(await wsEndpoint()); } catch (_) {}

  const exe = chromePath();
  if (!exe) die("找不到 Chrome，可用 CHROME_PATH 环境变量指定。", 4);
  try { mkdirSync(PROFILE, { recursive: true }); } catch (_) {}

  spawn(exe, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { detached: true, stdio: "ignore" }).unref();

  // 等调试端口起来
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await sleep(400);
    try { return await chromium.connectOverCDP(await wsEndpoint()); } catch (_) {}
  }
  die("Chrome 调试端口起不来，请手动关掉已有的 Variant 调试窗口后重试。", 5);
}

(async () => {
  const browser = await ensureBrowser();
  const ctx = browser.contexts()[0];
  if (!ctx) die("没有可用的浏览器上下文", 6);

  // 复用已在 variant 的页面，否则新开
  const pages = ctx.pages();
  let page = pages.find((p) => (p.url() || "").includes("variant.com"))
    || pages.find((p) => /^(about:blank|chrome:\/\/newtab)/.test(p.url() || ""))
    || pages[0];
  if (!page) {
    page = await ctx.newPage();
    await page.goto(URL_TARGET, { waitUntil: "domcontentloaded", timeout: HEADLESS_TIMEOUT });
  } else {
    await page.bringToFront();
    if (!(page.url() || "").includes("/community")) {
      await page.goto(URL_TARGET, { waitUntil: "domcontentloaded", timeout: HEADLESS_TIMEOUT });
    }
  }

  // 单 tab 语义：除工作 tab 外的空白页一律关掉（历史遗留的多余 tab 也一并清理）
  for (const p of pages) {
    if (p === page) continue;
    if (/^(about:blank|chrome:\/\/newtab)/.test(p.url() || "")) {
      try { await p.close(); } catch (_) {}
    }
  }

  // 未登录检测：community 会跳登录页
  await sleep(1200);
  const url = page.url() || "";
  if (/login|signin|auth/i.test(url)) {
    die("Variant 未登录。请在弹出的浏览器窗口里登录一次，之后会记住登录态。", 7);
  }

  // ① 点 + 号，同时拦截文件选择器直接投文件
  //    （原生 macOS 选择器无法用 Playwright 稳定驱动，filechooser 是等价且可靠的路径）
  const plus = page.locator(
    'button:has-text("+"), [aria-label*="attach" i], [aria-label*="upload" i], [data-testid*="attach" i]'
  ).first();

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 15_000 }).catch(() => null),
    plus.click({ timeout: 15_000 }).catch(async () => {
      // + 号定位不到时，退回找隐藏的 file input
      const inp = page.locator('input[type="file"]').first();
      await inp.waitFor({ state: "attached", timeout: 8_000 });
      await inp.setInputFiles(IMG);
    }),
  ]);
  if (chooser) await chooser.setFiles(IMG);

  // ② 等缩略图出现在输入框里（文件名芯片）
  const chip = page.locator('text=/\\.(png|jpe?g|webp)$/i').first();
  await chip.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {
    die("等待图片上传超时：输入框里没出现缩略图。", 8);
  });

  // ③ focus 输入区 → 键入 → 提交
  const input = page.locator(
    'textarea, [contenteditable="true"], input[type="text"]'
  ).last();
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.click();
  await input.type(PROMPT, { delay: 18 });
  await sleep(200);
  await input.press("Enter");

  await sleep(1500);
  console.log(JSON.stringify({ ok: true, prompt: PROMPT, image: IMG }));
  // 浏览器窗口留给用户看结果：只断开 CDP 连接，不关窗口
  try { if (typeof browser.disconnect === "function") await browser.disconnect(); } catch (_) {}
  process.exit(0);
})().catch((e) => {
  die(`发散投递失败：${String((e && e.message) || e)}`, 9);
});
