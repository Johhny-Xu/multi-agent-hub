// Agent Hub 桥接引擎：把"派发 → 阻塞回收"包成一次调用（ask）。
// 供 server.mjs（stdio MCP）与 ask.mjs（CLI 一次性）共用。
// 发布时同步 root mcp 与 integrations/dsh/mcp；tests/mcp_bridge.test.mjs 防止独立安装包漂移。
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
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
  qd: "qoder", qoder: "qoder",
  qdcn: "qoder-cn", qodercn: "qoder-cn", "qoder-cn": "qoder-cn",
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

const MAX_FILES = 8;
const MAX_FILE_BYTES = 1024 * 1024;

function contractError(code, stage, text, details = {}, kind = "rejected") {
  const error = hubError(kind, text);
  error.code = code;
  error.stage = stage;
  error.details = details;
  error.dispatch_count = 0;
  return error;
}

function fileError(error, name) {
  const code = error && error.code;
  if (code === "EACCES" || code === "EPERM") {
    return contractError("blocked_permission", "validation", "附件读取被本地权限策略拒绝：" + name,
      { file_id: name }, "permission");
  }
  return contractError("ATTACHMENT_UNREADABLE", "validation", "附件无法完整读取：" + name,
    { file_id: name, worker_reason: String(code || "read_error") });
}

/** `files` is the explicit authorization list for this call only. */
async function readAuthorizedAttachments(files) {
  if (!Array.isArray(files) || files.length > MAX_FILES || files.some((item) => typeof item !== "string" || !item)) {
    throw contractError("ATTACHMENT_LIMIT_EXCEEDED", "validation", "files must contain at most 8 local file paths",
      { actual_count: Array.isArray(files) ? files.length : 0, allowed_count: MAX_FILES });
  }
  const attachments = [];
  const mimeTypes = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".json": "application/json" };
  let size = 0;
  for (const source of files) {
    const name = basename(source);
    if (/^(?:\.env(?:\..*)?|\.?auth\.json|\.?credentials(?:\.json|\.ya?ml)?|id_(?:rsa|ed25519))$/i.test(name) || /\.(?:key|pem)$/i.test(name)) {
      throw contractError("ATTACHMENT_ACCESS_DENIED", "validation", "Credential files cannot be sent as task attachments",
        { file_id: name, worker_reason: "credential_filename" });
    }
    let before;
    try { before = await lstat(source); }
    catch (error) { throw fileError(error, name); }
    if (before.isSymbolicLink()) {
      throw contractError("ATTACHMENT_ACCESS_DENIED", "validation", "Symbolic links are not authorized attachments",
        { file_id: name, worker_reason: "symlink" });
    }
    if (!before.isFile()) {
      throw contractError("ATTACHMENT_UNREADABLE", "validation", "Attachment is not a regular file",
        { file_id: name, worker_reason: before.isDirectory() ? "directory" : "not_regular_file" });
    }
    let file;
    try {
      // O_NOFOLLOW closes the lstat/open race: a swapped symlink is refused
      // instead of being followed to an unauthorized target.
      const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW || 0));
      file = await open(source, flags);
    }
    catch (error) { throw fileError(error, name); }
    try {
      const stat = await file.stat();
      if (!stat.isFile()) {
        throw contractError("ATTACHMENT_UNREADABLE", "validation", "Attachment is not a regular file",
          { file_id: name, worker_reason: "not_regular_file" });
      }
      if (stat.size !== before.size || stat.mtimeMs !== before.mtimeMs) {
        throw contractError("ATTACHMENT_UNREADABLE", "validation", "Attachment changed before it was read",
          { file_id: name, worker_reason: "changed_before_read" });
      }
      if (size + stat.size > MAX_FILE_BYTES) {
        throw contractError("ATTACHMENT_LIMIT_EXCEEDED", "validation", "Attachments exceed the 1 MiB combined limit",
          { file_id: name, actual_bytes: size + stat.size, allowed_bytes: MAX_FILE_BYTES });
      }
      const data = await file.readFile();
      if (data.length !== stat.size) {
        throw contractError("ATTACHMENT_UNREADABLE", "validation", "Attachment read was incomplete",
          { file_id: name, actual_bytes: data.length, worker_reason: "short_read" });
      }
      const after = await file.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
        throw contractError("ATTACHMENT_UNREADABLE", "validation", "Attachment changed while it was being read",
          { file_id: name, worker_reason: "changed_while_reading" });
      }
      size += data.length;
      if (size > MAX_FILE_BYTES) {
        throw contractError("ATTACHMENT_LIMIT_EXCEEDED", "validation", "Attachments exceed the 1 MiB combined limit",
          { file_id: name, actual_bytes: size, allowed_bytes: MAX_FILE_BYTES });
      }
      attachments.push({ name, mime_type: mimeTypes[extname(name).toLowerCase()] || "text/plain", data_base64: data.toString("base64") });
    } catch (error) {
      if (error && error.code && error.stage) throw error;
      throw fileError(error, name);
    } finally { await file.close(); }
  }
  return attachments;
}

async function taskOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw contractError("TASK_OPTION_INVALID", "validation", "options must be an object");
  const known = new Set(["model", "cwd", "thinking", "stream", "files", "onProgress"]);
  for (const key of Object.keys(options)) if (!known.has(key)) throw contractError("TASK_OPTION_INVALID", "validation", "Unknown task option: " + key);
  const result = {};
  for (const key of ["model", "cwd"]) {
    if (options[key] !== undefined) {
      if (typeof options[key] !== "string" || !options[key].trim()) throw contractError("TASK_OPTION_INVALID", "validation", key + " must be a nonempty string");
      result[key] = options[key];
    }
  }
  if (options.thinking !== undefined) {
    if (!["default", "on", "off"].includes(options.thinking)) throw contractError("TASK_OPTION_INVALID", "validation", "thinking must be default/on/off");
    result.thinking = options.thinking;
  }
  if (options.stream !== undefined) {
    if (typeof options.stream !== "boolean") throw contractError("TASK_OPTION_INVALID", "validation", "stream must be a boolean");
    result.stream = options.stream;
  }
  if (options.files !== undefined) result.attachments = await readAuthorizedAttachments(options.files);
  return result;
}

/** The thread that asked for this dispatch, when the host mounted the hub MCP with one. Absent here means absent on the wire. */
function originThreadHeader() {
  const thread = String(process.env.HUB_ORIGIN_THREAD || process.env.AGENTHUB_ORIGIN_THREAD || "").trim();
  return thread ? { "X-Hub-Origin-Thread": thread } : {};
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
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}), ...originThreadHeader() },
    body: payload,
    signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
  });
  if (!resp.ok) {
    // 403 is a policy refusal; 401 is authentication, not permission policy.
    const kind = resp.status === 403 ? "permission" : "rejected";
    const error = hubError(kind, "HTTP " + resp.status + "：枢纽请求失败");
    error.http_status = resp.status;
    if (resp.status === 403) { error.code = "blocked_permission"; error.stage = "dispatch_acceptance"; }
    if (resp.status === 401) { error.code = "AUTH_FAILED"; error.stage = "dispatch_acceptance"; }
    throw error;
  }
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
  if (body.result.isError && !allowToolError) {
    let structured = null;
    try { structured = JSON.parse(text); } catch { structured = null; }
    if (structured && typeof structured === "object" && typeof structured.error_code === "string") {
      const error = hubError(structured.error_code === "blocked_permission" ? "permission" : "rejected",
        structured.message || "TOOL-ERROR");
      error.code = structured.error_code;
      error.stage = structured.failure_stage;
      error.details = structured.error_details;
      error.dispatch_count = structured.dispatch_count;
      throw error;
    }
    throw hubError("rejected", "TOOL-ERROR " + text);
  }
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
function parseReceipt(text, worker, expectedRef = null) {
  const cleaned = cleanText(text);
  const header = /^\[([^\]\r\n]+)\]([^\r\n]*)(?:\r?\n|$)/.exec(cleaned);
  if (!header) return { status: "unknown", ref: expectedRef || "", answer: cleaned.slice(0, 500) };
  const tag = header[1];
  const ref = tag.split("/").at(-1);
  const validRef = expectedRef ? ref === expectedRef : (refRegex(worker).test(ref) || /^[a-z0-9_-]+-[0-9a-f]{6,32}$/i.test(ref));
  const status = /(?:^|\s)status=([a-z]+)\b/i.exec(header[2])?.[1]?.toLowerCase();
  const workerStatus = /(?:^|\s)worker_status=([a-z]+)\b/i.exec(header[2])?.[1]?.toLowerCase();
  const errorCode = /(?:^|\s)error_code=([A-Za-z0-9_]+)\b/.exec(header[2])?.[1];
  const failureStage = /(?:^|\s)failure_stage=([a-z_]+)\b/i.exec(header[2])?.[1];
  const headerDispatchCount = /(?:^|\s)dispatch_count=(\d+)\b/.exec(header[2])?.[1];
  const auditDegraded = /(?:^|\s)audit_degraded=true\b/i.test(header[2]);
  const extra = { ...(workerStatus ? { worker_status: workerStatus } : {}),
    ...(errorCode ? { error_code: errorCode } : {}),
    ...(failureStage ? { failure_stage: failureStage } : {}),
    ...(headerDispatchCount !== undefined ? { dispatch_count: Number(headerDispatchCount) } : {}),
    ...(auditDegraded ? { audit_degraded: true } : {}) };
  const headerExit = /(?:^|\s)exit=(-?\d+)\b/.exec(header[2]);
  const footerExit = /\n\(exit=(-?\d+)\)\s*$/.exec(cleaned);
  if (validRef) {
    if ((headerExit && Number(headerExit[1]) !== 0) || (footerExit && Number(footerExit[1]) !== 0) || ["failed", "error", "timeout", "cancelled"].includes(status)) {
      return { status: "failed", ref, answer: cleaned.slice(0, 500), ...extra };
    }
    if (status === "completed") {
      const ans = extractAnswer(cleaned);
      if (/排队提醒|当前模型请求量较高|升级权益等待中|体验套餐可用额度已用完|套餐查询失败|额度已用完|可用额度已用完|积分不足|无可用额度/.test(ans)) {
        return { status: "failed", ref, answer: ans.slice(0, 500), ...extra };
      }
      return { status, ref, answer: ans, ...extra };
    }
    if (!expectedRef || status === "running") return { status: "running", ref, answer: "", ...extra };
  } else if (!expectedRef && headerExit && (tag === worker || tag.startsWith(worker + "/"))) {
    const isOk = Number(headerExit[1]) === 0;
    const ans = isOk ? extractAnswer(cleaned) : cleaned.slice(0, 500);
    if (isOk && /排队提醒|当前模型请求量较高|升级权益等待中|体验套餐可用额度已用完|套餐查询失败|额度已用完|可用额度已用完|积分不足|无可用额度/.test(ans)) {
      return { status: "failed", ref: "", answer: ans.slice(0, 500), ...extra };
    }
    return { status: isOk ? "completed" : "failed", ref: "", answer: ans, ...extra };
  }
  if (status === "running" && ref && /^[a-z0-9_-]+-[0-9a-f]{6,32}$/i.test(ref)) {
    return { status: "running", ref, answer: "", ...extra };
  }
  return { status: "unknown", ref: expectedRef || "", answer: cleaned.slice(0, 500), ...extra };
}

const PLACEHOLDER_ANSWERS = new Set(["(无输出)", "(尚无文本)", "(no output)", "(empty)", "task received", "已收到任务", "任务已收到"]);

function unusableAnswer(text) {
  const value = cleanText(text).replace(/\s+/g, "").toLowerCase();
  if (!value) return true;
  if (PLACEHOLDER_ANSWERS.has(value)) return true;
  return value.length <= 24 && ["思考中", "生成中", "thinking", "receivedthetask"].some((marker) => value.includes(marker));
}

/** Normalize one receipt while keeping the raw worker status and input ref. */
function receipt(text, worker, expectedRef = null) {
  const value = parseReceipt(text, worker, expectedRef);
  const workerStatus = value.worker_status || value.status;
  let status = value.status;
  let errorCode = value.error_code;
  let failureStage = value.failure_stage;
  if (status === "completed" && unusableAnswer(value.answer)) {
    status = "failed";
    errorCode = "WORKER_ANSWER_EMPTY";
    failureStage = "verification";
  } else if (status === "failed" && !errorCode) {
    errorCode = "WORKER_EXECUTION_FAILED";
    failureStage = "worker_execution";
  }
  return { ...value, status, worker_status: workerStatus, ...(errorCode ? { error_code: errorCode } : {}),
    ...(failureStage ? { failure_stage: failureStage } : {}) };
}

function createDispatchGuard() {
  let count = 0;
  return {
    begin() {
      if (count !== 0) {
        const error = hubError("rejected", "DUPLICATE_DISPATCH_DENIED: this logical task already dispatched");
        error.code = "DUPLICATE_DISPATCH_DENIED";
        error.dispatch_count = count;
        throw error;
      }
      count = 1;
    },
    get count() { return count; },
  };
}

async function startTask(worker, task, timeoutS, deadline, options = {}) {
  const guard = createDispatchGuard();
  let prepared;
  try {
    prepared = await taskOptions(options);
    if (performance.now() >= deadline) {
      return { status: "unknown", ref: "", answer: "派发前等待预算已用尽，未调用 worker。",
        error_code: "DISPATCH_TIMEOUT", failure_stage: "dispatch_acceptance", dispatch_count: 0 };
    }
  } catch (error) {
    return { status: "failed", ref: "", answer: "任务未派发：" + message(error),
      ...(error.code ? { error_code: error.code } : {}),
      failure_stage: error.stage || "validation",
      ...(error.details ? { error_details: error.details } : {}),
      dispatch_count: 0 };
  }
  try {
    guard.begin();
    const normalized = receipt(await dispatchWorker(worker, task, timeoutS, deadline, prepared), worker);
    return { ...normalized, dispatch_count: guard.count };
  } catch (error) {
    const permission = error.kind === "permission" || error.code === "blocked_permission" ||
      /\b(?:EACCES|EPERM|blocked_permission)\b/.test(String(error && error.message || ""));
    const rejected = error.kind === "rejected" || permission;
    const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
    const status = permission || rejected ? "failed" : "unknown";
    const errorCode = (typeof error.code === "string" ? error.code : null) ||
      (timedOut ? "DISPATCH_TIMEOUT" : "TASK_STATE_UNKNOWN");
    const prefix = permission ? "权限策略拒绝派发：" : status === "unknown" ? "未能确认派发是否受理，请先检查枢纽，避免重复执行：" : "枢纽拒绝派发：";
    const stage = error.stage || "dispatch_acceptance";
    const preDispatch = ["validation", "capability_validation", "command_binding", "audit"].includes(stage);
    return { status, ref: "", answer: prefix + message(error), error_code: errorCode,
      failure_stage: stage, dispatch_count: preDispatch ? 0 : guard.count,
      ...(error.details ? { error_details: error.details } : {}) };
  }
}

async function dispatchAndCollect(worker, task, timeoutS, options) {
  const deadline = performance.now() + timeoutS * 1000;
  const started = await startTask(worker, task, timeoutS, deadline, options);
  if (started.status !== "running") return { ok: started.status === "completed", worker, ...started };
  const { ref } = started;
  const dispatchCount = started.dispatch_count ?? 1;
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
        let status = ["error", "timeout", "cancelled"].includes(value.status) ? "failed" : value.status;
        const text = typeof value.text === "string" ? value.text : "";
        let errorCode = value.error_code;
        let stage = value.failure_stage;
        if (status === "completed" && unusableAnswer(text)) {
          status = "failed";
          errorCode = "WORKER_ANSWER_EMPTY";
          stage = "verification";
        } else if (status === "failed" && !errorCode) {
          errorCode = "WORKER_EXECUTION_FAILED";
          stage = stage || "worker_execution";
        } else if (status === "unknown") {
          errorCode = errorCode || "TASK_STATE_UNKNOWN";
          stage = stage || "result_query";
        }
        result = { ok: status === "completed", worker, ref, status,
          worker_status: value.worker_status || value.status, dispatch_count: dispatchCount,
          ...(errorCode ? { error_code: errorCode } : {}), ...(stage ? { failure_stage: stage } : {}),
          answer: text };
      } catch (error) {
        return { ok: false, worker, ref, status: "unknown", dispatch_count: dispatchCount, error_code: "TASK_STATE_UNKNOWN", failure_stage: "result_query", answer: "查询失败，保留原 ref：" + message(error) };
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
      return { ok: false, status: "unknown", worker, ref, dispatch_count: dispatchCount, error_code: "TASK_STATE_UNKNOWN", failure_stage: "result_query", answer: "查询失败，任务可能仍在执行，请用同一 ref 续查：" + message(error) };
    }
    const result = receipt(t, worker, ref);
    if (result.status !== "running") return { ok: result.status === "completed", worker, ...result, dispatch_count: dispatchCount };
    // 即时 running 回执也要退避，避免本地 HTTP 枢纽被紧密轮询淹没。
    const pauseMs = Math.min(100, Math.max(0, deadline - performance.now()));
    if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  return { ok: false, status: "running", worker, ref, error_code: "WAIT_BUDGET_EXHAUSTED", failure_stage: "result_collection", dispatch_count: 1, answer: `在 ${timeoutS}s 内未完成，任务仍可能执行；使用 ref=${ref} 续查，避免重复派发。` };
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
    return { ok: false, status: "failed", worker: String(workerRaw || ""), ref: "", dispatch_count: 0, error_code: "INVALID_WORKER", failure_stage: "validation", answer: `未知 worker「${workerRaw}」，可选：${CANONICAL.join(" / ")}` };
  }
  const recursive = recursiveDispatchError(worker);
  if (recursive) {
    return { ok: false, status: "failed", worker, ref: "", dispatch_count: 0, error_code: "RECURSIVE_DISPATCH_DENIED", failure_stage: "validation", answer: recursive };
  }
  const error = taskError(task, timeoutS);
  if (error) return { ok: false, status: "failed", worker, ref: "", dispatch_count: 0, error_code: "TASK_OPTION_INVALID", failure_stage: "validation", answer: error };
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
    return { ok: false, worker: String(workerRaw || ""), ref: "", dispatch_count: 0, error_code: "INVALID_WORKER", failure_stage: "validation", error: `未知 worker「${workerRaw}」，可选：${CANONICAL.join(" / ")}` };
  }
  const recursive = recursiveDispatchError(worker);
  if (recursive) {
    return { ok: false, status: "failed", worker, ref: "", dispatch_count: 0, error_code: "RECURSIVE_DISPATCH_DENIED", failure_stage: "validation", error: recursive };
  }
  const error = taskError(task, timeoutS);
  if (error) return { ok: false, worker, ref: "", dispatch_count: 0, error_code: "TASK_OPTION_INVALID", failure_stage: "validation", error };
  const result = await startTask(worker, task, timeoutS, performance.now() + DISPATCH_HTTP_MS, options);
  if (result.status === "running") return { ok: true, worker, ...result };
  if (result.status === "completed") return { ok: true, worker, ...result };
  return { ok: false, worker, ...result, error: result.answer };
}

/**
 * 按 ref 查一次当前状态（非阻塞，秒回）：{ status, answer }。
 * status: completed / failed / timeout / running / unknown。
 */
export async function fetchRef(ref) {
  const echoed = typeof ref === "string" ? ref : "";
  if (typeof ref !== "string" || !/^[\w.-]+-[0-9a-f]+$/i.test(ref)) {
    return { status: "unknown", ref: echoed, error_code: "TASK_STATE_UNKNOWN", answer: "ref 格式无效" };
  }
  let t;
  try {
    t = await callTool("hub_result", { ref }, 30_000);
  } catch (e) {
    const permission = e && (e.kind === "permission" || e.code === "blocked_permission");
    return { status: permission ? "failed" : "unknown", ref, worker_status: "unknown",
      error_code: permission ? "blocked_permission" : "TASK_STATE_UNKNOWN",
      failure_stage: "result_query",
      answer: "查询失败：" + String(e && e.message || e).slice(0, 200) };
  }
  const result = receipt(t, null, ref);
  const progress = result.status === "running" ? extractAnswer(t).replace(/^\[执行中·受控端界面快照\]\s*/, "").replace(/\n?\(尚无文本\)$/, "") : undefined;
  return { status: result.status, ref, worker_status: result.worker_status || result.status,
    ...(result.error_code ? { error_code: result.error_code } : result.status === "unknown" ? { error_code: "TASK_STATE_UNKNOWN" } : {}),
    ...(result.failure_stage ? { failure_stage: result.failure_stage } : result.status === "unknown" ? { failure_stage: "result_query" } : {}),
    ...(result.dispatch_count !== undefined ? { dispatch_count: result.dispatch_count } : {}),
    ...(result.audit_degraded ? { audit_degraded: true } : {}),
    answer: result.answer, ...(progress ? { progress } : {}) };
}

/**
 * 按 ref 探测 worker 是否真的在工作：进程树/CPU/输出/心跳/verdict。
 * 与 fetchRef 不同，running 时也适合调用；首次调用建基线，10 秒后再查可看增量。
 */
export async function taskStatus(ref) {
  if (typeof ref !== "string" || !/^[\w.-]+-[0-9a-f]+$/i.test(ref)) {
    return { ok: false, ref, status: "unknown", verdict: "unknown", answer: "ref 格式无效" };
  }
  let raw;
  try {
    raw = await callTool("hub_task_status", { ref, json: true }, 30_000);
  } catch (e) {
    return { ok: false, ref, status: "unknown", verdict: "unknown", answer: "存活查询失败：" + String(e && e.message || e).slice(0, 200) };
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, ref, status: "unknown", verdict: "unknown", answer: "存活查询返回了无效 JSON" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, ref, status: "unknown", verdict: "unknown", answer: "存活查询返回了无效结构" };
  }
  return {
    ok: value.status !== "unknown",
    ref,
    agent: value.agent ?? null,
    status: value.status ?? "unknown",
    verdict: value.verdict ?? "unknown",
    action: value.action ?? "inspect",
    answer: value.guidance ?? "",
    pid: value.pid ?? null,
    process_alive: value.process_alive ?? null,
    process_count: value.process_count ?? null,
    cpu_seconds: value.cpu_seconds ?? null,
    cpu_delta_seconds: value.cpu_delta_seconds ?? null,
    output_bytes: value.output_bytes ?? 0,
    output_delta_bytes: value.output_delta_bytes ?? null,
    last_output_age_s: value.last_output_age_s ?? null,
    heartbeat_age_s: value.heartbeat_age_s ?? null,
    elapsed_s: value.elapsed_s ?? null,
    preserve_ref: value.preserve_ref ?? value.status !== "completed",
  };
}
