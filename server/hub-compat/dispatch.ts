// hub-compat 派活层：老 MAH（agent_hub.py）的 15 个派活/查询工具的兼容实现。
// 对外文本格式逐字照抄老实现（_format_result / tool_hub_wait_result / _format_task_status /
// 「任务已异步受理」回执），因为 mcp/hub.mjs 的 parseReceipt/receipt/fetchRef/taskStatus
// 靠正则解析首行 `[agent/ref] status=…` 和尾行 `(exit=N)`。
// 内部把活派给 8801 的引擎：每个 worker 一个常驻 bot（hub·<agent>），每次派活开新任务线程，
// 轮询线程消息取 bot 回复。结果持久化到 stateDir/results/<ref>.json，进程重启后按 threadId 续读。
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { hubEventLog, redactEventText, type HubEventKind } from "./events.ts";
import { createOriginWriter, type OriginWriter } from "./origin.ts";

const MAX_OUTPUT_CHARS = 20000;
const TERMINAL_STATUSES = ["completed", "error", "timeout"];
const WAIT_CHECK_SCHEDULE = [0, 3, 6, 12, 25, 45, 70, 95];
/** The silent window: how long a worker may produce nothing before it counts as stuck. */
const DEFAULT_TASK_TIMEOUT_S = 900;
/** The absolute cap of one dispatch: a worker that keeps producing but never ends still stops here. */
const DEFAULT_HARD_TIMEOUT_S = 21600;
const DEFAULT_WAIT_S = 110;
const MAX_WAIT_BUDGET_S = 115;
const POLL_INTERVAL_MS = 2000;
/** 老 TRAE_GATEWAY 语义：每次调用时读 env（测试可在进程内覆盖指向假网关）。 */
function traeGateway(): string {
  return String(process.env.TRAE_GATEWAY || "http://127.0.0.1:8787").replace(/\/+$/, "");
}

function positiveTimeout(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? text.slice(0, MAX_OUTPUT_CHARS) + `\n...[输出已截断, 共 ${text.length} 字符]`
    : text;
}

function asBool(value: unknown, fallback = false): boolean {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return !["", "0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

/** 老 state_store.safe_component 的宽容版：查询入口先过它，坏字符不落盘即可。 */
function safeComponent(value: unknown): string {
  return String(value ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "unknown";
}

function now(): number {
  return Date.now() / 1000;
}

function shortRef(agent: string): string {
  return `${agent}-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

/** 8801 自动/Chief 重试同一请求时写进线程的 user 消息（server/incidents.ts RETRY_LEAD）。 */
export const RETRY_NOTICE_PREFIX = "[From OpenMausBot · retry";
export function isRetryNotice(m: any): boolean {
  return m?.role === "user" && m?.kind === "text" && typeof m?.text === "string" && m.text.startsWith(RETRY_NOTICE_PREFIX);
}

/** E11：回合失败后 8801 可能马上自动续跑；先等这么久看有没有续跑，再记失败。 */
export const RETRY_GRACE_S = 120;

function errorMessage(error: unknown): string {
  return String((error as Error)?.message || error);
}

/** E19：引擎把长命令转后台后，回合常以一句进度叙述收尾（「正在运行测试验证...」），汇报并没有写。 */
export const REPORT_FOLLOWUP_TEXT =
  "你上一轮只回了进度，没有写汇报。请等命令/测试跑完，把结果写进汇报文件，最后一条消息必须是汇报摘要。把汇报写完再结束。";

/** 最后一条只是「还在进行」的进度叙述：短、且以进行中的说法开头或省略号收尾。真正的交付不会这样开头。 */
const PROGRESS_END = /^(?:正在|仍在|还在|等待|请稍等|稍等|running\b|still (?:running|working|going)\b|waiting\b|an asynchronous command\b|the command is still running\b)/i;
export function endedWithoutReport(text: string): boolean {
  const trimmed = String(text ?? "").trim();
  if (!trimmed || trimmed.length >= 400) return false;
  return PROGRESS_END.test(trimmed) || /(?:\.\.\.|…)$/.test(trimmed);
}

// ---------------------------------------------------------------- worker 注册表

/** worker 规范名 → 8801 instanceId（任务书指定映射）。 */
const WORKERS: Record<string, string> = {
  antigravity: "antigravity", codebuddy: "codebuddy", "codebuddy-cn": "codebuddyCn",
  minimaxcode: "mcode", qoder: "qoder", "qoder-cn": "qoderCn", codearts: "codearts",
  meoo: "meoo", cline: "cline", opencode: "opencodeGo", "github-copilot": "githubCopilot",
  zcode: "zcode",
};

/** 缺省模型是裸 id（GLM-5.3-Flash），而引擎目录在多个 provider 提供同名模型时只列 `providerId/modelId`：
 * 取目录里同名的那个，账号 start plan 优先，否则第一个；目录里本就有裸 id 或没有同名项时原样返回。 */
export function qualifyDefaultModel(model: string | undefined, options: readonly string[]): string | undefined {
  if (!model || !options.length || options.includes(model) || model.includes("/")) return model;
  const bare = model.toLowerCase();
  const matches = options.filter((id) => id.slice(id.lastIndexOf("/") + 1).toLowerCase() === bare);
  return matches.find((id) => /^(account|builtin):bigmodel-start-plan\//i.test(id)) ?? matches[0] ?? model;
}

/** 老实现 AGENT_ALIASES（_resolve_agent）：简称 → 规范名。 */
const AGENT_ALIASES: Record<string, string> = {
  agy: "antigravity", cb: "codebuddy", cbcn: "codebuddy-cn", mimo: "mimocode",
  gcp: "github-copilot", copilot: "github-copilot", mmx: "minimaxcode",
  trae: "traecode", ca: "codearts", "huawei-codearts": "codearts", oc: "opencode",
  intl: "codebuddy", "codebuddy-intl": "codebuddy", cbcnintl: "codebuddy",
  qd: "qoder", qdcn: "qoder-cn", qodercn: "qoder-cn",
};

function resolveAgent(name: unknown): string {
  const raw = String(name ?? "").trim();
  const low = raw.toLowerCase();
  if (AGENT_ALIASES[low]) return AGENT_ALIASES[low];
  const known = [...Object.keys(WORKERS), "traecode"];
  if (known.includes(raw)) return raw;
  return known.find((k) => k.toLowerCase() === low) ?? low;
}

/** 通道缺省模型。zcode 走 ZCode 套餐额度，用 GLM-5.3-Flash（T3 的 zcode 驱动把套餐模型放在目录首位）；
 * 必须同时出现在 8801 /api/instances 的 options 里，否则 resolveBotModel 以 UNSUPPORTED 拒绝派活。 */
const DEFAULT_MODELS: Record<string, string> = { zcode: "GLM-5.3-Flash" };

// ---------------------------------------------------------------- 结果存取（stateDir/results/<ref>.json）

interface ResultRecord {
  ref: string; agent: string; status: string; worker_status?: string;
  task?: string; text?: string; progress?: string | null; partial_text?: string;
  error_code?: string; failure_stage?: string; exit_code?: number;
  started_at?: number; updated_at?: number; last_output_at?: number; heartbeat?: number;
  progress_at?: number; output_bytes?: number; dispatch_count?: number;
  /** The user message this dispatch posted: the only way back to this exact turn. */
  request_message_id?: string; request_message_at_ms?: number; turn_id?: string;
  /** The two windows: silence since real progress, and the absolute cap. */
  idle_timeout_s?: number; hard_timeout_s?: number; last_worker_progress_at?: number;
  liveness_source?: string; thread_id?: string; bot_id?: string; model?: string;
  cwd?: string; dispatch_message_at?: number; session_id?: string;
  audit_degraded?: boolean; status_history?: Array<Record<string, unknown>>;
  last_confirmed_status?: string; [key: string]: unknown;
}

/** Per-call channel the transport hands to a long tool: `notifications/progress` when the client asked for it. */
export interface DispatchCallContext {
  progress?: (message: string) => void;
}

export function createDispatchTools(opts: { omBase: string; stateDir: string; retryGraceS?: number }) {
  const retryGraceS = opts.retryGraceS ?? RETRY_GRACE_S;  const resultsDir = join(opts.stateDir, "results");
  const botsFile = join(opts.stateDir, "dispatch-bots.json");
  const events = hubEventLog(opts.stateDir);
  /** Progress goes back into the thread that asked for the work, when that thread is known. */
  const origin: OriginWriter = createOriginWriter({ omBase: opts.omBase });
  mkdirSync(resultsDir, { recursive: true });

  const activeRuns = new Map<string, Promise<void>>();

  function resultPath(ref: string): string {
    return join(resultsDir, safeComponent(ref) + ".json");
  }

  function readResult(ref: string): ResultRecord | null {
    const path = resultPath(ref);
    if (!existsSync(path)) return null;
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      return data && typeof data === "object" && !Array.isArray(data) ? data as ResultRecord : null;
    } catch {
      throw new Error("Task result is invalid; preserve its ref");
    }
  }

  function updateResult(ref: string, fields: Partial<ResultRecord>): ResultRecord {
    const current = readResult(ref) ?? ({} as ResultRecord);
    const patch = { ...fields };
    if (patch.status && patch.status !== current.status) {
      const history = Array.isArray(current.status_history) ? [...current.status_history] : [];
      history.push({ from: current.status ?? null, to: patch.status, error_code: patch.error_code,
        failure_stage: patch.failure_stage, at: now() });
      patch.status_history = history;
      patch.last_confirmed_status = patch.status;
    }
    const merged = { ...current, ...patch, ref, updated_at: now() } as ResultRecord;
    const tmp = resultPath(ref) + ".tmp-" + randomUUID().slice(0, 8);
    writeFileSync(tmp, JSON.stringify(merged, null, 1));
    renameSync(tmp, resultPath(ref));
    if (patch.status && patch.status !== current.status) emitTransition(merged, patch.status);
    return merged;
  }

  /** Terminal transitions feed the event stream from one place, so every path (poll loop, reaped, reap) reports. */
  function emitTransition(record: ResultRecord, status: string): void {
    // "zcode-last"/"trae-last" are summary scratch files, not dispatches anyone follows.
    if (record.ref === "zcode-last" || record.ref === "trae-last") return;
    const kind: HubEventKind | null = status === "completed" ? "done"
      : status === "error" ? "error"
      : status === "timeout" ? "timeout"
      : null;
    if (!kind) return;
    const fallback = kind === "done" ? "任务完成" : kind === "timeout" ? "任务超时" : "任务失败";
    events.emit(record.ref, record.agent, kind, record.text || record.error_code || fallback);
    // The asking thread gets the outcome with the summary and the time it took.
    const startedAt = Number(record.started_at ?? 0);
    const endedAt = Number(record.updated_at ?? now());
    const elapsedS = startedAt > 0 ? Math.max(0, Math.round(endedAt - startedAt)) : 0;
    void origin.terminal(record.ref, record.agent, record.status, record.text || record.error_code || fallback, elapsedS);
  }

  function reapResult(d: ResultRecord | null): ResultRecord | null {
    if (!d || d.status !== "running") return d;
    // 两道闸：静默窗口按 worker 的真实进展算，硬上限按派发起算。
    const idleS = Number(d.idle_timeout_s ?? DEFAULT_TASK_TIMEOUT_S) || DEFAULT_TASK_TIMEOUT_S;
    const hardS = Number(d.hard_timeout_s ?? DEFAULT_HARD_TIMEOUT_S) || DEFAULT_HARD_TIMEOUT_S;
    const startedAt = Number(d.started_at ?? now());
    const progressedAt = Number(d.last_worker_progress_at ?? d.progress_at ?? d.last_output_at ?? startedAt);
    const idleAge = now() - progressedAt;
    const hardAge = now() - startedAt;
    if (idleAge < idleS && hardAge < hardS) return d;
    // OM 通道没有 CLI PID 树可探活；线程若还能取到新消息，refresh 会先落盘。
    const why = hardAge >= hardS
      ? `已达硬上限 ${hardS}s`
      : `已 ${Math.round(idleAge / 60)} 分钟无任何进展`;
    return updateResult(d.ref, {
      status: "timeout", progress: null,
      text: `任务超时: ${why}, 判定 worker 已异常退出。请检查 async_worker 日志。`,
      ...(d.partial_text ? { partial_text: d.partial_text } : {}),
    });
  }

  // ---------------------------------------------------------------- 8801 OM API 客户端

  async function om(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; json: any }> {
    const resp = await fetch(opts.omBase.replace(/\/+$/, "") + path, {
      method: init?.method ?? "GET",
      headers: { "Content-Type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(25_000),
    });
    let json: any = null;
    try { json = await resp.json(); } catch { /* 空响应体 */ }
    return { status: resp.status, json };
  }

  interface BotEntry { botId: string; model?: string }

  function readBots(): Record<string, BotEntry> {
    try {
      const data = JSON.parse(readFileSync(botsFile, "utf8"));
      return data?.bots && typeof data.bots === "object" ? data.bots : {};
    } catch {
      return {};
    }
  }

  function writeBots(bots: Record<string, BotEntry>): void {
    const tmp = botsFile + ".tmp-" + randomUUID().slice(0, 8);
    writeFileSync(tmp, JSON.stringify({ bots }, null, 1));
    renameSync(tmp, botsFile);
  }

  // ------------------------------------------------ worker 停用（8801 实例设置里的 disabled）

  /** 老 `local_availability` 的 profile_disabled 分支（文案逐字）。 */
  const DISABLED_REASON = "已在控制台或配置中禁用此 worker。";
  function disabledAvailability(): { enabled: boolean; code: string; reason: string; refreshable: boolean } {
    return { enabled: false, code: "profile_disabled", reason: DISABLED_REASON, refreshable: false };
  }

  /** 老 `tool_hub_dispatch_cli`：`UNAVAILABLE: <code>: <reason>`。 */
  function disabledError(): Error {
    return new Error(`UNAVAILABLE: profile_disabled: ${DISABLED_REASON}`);
  }

  /** 现读 8801 的实例设置：停用只认那里的 disabled 字段，agents.json 不再是真源。 */
  async function agentDisabled(agent: string): Promise<boolean> {
    const instanceId = WORKERS[agent];
    if (!instanceId) return false;
    return (await instanceView()).states.get(instanceId)?.disabled === true;
  }

  interface InstanceModels { defaultModel: string | null; options: string[] }

  /** GET /api/instances 取该 instance 的 models.default / options（8801 不可达时返回 null）。 */
  async function instanceModels(instanceId: string): Promise<InstanceModels | null> {
    let fetched: { status: number; json: any };
    try { fetched = await om("/api/instances"); } catch { return null; }
    if (fetched.status < 200 || fetched.status >= 300) return null;
    const instances: any[] = Array.isArray(fetched.json?.instances) ? fetched.json.instances : [];
    const inst = instances.find((item) => String(item?.instanceId ?? "") === instanceId);
    if (!inst) return null;
    const rawDefault = inst?.models?.default;
    const defaultModel = typeof rawDefault === "string" && rawDefault.trim() ? rawDefault.trim() : null;
    const options = Array.isArray(inst?.models?.options)
      ? inst.models.options.map((m: any) => String(m?.id ?? "")).filter(Boolean) : [];
    return { defaultModel, options };
  }

  /**
   * 8801 的 POST /api/bots 要求 modelSelection.model 必填：
   * 显式缺省（DEFAULT_MODELS）优先，否则取该 instance 的 models.default，再退 options[0]。
   * 显式缺省也要在该 instance 的 options 里，否则拒绝（zcode 的 deepseek-v4.1-flash 同理）。
   */
  async function resolveBotModel(agent: string): Promise<string> {
    const info = await instanceModels(WORKERS[agent]);
    const explicit = qualifyDefaultModel(DEFAULT_MODELS[agent], info?.options ?? []);
    const model = explicit ?? info?.defaultModel ?? info?.options[0] ?? null;
    if (!model) {
      throw new Error(`${WORKERS[agent]} 引擎没有可用模型 (GET /api/instances 未给出 models.default/options)`);
    }
    if (explicit && info && info.options.length && !info.options.includes(explicit)) {
      throw new Error(`UNSUPPORTED: 模型 ${explicit} 不在 ${WORKERS[agent]} 引擎的可选模型中`);
    }
    return model;
  }

  /** 归档与删除是两件事：归档要人自己取消归档，Hub 不替他解；删除可以重建。 */
  function archivedError(agent: string): Error {
    return Object.assign(
      new Error(`UNAVAILABLE: worker_archived: ${agent} 常驻 bot (hub·${agent}) 已被归档，请在工作台取消归档后再派活。`),
      { code: "WORKER_ARCHIVED" });
  }

  /** 8801 当前的 bot 列表。 */
  async function liveBots(): Promise<any[]> {
    const existing = await om("/api/bots");
    return Array.isArray(existing.json) ? existing.json
      : Array.isArray(existing.json?.bots) ? existing.json.bots : [];
  }

  /**
   * 每个 worker 一个常驻 bot：名字 hub·<agent>，记在状态文件里。
   *
   * 登记过的 bot 每次都要验活：还在且没归档才用；已归档明确拒绝（不自动取消归档）；
   * 已删除就重建一个同名的。登记为空时不按名字去接管任何同名 bot——那个 bot 不归 Hub 管。
   */
  async function ensureBot(agent: string): Promise<BotEntry> {
    const bots = readBots();
    const registered = bots[agent]?.botId;
    if (registered) {
      const live = await liveBots();
      const bot = live.find((b) => String(b?.id ?? "") === registered);
      if (bot) {
        if (bot.hidden === true) throw archivedError(agent);
        const entry = { botId: registered, model: bot.modelSelection?.model ?? bots[agent]?.model };
        bots[agent] = entry; writeBots(bots);
        return entry;
      }
      // 登记的 bot 已被删除：重建，不去接管任何别的同名 bot。
      delete bots[agent]; writeBots(bots);
    }
    const model = await resolveBotModel(agent);
    const created = await om("/api/bots", { method: "POST", body: {
      name: `hub·${agent}`,
      modelSelection: { instanceId: WORKERS[agent], model },
    } });
    if (created.status !== 200 && created.status !== 201) {
      throw new Error(`${agent} 常驻 bot 创建失败 (HTTP ${created.status}): ${JSON.stringify(created.json)?.slice(0, 200)}`);
    }
    const bot = created.json?.bot ?? created.json;
    if (!bot?.id) throw new Error(`${agent} 常驻 bot 创建响应缺少 id`);
    const entry = { botId: String(bot.id), model: bot.modelSelection?.model ?? model };
    bots[agent] = entry; writeBots(bots);
    return entry;
  }

  async function patchBotModel(agent: string, entry: BotEntry, model: string): Promise<void> {
    if (!model || model === entry.model) return;
    const patched = await om(`/api/bots/${entry.botId}`, { method: "PATCH", body: {
      modelSelection: { instanceId: WORKERS[agent], model } } });
    if (patched.status !== 200) {
      throw new Error(`UNSUPPORTED: 模型 ${model} 未被 ${WORKERS[agent]} 引擎接受 (HTTP ${patched.status})`);
    }
    entry.model = model;
    const bots = readBots(); bots[agent] = entry; writeBots(bots);
  }

  interface Turn { threadId: string; sentAt: number; requestMessageId?: string; requestAtMs?: number }

  /** 派一次活：开新任务线程（cwd 缺省 $HOME）→ 发任务文本。 */
  async function startTurn(agent: string, entry: BotEntry, task: string, cwd?: unknown): Promise<Turn> {
    const workdir = expandDir(typeof cwd === "string" && cwd.trim() ? cwd : "$HOME");
    const opened = await om(`/api/bots/${entry.botId}/tasks`, { method: "POST", body: { cwd: workdir } });
    if (opened.status === 404) throw Object.assign(new Error("BOT_GONE"), { code: "BOT_GONE" });
    if (opened.status < 200 || opened.status >= 300) {
      throw new Error(`任务线程创建失败 (HTTP ${opened.status}): ${JSON.stringify(opened.json)?.slice(0, 200)}`);
    }
    const body = opened.json ?? {};
    const threadId = String(body.threadId ?? body.thread_id ?? body.thread?.id
      ?? body.task?.threadId ?? body.task?.id ?? body.id ?? "");
    if (!threadId) throw new Error("任务线程创建响应缺少 threadId");
    const sent = await om(`/api/bots/${entry.botId}/messages`, { method: "POST", body: { text: task, threadId } });
    if (sent.status < 200 || sent.status >= 300) {
      throw new Error(`任务消息发送失败 (HTTP ${sent.status}): ${JSON.stringify(sent.json)?.slice(0, 200)}`);
    }
    // 服务端回执里的那条 user 消息 id，就是这一回合的锚：之后只认它的回合，不认同线程的下一轮。
    const requestMessageId = String(sent.json?.message?.id ?? "") || undefined;
    const atMs = Number(sent.json?.message?.at ?? NaN);
    return { threadId, sentAt: now(), requestMessageId,
      requestAtMs: Number.isFinite(atMs) && atMs > 0 ? atMs : undefined };
  }

  /** E19：同一线程里再发一条「把汇报写完」，把同一回合的锚换成这条新请求。 */
  async function askForReport(entry: BotEntry, threadId: string): Promise<Turn | null> {
    const sent = await om(`/api/bots/${entry.botId}/messages`, { method: "POST", body: { text: REPORT_FOLLOWUP_TEXT, threadId } });
    if (sent.status < 200 || sent.status >= 300) return null;
    const requestMessageId = String(sent.json?.message?.id ?? "") || undefined;
    const atMs = Number(sent.json?.message?.at ?? NaN);
    return { threadId, sentAt: now(), requestMessageId,
      requestAtMs: Number.isFinite(atMs) && atMs > 0 ? atMs : undefined };
  }

  function expandDir(dir: string): string {
    const base = dir === "$HOME" || dir === "~" ? homedir()
      : dir.startsWith("~/") ? join(homedir(), dir.slice(2))
      : dir.replace(/^\$HOME/, homedir());
    return base;
  }

  interface ThreadView {
    reachable: boolean;
    /** E11：失败后 8801 自动重试（同线程续跑）的次数；重试开始后旧一轮的失败不再算数。 */
    retries: number;
    lastBotTextAt: number | null;
    lastBotText: string;
    lastActivityAt: number | null;
    lastMessageAt: number | null;
    lastToolName: string;
    errors: string[];
    /** 这一回合的明确信号：没有它们就不算成功。 */
    cancelled: boolean;
    succeeded: boolean;
    failed: boolean;
    terminal: boolean;
    /** 回合有终态证据：8801 回合结束时给最后一条助手文本打 turnTerminal，并写 turnSucceeded。 */
    settled: boolean;
    pending: boolean;
    toolCount: number;
    /** worker 真正产出的最后时刻（秒）：Hub 自己的心跳不算。 */
    lastProgressAt: number | null;
    turnId: string | null;
    /** 回合锚点是否找到：找不到就只能按时间窗看，绝不跨回合。 */
    bound: boolean;
  }

  /** 这一回合的锚：8801 用 requestMessageId / turnId 标出每条消息属于哪一轮。 */
  interface TurnBinding {
    requestMessageId?: string;
    requestAtMs?: number;
    taskText?: string;
  }

  /**
   * 只挑属于本次派发的那一轮消息。
   *
   * 主锚是 8801 回执里的那条 user 消息 id：之后带这个 requestMessageId 的消息、以及同一
   * turnId 的消息，都属于本轮。锚没被消息带出来时（本轮只有 activity 行），退到
   * 「本条请求与下一条请求之间」的时间窗。窗口之后的消息属于下一轮，不算本次结果。
   */
  function selectTurnMessages(messages: any[], binding: TurnBinding):
    { mine: any[]; requestMessageId?: string; turnId: string | null; bound: boolean } {
    const ordered = [...messages].sort((a, b) => Number(a?.at ?? 0) - Number(b?.at ?? 0));
    let request = binding.requestMessageId
      ? ordered.find((m) => String(m?.id ?? "") === binding.requestMessageId) ?? null
      : null;
    if (!request) {
      const anchorMs = Number(binding.requestAtMs ?? 0);
      const users = ordered.filter((m) => m?.role === "user" && m?.kind === "text");
      request = users.find((m) => {
        const at = Number(m?.at ?? 0);
        if (anchorMs > 0) return at >= anchorMs - 2000;
        if (binding.taskText) return m?.text === binding.taskText;
        return false;
      }) ?? null;
    }
    const requestId = request?.id
      ? String(request.id)
      : (binding.requestMessageId ? String(binding.requestMessageId) : "");
    if (!requestId) return { mine: ordered, requestMessageId: undefined, turnId: null, bound: false };
    const requestAt = request ? Number(request.at ?? 0) : (binding.requestAtMs ? Number(binding.requestAtMs) : 0);
    // E11：8801 失败后自动续跑同一请求（「[From OpenMausBot · retry …」那条 user 消息），续跑属于本轮，
    // 不是下一条请求；它带出来的消息挂在这条重试消息的 id 上。
    const retryIds = new Set<string>();
    const nextRequestAt = ordered.find((m) => {
      if (!(m?.role === "user" && m?.kind === "text" && Number(m?.at ?? 0) > requestAt && String(m?.id ?? "") !== requestId)) return false;
      if (isRetryNotice(m)) { if (m?.id) retryIds.add(String(m.id)); return false; }
      return true;
    })?.at ?? Number.POSITIVE_INFINITY;
    for (const m of ordered) {
      if (isRetryNotice(m) && Number(m?.at ?? 0) > requestAt && Number(m?.at ?? 0) < nextRequestAt && m?.id) retryIds.add(String(m.id));
    }
    const turnIds = new Set<string>();
    for (const m of ordered) {
      const ownReq = String(m?.requestMessageId ?? "");
      if ((ownReq === requestId || retryIds.has(ownReq)) && typeof m?.turnId === "string" && m.turnId) {
        turnIds.add(m.turnId);
      }
    }
    const mine = ordered.filter((m) => {
      // 带了别的 requestMessageId 的行属于别的回合：不进本轮，也不靠时间窗兜底。
      const own = String(m?.requestMessageId ?? "");
      if (own && own !== requestId && !retryIds.has(own)) return false;
      if (own === requestId || retryIds.has(own)) return true;
      if (retryIds.has(String(m?.id ?? ""))) return true;
      // 本次的请求行本身也要看：8801 把 requestCancelled / requestPending 标在这行上。
      if (String(m?.id ?? "") === requestId) return true;
      const turnId = typeof m?.turnId === "string" ? m.turnId : "";
      if (turnId && turnIds.has(turnId)) return true;
      const at = Number(m?.at ?? 0);
      return at >= requestAt && at < nextRequestAt && m?.role !== "user";
    });
    return { mine, requestMessageId: requestId, turnId: [...turnIds][0] ?? null, bound: true };
  }

  async function readThread(threadId: string, afterEpoch: number, binding?: TurnBinding): Promise<ThreadView> {
    const view: ThreadView = {
      reachable: false,
      lastBotTextAt: null,
      lastBotText: "",
      lastActivityAt: null,
      lastMessageAt: null,
      lastToolName: "",
      retries: 0,
      errors: [],
      cancelled: false,
      succeeded: false,
      failed: false,
      terminal: false,
      pending: false,
      toolCount: 0,
      lastProgressAt: null,
      turnId: null,
      bound: false,
    };
    let fetched: { status: number; json: any };
    try { fetched = await om(`/api/threads/${threadId}/messages?limit=200`); }
    catch { return view; }
    if (fetched.status === 404) return view;
    if (fetched.status < 200 || fetched.status >= 300) return view;
    const messages: any[] = Array.isArray(fetched.json?.messages) ? fetched.json.messages
      : Array.isArray(fetched.json) ? fetched.json : [];
    view.reachable = true;
    const selected = selectTurnMessages(messages, binding ?? {});
    view.bound = selected.bound;
    view.turnId = selected.turnId;
    let lastTextSucceeded = false;
    for (const m of selected.mine) {
      const at = Number(m?.at ?? 0) / 1000;
      // 锚点已经把范围定在本轮；有锚就不再靠墙钟筛，免得时钟偏差把本轮消息筛掉。
      if (!selected.bound && !(at > afterEpoch)) continue;
      if (isRetryNotice(m)) {
        // E11：自动重试开始，上一段的失败/终态/工具错误作废，以续跑的结果为准。
        view.retries += 1;
        view.failed = false; view.succeeded = false; view.terminal = false; view.settled = false;
        view.errors = [];
        lastTextSucceeded = false;
        continue;
      }
      // 本轮请求行（用户发的那条）只用来读取消/排队标记，不算 worker 输出。
      if (m?.role !== "user" && (view.lastMessageAt === null || at >= view.lastMessageAt)) {
        view.lastMessageAt = at;
      }
      if (m?.turnSucceeded === true) { view.succeeded = true; view.failed = false; view.settled = true; }
      if (m?.turnSucceeded === false) { view.failed = true; view.settled = true; }
      if (m?.turnTerminal === true) { view.terminal = true; view.settled = true; }
      if (m?.requestCancelled === true) view.cancelled = true;
      if (m?.requestPending === true) view.pending = true;
      if (m?.role === "bot" && m?.kind === "text" && typeof m?.text === "string" && m.text.trim()) {
        if (view.lastBotTextAt === null || at >= view.lastBotTextAt) {
          view.lastBotTextAt = at;
          view.lastBotText = m.text;
          lastTextSucceeded = m?.turnSucceeded === true;
        }
      }
      if (m?.role === "bot" && m?.kind === "digest") {
        const reply = typeof m?.digest?.reply === "string" && m.digest.reply.trim()
          ? m.digest.reply.trim()
          : (typeof m?.text === "string" ? (/(?:^|\s)· reply:\s*(.*)$/.exec(m.text)?.[1]?.trim() ?? "") : "");
        if (reply && (view.lastBotTextAt === null || at >= view.lastBotTextAt)) {
          view.lastBotTextAt = at;
          view.lastBotText = reply;
          lastTextSucceeded = m?.turnSucceeded === true;
        }
        if (m?.turnSucceeded === true) {
          view.succeeded = true;
          view.terminal = true;
          view.settled = true;
          lastTextSucceeded = true;
        } else if (m?.turnSucceeded === false) {
          view.failed = true;
          view.settled = true;
        }
      }
      if (m?.kind === "activity") {
        view.toolCount += 1;
        if (view.lastActivityAt === null || at >= view.lastActivityAt) {
          view.lastActivityAt = at;
        }
        const tool = m?.tool;
        const toolName = typeof tool?.name === "string" ? tool.name : "";
        if (toolName) view.lastToolName = toolName;
        const mText = typeof m?.text === "string" ? m.text : "";
        // 取消优先于 ok:true：8801 把「用户停了这一轮」记成 stopped，工具本身仍是 ok。
        // E40：只认 8801 自己的停止标记（请求行 requestCancelled、活动行以 stopped:/已取消/已停止 开头），
        // 不扫工具输出正文——MCP 工具返回「secret: the person cancelled」「approval cancelled」之类是正常结果，
        // 曾被误判成整轮取消（codebuddy-cn-0a1eabb7bf，Pinky 授权超时）。
        const stopped = m?.requestCancelled === true
          || /^\s*(?:stopped:|已取消|已停止)/i.test(toolName)
          || /^\s*(?:stopped:|已取消|已停止)/i.test(mText);
        if (stopped) view.cancelled = true;
        const isError = tool?.ok === false
          || toolName.startsWith("error:")
          || (tool?.ok !== true && /^(?:error:|failed:|fail:|错误|失败)/i.test(toolName))
          || /^(?:error:|failed:|fail:|错误|失败)/i.test(mText)
          || /error|失败|错误|interrupted|中断/i.test(mText);
        if (isError && !stopped) view.errors.push(toolName || mText || "activity error");
      }
      if (m?.role === "bot" && (m?.kind === "text" || m?.kind === "activity" || m?.kind === "digest")) {
        if (view.lastProgressAt === null || at >= view.lastProgressAt) view.lastProgressAt = at;
      }
    }
    // 只有最后一条 bot 文本自己的成功标记才算成功：中间的过程叙述不算交付。
    view.succeeded = view.terminal || (view.succeeded && lastTextSucceeded);
    return view;
  }

  interface TurnStatus {
    running: boolean;
    state?: string;
    activity?: string;
    reason?: string;
    error?: string;
  }

  /**
   * 查询 8801 回合权威信号：
   * 1. 优先查 /api/threads/:threadId/job (conversation.busy / state)
   * 2. 备选查 /api/bots?messages=0 里对应的 task.busy / task.activity
   *
   * since 必须是 8801 服务端的毫秒时间（用回执里那条 user 消息的 at），不能拿 Hub 的秒时间充数：
   * 8801 的 job 视图是「此刻起」的语义，since 不对就只看得到别人的回合。
   */
  async function checkTurnStatus(threadId: string, botId?: string, sinceMs?: number): Promise<TurnStatus> {
    try {
      const query = sinceMs && sinceMs > 0 ? `?since=${Math.round(sinceMs)}` : "";
      const res = await om(`/api/threads/${threadId}/job${query}`);
      if (res.status === 200 && res.json && typeof res.json === "object") {
        const json = res.json;
        const busy = Boolean(json.conversation?.busy);
        const state = String(json.state ?? "");
        const activity = String(json.conversation?.activity ?? "");
        const reason = String(json.reason ?? "");
        const running = busy || state === "running";
        let error: string | undefined;
        if (!running) {
          if (state === "failed" || state === "stalled" || activity === "dead" || activity === "no-signal") {
            error = reason || activity || state;
          }
        }
        return { running, state, activity, reason, error };
      }
    } catch { /* om 错误时不抛出 */ }

    try {
      const botsRes = await om("/api/bots?messages=0");
      if (botsRes.status === 200 && botsRes.json) {
        const list: any[] = Array.isArray(botsRes.json) ? botsRes.json
          : Array.isArray(botsRes.json?.bots) ? botsRes.json.bots : [];
        for (const b of list) {
          if (botId && b.id !== botId) continue;
          const tasks: any[] = Array.isArray(b?.tasks) ? b.tasks : [];
          const t = tasks.find((item) => String(item?.threadId ?? "") === threadId);
          if (t) {
            const busy = t.busy === true || t.activity === "working" || t.activity === "parked.computer";
            const activity = String(t.activity ?? "");
            let error: string | undefined;
            if (!busy && (activity === "dead" || activity === "no-signal")) {
              error = activity;
            }
            return { running: busy, activity, error };
          }
        }
      }
    } catch { /* ignore */ }

    return { running: false };
  }

  type Settlement =
    | { kind: "running" }
    | { kind: "completed"; text: string }
    | { kind: "error"; code: string; message: string };

  /**
   * 一次派发的唯一结算口径，优先级：取消 > 失败 > 明确成功。
   *
   * idle、查询失败、线程暂不可见都不是成功：没有明确终态就继续等，等到静默窗口或硬上限
   * 再按超时结算。明确成功还得有交付物——终态却什么都没有，就是空转，按失败记。
   */
  function settleTurn(view: ThreadView, turnStatus: TurnStatus, fallbackText?: string): Settlement {
    if (view.cancelled) {
      return { kind: "error", code: "WORKER_CANCELLED", message: "任务被取消" };
    }
    if (view.failed) {
      return { kind: "error", code: "WORKER_FAILED", message: view.errors[0] ?? "回合以失败结束" };
    }
    if (turnStatus.error) {
      return { kind: "error", code: "WORKER_FAILED", message: turnStatus.error };
    }
    // E14：单个工具调用失败（grep 无匹配 exit 1、测试红了再修）是回合里的正常过程，不是回合失败；
    // 回合还在跑就继续等，回合成功收尾就算成功，只有回合结束且没成功时才拿工具错误当失败原因。
    if (turnStatus.running) return { kind: "running" };
    const text = view.lastBotText || fallbackText || "";
    if (view.succeeded) {
      if (text) return { kind: "completed", text };
      if (view.toolCount > 0) return { kind: "completed", text: "" };
      return { kind: "error", code: "WORKER_EMPTY_RESULT", message: "回合结束但没有任何交付内容" };
    }
    if (view.errors.length) {
      return { kind: "error", code: "WORKER_FAILED", message: view.errors.join("; ") };
    }
    return { kind: "running" };
  }

  // ---------------------------------------------------------------- 事件流（accepted/started/progress）

  const startedRuns = new Set<string>();
  const progressSeen = new Map<string, { text: string; at: number; heartbeatAt: number }>();

  function markStarted(ref: string, agent: string, model?: string): void {
    if (startedRuns.has(ref)) return;
    startedRuns.add(ref);
    events.emit(ref, agent, "started", model ? `已开始执行 (${model})` : "已开始执行");
  }

  /** One progress line per ~2s at most: new bot text, else a tool name, else a 30s heartbeat. */
  function reportProgress(ref: string, agent: string, view: ThreadView): void {
    const nowSec = now();
    const seen = progressSeen.get(ref) ?? { text: "", at: 0, heartbeatAt: 0 };
    const text = view.lastBotText ? redactEventText(view.lastBotText) : "";
    const candidate = view.lastToolName
      ? `工具调用: ${view.lastToolName}${text ? ` · ${text}` : ""}`.slice(0, 200)
      : text.slice(0, 200);
    if (candidate && candidate !== seen.text && nowSec - seen.at >= 2) {
      events.emit(ref, agent, "progress", candidate);
      void origin.progress(ref, agent, candidate);
      progressSeen.set(ref, { text: candidate, at: nowSec, heartbeatAt: nowSec });
      return;
    }
    if (nowSec - seen.heartbeatAt >= 30) {
      const startedAt = Number(readResult(ref)?.started_at ?? nowSec);
      const heartbeat = `仍在执行 (${Math.max(1, Math.round(nowSec - startedAt))}s)`;
      events.emit(ref, agent, "progress", heartbeat);
      void origin.progress(ref, agent, heartbeat);
      progressSeen.set(ref, { ...seen, heartbeatAt: nowSec });
    }
  }

  // ---------------------------------------------------------------- 派活后台执行（轮询线程取回复）

  async function runTurn(ref: string, agent: string, task: string, model: string | undefined, cwd: unknown,
    gateway: "om" | "trae", budgetS: number, prepared?: BotEntry): Promise<void> {
    try {
      if (gateway === "trae") {
        await runTraeGatewayTurn(ref, budgetS);
        return;
      }
      let entry: BotEntry | undefined = prepared;
      const existing = readResult(ref);
      if (!entry) {
        if (existing?.bot_id) {
          entry = { botId: existing.bot_id, model: existing.model };
        } else {
          try {
            entry = await ensureBot(agent);
            if (model) await patchBotModel(agent, entry, model);
          } catch (error) {
            updateResult(ref, { status: "error", worker_status: "error", error_code: "WORKER_START_FAILED",
              failure_stage: "worker_execution", text: errorMessage(error), exit_code: 1 });
            return;
          }
        }
      }
      let turn: Turn;
      const binding: TurnBinding = {};
      if (existing?.thread_id) {
        turn = {
          threadId: existing.thread_id,
          sentAt: Number(existing.dispatch_message_at ?? existing.started_at ?? now()),
          requestMessageId: existing.request_message_id,
          requestAtMs: existing.request_message_at_ms,
        };
        binding.requestMessageId = existing.request_message_id;
        binding.requestAtMs = existing.request_message_at_ms;
        binding.taskText = String(existing.task ?? task);
      } else {
        try {
          turn = await startTurn(agent, entry, task, cwd);
        } catch (error) {
          if ((error as { code?: string })?.code === "BOT_GONE") {
            // 常驻 bot 被外部删除：重建一次再派。
            const bots = readBots(); delete bots[agent]; writeBots(bots);
            try {
              entry = await ensureBot(agent);
              if (model) await patchBotModel(agent, entry, model);
              turn = await startTurn(agent, entry, task, cwd);
            } catch (retryError) {
              updateResult(ref, { status: "error", worker_status: "error", error_code: "WORKER_START_FAILED",
                failure_stage: "worker_execution", text: errorMessage(retryError), exit_code: 1 });
              return;
            }
          } else {
            updateResult(ref, { status: "error", worker_status: "error", error_code: "WORKER_START_FAILED",
              failure_stage: "worker_execution", text: errorMessage(error), exit_code: 1 });
            return;
          }
        }
        binding.requestMessageId = turn.requestMessageId;
        binding.requestAtMs = turn.requestAtMs;
        binding.taskText = task;
        updateResult(ref, { thread_id: turn.threadId, bot_id: entry.botId, dispatch_message_at: turn.sentAt,
          request_message_id: turn.requestMessageId, request_message_at_ms: turn.requestAtMs, heartbeat: now() });
      }
      markStarted(ref, agent, model);

      const budget = readResult(ref);
      const idleS = Number(budget?.idle_timeout_s ?? budgetS) || budgetS;
      const hardS = Number(budget?.hard_timeout_s ?? DEFAULT_HARD_TIMEOUT_S) || DEFAULT_HARD_TIMEOUT_S;
      const startedAt = Number(budget?.started_at ?? now());
      let lastText = "";
      let failedSince: number | null = null;
      for (;;) {
        await sleep(POLL_INTERVAL_MS);
        const record = readResult(ref);
        if (!record || record.status !== "running") return;
        // 硬上限：worker 一直有进展也不能越过它。
        if (now() - startedAt >= hardS) {
          updateResult(ref, { status: "timeout", progress: null,
            text: `任务超时: 已达硬上限 ${hardS}s`, ...(lastText ? { partial_text: lastText } : {}) });
          return;
        }
        // 静默窗口：只认 worker 的真实进展（新的 bot 文本/工具/digest），Hub 自己的心跳不续期。
        const progressedAt = Number(record.last_worker_progress_at ?? record.started_at ?? now());
        if (now() - progressedAt >= idleS) {
          updateResult(ref, { status: "timeout", progress: null,
            text: `任务超时: 已 ${Math.round((now() - progressedAt) / 60)} 分钟没有任何进展`,
            ...(lastText ? { partial_text: lastText } : {}) });
          return;
        }
        const after = Math.max(Number(record.dispatch_message_at ?? turn.sentAt), 0);
        const [view, turnStatus] = await Promise.all([
          readThread(turn.threadId, after, binding),
          checkTurnStatus(turn.threadId, entry.botId, turn.requestAtMs),
        ]);
        const patch: Partial<ResultRecord> = { heartbeat: now() };
        const latestTime = view.lastMessageAt ?? view.lastBotTextAt ?? view.lastActivityAt;
        if (latestTime !== null) {
          patch.last_output_at = latestTime;
        }
        if (view.lastProgressAt !== null) {
          patch.last_worker_progress_at = Math.max(Number(record.last_worker_progress_at ?? 0), view.lastProgressAt);
        }
        if (view.turnId) patch.turn_id = view.turnId;
        if (view.lastBotText) {
          patch.progress = view.lastBotText.slice(0, 600);
          patch.progress_at = view.lastBotTextAt ?? now();
          patch.partial_text = view.lastBotText;
          patch.output_bytes = Buffer.byteLength(view.lastBotText, "utf8");
          lastText = view.lastBotText;
        }
        if (!view.reachable && record.thread_id) {
          // 线程暂时取不到：保留 running，verdict 走 worker_exited_result_missing，不误判终态。
          updateResult(ref, { ...patch, thread_missing: true });
          continue;
        }
        updateResult(ref, { ...patch, thread_missing: false });
        reportProgress(ref, agent, view);

        // 唯一结算口径：取消 > 失败 > 明确成功；idle/查询失败都不算成功。
        const settled = settleTurn(view, turnStatus, lastText || record.partial_text);
        if (settled.kind === "running") { failedSince = null; continue; }
        if (!readResult(ref) || readResult(ref)!.status !== "running") return;
        // E11/E6/E10：失败（取消除外）先观察一段，8801 自动续跑了就跟着续跑的结果走。
        if (settled.kind === "error" && settled.code === "WORKER_FAILED") {
          failedSince ??= now();
          if (now() - failedSince < retryGraceS) continue;
        }
        if (settled.kind === "error") {
          updateResult(ref, {
            status: "error", worker_status: "error", error_code: settled.code,
            failure_stage: "worker_execution", text: `任务失败: ${settled.message}`, exit_code: 1,
            progress: null, ...(lastText ? { partial_text: lastText } : {}),
          });
          return;
        }
        // E19：回合结束但最后一句只是进度（长命令被转后台），标 needs_followup 并追问一次，把汇报补上。
        const beforeFollowup = readResult(ref);
        if (!beforeFollowup?.followup_sent && endedWithoutReport(settled.text)) {
          updateResult(ref, { needs_followup: true });
          const asked = await askForReport(entry, turn.threadId);
          if (asked) {
            binding.requestMessageId = asked.requestMessageId;
            binding.requestAtMs = asked.requestAtMs;
            updateResult(ref, {
              followup_sent: true, followup_at: now(),
              request_message_id: asked.requestMessageId, request_message_at_ms: asked.requestAtMs,
              dispatch_message_at: asked.sentAt, last_worker_progress_at: now(),
            });
            events.emit(ref, agent, "progress", "自动追问: 把汇报写完");
            failedSince = null;
            continue;
          }
        }
        updateResult(ref, {
          status: "completed", worker_status: "completed", text: settled.text,
          exit_code: 0, last_output_at: view.lastBotTextAt ?? latestTime ?? now(),
          output_bytes: Buffer.byteLength(settled.text, "utf8"), progress: null,
        });
        return;
      }
    } catch (error) {
      try {
        updateResult(ref, { status: "error", worker_status: "error", error_code: "WORKER_FAILED",
          failure_stage: "worker_execution", text: errorMessage(error), exit_code: 1 });
      } catch { /* 结果文件坏时不掩盖原错误 */ }
    }
  }

  /** trae 同步/异步共用：直接调 TraeClaw 网关 /v1/chat（老 async_worker.trae_run 的通道）。 */
  async function traeGatewayChat(task: string, sessionId: string, newChat: boolean, timeoutS: number):
    Promise<{ text: string; sessionId: string; status: string }> {
    const payload: Record<string, unknown> = { content: task, sessionMetadata: { client: "async" } };
    if (sessionId) payload.sessionId = sessionId;
    if (newChat) payload.newChat = true;
    let data: any;
    try {
      const resp = await fetch(traeGateway() + "/v1/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutS * 1000))),
      });
      data = await resp.json();
    } catch (error) {
      throw new Error(`无法连接 Trae 网关 (${traeGateway()}/v1/chat): ${errorMessage(error)}。请确认 TraeCode 桌面端及网关已就绪，或检查 TRAE_GATEWAY 配置。`);
    }
    if (!data || typeof data !== "object") throw new Error("Trae 网关返回了无效响应");
    if (data.error || data.success === false) throw new Error(String(data.error || "Trae 网关执行失败").slice(0, 300));
    const body = data.data ?? {};
    const session = body.session ?? {};
    const result = body.result ?? {};
    if (typeof body !== "object" || typeof session !== "object" || typeof result !== "object") {
      throw new Error("Trae 网关返回了无效结果格式");
    }
    const statuses = [session.status, result.status].filter((s) => s !== null && s !== undefined)
      .map((s) => String(s).trim().toLowerCase());
    if (statuses.includes("timeout")) {
      return { text: "Trae 网关任务超时", sessionId: String(session.sessionId || sessionId || ""), status: "timeout" };
    }
    if (statuses.some((s) => s === "error" || s === "failed")) {
      throw new Error("Trae 网关任务失败: " + String(result.error || session.status || result.status).slice(0, 300));
    }
    const text = typeof result.text === "string" ? result.text : "";
    if ((statuses.length && statuses.some((s) => !["completed", "done", "finished", "ok", "success"].includes(s)))
      || (!statuses.length && !text.trim())) {
      throw new Error("Trae 网关状态不确定，继续查询原任务；请勿重新派发: " + (statuses.join(",") || "missing"));
    }
    return { text, sessionId: String(session.sessionId || sessionId || ""), status: "completed" };
  }

  async function runTraeGatewayTurn(ref: string, budgetS: number): Promise<void> {
    const record = readResult(ref);
    if (!record) return;
    markStarted(ref, "traecode");
    const deadline = now() + budgetS;
    while (now() < deadline) {
      try {
        const outcome = await traeGatewayChat(String(record.task ?? ""), String(record.session_id ?? ""),
          record.new_chat === true, Math.max(1, deadline - now()));
        if (!readResult(ref) || readResult(ref)!.status !== "running") return;
        updateResult(ref, { status: outcome.status === "timeout" ? "timeout" : "completed",
          text: outcome.text, session_id: outcome.sessionId, exit_code: 0, last_output_at: now(),
          output_bytes: Buffer.byteLength(outcome.text, "utf8"), progress: null });
        return;
      } catch (error) {
        const messageText = errorMessage(error);
        if (!readResult(ref) || readResult(ref)!.status !== "running") return;
        if (/状态不确定/.test(messageText)) { await sleep(3000); continue; }
        updateResult(ref, { status: /超时/.test(messageText) ? "timeout" : "error", text: messageText,
          exit_code: /超时/.test(messageText) ? undefined : 1, progress: null });
        return;
      }
    }
    updateResult(ref, { status: "timeout", text: `trae 任务超时 (>${Math.round(budgetS)}s)`, progress: null });
  }

  function launchRun(ref: string, agent: string, task: string, model: string | undefined, cwd: unknown,
    gateway: "om" | "trae", budgetS: number, prepared?: BotEntry): void {
    const run = runTurn(ref, agent, task, model, cwd, gateway, budgetS, prepared)
      .catch(() => {}).finally(() => { activeRuns.delete(ref); });
    activeRuns.set(ref, run);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------- 存活判定（verdict 按任务书四值）

  const activeOutputSeconds = (): number => {
    const raw = Number(process.env.AGENTHUB_LIVENESS_ACTIVE_OUTPUT_S);
    return Number.isFinite(raw) && raw >= 5 && raw <= 600 ? raw : 60;
  };

  function taskLiveness(d: ResultRecord): Record<string, unknown> {
    const current = now();
    const ref = String(d.ref || "");
    const status = String(d.status || "unknown");
    const terminal = TERMINAL_STATUSES.includes(status);
    const ageOf = (value: unknown): number | null => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? Math.max(0, Math.round((current - n) * 10) / 10) : null;
    };
    const outputBytes = Number(d.output_bytes ?? 0) || 0;
    const outputAge = ageOf(d.last_output_at);
    const heartbeatAge = ageOf(d.heartbeat);
    const progressAge = ageOf(d.progress_at);
    const startedAge = ageOf(d.started_at);
    const recordAge = ageOf(d.updated_at);
    const progressPresent = Boolean(d.progress);

    let verdict = status;
    let action = "none";
    let guidance = "";
    if (terminal) {
      if (status === "completed") { action = "done"; guidance = "任务已完成，直接读取结果。"; }
      else if (status === "timeout") { action = "inspect_timeout"; guidance = "任务已按超时预算回收；先读 partial_text，确认是否续跑，不要盲目重派。"; }
      else { action = "handle_error"; guidance = "任务以错误结束；按 error 文本处理。"; }
    } else if (status !== "running") {
      action = "inspect"; guidance = "任务不是 running 状态，先核对 ref 与结果文件。";
    } else {
      // OM/GUI 通道没有 CLI PID：按线程消息与心跳判定。
      const threadGone = d.thread_id && d.thread_missing === true;
      if (threadGone) {
        verdict = "worker_exited_result_missing";
        action = "inspect_delivery";
        guidance = "worker 已退出但结果仍是 running：先查 async_worker 日志和结果目录，不要重新派发。";
      } else if (progressPresent && progressAge !== null && progressAge <= 120) {
        verdict = "working";
        action = "wait";
        guidance = "线程仍在产生新消息，继续等待；不要按墙钟截断。";
      } else if (outputAge !== null && outputAge <= activeOutputSeconds()) {
        verdict = "working";
        action = "wait";
        guidance = "线程仍在产生新消息，继续等待；不要按墙钟截断。";
      } else if (heartbeatAge !== null && heartbeatAge <= 120) {
        verdict = "alive_waiting";
        action = "wait";
        guidance = "进程仍存活，但最近没有输出/CPU 增量（模型思考、排队或等待上游；活跃窗口 "
          + `${Math.round(activeOutputSeconds())}s）。`;
      } else if (startedAge !== null && startedAge <= 120) {
        verdict = "starting";
        action = "wait";
        guidance = "任务刚开始，尚无存活样本；10 秒后再查一次。";
      } else {
        verdict = "worker_exited_result_missing";
        action = "inspect_delivery";
        guidance = "没有进程、心跳或进度证据；先查 GUI 网关与结果回传，不能直接判 worker 失败。";
      }
    }
    return {
      ref, agent: d.agent, status, verdict, action, guidance,
      preserve_ref: !terminal,
      pid: null, process_alive: null, process_count: null,
      liveness_source: d.liveness_source || "gui",
      cpu_seconds: null, cpu_delta_seconds: null,
      output_bytes: outputBytes, output_delta_bytes: null,
      last_output_age_s: outputAge, heartbeat_age_s: heartbeatAge,
      progress_age_s: progressAge, record_age_s: recordAge,
      elapsed_s: startedAge, sample_window_s: null,
    };
  }

  /** 老 _format_task_status 逐字结构（本通道 process 走 n/a (gui) 分支）。 */
  function formatTaskStatus(live: Record<string, any>): string {
    let line = `[${live.ref}] agent=${live.agent} status=${live.status}`;
    line += `\nverdict=${live.verdict} action=${live.action}`;
    let process: string;
    if (TERMINAL_STATUSES.includes(live.status)) process = "process=finished";
    else if (live.process_alive === null || live.process_alive === undefined) {
      process = `process=n/a (${live.liveness_source || "gui"})`;
    } else {
      process = `process=alive(${live.process_alive}) pid=${live.pid} tree=${live.process_count}`;
    }
    if (live.cpu_seconds !== null && live.cpu_seconds !== undefined) {
      process += ` cpu=${live.cpu_seconds}s`;
      if (live.cpu_delta_seconds !== null && live.cpu_delta_seconds !== undefined) {
        process += ` (+${live.cpu_delta_seconds}s)`;
      }
    }
    line += `\n${process}`;
    line += `\noutput=${live.output_bytes ?? 0}B`;
    if (live.output_delta_bytes !== null && live.output_delta_bytes !== undefined) {
      line += ` (+${live.output_delta_bytes}B)`;
    }
    if (live.last_output_age_s !== null && live.last_output_age_s !== undefined) {
      line += ` last_output=${live.last_output_age_s}s ago`;
    }
    const signals: string[] = [];
    for (const [key, label] of [["heartbeat_age_s", "heartbeat"], ["progress_age_s", "progress"], ["record_age_s", "record"]] as const) {
      if (live[key] !== null && live[key] !== undefined) signals.push(`${label}=${live[key]}s ago`);
    }
    if (live.elapsed_s !== null && live.elapsed_s !== undefined) signals.push(`elapsed=${live.elapsed_s}s`);
    if (signals.length) line += "\n" + signals.join(" ");
    line += `\nguidance: ${live.guidance || "—"}`;
    return line;
  }

  /** 老 _format_result 逐字结构。 */
  function formatResult(d: ResultRecord): string {
    const ref = d.ref ?? "?";
    let out = `[${ref}] agent=${d.agent} status=${d.status}`;
    if (d.worker_status && d.worker_status !== d.status) out += " worker_status=" + d.worker_status;
    if (d.error_code) out += " error_code=" + d.error_code;
    if (d.failure_stage) out += " failure_stage=" + d.failure_stage;
    if (d.dispatch_count !== null && d.dispatch_count !== undefined) out += " dispatch_count=" + d.dispatch_count;
    if (d.audit_degraded) out += " audit_degraded=true";
    if (d.status === "running" && d.progress) out += `\n[执行中·受控端界面快照] ${String(d.progress).slice(0, 600)}`;
    out += `\n${truncate(String(d.text ?? "")) || "(尚无文本)"}`;
    if (d.status === "timeout" && d.partial_text) {
      out += `\n[超时前最后输出·仅供续跑] ${truncate(String(d.partial_text))}`;
    }
    if (d.session_id) out += `\n(继续对话 session_id: ${d.session_id})`;
    if (d.exit_code !== null && d.exit_code !== undefined) out += `\n(exit=${d.exit_code})`;
    return out;
  }

  /**
   * 重启恢复 + 读取前刷新：
   * 1. 若挂着 thread_id 且回合仍在运行（即使之前被错标为 completed），纠正回 running；
   * 2. 若挂着 thread_id 且回合已结束，补齐或纠正最终结果（取最后一条 bot text）；
   * 3. 若处于超时判定窗口，执行 reapResult。
   */
  async function reaped(ref: string): Promise<ResultRecord | null> {
    let d = readResult(ref);
    if (!d) return null;

    if (d.thread_id) {
      const turnStatus = await checkTurnStatus(d.thread_id, d.bot_id, d.request_message_at_ms);
      const after = Math.max(Number(d.dispatch_message_at ?? d.started_at ?? 0), 0);
      const binding: TurnBinding = {
        requestMessageId: d.request_message_id,
        requestAtMs: d.request_message_at_ms,
        taskText: String(d.task ?? ""),
      };

      if (turnStatus.running) {
        // 回合仍在进行中：如果已被错标为 completed，必须纠正回 running！
        let view: ThreadView;
        try { view = await readThread(d.thread_id, after, binding); }
        catch { view = { reachable: false, lastBotTextAt: null, lastBotText: "", lastActivityAt: null, lastMessageAt: null, lastToolName: "", retries: 0, errors: [], cancelled: false, succeeded: false, failed: false, terminal: false, pending: false, toolCount: 0, lastProgressAt: null, turnId: null, bound: false }; }

        const latestTime = view.lastMessageAt ?? view.lastBotTextAt ?? view.lastActivityAt;
        const patch: Partial<ResultRecord> = {
          status: "running",
          worker_status: "running",
          exit_code: undefined,
          heartbeat: now(),
          thread_missing: !view.reachable,
        };
        if (latestTime !== null) {
          patch.last_output_at = latestTime;
        }
        if (view.lastProgressAt !== null) {
          patch.last_worker_progress_at = Math.max(Number(d.last_worker_progress_at ?? 0), view.lastProgressAt);
        }
        if (view.lastBotText) {
          patch.progress = view.lastBotText.slice(0, 600);
          patch.progress_at = view.lastBotTextAt ?? now();
          patch.partial_text = view.lastBotText;
          patch.output_bytes = Buffer.byteLength(view.lastBotText, "utf8");
        }
        d = updateResult(d.ref, patch);

        // 如果后台轮询已不在跑，拉起后台轮询继续盯该线程
        if (!activeRuns.has(d.ref)) {
          // 恢复观察器沿用记录里的预算：静默窗口与硬上限都不从头再给一遍。
          const idleS = Number(d.idle_timeout_s ?? DEFAULT_TASK_TIMEOUT_S) || DEFAULT_TASK_TIMEOUT_S;
          launchRun(d.ref, d.agent, String(d.task ?? ""), d.model, d.cwd, "om", idleS);
        }
        return reapResult(d);
      } else {
        // 回合已不在运行：
        let view: ThreadView | null = null;
        if (d.status === "running" && !activeRuns.has(d.ref)) {
          try { view = await readThread(d.thread_id, after, binding); } catch { return reapResult(d); }
          if (!view.reachable) {
            updateResult(d.ref, { thread_missing: true, heartbeat: now() });
            return reapResult(readResult(d.ref));
          }
          // 结算口径与后台轮询一致：idle/查不到不算成功，没明确终态就继续等。
          const settled = settleTurn(view, turnStatus, d.partial_text);
          if (settled.kind === "running") {
            updateResult(d.ref, { heartbeat: now() });
            return reapResult(readResult(d.ref));
          }
          if (settled.kind === "error") {
            return updateResult(d.ref, {
              status: "error", worker_status: "error", error_code: settled.code,
              failure_stage: "worker_execution", text: `任务失败: ${settled.message}`,
              exit_code: 1, progress: null,
              ...(view.lastBotText ? { partial_text: view.lastBotText } : {}),
            });
          }
          return updateResult(d.ref, {
            status: "completed", worker_status: "completed", text: settled.text, exit_code: 0,
            last_output_at: view.lastBotTextAt ?? view.lastMessageAt ?? now(),
            output_bytes: Buffer.byteLength(settled.text, "utf8"),
            progress: null, heartbeat: now(), thread_missing: false,
          });
        } else if (d.status === "completed") {
          // 已标记为 completed：检查是否有更晚的最终 bot text（纠正过早取第一句的脏记录）
          try { view = await readThread(d.thread_id, after, binding); } catch { /* ignore */ }
          if (view) {
            // 状态跟文本一起重算：终态变成失败/取消时，completed 不能留着。
            const settled = settleTurn(view, turnStatus, d.text || d.partial_text);
            const changed = settled.kind === "error"
              || (settled.kind === "completed" && settled.text !== d.text);
            if (changed) {
              if (settled.kind === "error") {
                d = updateResult(d.ref, {
                  status: "error", worker_status: "error", error_code: settled.code,
                  failure_stage: "worker_execution", text: `任务失败: ${settled.message}`,
                  exit_code: 1, progress: null,
                });
              } else {
                d = updateResult(d.ref, {
                  status: "completed", worker_status: "completed", text: settled.text,
                  output_bytes: Buffer.byteLength(settled.text, "utf8"),
                  last_output_at: view.lastBotTextAt ?? d.last_output_at,
                });
              }
            }
          }
        } else if (d.status === "timeout" || (d.status === "error" && d.error_code === "WORKER_FAILED")) {
          // 曾经超时：同一回合晚到的终态可以补结算；别的回合的成功不串进来。
          // E11：记过失败的，8801 自动续跑后成功收尾，也补结算成 completed（失败不改写成另一个失败）。
          const wasError = d.status === "error";
          try { view = await readThread(d.thread_id, after, binding); } catch { /* ignore */ }
          if (view?.bound && (!wasError || view.retries > 0)) {
            const settled = settleTurn(view, turnStatus, d.partial_text);
            if (settled.kind === "error" && !wasError) {
              d = updateResult(d.ref, {
                status: "error", worker_status: "error", error_code: settled.code,
                failure_stage: "worker_execution", text: `任务失败: ${settled.message}`,
                exit_code: 1, progress: null,
              });
            } else if (settled.kind === "completed") {
              d = updateResult(d.ref, {
                status: "completed", worker_status: "completed", text: settled.text,
                exit_code: 0, output_bytes: Buffer.byteLength(settled.text, "utf8"),
                last_output_at: view.lastBotTextAt ?? d.last_output_at, progress: null,
              });
            }
          }
        }
      }
    }

    if (d.status !== "running") return d;
    return reapResult(d);
  }

  // ---------------------------------------------------------------- GUI 通道参数校验（老 _check_gui_options 逐字）

  function checkGuiOptions(args: Record<string, any>, agent: string): void {
    if ((args.thinking ?? "default") !== "default" || args.attachments) {
      throw new Error("UNSUPPORTED: GUI 通道尚未验证思考开关或附件输入；请使用对应官方 CLI");
    }
    if ("stream" in args && typeof args.stream !== "boolean") {
      throw new Error("stream 必须是布尔值");
    }
    if (args.cwd) throw new Error("UNSUPPORTED: GUI 通道无法保证指定工作目录");
    const defaultModel = DEFAULT_MODELS[agent];
    const requested = String(args.model ?? "").trim();
    if (requested && !["default", "默认", defaultModel].includes(requested)) {
      throw new Error("UNSUPPORTED: GUI 通道无法切换请求的模型");
    }
  }

  // ---------------------------------------------------------------- 工具实现

  const tools: Record<string, (args: any, ctx?: DispatchCallContext) => Promise<string>> = {};

  /** 异步受理回执：老 agent_hub.py:901 逐字（无 callback/audit 降级时）。 */
  function dispatchReceipt(agent: string, ref: string): string {
    return `[${agent}/${ref}] 任务已异步受理 (此类任务耗时长, 不阻塞等待)。\n`
      + `查询结果: hub_result(ref="${ref}")\n`
      + `查存活状态: hub_task_status(ref="${ref}")  ← 先看 verdict，再看结果\n`
      + `verdict=working/alive_waiting/gui_working 时任务仍在工作，不要按墙钟截断；`
      + `只有终态或 worker_exited_result_missing 才需要处理。`;
  }

  tools.hub_dispatch_cli = async (args, context) => {
    const agent = resolveAgent(args?.agent);
    if (!agent) throw new Error("缺少 agent");
    if (typeof args?.task !== "string") throw new Error("task 必须是字符串");
    const task = args.task.trim();
    if (!task) throw new Error("缺少 task");
    if (await agentDisabled(agent)) throw disabledError();
    if (agent === "traecode") return tools.trae_delegate({ ...args, task });
    if (!WORKERS[agent]) {
      return `${agent} 未配置 CLI (agents.json 中 cli 为 null)。`
        + `确认该工具的无头调用命令后, 填入 agents.json 的 cli 字段即可。`;
    }
    if ((args.thinking ?? "default") !== "default" || args.attachments) {
      throw new Error("UNSUPPORTED: 此通道尚未验证思考开关或附件输入；请使用对应官方 CLI");
    }
    if (args.permission && args.permission !== "default") {
      throw new Error("UNSUPPORTED: 此通道不支持的 permission 参数");
    }
    if (args.effort && args.effort !== "default") {
      throw new Error("UNSUPPORTED: 此通道不支持的 effort 参数");
    }
    if ("stream" in args && typeof args.stream !== "boolean") {
      throw new Error("stream 必须是布尔值");
    }
    if (args.cwd && (typeof args.cwd !== "string" || !args.cwd.trim())) {
      throw new Error("cwd 必须是非空字符串");
    }
    const requestedModel = String(args.model ?? "").trim();
    const model = ["", "default", "默认"].includes(requestedModel)
      ? DEFAULT_MODELS[agent] : requestedModel;
    // 老 _dispatch_prepared_cli 在受理前完成 bot/模型准备：模型不被引擎接受 = 派发被拒。
    let entry: BotEntry;
    try {
      entry = await ensureBot(agent);
    } catch (error) {
      return `${agent} CLI 启动失败: ${errorMessage(error)}`;
    }
    if (model) await patchBotModel(agent, entry, model);
    const timeout = positiveTimeout(args.timeout_s, DEFAULT_TASK_TIMEOUT_S);
    const hardTimeout = positiveTimeout(args.hard_timeout_s, DEFAULT_HARD_TIMEOUT_S);
    const ref = shortRef(agent);
    updateResult(ref, { agent, status: "running", ...(context?.originThreadId ? { origin_thread_id: context.originThreadId } : {}), worker_status: "running", task,
      started_at: now(), dispatch_count: 1, liveness_source: "gui", model: model || undefined,
      idle_timeout_s: timeout, hard_timeout_s: hardTimeout, last_worker_progress_at: now(),
      cwd: args.cwd ? expandDir(String(args.cwd)) : undefined, output_bytes: 0, heartbeat: now() });
    events.emit(ref, agent, "accepted", `任务已受理 (${model || "默认模型"})`);
    await origin.accepted(ref, agent, context?.originThreadId);
    launchRun(ref, agent, task, model, args.cwd, "om", timeout, entry);
    return dispatchReceipt(agent, ref);
  };

  /** 老 tool_hub_wait_result：服务端阻塞等待，0/3/6/12/25/45/70/95 秒递进回查，单次预算 ≤115s。 */
  tools.hub_wait_result = async (args, ctx) => {
    const ref = String(args?.ref ?? "").trim();
    if (!ref) throw new Error("缺少 ref");
    const budget = Math.min(positiveTimeout(args?.wait_s, DEFAULT_WAIT_S), MAX_WAIT_BUDGET_S);
    const start = Date.now();
    let idx = 0;
    let lastProgress = "";
    for (;;) {
      const target = idx < WAIT_CHECK_SCHEDULE.length
        ? WAIT_CHECK_SCHEDULE[idx]
        : WAIT_CHECK_SCHEDULE[WAIT_CHECK_SCHEDULE.length - 1] + 300 * (idx - WAIT_CHECK_SCHEDULE.length + 1);
      const remaining = budget - (Date.now() - start) / 1000;
      if (remaining <= 0) break;
      const wait = Math.min(Math.max(target - (Date.now() - start) / 1000, 0), remaining);
      if (wait > 0) await sleep(wait * 1000);
      const d = await reaped(ref);
      if (!d) return `[${ref}] status=unknown\n未找到任务结果，请核对 ref。`;
      if (TERMINAL_STATUSES.includes(d.status)) return formatResult(d);
      if (d.progress && d.progress !== lastProgress) {
        lastProgress = d.progress;
        // Supported clients opened a progress channel; others simply never asked for one.
        ctx?.progress?.(redactEventText(lastProgress).slice(0, 200));
      }
      idx += 1;
      if ((Date.now() - start) / 1000 >= budget) break;
    }
    const d = await reaped(ref);
    if (d && TERMINAL_STATUSES.includes(d.status)) return formatResult(d);
    if (!d) return `[${ref}] status=unknown\n未找到任务结果，请核对 ref。`;
    const live = taskLiveness(d);
    let out = `[${ref}] status=running (等待预算用尽, 任务仍在执行)\n`
      + `[受控端界面快照] ${(lastProgress || "(暂无)").slice(0, 500)}\n`;
    out += `[存活] verdict=${live.verdict} action=${live.action} `
      + `pid=${live.pid || "-"} cpu=${live.cpu_seconds}s `
      + `output=${live.output_bytes}B (+${live.output_delta_bytes}B)\n`
      + `${live.guidance}\n`;
    out += "建议: 再次调用本工具 (wait_s=110) 继续等待；看到 verdict=working/alive_waiting 时不要按墙钟截断。";
    return out;
  };

  tools.hub_result = async (args) => {
    const ref = String(args?.ref ?? "").trim();
    if (!ref) throw new Error("缺少 ref");
    const d = await reaped(ref);
    if (!d) return `[${ref}] status=unknown\n未找到任务结果，请核对 ref。`;
    return formatResult(d);
  };

  /** 老 tool_hub_result_json：白名单字段 + verdict/liveness。 */
  tools.hub_result_json = async (args) => {
    const ref = safeComponent(String(args?.ref ?? "").trim());
    const data = await reaped(ref);
    if (!data) {
      return JSON.stringify({ ref, status: "unknown", verdict: "unknown",
        text: "未找到任务结果，请核对 ref。" });
    }
    const keys = ["ref", "agent", "status", "worker_status", "error_code", "failure_stage", "error_details",
      "dispatch_count", "status_history", "last_confirmed_status", "audit_degraded", "verification",
      "text", "progress", "exit_code", "updated_at", "model", "thinking", "stream", "attachments", "usage",
      "timeout_kind", "partial_text", "needs_followup", "followup_sent"] as const;
    const out: Record<string, unknown> = {};
    for (const key of keys) if (key in data) out[key] = (data as Record<string, unknown>)[key];
    const live = taskLiveness(data);
    out.verdict = live.verdict;
    out.liveness = live;
    return JSON.stringify(out);
  };

  tools.hub_task_status = async (args) => {
    const ref = safeComponent(String(args?.ref ?? "").trim());
    if (!ref) throw new Error("缺少 ref");
    const data = await reaped(ref);
    const live = data
      ? taskLiveness(data)
      : { ref, agent: null, status: "unknown", verdict: "unknown", action: "inspect",
        guidance: "未找到任务结果，请核对 ref。", preserve_ref: true };
    if (asBool(args?.json)) return JSON.stringify(live);
    return formatTaskStatus(live);
  };

  /** 自 since 起的增量事件；取代整包轮询任务状态。 */
  tools.hub_events = async (args) => {
    const ref = safeComponent(String(args?.ref ?? "").trim());
    if (!ref) throw new Error("缺少 ref");
    const sinceRaw = Number(args?.since ?? 0);
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;
    const list = events.list(ref, since);
    let status = "unknown";
    let agent: string | null = null;
    try {
      const record = readResult(ref);
      if (record) {
        status = String(record.status ?? "unknown");
        agent = String(record.agent ?? "") || null;
      }
    } catch { /* 结果文件坏时事件仍可读 */ }
    return JSON.stringify({ ref, agent, status, events: list,
      next: list.length ? list[list.length - 1].seq : since });
  };

  /** 老 hub_set_agent_status：真源改为 8801 实例设置里的 disabled；输出 JSON 逐字不变。 */
  tools.hub_set_agent_status = async (args) => {
    const agent = resolveAgent(args?.agent ?? args?.worker);
    if (!agent) throw new Error("缺少 agent 或 worker 参数");
    let enabled: boolean;
    if (args?.enabled === undefined && args?.disabled !== undefined) {
      enabled = !asBool(args.disabled, false);
    } else if (args?.enabled !== undefined) {
      enabled = asBool(args.enabled, true);
    } else {
      throw new Error("缺少 enabled 或 disabled 参数");
    }
    const instanceId = WORKERS[agent];
    if (!instanceId) throw new Error(`未知 agent: ${agent}`);
    let patched: { status: number; json: any };
    try {
      patched = await om(`/api/instances/${encodeURIComponent(instanceId)}`, {
        method: "PATCH", body: { disabled: !enabled },
      });
    } catch (error) {
      throw new Error(`无法写入 ${agent} 的停用状态（8801 不可达）: ${errorMessage(error)}`);
    }
    if (patched.status === 404) throw new Error(`未知 agent: ${agent}`);
    if (patched.status < 200 || patched.status >= 300) {
      throw new Error(`设置 ${agent} 状态失败 (HTTP ${patched.status}): ${String(patched.json?.error ?? "")}`);
    }
    const stateLabel = enabled ? "已激活" : "已禁用";
    return JSON.stringify({
      ok: true,
      agent,
      enabled,
      message: `子代理 ${agent} ${stateLabel}，全端（WebUI 及各插件）已同步生效。`,
    });
  };

  tools.hub_list_agents = async () => {
    const { lines } = await instanceView();
    return "已注册代理:\n" + (lines.length ? lines.join("\n") : "(暂无, 各端调用 hub_heartbeat 注册)");
  };

  tools.hub_capabilities = async (args) => {
    if (typeof args?.refresh !== "undefined" && typeof args.refresh !== "boolean") {
      throw new Error("refresh must be a boolean");
    }
    const wanted = resolveAgent(args?.agent ?? args?.worker ?? "");
    const selected = String(args?.model ?? "").trim();
    const { states } = await instanceView();
    const workers: Record<string, unknown> = {};
    const names = [...Object.keys(WORKERS), "traecode"].sort();
    for (const agent of names) {
      if (wanted && agent !== wanted) continue;
      if (agent === "traecode") {
        workers[agent] = { configured: true, default_model: null, platform: process.platform,
          attachment_policy: { platform: process.platform, mode: "none" }, model_selection: false,
          availability: { enabled: true, code: "ok", reason: "", refreshable: false },
          models: [], failures: [], thinking: false, stream: "gui_snapshot", attachments: {} };
        continue;
      }
      const state = states.get(WORKERS[agent]);
      const disabled = state?.disabled === true;
      const enabled = state?.available === true;
      const availability = disabled ? disabledAvailability()
        : { enabled, code: enabled ? "ok" : "engine_unavailable",
          reason: enabled ? "" : String(state?.reason || "8801 引擎不可用"), refreshable: false };
      const options: Array<{ id: string; label?: string }> = state?.models ?? [];
      const defaultModel = DEFAULT_MODELS[agent]
        ?? (selected && options.some((m) => m.id === selected) ? selected : state?.default ?? null);
      const identifiers = selected ? [selected] : options.map((m) => m.id);
      const models = identifiers.map((id) => ({ id, aliases: [],
        availability: disabled ? disabledAvailability()
          : id === defaultModel || options.some((m) => m.id === id)
            ? availability : { enabled: false, code: "model_not_configured",
              reason: "所选模型未在本机 worker 配置中声明。", refreshable: false } }));
      workers[agent] = { configured: true, default_model: defaultModel, platform: process.platform,
        attachment_policy: { platform: process.platform, mode: "none" }, model_selection: true,
        availability, models, failures: [], thinking: state?.hasVariants === true,
        stream: "gui_snapshot", attachments: {} };
    }
    return JSON.stringify({ schema_version: 2, platform: process.platform, workers,
      attachment_limit_bytes: 1024 * 1024, scope: "configured_capabilities_not_a_login_or_generation_check" });
  };

  tools.hub_list_models = async (args) => {
    const wanted = args?.agent ? resolveAgent(args.agent) : null;
    const { states } = await instanceView();
    const lines: string[] = [];
    for (const agent of Object.keys(WORKERS).sort()) {
      if (wanted && agent !== wanted) continue;
      const state = states.get(WORKERS[agent]);
      const options: Array<{ id: string }> = state?.models ?? [];
      if (!options.length && !state?.default) continue;
      const parts = options.map((m) => `${m.id}→${m.id}`);
      const defaultModel = DEFAULT_MODELS[agent] ?? state?.default;
      if (defaultModel) parts.push(`默认→${defaultModel}`);
      lines.push(`- ${agent}: model_arg=未配置 | ${parts.join(", ")}`);
    }
    if (wanted === "traecode" && !lines.length) lines.push("- traecode: model_arg=未配置 | 未配别名表 (model 参数将原样传给 CLI)");
    return "各 worker 可选模型:\n" + (lines.length ? lines.join("\n") : "(还没有配置 CLI 的 worker)");
  };

  tools.hub_login = async (args) => {
    const worker = resolveAgent(args?.agent);
    const action = String(args?.action ?? "status");
    return JSON.stringify({ ok: false, worker, action, status: "unavailable",
      error: "hub-compat 通道不管理登录；请在 8801 工作台或对应 worker 宿主机完成登录。" });
  };

  tools.zcode_delegate = async (args, context) => {
    checkGuiOptions(args, "zcode");
    const task = String(args?.task ?? "").trim();
    if (!task) throw new Error("缺少 task");
    if (await agentDisabled("zcode")) throw disabledError();
    const wait = asBool(args?.wait, true);
    const timeout = positiveTimeout(args?.timeout_s, 300);
    if (!wait) {
      const ref = shortRef("zcode");
      updateResult(ref, { agent: "zcode", status: "running", ...(context?.originThreadId ? { origin_thread_id: context.originThreadId } : {}), worker_status: "running", task,
        started_at: now(), dispatch_count: 1, liveness_source: "gui", output_bytes: 0, heartbeat: now() });
      events.emit(ref, "zcode", "accepted", `任务已受理 (${DEFAULT_MODELS.zcode})`);
      await origin.accepted(ref, "zcode", context?.originThreadId);
      launchRun(ref, "zcode", task, DEFAULT_MODELS.zcode, undefined, "om", timeout);
      return `[zcode/${ref}] 已异步受理, status=running。\n查询结果: zcode_result(ref="${ref}")`;
    }
    const ref = shortRef("zcode");
    updateResult(ref, { agent: "zcode", status: "running", ...(context?.originThreadId ? { origin_thread_id: context.originThreadId } : {}), worker_status: "running", task,
      started_at: now(), dispatch_count: 1, liveness_source: "gui", output_bytes: 0, heartbeat: now() });
    events.emit(ref, "zcode", "accepted", `任务已受理 (${DEFAULT_MODELS.zcode})`);
    await origin.accepted(ref, "zcode", context?.originThreadId);
    const run = runTurn(ref, "zcode", task, DEFAULT_MODELS.zcode, undefined, "om", timeout)
      .catch(() => {}).finally(() => activeRuns.delete(ref));
    activeRuns.set(ref, run);
    await run;
    const d = readResult(ref);
    const status = d?.status === "completed" ? "completed" : d?.status === "timeout" ? "timeout" : "error";
    const text = d?.text || (d?.status === "timeout" ? `驱动执行超时 (>${timeout}s)` : d?.partial_text || "驱动没有返回诊断输出");
    const exitCode = d?.exit_code ?? (status === "completed" ? 0 : 1);
    updateResult("zcode-last", { agent: "zcode", status, text, exit_code: exitCode });
    return `[zcode] status=${status} exit=${exitCode}\n${text || "(空响应)"}`;
  };

  tools.zcode_result = async (args) => {
    const ref = String(args?.ref ?? "").trim();
    if (!ref) throw new Error("缺少 ref");
    const d = await reaped(ref);
    if (!d) return `未找到 ${ref} 的结果 (可能尚未落盘, 稍后再查)。`;
    return formatResult(d);
  };

  tools.trae_delegate = async (args, context) => {
    checkGuiOptions(args, "traecode");
    const task = String(args?.task ?? "").trim();
    if (!task) throw new Error("缺少 task");
    const wait = asBool(args?.wait, true);
    const sessionId = typeof args?.session_id === "string" ? args.session_id : "";
    const timeout = positiveTimeout(args?.timeout_s, 240);
    if (!wait) {
      const ref = shortRef("traecode");
      updateResult(ref, { agent: "traecode", status: "running", ...(context?.originThreadId ? { origin_thread_id: context.originThreadId } : {}), worker_status: "running", task,
        started_at: now(), dispatch_count: 1, liveness_source: "gui", session_id: sessionId,
        new_chat: asBool(args?.new_chat, false), output_bytes: 0, heartbeat: now() });
      events.emit(ref, "traecode", "accepted", "任务已受理 (TraeClaw 网关)");
      await origin.accepted(ref, "traecode", context?.originThreadId);
      launchRun(ref, "traecode", task, undefined, undefined, "trae", timeout);
      return `[traecode/${ref}] 已异步受理, status=running。\n查询结果: trae_result(ref="${ref}")`;
    }
    try {
      const outcome = await traeGatewayChat(task, sessionId, asBool(args?.new_chat, false), timeout);
      const status = outcome.status === "timeout" ? "timeout" : "completed";
      updateResult("trae-last", { agent: "trae", status, text: outcome.text, session_id: outcome.sessionId });
      let out = `[trae/${outcome.sessionId || "new"}] status=${status}\n${truncate(outcome.text) || "(空响应)"}`;
      if (outcome.sessionId) out += `\n(继续对话请带 session_id: ${outcome.sessionId})`;
      return out;
    } catch (error) {
      const messageText = errorMessage(error);
      const status = /超时/.test(messageText) ? "timeout" : "error";
      updateResult("trae-last", { agent: "trae", status, text: messageText, session_id: sessionId });
      return `[trae/${sessionId || "new"}] status=${status}\n${truncate(messageText) || "(空响应)"}`;
    }
  };

  tools.trae_result = async (args) => {
    const ref = String(args?.ref ?? "").trim();
    if (!ref) throw new Error("缺少 ref");
    const d = reapResult(readResult(ref));
    if (!d) return `未找到 ${ref} 的结果 (可能尚未落盘, 稍后再查)。`;
    return formatResult(d);
  };

  tools.trae_status = async () => {
    let data: any;
    try {
      const resp = await fetch(traeGateway() + "/health", { signal: AbortSignal.timeout(15_000) });
      data = await resp.json();
    } catch (error) {
      return `TraeClaw 网关: 未连接 (无法连接 Trae 网关 (${traeGateway()}): ${errorMessage(error)})`;
    }
    if (!data || data.error) {
      return `TraeClaw 网关: 未连接 (${data?.error ?? "响应无效"})`;
    }
    const body = data.data ?? {};
    const auto = body.automation ?? {};
    const target = (auto.target ?? {}).title ?? "";
    return `TraeClaw 网关: ${body.status ?? "?"} | CDP 自动化: ${auto.ready ? "就绪" : "未就绪"} | 目标窗口: ${target}`;
  };

  tools.trae_new_chat = async (args) => {
    let data: any;
    try {
      const resp = await fetch(traeGateway() + "/v1/mode", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: String(args?.mode ?? "chat") }),
        signal: AbortSignal.timeout(15_000),
      });
      data = await resp.json();
    } catch (error) {
      throw new Error(`无法连接 Trae 网关 (${traeGateway()}/v1/mode): ${errorMessage(error)}`);
    }
    if (data?.error) throw new Error(String(data.error));
    return "已请求 Trae 切换/新建会话。";
  };

  /** /api/instances 现读快照：states Map<instanceId, {available,authenticated,disabled,reason,default,models,hasVariants}>。 */
  async function instanceView(): Promise<{ lines: string[]; states: Map<string, {
    available: boolean; authenticated: boolean; disabled: boolean; reason: string; default: string | null;
    models: Array<{ id: string; label?: string }>; hasVariants: boolean; display: string } | null> }> {
    const states = new Map<string, { available: boolean; authenticated: boolean; disabled: boolean; reason: string;
      default: string | null; models: Array<{ id: string; label?: string }>; hasVariants: boolean;
      display: string } | null>();
    const lines: string[] = [];
    let fetched: { status: number; json: any } = { status: 0, json: null };
    try { fetched = await om("/api/instances"); } catch { /* 8801 不可达时全部离线 */ }
    const instances: any[] = Array.isArray(fetched.json?.instances) ? fetched.json.instances : [];
    for (const inst of instances) {
      const snapshot = inst?.snapshot ?? {};
      states.set(String(inst?.instanceId ?? ""), {
        available: snapshot.state === "available",
        authenticated: snapshot.authenticated === true,
        disabled: inst?.disabled === true,
        reason: String(snapshot.reason ?? ""),
        default: inst?.models?.default ?? null,
        models: Array.isArray(inst?.models?.options)
          ? inst.models.options.map((m: any) => ({ id: String(m?.id ?? ""), label: m?.label })) : [],
        hasVariants: Array.isArray(inst?.models?.options)
          && inst.models.options.some((m: any) => Array.isArray(m?.variants) && m.variants.length),
        display: String(inst?.displayName ?? inst?.instanceId ?? "?"),
      });
    }
    for (const agent of Object.keys(WORKERS).sort()) {
      const state = states.get(WORKERS[agent]) ?? null;
      const label = state?.disabled === true ? "已禁用"
        : !state ? "离线"
        : state.available && state.authenticated ? "在线"
        : state.available ? "就绪" : "离线";
      const cli = state ? `om:${WORKERS[agent]} (${state.available ? state.display : "离线"})` : "未配置";
      lines.push(`- ${agent} [${label}] 角色: worker | CLI: ${cli}`);
    }
    lines.push("- traecode [就绪] 角色: worker | 调度通道: TraeClaw 网关");
    return { lines, states };
  }

  return tools;
}
