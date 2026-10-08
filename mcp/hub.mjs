// Agent Hub 桥接引擎：把"派发 → 阻塞回收"包成一次调用（ask）。
// 供 server.mjs（stdio MCP）与 ask.mjs（CLI 一次性）共用。
// 通道事实（2026-10-06 实测）：CLI worker 走 hub_dispatch_cli；traecode 无 CLI 走 trae_delegate(wait:false)，
// 其 ref 前缀是 trae-<hex>（其余 <规范名>-<hex>）；回收统一 hub_wait_result，对 trae ref 同样有效。

export const HUB = process.env.AGENTHUB_URL || "http://127.0.0.1:8765/mcp?token=EXAMPLE_REDACTED_TOKEN";

const ALIASES = {
  agy: "antigravity", antigravity: "antigravity",
  cb: "codebuddy", "codebuddy-intl": "codebuddy", cbcnintl: "codebuddy", intl: "codebuddy", codebuddy: "codebuddy",
  cbcn: "codebuddy-cn", "codebuddy-cn": "codebuddy-cn",
  mimo: "mimocode", mimocode: "mimocode",
  gcp: "github-copilot", copilot: "github-copilot", "github-copilot": "github-copilot",
  mmx: "minimaxcode", minimaxcode: "minimaxcode",
  trae: "traecode", traecode: "traecode",
  zcode: "zcode",
};

export const CANONICAL = [...new Set(Object.values(ALIASES))].sort();

/** 简称/规范名 → 规范名；未知返回 null。 */
export function resolveWorker(raw) {
  const k = String(raw || "").trim().toLowerCase();
  return ALIASES[k] || null;
}

function refRegex(worker) {
  const prefix = worker === "traecode" ? "trae" : worker;
  return new RegExp(prefix + "-[0-9a-f]+");
}

/** 从枢纽回执里提取回答正文：去首行 [ref] 状态行，去尾部 (exit=N)/(继续对话…)，去 ANSI 色码。 */
export function extractAnswer(text) {
  return String(text)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/^\[[^\]]*\][^\n]*\n/, "")
    .replace(/\n?\((?:exit=\d+|继续对话[^)]*)\)\s*$/, "")
    .trim();
}

async function callTool(name, args, timeoutMs) {
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const resp = await fetch(HUB, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await resp.json();
  if (body.error) throw new Error("RPC-ERROR " + (body.error.message || "unknown"));
  return body.result?.content?.[0]?.text ?? "EMPTY";
}

/**
 * 派发并阻塞回收（单次尝试，内部原语）。
 * 返回 { ok, status, worker, ref, answer }；status: completed / failed / running（超时未完，ref 可续查）。
 */
async function dispatchAndCollect(worker, task, timeoutS) {
  let dispatchText;
  try {
    if (worker === "traecode") {
      dispatchText = await callTool("trae_delegate", { task: String(task), wait: false }, 45_000);
    } else {
      dispatchText = await callTool("hub_dispatch_cli", { agent: worker, task: String(task), timeout_s: Math.max(timeoutS, 60) }, 45_000);
    }
  } catch (e) {
    return { ok: false, status: "failed", worker, ref: "", answer: "派发失败（枢纽不可达）：" + String(e && e.message || e).slice(0, 200) };
  }
  const m = refRegex(worker).exec(dispatchText);
  if (!m) {
    return { ok: false, status: "failed", worker, ref: "", answer: "派发失败（未返回 ref，可能 403/通道不可用）：" + dispatchText.slice(0, 400) };
  }
  const ref = m[0];
  const deadline = Date.now() + Math.max(30, timeoutS) * 1000;
  while (Date.now() < deadline) {
    const waitS = Math.min(110, Math.max(10, Math.round((deadline - Date.now()) / 1000)));
    let t;
    try {
      t = await callTool("hub_wait_result", { ref, wait_s: waitS }, (waitS + 40) * 1000);
    } catch (e) {
      return { ok: false, status: "failed", worker, ref, answer: "回收失败：" + String(e && e.message || e).slice(0, 200) };
    }
    const st = /status=(\w+)/.exec(t)?.[1] || "running";
    if (st === "completed") {
      return { ok: true, status: "completed", worker, ref, answer: extractAnswer(t) };
    }
    if (st === "failed" || st === "timeout") {
      return { ok: false, status: "failed", worker, ref, answer: t.slice(0, 500) };
    }
  }
  return { ok: false, status: "running", worker, ref, answer: `在 ${timeoutS}s 内未完成，稍后可用 ref=${ref} 查询枢纽结果（hub_result）` };
}

/**
 * 把任务派给一个 worker 并阻塞到出结果。
 * 返回 { ok, status, worker, ref, answer }；status: completed / failed / running（超时未完，ref 可续查）。
 * 自愈：检测到上游"空文本轮"占位符（此轮未产生文本回复）或空输出时自动重试一次——
 * cbcn 上游约 25% 概率返回空文本轮（finish=stop 无内容），重试即可拿到正常回答。
 */
export async function ask(workerRaw, task, timeoutS = 300) {
  const worker = resolveWorker(workerRaw);
  if (!worker) {
    return { ok: false, status: "failed", worker: String(workerRaw || ""), ref: "", answer: `未知 worker「${workerRaw}」，可选：${CANONICAL.join(" / ")}` };
  }
  if (!String(task || "").trim()) {
    return { ok: false, status: "failed", worker, ref: "", answer: "task 不能为空" };
  }
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    last = await dispatchAndCollect(worker, String(task), timeoutS);
    const bad = (last.answer || "").includes("此轮未产生文本回复") ||
                (last.answer || "").trim() === "(无输出)" ||
                (last.status === "completed" && !(last.answer || "").trim());
    if (!bad || attempt === 2) return last;
  }
  return last;
}

/** 列出枢纽注册代理与在线状态（原文）。 */
export async function hubStatus() {
  return callTool("hub_list_agents", {}, 30_000);
}

/**
 * 只派发不等待：立即返回 { ok, worker, ref, raw? }。
 * 专为 30 秒 MCP 上限的工作流子代理设计——ref 秒级到手，结果用 fetchRef 续查。
 */
export async function dispatchOnly(workerRaw, task, timeoutS = 900) {
  const worker = resolveWorker(workerRaw);
  if (!worker) {
    return { ok: false, worker: String(workerRaw || ""), ref: "", error: `未知 worker「${workerRaw}」，可选：${CANONICAL.join(" / ")}` };
  }
  if (!String(task || "").trim()) {
    return { ok: false, worker, ref: "", error: "task 不能为空" };
  }
  let dispatchText;
  try {
    if (worker === "traecode") {
      dispatchText = await callTool("trae_delegate", { task: String(task), wait: false }, 45_000);
    } else {
      dispatchText = await callTool("hub_dispatch_cli", { agent: worker, task: String(task), timeout_s: Math.max(timeoutS, 60) }, 45_000);
    }
  } catch (e) {
    return { ok: false, worker, ref: "", error: "派发失败（枢纽不可达）：" + String(e && e.message || e).slice(0, 200) };
  }
  const m = refRegex(worker).exec(dispatchText);
  if (!m) {
    return { ok: false, worker, ref: "", error: "派发失败（未返回 ref，可能 403/通道不可用）：" + dispatchText.slice(0, 400) };
  }
  return { ok: true, worker, ref: m[0] };
}

/**
 * 按 ref 查一次当前状态（非阻塞，秒回）：{ status, answer }。
 * status: completed / failed / timeout / running / unknown。
 */
export async function fetchRef(ref) {
  if (!/^[\w.-]+-[0-9a-f]+$/i.test(String(ref || ""))) {
    return { status: "unknown", answer: "ref 格式无效" };
  }
  let t;
  try {
    t = await callTool("hub_result", { ref }, 30_000);
  } catch (e) {
    return { status: "unknown", answer: "查询失败：" + String(e && e.message || e).slice(0, 200) };
  }
  const st = /status=(\w+)/.exec(t)?.[1] || "running";
  if (st === "completed") {
    return { status: "completed", answer: extractAnswer(t) };
  }
  if (st === "failed" || st === "timeout") {
    return { status: "failed", answer: t.slice(0, 500) };
  }
  return { status: st, answer: "" };
}
