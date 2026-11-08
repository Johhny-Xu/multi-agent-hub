/**
 * Persistent JSON state for the hub-compat server.
 *
 * Mirrors the on-disk behaviour of the legacy Python hub (state_store.py /
 * result_store.py / agent_hub.py): every document is written to a temporary
 * file and renamed into place, mutations are serialised through a bounded
 * process-safe lock file, and readers tolerate a missing file while rejecting
 * a corrupt one. Only Node builtins are used.
 */
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const ONLINE_WINDOW_SEC = 600;
export const MAX_OUTPUT_CHARS = 20000;
export const LOCK_TIMEOUT_SEC = 10;
/** A running record older than this (no progress) is reclaimed as timeout. */
export const STALE_RUNNING_SEC = positiveSeconds(
  process.env.HUB_STALE_RUNNING_SEC === undefined ? 1800 : Number(process.env.HUB_STALE_RUNNING_SEC),
  1800,
);
const MAX_MAILBOX = 500;
const TASK_DISPLAY_LIMIT = 50;
const LOCK_STALE_MS = 30000;

export type JsonObject = Record<string, any>;

/** Legacy `_resolve_agent` alias table (agent_hub.py). */
export const AGENT_ALIASES: Record<string, string> = {
  agy: "antigravity",
  cb: "codebuddy",
  cbcn: "codebuddy-cn",
  mimo: "mimocode",
  gcp: "github-copilot",
  mmx: "minimaxcode",
  trae: "traecode",
  ca: "codearts",
  "huawei-codearts": "codearts",
  oc: "opencode",
};

const RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

function positiveSeconds(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Python `str(value or "")` for the scalar types the tools accept. */
export function textValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/** Legacy `_as_bool`: strings "0"/"false"/"no"/"off" are false, not truthy. */
export function asBool(value: unknown, fallback = false): boolean {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return !["", "0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

/** Legacy `safe_component`: one portable filename component, no traversal. */
export function safeComponent(value: unknown): string {
  const name = textValue(value);
  if (
    !name ||
    name === "." ||
    name === ".." ||
    [...name].length > 160 ||
    /[. ]$/.test(name) ||
    [...name].some((char) => char.charCodeAt(0) < 32 || '/\\:<>"|?*'.includes(char))
  ) {
    throw new Error("标识符不能包含路径分隔符、控制字符或非法文件名字符");
  }
  if (RESERVED_NAMES.has(name.split(".", 1)[0].toUpperCase())) {
    throw new Error("标识符不能使用系统保留文件名");
  }
  return name;
}

/** Expand `$VAR` / `${VAR}` and a leading `~`, then resolve to an absolute path. */
export function expandPath(value: string): string {
  let out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, plain) => {
    return process.env[braced ?? plain] ?? "";
  });
  if (out === "~" || out.startsWith("~/")) out = join(homedir(), out.slice(1));
  return resolve(out);
}

/** `$HUB_STATE_DIR` or `~/.multi-agent-hub/hub-state/`. */
export function resolveStateDir(): string {
  const configured = process.env.HUB_STATE_DIR?.trim();
  return expandPath(configured ? configured : join(homedir(), ".multi-agent-hub", "hub-state"));
}

export function resolveAgentsFile(stateDir: string): string {
  const configured = process.env.HUB_AGENTS_FILE?.trim();
  return configured ? expandPath(configured) : join(stateDir, "agents.json");
}

/** Legacy `_read_json`: any read or parse failure yields the caller's default. */
export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, "")) as T;
  } catch {
    return fallback;
  }
}

let temporaryCounter = 0;

/** Write JSON atomically: temp file in the same directory, then rename. */
export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  temporaryCounter += 1;
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${temporaryCounter}.tmp`);
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(JSON.stringify(data), "utf8");
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function acquireLockFile(path: string, timeoutMs: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A crashed holder leaves the file behind; only reclaim clearly stale ones.
      try {
        const info = await stat(path);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await unlink(path);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`等待状态锁超时: ${basename(path)}`);
      await delay(5 + Math.random() * 10);
    }
  }
}

const tails = new Map<string, Promise<unknown>>();

/**
 * Serialise mutations of one file both inside this process and across
 * processes (exclusive-create lock file). Mirrors StateFileLock's bounded wait.
 */
export async function withFileLock<T>(
  lockPath: string,
  body: () => Promise<T>,
  timeoutMs = LOCK_TIMEOUT_SEC * 1000,
): Promise<T> {
  const key = resolve(lockPath);
  const previous = tails.get(key) ?? Promise.resolve();
  let releaseCurrent: () => void = () => {};
  const current = new Promise<void>((done) => {
    releaseCurrent = done;
  });
  const tail = previous.then(() => current);
  tails.set(key, tail);
  await previous;
  try {
    await acquireLockFile(lockPath, timeoutMs);
    try {
      return await body();
    } finally {
      await rm(lockPath, { force: true });
    }
  } finally {
    releaseCurrent();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

function truncate(text: string): string {
  if (text.length > MAX_OUTPUT_CHARS) {
    return text.slice(0, MAX_OUTPUT_CHARS) + `\n...[输出已截断, 共 ${text.length} 字符]`;
  }
  return text;
}

/** Legacy `_tid`: local wall clock plus four random digits. */
function taskId(): string {
  const now = new Date();
  const stamp = `${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `t-${stamp}-${1000 + Math.floor(Math.random() * 9000)}`;
}

function clockLabel(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function resultPath(resultsDir: string, ref: string): string {
  return join(resultsDir, `${safeComponent(ref)}.json`);
}

/**
 * Read one result document. Missing is null; a corrupt or unreadable file is an
 * error so a task's metadata is never silently replaced by an empty record.
 */
export async function readResult(resultsDir: string, ref: string): Promise<JsonObject | null> {
  const path = resultPath(resultsDir, ref);
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      const raw = await readFile(path, "utf8");
      const value: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Result is not an object");
      return value as JsonObject;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (code === "EACCES" || code === "EPERM") {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Task result is temporarily inaccessible; preserve its ref");
        await delay(Math.min(20, remaining));
        continue;
      }
      throw new Error("Task result is invalid; preserve its ref");
    }
  }
}

export interface UpdateResultOptions {
  onlyIfRunning?: boolean;
  expectedUpdatedAt?: unknown;
}

/** Legacy `update_result`: records status history and a fresh updated_at. */
export async function updateResult(
  resultsDir: string,
  ref: string,
  fields: JsonObject,
  options: UpdateResultOptions = {},
): Promise<JsonObject> {
  const path = resultPath(resultsDir, ref);
  return withFileLock(`${path}.lock`, async () => {
    const current: JsonObject = (await readResult(resultsDir, ref)) ?? {};
    if (options.onlyIfRunning && current.status !== "running") return current;
    if (options.expectedUpdatedAt !== undefined && current.updated_at !== options.expectedUpdatedAt) return current;
    const next: JsonObject = { ...current, ...fields };
    const status = fields.status;
    if (status !== undefined && status !== null) {
      if (current.status !== status) {
        const history = Array.isArray(current.status_history) ? [...current.status_history] : [];
        history.push({
          from: current.status ?? null,
          to: status,
          error_code: fields.error_code ?? null,
          failure_stage: fields.failure_stage ?? null,
          at: Date.now() / 1000,
        });
        next.status_history = history;
      }
      next.last_confirmed_status = status;
    }
    next.ref = ref;
    next.updated_at = Date.now() / 1000;
    await atomicWriteJson(path, next);
    return next;
  });
}

/** Reclaim a stale running record. A live PID tree is never judged by wall clock. */
export async function reapResult(resultsDir: string, data: JsonObject | null): Promise<JsonObject | null> {
  if (!data || data.status !== "running") return data;
  const age = Date.now() / 1000 - Number(data.updated_at ?? 0);
  if (!(age >= STALE_RUNNING_SEC)) return data;
  const pid = Number(data.pid);
  if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) return data;
  const ref = textValue(data.ref);
  if (!ref) return data;
  return updateResult(
    resultsDir,
    ref,
    {
      status: "timeout",
      progress: null,
      text: `任务超时: 已 ${Math.round(age / 60)} 分钟无任何进展, 判定 worker 已异常退出。请检查 async_worker 日志。`,
    },
    { onlyIfRunning: true, expectedUpdatedAt: data.updated_at },
  );
}

export interface HubStoreOptions {
  stateDir?: string;
  agentsFile?: string;
}

/**
 * The legacy hub's local state: registry, task queue, mailboxes, notes,
 * agent enablement and async results. Every method returns the exact text the
 * Python tools returned, because mcp/hub.mjs and the host plugins parse it.
 */
export class HubStore {
  readonly stateDir: string;
  readonly resultsDir: string;
  readonly agentsFile: string;

  constructor(options: HubStoreOptions = {}) {
    this.stateDir = resolve(options.stateDir ? expandPath(options.stateDir) : resolveStateDir());
    this.resultsDir = join(this.stateDir, "results");
    this.agentsFile = options.agentsFile ? expandPath(options.agentsFile) : resolveAgentsFile(this.stateDir);
  }

  private statePath(name: string): string {
    return join(this.stateDir, name);
  }

  private lockPath(name: string): string {
    return this.statePath(`${safeComponent(name)}.lock`);
  }

  async registry(): Promise<JsonObject> {
    const data = await readJsonFile<unknown>(this.statePath("registry.json"), {});
    return data && typeof data === "object" && !Array.isArray(data) ? (data as JsonObject) : {};
  }

  /** Legacy `_load_agents`: only `{ agents: { name: object } }` entries count. */
  async agents(): Promise<Record<string, JsonObject>> {
    const data = await readJsonFile<unknown>(this.agentsFile, {});
    const agents = data && typeof data === "object" && !Array.isArray(data) ? (data as JsonObject).agents : undefined;
    if (!agents || typeof agents !== "object" || Array.isArray(agents)) return {};
    const out: Record<string, JsonObject> = {};
    for (const [name, profile] of Object.entries(agents as JsonObject)) {
      if (profile && typeof profile === "object" && !Array.isArray(profile)) out[name] = profile as JsonObject;
    }
    return out;
  }

  /** Legacy `_resolve_agent`: alias table, then registered/case-insensitive name. */
  async resolveAgent(raw: unknown): Promise<string> {
    const name = textValue(raw).trim();
    const low = name.toLowerCase();
    if (Object.hasOwn(AGENT_ALIASES, low)) return AGENT_ALIASES[low];
    const agents = await this.agents();
    if (Object.hasOwn(agents, name)) return name;
    if (Object.hasOwn(agents, low)) return low;
    for (const known of Object.keys(agents)) {
      if (known.toLowerCase() === low) return known;
    }
    return low;
  }

  async heartbeat(args: JsonObject): Promise<string> {
    const agent = await this.resolveAgent(args.agent);
    if (!agent) throw new Error("缺少 agent 名称");
    const name = safeComponent(agent);
    const reg = await withFileLock(this.lockPath("registry"), async () => {
      const state = await this.registry();
      const entry: JsonObject = regEntry(state, name);
      entry.role = args.role || entry.role || "";
      entry.capabilities = args.capabilities || entry.capabilities || [];
      entry.last_seen = Date.now() / 1000;
      state[name] = entry;
      await atomicWriteJson(this.statePath("registry.json"), state);
      return state;
    });
    const now = Date.now() / 1000;
    const online = Object.entries(reg)
      .filter(([, entry]) => now - Number((entry as JsonObject)?.last_seen ?? 0) < ONLINE_WINDOW_SEC)
      .map(([name]) => name)
      .sort();
    return `${name} 心跳已登记。当前 10 分钟内在线: ${online.join(", ") || "仅自己"}`;
  }

  async listTasks(args: JsonObject): Promise<string> {
    const data = await readJsonFile<JsonObject>(this.statePath("tasks.json"), { tasks: [] });
    const status = args.status as string | undefined;
    const agent = args.agent ? await this.resolveAgent(args.agent) : null;
    const tasks = Array.isArray(data.tasks) ? (data.tasks as JsonObject[]) : [];
    const matched = tasks.filter((task) => {
      if (status && task.status !== status) return false;
      if (agent && ![task.from_agent, task.to_agent, task.claimed_by].includes(agent)) return false;
      return true;
    });
    if (!matched.length) return "没有匹配的任务。";
    const lines = matched.slice(-TASK_DISPLAY_LIMIT).map((task) => (
      `- ${task.id} [${task.status}] ${task.title}`
      + ` | 发起: ${task.from_agent} -> 指派: ${task.to_agent || "无"}`
      + ` | 执行: ${task.claimed_by || "-"}`
      + ` | 优先级: ${task.priority}`
    ));
    return `共 ${matched.length} 条(最多显示50):\n${lines.join("\n")}`;
  }

  async postTask(args: JsonObject): Promise<string> {
    const fromAgent = await this.resolveAgent(args.from_agent);
    const title = textValue(args.title).trim();
    if (!fromAgent || !title) throw new Error("缺少 from_agent 或 title");
    const from = safeComponent(fromAgent);
    const to = args.to_agent ? safeComponent(await this.resolveAgent(args.to_agent)) : null;
    const task = await withFileLock(this.lockPath("tasks"), async () => {
      const data = await readJsonFile<JsonObject>(this.statePath("tasks.json"), { seq: 0, tasks: [] });
      const seq = Number(data.seq ?? 0) + 1;
      data.seq = seq;
      if (!Array.isArray(data.tasks)) data.tasks = [];
      const entry: JsonObject = {
        id: `${taskId()}-${seq}`,
        title,
        detail: textValue(args.detail),
        from_agent: from,
        to_agent: to,
        priority: args.priority || "normal",
        cwd: args.cwd || null,
        status: "open",
        claimed_by: null,
        result: null,
        created_ts: Date.now() / 1000,
        done_ts: null,
      };
      data.tasks.push(entry);
      await atomicWriteJson(this.statePath("tasks.json"), data);
      return entry;
    });
    if (task.to_agent) {
      await this.mailPush(task.to_agent, from, `新任务 ${task.id}: ${title} (用 hub_claim_task 认领)`);
    }
    return `任务已入队: ${task.id} 「${title}」 -> ${task.to_agent || "任意代理认领"}`;
  }

  async claimTask(args: JsonObject): Promise<string> {
    const id = textValue(args.task_id).trim();
    const agent = await this.resolveAgent(args.agent);
    if (!id || !agent) throw new Error("缺少 task_id 或 agent");
    return withFileLock(this.lockPath("tasks"), async () => {
      const data = await readJsonFile<JsonObject>(this.statePath("tasks.json"), { tasks: [] });
      const tasks = Array.isArray(data.tasks) ? (data.tasks as JsonObject[]) : [];
      for (const task of tasks) {
        if (task.id !== id) continue;
        if (task.status !== "open") return `任务 ${id} 当前状态为 ${task.status}, 认领失败。`;
        if (task.to_agent && task.to_agent !== agent) {
          return `任务 ${id} 指定给 ${task.to_agent}, ${agent} 无权认领。`;
        }
        task.status = "in_progress";
        task.claimed_by = agent;
        task.claimed_ts = Date.now() / 1000;
        await atomicWriteJson(this.statePath("tasks.json"), data);
        await this.mailPush(task.from_agent, agent, `${agent} 已认领任务 ${id}「${task.title}」`);
        return `已认领 ${id}「${task.title}」。详情: ${task.detail || "(无)"}`;
      }
      return `未找到任务 ${id}。`;
    });
  }

  async completeTask(args: JsonObject): Promise<string> {
    const id = textValue(args.task_id).trim();
    const agent = await this.resolveAgent(args.agent);
    const result = textValue(args.result);
    const success = asBool(args.success, true);
    if (!id || !agent) throw new Error("缺少 task_id 或 agent");
    return withFileLock(this.lockPath("tasks"), async () => {
      const data = await readJsonFile<JsonObject>(this.statePath("tasks.json"), { tasks: [] });
      const tasks = Array.isArray(data.tasks) ? (data.tasks as JsonObject[]) : [];
      for (const task of tasks) {
        if (task.id !== id) continue;
        if (task.status !== "in_progress" || task.claimed_by !== agent) {
          return `任务 ${id} 必须由已认领的代理完成，当前操作未写入。`;
        }
        task.status = success ? "done" : "failed";
        task.result = truncate(result);
        task.done_ts = Date.now() / 1000;
        await atomicWriteJson(this.statePath("tasks.json"), data);
        await this.mailPush(
          task.from_agent,
          agent,
          `任务 ${id}「${task.title}」已${success ? "完成" : "失败"}。结果: ${task.result}`,
        );
        return `任务 ${id} 已标记${success ? "完成" : "失败"}, 结果已回传给 ${task.from_agent}。`;
      }
      return `未找到任务 ${id}。`;
    });
  }

  private async mailPush(toAgent: string, fromAgent: string, message: string): Promise<void> {
    const to = safeComponent(toAgent);
    await withFileLock(this.lockPath(`mailbox-${to}`), async () => {
      const box = await readJsonFile<JsonObject[]>(this.statePath(`mailbox-${to}.json`), []);
      const messages = Array.isArray(box) ? box : [];
      messages.push({ ts: Date.now() / 1000, from: fromAgent, text: message, read: false });
      await atomicWriteJson(this.statePath(`mailbox-${to}.json`), messages.slice(-MAX_MAILBOX));
    });
  }

  async sendMessage(args: JsonObject): Promise<string> {
    const toAgent = await this.resolveAgent(args.to_agent);
    const fromAgent = textValue(args.from_agent).trim();
    const message = textValue(args.text);
    if (!toAgent || !fromAgent || !message) throw new Error("缺少 to_agent / from_agent / text");
    await this.mailPush(toAgent, fromAgent, truncate(message));
    return `消息已投递到 ${toAgent} 的收件箱。`;
  }

  async readMessages(args: JsonObject): Promise<string> {
    const agent = await this.resolveAgent(args.agent);
    if (!agent) throw new Error("缺少 agent");
    const name = safeComponent(agent);
    const mark = asBool(args.mark_read, true);
    const unread = await withFileLock(this.lockPath(`mailbox-${name}`), async () => {
      const box = await readJsonFile<JsonObject[]>(this.statePath(`mailbox-${name}.json`), []);
      const messages = Array.isArray(box) ? box : [];
      const pending = messages.filter((message) => !message.read);
      const delivered = pending.slice(0, TASK_DISPLAY_LIMIT);
      if (mark && pending.length) {
        for (const message of delivered) message.read = true;
        await atomicWriteJson(this.statePath(`mailbox-${name}.json`), messages);
      }
      return { pending, delivered };
    });
    if (!unread.pending.length) return `${name} 没有未读消息。`;
    const lines = unread.delivered.map(
      (message) => `- [${clockLabel(Number(message.ts))}] ${message.from}: ${message.text}`,
    );
    return `${name} 有 ${unread.pending.length} 条未读，本次返回 ${unread.delivered.length} 条:\n${lines.join("\n")}`;
  }

  async noteSet(args: JsonObject): Promise<string> {
    const key = textValue(args.key).trim();
    const agent = textValue(args.agent || "unknown").trim();
    if (!key) throw new Error("缺少 key");
    await withFileLock(this.lockPath("notes"), async () => {
      const notes = await readJsonFile<JsonObject>(this.statePath("notes.json"), {});
      notes[key] = { value: textValue(args.value), agent, ts: Date.now() / 1000 };
      await atomicWriteJson(this.statePath("notes.json"), notes);
    });
    return `笔记「${key}」已保存。`;
  }

  async noteGet(args: JsonObject): Promise<string> {
    const key = textValue(args.key).trim();
    const notes = await readJsonFile<JsonObject>(this.statePath("notes.json"), {});
    if (key) {
      const note = notes[key];
      return note ? `${key} = ${note.value} (by ${note.agent})` : `没有笔记「${key}」。`;
    }
    const keys = Object.keys(notes).sort();
    return `全部笔记: ${keys.length ? keys.join(", ") : "(空)"}`;
  }

  /** Legacy `hub_reap`: reclaim stale running records and report the survivors. */
  async reap(): Promise<string> {
    let names: string[];
    try {
      names = await readdir(this.resultsDir);
    } catch {
      return "结果目录不存在, 暂无历史任务。";
    }
    const reaped: Array<[string, number]> = [];
    const stillRunning: Array<[string, number]> = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const ref = name.slice(0, -5);
      const data = await readResult(this.resultsDir, ref);
      if (!data || data.status !== "running") continue;
      const age = Date.now() / 1000 - Number(data.updated_at ?? 0);
      if (age >= STALE_RUNNING_SEC) {
        const current = await reapResult(this.resultsDir, data);
        if (current?.status === "timeout") reaped.push([ref, age]);
        else if (current?.status === "running") stillRunning.push([ref, age]);
      } else {
        stillRunning.push([ref, age]);
      }
    }
    const lines: string[] = [];
    if (reaped.length) {
      lines.push(`已判定超时并回收 ${reaped.length} 条:`);
      lines.push(...reaped.map(([ref, age]) => `  - ${ref} (停滞 ${Math.round(age / 60)} 分钟)`));
    } else {
      lines.push("没有需要回收的陈旧任务。");
    }
    if (stillRunning.length) {
      lines.push(`仍在正常运行 ${stillRunning.length} 条:`);
      lines.push(...stillRunning.map(([ref, age]) => `  - ${ref} (已 ${Math.round(age / 60)} 分钟)`));
    }
    return lines.join("\n");
  }
}

function regEntry(state: JsonObject, name: string): JsonObject {
  const entry = state[name];
  return entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
}

/** Handlers for the eleven local tools, keyed exactly as the contract names them. */
export function createLocalTools(store: HubStore): Record<string, (args: JsonObject) => Promise<string>> {
  return {
    hub_heartbeat: (args) => store.heartbeat(args),
    hub_list_tasks: (args) => store.listTasks(args),
    hub_post_task: (args) => store.postTask(args),
    hub_claim_task: (args) => store.claimTask(args),
    hub_complete_task: (args) => store.completeTask(args),
    hub_send_message: (args) => store.sendMessage(args),
    hub_read_messages: (args) => store.readMessages(args),
    hub_note_set: (args) => store.noteSet(args),
    hub_note_get: (args) => store.noteGet(args),
    hub_reap: () => store.reap(),
  };
}
