#!/usr/bin/env node
/**
 * UX 自检桥 · 本地 HTTP 服务（零依赖，纯 node）
 *
 * 扩展"自检"tab 点按钮 → background fetch POST http://127.0.0.1:8765/audit
 *   → 本服务收到选中元素数据 → 调 `claude -p` 跑 UX 审查 → 返回结构化 JSON
 *
 * 事件驱动、按需调用：没有请求时服务空闲（不轮询、不烧 token），
 *   只有真的收到 /audit 请求才调一次 claude。
 *
 * 用法： node ~/ux-audit-bridge/server.mjs   （默认端口 8765）
 * 停止： Ctrl+C
 * 探活： curl http://127.0.0.1:8765/ping
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";

const BASE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8765);
const PROMPT = readFileSync(join(BASE, "audit-prompt.md"), "utf8");
const LOG_DIR = join(BASE, "log");
try { mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}

// claude CLI 定位（跨用户、跨安装方式，不硬编码用户名/路径）：
// launchd 环境 PATH 很干净，靠 PATH 会 ENOENT，所以尽量解析出绝对路径。
// 优先级：环境变量 CLAUDE_BIN > 常见安装位置逐个探测 > `which claude` > 回退裸 "claude"。
const HOME = process.env.HOME || homedir();
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN && existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const candidates = [
    `${HOME}/.npm-global/bin/claude`,
    `${HOME}/.local/bin/claude`,
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    `${HOME}/.bun/bin/claude`,
    `${HOME}/.volta/bin/claude`,
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  // 兜底：用登录 shell 解析（能拿到 nvm/asdf 等自定义路径）
  try {
    const out = execFileSync(process.env.SHELL || "/bin/zsh", ["-lic", "command -v claude"], { encoding: "utf8" }).trim();
    if (out && existsSync(out)) return out;
  } catch (_) {}
  return "claude"; // 最后回退，靠 PATH
}
const CLAUDE_BIN = resolveClaudeBin();
const CHILD_ENV = {
  ...process.env,
  PATH: `${HOME}/.npm-global/bin:${HOME}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin${process.env.PATH ? ":" + process.env.PATH : ""}`,
  HOME,
};

function log(...a) { console.log(new Date().toLocaleTimeString(), ...a); }

// 两段式任务表：/audit/start 立即返回 taskId 并后台跑审查；/audit/result 轮询取结果。
// 这样扩展每次都是「秒回的短请求」，MV3 background service worker 无需长时间存活、
// 不会被 30s 空闲回收（长等待拆成多次短轮询）。
const tasks = new Map(); // taskId -> { status:'running'|'done'|'error', out?, ts }
let taskSeq = 0;
function newTaskId() { return `t${Date.now()}_${++taskSeq}`; }
// 清理超过 10 分钟的旧任务
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of tasks) if (now - t.ts > 600000) tasks.delete(id);
}, 120000).unref?.();

// 从模型输出里尽力抠出 JSON 主体。返回 {ok, value} —— ok=false 表示解析失败（触发重试）。
function extractJson(text) {
  const t = (text || "").trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : t;
  const s = body.indexOf("{");
  const e = body.lastIndexOf("}");
  if (s >= 0 && e > s) {
    const candidate = body.slice(s, e + 1);
    try { return { ok: true, value: JSON.parse(candidate) }; } catch (_) {}
    return { ok: false, value: { _raw: candidate, _parseError: true } };
  }
  return { ok: false, value: { _raw: body, _parseError: true } };
}

// 调一次 claude -p，返回 {ok, stdout/error}
function callClaude(prompt) {
  return new Promise((resolve) => {
    execFile(
      CLAUDE_BIN,
      ["-p", prompt],
      { maxBuffer: 20 * 1024 * 1024, timeout: 150000, cwd: BASE, env: CHILD_ENV },
      (err, stdout, stderr) => {
        if (err) resolve({ ok: false, error: err.message, stderr: (stderr || "").slice(0, 800) });
        else resolve({ ok: true, stdout });
      }
    );
  });
}

// 跑审查：解析失败自动重试一次（提示模型上次 JSON 非法）
async function runAudit(req) {
  const userContent = [
    `【页面名】${req.pageName || "未命名"}`,
    req.context ? `【上下文/项目背景】${req.context}` : "",
    `【选中元素 HTML】\n${req.elementHtml || "(未提供)"}`,
    req.extra ? `【补充信息】${req.extra}` : "",
  ].filter(Boolean).join("\n\n");

  const basePrompt = `${PROMPT}\n\n---\n下面是本次要审查的元素：\n\n${userContent}`;
  const t0 = Date.now();
  log("▶ 收到审查请求：", req.pageName || "(未命名)");

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = attempt === 1
      ? basePrompt
      : basePrompt + "\n\n⚠️ 上次输出的 JSON 无法解析（多半是值里出现了英文双引号）。请重新输出，字段值里绝不使用英文双引号（用「」代替），确保整体是一个可被 JSON.parse 的合法对象。";
    const r = await callClaude(prompt);
    if (!r.ok) {
      const ms = Date.now() - t0;
      log("✗ 审查失败：", r.error, `(${ms}ms)`);
      return { ok: false, error: r.error, stderr: r.stderr };
    }
    const parsed = extractJson(r.stdout);
    if (parsed.ok) {
      const ms = Date.now() - t0;
      const n = Array.isArray(parsed.value.issues) ? parsed.value.issues.length : 0;
      log("✓ 审查完成", `(${ms}ms)`, `${n} 条问题`, attempt > 1 ? "(重试后成功)" : "");
      return { ok: true, result: parsed.value };
    }
    log(`⚠ 第 ${attempt} 次 JSON 解析失败${attempt < 2 ? "，重试…" : ""}`);
    if (attempt === 2) {
      const ms = Date.now() - t0;
      log("✗ 两次均解析失败", `(${ms}ms)`);
      return { ok: true, result: parsed.value }; // 仍返回 _raw，前端显示解析失败提示
    }
  }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    // 允许扩展跨源调用
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

const server = createServer((req, res) => {
  // CORS 预检
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // 探活
  if (req.method === "GET" && req.url === "/ping") {
    sendJson(res, 200, { ok: true, service: "ux-audit-bridge", port: PORT });
    return;
  }

  // 两段式 · 发起：立即返回 taskId，后台异步跑审查
  if (req.method === "POST" && req.url === "/audit/start") {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 5_000_000) req.destroy(); });
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(raw || "{}"); }
      catch (e) { return sendJson(res, 400, { ok: false, error: "bad json" }); }
      const taskId = newTaskId();
      tasks.set(taskId, { status: "running", ts: Date.now() });
      // 后台跑，不阻塞响应
      runAudit(payload).then((out) => {
        tasks.set(taskId, { status: "done", out, ts: Date.now() });
        try { writeFileSync(join(LOG_DIR, `audit-${Date.now()}.json`), JSON.stringify({ req: payload, out }, null, 2)); } catch (_) {}
      }).catch((e) => {
        tasks.set(taskId, { status: "error", out: { ok: false, error: String(e && e.message || e) }, ts: Date.now() });
      });
      sendJson(res, 200, { ok: true, taskId });
    });
    return;
  }

  // 两段式 · 轮询取结果
  if (req.method === "GET" && req.url.startsWith("/audit/result")) {
    const u = new URL(req.url, "http://x");
    const taskId = u.searchParams.get("taskId") || "";
    const t = tasks.get(taskId);
    if (!t) { sendJson(res, 200, { ok: true, status: "unknown" }); return; }
    if (t.status === "running") { sendJson(res, 200, { ok: true, status: "running" }); return; }
    // done / error
    sendJson(res, 200, { ok: true, status: t.status, ...(t.out || {}) });
    return;
  }

  // 审查
  if (req.method === "POST" && req.url === "/audit") {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 5_000_000) req.destroy(); });
    req.on("end", async () => {
      let payload;
      try { payload = JSON.parse(raw || "{}"); }
      catch (e) { return sendJson(res, 400, { ok: false, error: "bad json" }); }
      const out = await runAudit(payload);
      // 留档便于排查
      try {
        writeFileSync(join(LOG_DIR, `audit-${Date.now()}.json`),
          JSON.stringify({ req: payload, out }, null, 2));
      } catch (_) {}
      sendJson(res, out.ok ? 200 : 500, out);
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  log(`UX 自检桥已启动 → http://127.0.0.1:${PORT}`);
  log("探活: curl http://127.0.0.1:" + PORT + "/ping");
  log("停止: Ctrl+C");
});
