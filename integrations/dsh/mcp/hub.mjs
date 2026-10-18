// Agent Hub 桥接引擎：把"派发 → 阻塞回收"包成一次调用（ask）。
// 供 server.mjs（stdio MCP）与 ask.mjs（CLI 一次性）共用。
// 发布时同步 root mcp 与 integrations/dsh/mcp；tests/mcp_bridge.test.mjs 防止独立安装包漂移。
import { open } from "node:fs/promises";
import { basename, extname } from "node:path";
import { loadConnection } from "./config.mjs";

export let HUB = null;
let CONNECTION = null, CONNECTION_ERROR = null;

export async function refreshConnection() {
  try {
    CONNECTION = await loadConnection();
    CONNECTION_ERROR = null;
    HUB = CONNECTION.url;
    return CONNECTION;
  } catch {
    CONNECTION = null;
    HUB = undefined;
    CONNECTION_ERROR = 'SETUP_REQUIRED：连接配置缺失或无效。先调用 hub_discover 扫描，再运行 connect.cmd / connect.sh 配对并重启宿主 MCP。';
    return null;
  }
}

await refreshConnection();

async function getConnection() {
  if (!CONNECTION || CONNECTION_ERROR) {
    await refreshConnection();
  }
  if (CONNECTION_ERROR || !CONNECTION) throw hubError('rejected', CONNECTION_ERROR);
  return CONNECTION;
}

const ALIASES = {
  agy: "antigravity", antigravity: "antigravity",
  cb: "codebuddy", "codebuddy-intl": "codebuddy", cbcnintl: "codebuddy", intl: "codebuddy", codebuddy: "codebuddy",
  cbcn: "codebuddy-cn", "codebuddy-cn": "codebuddy-cn",
  mimo: "mimocode", mimocode: "mimocode",
  gcp: "github-copilot", copilot: "github-copilot", "github-copilot": "github-copilot",
  mmx: "minimaxcode", minimaxcode: "minimaxcode",
  trae: "traecode", traecode: "traecode",
  zcode: "zcode",
  ca: "codearts", codearts: "codearts", "huawei-codearts": "codearts",
  cline: "cline",
  oc: "opencode", opencode: "opencode",
};

export const CANONICAL = [...new Set(Object.values(ALIASES))].sort();

/** 简称/规范名 → 规范名；未知返回 null。 */
export function resolveWorker(raw) {
  const k = String(raw || "").trim().toLowerCase();
  return Object.hasOwn(ALIASES, k) ? ALIASES[k] : null;
}

function refRegex(worker) {
  const prefix = worker === "traecode" ? "(?:traecode|trae)" : worker;
  return new RegExp("^" + prefix + "-[0-9a-f]+$", "i");
}

function cleanText(text) {
  return String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
}

/** 从枢纽回执里提取正文，移除状态行和连续的退出码/会话元数据尾行。 */
export function extractAnswer(text) {
  return cleanText(text)
    .replace(/^\[[^\]]*\][^\n]*(?:\n|$)/, "")
    .replace(/^>\s*build\s*·[^\n]*(?:\n|$)/, "")
    .replace(/(?:\n?\((?:exit=-?\d+|继续对话[^)]*)\)\s*)+$/, "")
    .trim();
}

const MAX_TIMEOUT_S = 86400;
const DISPATCH_HTTP_MS = 25000;
let nextRequestId = 0;

function validTimeout(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_TIMEOUT_S;
}

function message(error) {
  let text = String(error?.message || error).replace(/([?&]token=)[^&\s]+/gi, "$1[REDACTED]");
  if (process.env.HUB_TOKEN) text = text.replaceAll(process.env.HUB_TOKEN, "[REDACTED]");
  if (CONNECTION?.token) text = text.replaceAll(CONNECTION.token, "[REDACTED]");
  return text.slice(0, 500);
}

async function taskOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw hubError("rejected", "options must be an object");
  const known = new Set(["model", "cwd", "thinking", "stream", "files", "onProgress"]);
  for (const key of Object.keys(options)) if (!known.has(key)) throw hubError("rejected", "Unknown task option: " + key);
  const result = {};
  for (const key of ["model", "cwd"]) {
    if (options[key] !== undefined) {
      if (typeof options[key] !== "string" || !options[key].trim()) throw hubError("rejected", key + " must be a nonempty string");
      result[key] = options[key];
    }
  }
  if (options.thinking !== undefined) {
    if (!["default", "on", "off"].includes(options.thinking)) throw hubError("rejected", "thinking must be default/on/off");
    result.thinking = options.thinking;
  }
  if (options.stream !== undefined) {
    if (typeof options.stream !== "boolean") throw hubError("rejected", "stream must be a boolean");
    result.stream = options.stream;
  }
  if (options.files !== undefined) {
    if (!Array.isArray(options.files) || options.files.length > 8 || options.files.some((f) => typeof f !== "string" || !f)) {
      throw hubError("rejected", "files must contain at most 8 local file paths");
    }
    result.attachments = [];
    let size = 0;
    const mimeTypes = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".json": "application/json" };
    for (const source of options.files) {
      const name = basename(source);
      if (/^(?:\.env(?:\..*)?|\.?auth\.json|\.?credentials(?:\.json|\.ya?ml)?|id_(?:rsa|ed25519))$/i.test(name) || /\.(?:key|pem)$/i.test(name)) {
        throw hubError("rejected", "Credential files cannot be sent as task attachments");
      }
      const file = await open(source, "r");
      try {
        const stat = await file.stat();
        if (!stat.isFile() || size + stat.size > 1024 * 1024) throw hubError("rejected", "Attachments exceed the 1 MiB combined limit or are not regular files");
        const data = await file.readFile();
        size += data.length;
        if (size > 1024 * 1024) throw hubError("rejected", "Attachments exceed the 1 MiB combined limit");
        result.attachments.push({ name, mime_type: mimeTypes[extname(name).toLowerCase()] || "text/plain", data_base64: data.toString("base64") });
      } finally { await file.close(); }
    }
  }
  return result;
}

function hubError(kind, text) {
  const error = new Error(text);
  error.kind = kind;
  return error;
}

async function callTool(name, args, timeoutMs, allowToolError = false) {
  const conn = await getConnection();
  const id = ++nextRequestId;
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const target = new URL(conn.url);
  const token = target.searchParams.get("token") || conn.token;
  target.searchParams.delete("token");
  const resp = await fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: payload,
    signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
  });
  if (!resp.ok) throw hubError("rejected", "HTTP " + resp.status + "：枢纽请求失败");
  let body;
  try { body = await resp.json(); }
  catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") throw error;
    throw hubError("protocol", "PROTOCOL-ERROR：枢纽响应不是有效 JSON");
  }
  if (!body || Array.isArray(body) || body.jsonrpc !== "2.0" || body.id !== id ||
      (Object.hasOwn(body, "result") === Object.hasOwn(body, "error"))) {
    throw hubError("protocol", "PROTOCOL-ERROR：枢纽响应格式或请求 ID 不匹配");
  }
  if (body.error) throw hubError("rejected", "RPC-ERROR " + (body.error.message || "unknown"));
  if (!body.result || !Array.isArray(body.result.content)) throw hubError("protocol", "PROTOCOL-ERROR：缺少工具内容");
  const blocks = body.result.content.filter((block) => block?.type === "text" && typeof block.text === "string");
  if (!blocks.length) throw hubError("protocol", "PROTOCOL-ERROR：工具没有返回文本内容");
  const text = blocks.map((block) => block.text).join("\n");
  if (body.result.isError && !allowToolError) throw hubError("rejected", "TOOL-ERROR " + text);
  return text;
}

async function dispatchWorker(worker, task, timeoutS, deadline, options) {
  const remaining = () => Math.max(1, Math.min(DISPATCH_HTTP_MS, deadline - performance.now()));
  if (worker === "traecode") return callTool("trae_delegate", { task, wait: false, timeout_s: timeoutS, ...options }, remaining());
  const text = await callTool("hub_dispatch_cli", { agent: worker, task, timeout_s: timeoutS, ...options }, remaining());
  // 只在明确未受理时回退，正文引用此诊断不能引发第二次派发。
  if (worker === "zcode" && /^zcode\s+未配置 CLI\b/.test(cleanText(text))) {
    if (performance.now() >= deadline) throw hubError("rejected", "ZCode CLI 未配置，派发等待预算已用尽");
    return callTool("zcode_delegate", { task, wait: false, timeout_s: timeoutS, ...options }, remaining());
  }
  return text;
}

/** 状态来自首行回执；退出码使用枢纽的尾行格式，不扫描正文中的 ref/status。 */
function receipt(text, worker, expectedRef = null) {
  const cleaned = cleanText(text);
  const header = /^\[([^\]\r\n]+)\]([^\r\n]*)(?:\r?\n|$)/.exec(cleaned);
  if (!header) return { status: "unknown", ref: expectedRef || "", answer: cleaned.slice(0, 500) };
  const tag = header[1];
  const ref = tag.split("/").at(-1);
  const validRef = expectedRef ? ref === expectedRef : (refRegex(worker).test(ref) || /^[a-z0-9_-]+-[0-9a-f]{6,32}$/i.test(ref));
  const status = /(?:^|\s)status=([a-z]+)\b/i.exec(header[2])?.[1]?.toLowerCase();
  const headerExit = /(?:^|\s)exit=(-?\d+)\b/.exec(header[2]);
  const footerExit = /\n\(exit=(-?\d+)\)\s*$/.exec(cleaned);
  if (validRef) {
    if ((headerExit && Number(headerExit[1]) !== 0) || (footerExit && Number(footerExit[1]) !== 0) || ["failed", "error", "timeout", "cancelled"].includes(status)) {
      return { status: "failed", ref, answer: cleaned.slice(0, 500) };
    }
    if (status === "completed") {
      const ans = extractAnswer(cleaned);
      if (/排队提醒|当前模型请求量较高|升级权益等待中|体验套餐可用额度已用完|套餐查询失败|额度已用完|可用额度已用完|积分不足|无可用额度/.test(ans)) {
        return { status: "failed", ref, answer: ans.slice(0, 500) };
      }
      return { status, ref, answer: ans };
    }
    if (!expectedRef || status === "running") return { status: "running", ref, answer: "" };
  } else if (!expectedRef && headerExit && (tag === worker || tag.startsWith(worker + "/"))) {
    const isOk = Number(headerExit[1]) === 0;
    const ans = isOk ? extractAnswer(cleaned) : cleaned.slice(0, 500);
    if (isOk && /排队提醒|当前模型请求量较高|升级权益等待中|体验套餐可用额度已用完|套餐查询失败|额度已用完|可用额度已用完|积分不足|无可用额度/.test(ans)) {
      return { status: "failed", ref: "", answer: ans.slice(0, 500) };
    }
    return { status: isOk ? "completed" : "failed", ref: "", answer: ans };
  }
  if (status === "running" && ref && /^[a-z0-9_-]+-[0-9a-f]{6,32}$/i.test(ref)) {
    return { status: "running", ref, answer: "" };
  }
  return { status: "unknown", ref: expectedRef || "", answer: cleaned.slice(0, 500) };
}

async function startTask(worker, task, timeoutS, deadline, options = {}) {
  let prepared;
  try {
    prepared = await taskOptions(options);
    if (performance.now() >= deadline) throw new Error("派发前等待预算已用尽");
  } catch (error) {
    return { status: "failed", ref: "", answer: "任务未派发：" + message(error) };
  }
  try {
    return receipt(await dispatchWorker(worker, task, timeoutS, deadline, prepared), worker);
  } catch (error) {
    const status = error.kind === "rejected" ? "failed" : "unknown";
    const prefix = status === "unknown" ? "未能确认派发是否受理，请先检查枢纽，避免重复执行：" : "枢纽拒绝派发：";
    return { status, ref: "", answer: prefix + message(error) };
  }
}

async function dispatchAndCollect(worker, task, timeoutS, options) {
  const deadline = performance.now() + timeoutS * 1000;
  const started = await startTask(worker, task, timeoutS, deadline, options);
  if (started.status !== "running") return { ok: started.status === "completed", worker, ...started };
  const { ref } = started;
  let previousProgress = "";
  while (performance.now() < deadline) {
    const remainingMs = deadline - performance.now();
    const waitS = Math.min(110, remainingMs / 1000);
    let t;
    if (options.stream) {
      let result;
      try {
        const value = JSON.parse(await callTool("hub_result_json", { ref }, Math.min(remainingMs, 30000)));
        if (value.ref !== ref || !["running", "completed", "error", "failed", "timeout", "cancelled", "unknown"].includes(value.status)) throw new Error("Invalid structured task result");
        const progress = typeof value.progress === "string" ? value.progress : "";
        if (progress && progress !== previousProgress) {
          previousProgress = progress;
          if (typeof options.onProgress === "function") await options.onProgress({ ref, status: value.status, text: progress });
        }
        const status = ["error", "timeout", "cancelled"].includes(value.status) ? "failed" : value.status;
        result = { ok: status === "completed", worker, ref, status, answer: typeof value.text === "string" ? value.text : "" };
      } catch (error) {
        return { ok: false, worker, ref, status: "unknown", answer: "查询失败，保留原 ref：" + message(error) };
      }
      if (result.status !== "running") return result;
      await new Promise((resolve) => setTimeout(resolve, Math.min(150, Math.max(0, deadline - performance.now()))));
      continue;
    }
    try {
      t = await callTool("hub_wait_result", { ref, wait_s: waitS }, Math.min(remainingMs, (waitS + 5) * 1000));
    } catch (error) {
      if (performance.now() >= deadline) break;
      if (error.name === "TimeoutError" || error.name === "AbortError") continue;
      return { ok: false, status: "unknown", worker, ref, answer: "查询失败，任务可能仍在执行，请用同一 ref 续查：" + message(error) };
    }
    const result = receipt(t, worker, ref);
    if (result.status !== "running") return { ok: result.status === "completed", worker, ...result };
    // 即时 running 回执也要退避，避免本地 HTTP 枢纽被紧密轮询淹没。
    const pauseMs = Math.min(100, Math.max(0, deadline - performance.now()));
    if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  return { ok: false, status: "running", worker, ref, answer: `在 ${timeoutS}s 内未完成，任务仍可能执行；使用 ref=${ref} 续查，避免重复派发。` };
}

function taskError(task, timeoutS) {
  if (typeof task !== "string" || !task.trim()) return "task 必须是非空字符串";
  if (!validTimeout(timeoutS)) return `timeout_s 必须是大于 0 且不超过 ${MAX_TIMEOUT_S} 的有限数字`;
  return null;
}

function recursiveDispatchError(worker) {
  // Hub sets this only for an actual worker child process. Canonicalize both
  // sides so native plugins cannot bypass the guard with a worker alias.
  if (resolveWorker(process.env.AGENTHUB_WORKER_ID) !== worker) return null;
  return `RECURSIVE_DISPATCH_DENIED: ${worker} worker cannot dispatch another ${worker} task through this bridge.`;
}

/** 派发一次并在总预算内回收。空回复不能证明任务未执行，因此不自动重复有副作用的任务。 */
export async function ask(workerRaw, task, timeoutS = 300, options = {}) {
  const worker = resolveWorker(workerRaw);
  if (!worker) {
    return { ok: false, status: "failed", worker: String(workerRaw || ""), ref: "", answer: `未知 worker「${workerRaw}」，可选：${CANONICAL.join(" / ")}` };
  }
  const recursive = recursiveDispatchError(worker);
  if (recursive) {
    return { ok: false, status: "failed", worker, ref: "", answer: recursive };
  }
  const error = taskError(task, timeoutS);
  if (error) return { ok: false, status: "failed", worker, ref: "", answer: error };
  return dispatchAndCollect(worker, task, timeoutS, options);
}

/** 列出枢纽注册代理与在线状态（原文）。 */
export async function hubStatus() {
  return callTool("hub_list_agents", {}, 30_000);
}

export async function hubCapabilities(workerRaw, options = {}) {
  const worker = workerRaw === undefined ? null : resolveWorker(workerRaw);
  if (workerRaw !== undefined && !worker) throw new Error("Unknown worker");
  if (options.model !== undefined && (typeof options.model !== 'string' || !options.model.trim())) throw new Error('model must be a nonempty string');
  if (options.refresh !== undefined && typeof options.refresh !== 'boolean') throw new Error('refresh must be a boolean');
  return JSON.parse(await callTool("hub_capabilities", {
    ...(worker ? { agent: worker } : {}), ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.refresh !== undefined ? { refresh: options.refresh } : {}),
  }, 30000));
}

export async function hubSetAgentStatus(workerRaw, enabled) {
  const worker = resolveWorker(workerRaw);
  if (!worker) throw new Error(`Unknown worker: ${workerRaw}`);
  const result = await callTool("hub_set_agent_status", { agent: worker, enabled: !!enabled }, 30000);
  try {
    return JSON.parse(result);
  } catch {
    return { ok: true, text: result };
  }
}

const LOGIN_STATUSES = new Set([
  "preparing", "awaiting_user", "authenticated", "expired", "failed",
  "manual_required", "unavailable", "cancelled", "unknown",
]);

function publicLoginText(value) {
  return String(value || "").slice(0, 2000)
    .replace(/\bBearer\s+[^\s"',}]+/gi, "Bearer [REDACTED]")
    .replace(/((?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|password|secret|token)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[REDACTED]");
}

/** 登录结果只公开操作状态及用户需要的授权链接，丢弃 account/userinfo/token 等内部字段。 */
export function publicLoginResult(raw, worker, action) {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const result = {
    ok: value.ok === true,
    worker,
    action,
    status: LOGIN_STATUSES.has(value.status) ? value.status : "unknown",
  };
  for (const key of ["user_code", "expires_at", "instructions", "error"]) {
    if (typeof value[key] === "string" && value[key]) result[key] = publicLoginText(value[key]);
  }
  if (typeof value.login_url === "string" && value.login_url) {
    try {
      const url = new URL(value.login_url);
      const secretParam = [...url.searchParams.keys()].some((key) =>
        /^(?:accesstoken|refreshtoken|idtoken|apikey|password|secret|authorization|token)$/.test(key.toLowerCase().replace(/[^a-z0-9]/g, "")));
      if (url.protocol === "https:" && !url.username && !url.password && !url.hash && !secretParam) {
        result.login_url = url.href;
      } else {
        result.ok = false;
        result.error = "枢纽返回的登录链接格式不安全，请在 worker 宿主机检查登录配置。";
      }
    } catch {
      result.ok = false;
      result.error = "枢纽返回的登录链接格式无效。";
    }
  }
  return result;
}

/** 在枢纽宿主机发起/查询/取消官方登录流程，不在插件客户端运行 CLI。 */
export async function hubLogin(workerRaw, action = "status") {
  const worker = resolveWorker(workerRaw);
  if (!worker) return { ok: false, worker: String(workerRaw || ""), action, status: "unavailable", error: "未知 worker，可选：" + CANONICAL.join(" / ") };
  if (!["start", "status", "cancel"].includes(action)) {
    return { ok: false, worker, action: "status", status: "failed", error: "action 必须是 start / status / cancel" };
  }
  try {
    const text = await callTool("hub_login", { agent: worker, action }, 30_000, true);
    return publicLoginResult(JSON.parse(text), worker, action);
  } catch (e) {
    return { ok: false, worker, action, status: "unavailable", error: "登录服务不可用：" + publicLoginText(e && e.message || e).slice(0, 300) };
  }
}

/**
 * 异步派发返回 ref；同步配置直接返回 completed/failed 与 answer。
 * HTTP 受理请求限制 25 秒；网络失败不证明远端未执行，不能自动重派。
 */
export async function dispatchOnly(workerRaw, task, timeoutS = 900, options = {}) {
  const worker = resolveWorker(workerRaw);
  if (!worker) {
    return { ok: false, worker: String(workerRaw || ""), ref: "", error: `未知 worker「${workerRaw}」，可选：${CANONICAL.join(" / ")}` };
  }
  const recursive = recursiveDispatchError(worker);
  if (recursive) {
    return { ok: false, status: "failed", worker, ref: "", error: recursive };
  }
  const error = taskError(task, timeoutS);
  if (error) return { ok: false, worker, ref: "", error };
  const result = await startTask(worker, task, timeoutS, performance.now() + DISPATCH_HTTP_MS, options);
  if (result.status === "running") return { ok: true, worker, status: "running", ref: result.ref };
  if (result.status === "completed") return { ok: true, worker, ...result };
  return { ok: false, worker, ...result, error: result.answer };
}

/**
 * 按 ref 查一次当前状态（非阻塞，秒回）：{ status, answer }。
 * status: completed / failed / timeout / running / unknown。
 */
export async function fetchRef(ref) {
  if (typeof ref !== "string" || !/^[\w.-]+-[0-9a-f]+$/i.test(ref)) {
    return { status: "unknown", answer: "ref 格式无效" };
  }
  let t;
  try {
    t = await callTool("hub_result", { ref }, 30_000);
  } catch (e) {
    return { status: "unknown", answer: "查询失败：" + String(e && e.message || e).slice(0, 200) };
  }
  const result = receipt(t, null, ref);
  const progress = result.status === "running" ? extractAnswer(t).replace(/^\[执行中·受控端界面快照\]\s*/, "").replace(/\n?\(尚无文本\)$/, "") : undefined;
  return { status: result.status, answer: result.answer, ...(progress ? { progress } : {}) };
}
