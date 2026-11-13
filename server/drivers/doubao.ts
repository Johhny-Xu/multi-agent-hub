// 豆包 CLI (@bytedance/doubao-cli) — no ACP, no JSON stream, no MCP injection: `doubao -p "<prompt>"` runs one
// non-interactive turn and prints the answer on stdout. The sign-in and the plan live in the CLI's own store; this
// driver never reads or writes them and takes no API key, so every turn is one child process.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

import { newEventId, newId } from "../contracts.ts";
import type {
  DriverCreateInput, ModelCatalog, ProviderDriver, ProviderInstance, ProviderSnapshot,
  RequestOutcome, RuntimeEvent, RuntimeEventListener, SendTurnInput, TurnStartResult,
} from "../contracts.ts";
import { stripControlPlaneEnv } from "../credential-env.ts";
import { augmentedPath, userHome } from "../env-path.ts";
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";
import { redactSecretsInText } from "../redact.ts";
import type { EffortLevel } from "../../shared/wire.ts";

const DRIVER_KIND = "doubaoAgent";
const DEFAULT_TURN_TIMEOUT_MS = 900_000;
const AUTH_TIMEOUT_MS = 10_000;
const SNAPSHOT_TTL_MS = 60_000;
const MAX_STDOUT_CHARS = 200_000;
const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_FAILURE_CHARS = 500;

export interface DoubaoConfig {
  cli: string;
  workspace?: string;
}

/** The CLI picks its own model unless a bot names one; the picker offers only that. */
export const DOUBAO_MODELS: ModelCatalog = {
  default: "Auto",
  options: [{ id: "Auto", label: "Auto（豆包自动选择）" }],
};

const INSTALL_NOTE =
  "豆包 CLI 没有安装。安装：`npm install -g @bytedance/doubao-cli`，文档 https://www.doubao.com/work/docs/zh-cn/doubao-cli";
const SIGN_IN_NOTE = "豆包 CLI 未登录：在服务器以运行 bot 的用户执行 `doubao login`。";

/** A path-like value (absolute, or one with a separator) decides on its own; a missing one is not a hint to search. */
function isExplicitCli(value: string): boolean {
  return value.length > 0 && (/[/\\]/.test(value) || /^[a-zA-Z]:/.test(value));
}

/** `config.cli` or OMB_DOUBAO_CLI when it names a path, else `doubao` on the instance's PATH and the two usual
 * install folders. */
export function resolveDoubaoCli(env: Record<string, string | undefined>, cli: string): string | null {
  const explicit = [cli, env.OMB_DOUBAO_CLI].find((entry): entry is string => typeof entry === "string" && isExplicitCli(entry));
  if (explicit) return existsSync(explicit) ? explicit : null;
  const path = (env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  for (const dir of path) {
    const candidate = join(dir, process.platform === "win32" ? "doubao.cmd" : "doubao");
    if (existsSync(candidate)) return candidate;
  }
  const home = userHome(env);
  return [join(home, ".npm-global", "bin", "doubao"), join(home, ".local", "bin", "doubao")]
    .find((candidate) => existsSync(candidate)) ?? null;
}

/** `agent_mode` holds one folder per account, each with its own `workspace/.sessions`; the CLI is used by one
 * account on a machine, so every account's ids are read and the newest turn's single new one is the session. */
export function doubaoSessionsRoot(env: Record<string, string | undefined>): string {
  const dataHome = env.XDG_DATA_HOME?.trim() || join(userHome(env), ".local", "share");
  return join(dataHome, "doubao_cli", "agent_mode");
}

/** Numeric session folders under `root` itself, or under each account's `workspace/.sessions` beneath it. */
export function listDoubaoSessionIds(root: string): string[] {
  const sessionDirs = [root];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) sessionDirs.push(join(root, entry.name, "workspace", ".sessions"));
    }
  } catch {}
  const ids = new Set<string>();
  for (const dir of sessionDirs) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && /^\d+$/.test(entry.name)) ids.add(entry.name);
      }
    } catch {}
  }
  return [...ids].sort((a, b) => Number(a) - Number(b));
}

export function doubaoEffort(effort: EffortLevel | undefined): "low" | "medium" | "high" | undefined {
  if (!effort) return undefined;
  if (effort === "none" || effort === "low") return "low";
  if (effort === "medium") return "medium";
  return "high";
}

export interface DoubaoArgsInput {
  prompt: string;
  cwd: string;
  model?: string;
  effort?: EffortLevel;
  resumeId?: string;
}

/** `-p` runs unattended, so `always_allow`; the bypass flag stays off. A model named Auto is the CLI's own default. */
export function doubaoArgs({ prompt, cwd, model, effort, resumeId }: DoubaoArgsInput): string[] {
  const args: string[] = [];
  if (resumeId) args.push("--resume", resumeId);
  args.push("-C", cwd);
  if (model && model !== DOUBAO_MODELS.default) args.push("--model", model);
  const level = doubaoEffort(effort);
  if (level) args.push("--effort", level);
  args.push("--permission-mode", "always_allow", "-p", prompt);
  return args;
}

// oxlint-disable-next-line no-control-regex -- strips ANSI escape sequences
const ANSI = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;

/** stdout's answer without terminal colouring or surrounding blank lines. */
export function cleanDoubaoReply(stdout: string): string {
  return String(stdout ?? "").replace(ANSI, "").trim();
}

export interface DoubaoFailure {
  message: string;
  setup?: boolean;
  limit?: "engine";
}

const tail = (text: string, limit = MAX_FAILURE_CHARS) => text.trim().slice(-limit);

/** Exit code 4 and the CLI's own auth words are a sign-in problem; quota words are the account's plan; anything
 * else is the CLI's stderr so the person can read what it said. */
export function classifyDoubaoFailure(code: number | null, stderr: string, stdout: string): DoubaoFailure {
  const combined = `${stderr ?? ""}\n${stdout ?? ""}`;
  if (code === 4 || /login_required|auth_unavailable/i.test(combined)) {
    return { message: SIGN_IN_NOTE, setup: true };
  }
  if (/订阅|额度|quota|subscription|权益/i.test(combined)) {
    const detail = tail(stderr || stdout);
    return { message: redactSecretsInText(detail ? `豆包套餐额度不足：${detail}` : "豆包套餐额度不足。"), limit: "engine" };
  }
  const detail = tail(stderr || stdout);
  return { message: redactSecretsInText(detail || `豆包 CLI 退出码 ${code ?? "unknown"}。`) };
}

export interface DoubaoDeps {
  spawn: (cli: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;
  exec: (cli: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  listSessions: (root: string) => string[];
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps = (): DoubaoDeps => ({
  spawn: (cli, args, options) => spawnCli(cli, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] }, "bot"),
  exec: (cli, args, options) => new Promise((resolve) => {
    execCli(cli, args, { env: options.env, timeout: options.timeout }, (error, stdout, stderr) => {
      const raw = error as NodeJS.ErrnoException | null;
      resolve({
        code: error ? (typeof raw?.code === "number" ? raw.code : null) : 0,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
      });
    });
  }),
  listSessions: listDoubaoSessionIds,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

function decodeConfig(raw: unknown): DoubaoConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    cli: typeof o.cli === "string" && o.cli.trim() ? o.cli.trim() : "doubao",
    ...(typeof o.workspace === "string" && o.workspace.trim() ? { workspace: o.workspace.trim() } : {}),
  };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The newest turns that fit the budget, oldest first, in the words the CLI will read. */
function replayTranscript(transcript: ReadonlyArray<{ role: "user" | "assistant"; text: string }>): string {
  const lines: string[] = [];
  let used = 0;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index]!;
    const line = `${entry.role === "assistant" ? "助手" : "用户"}：${entry.text}`;
    if (used + line.length > MAX_TRANSCRIPT_CHARS) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  return lines.join("\n\n");
}

/** A new session gets the persona, and the thread it is replacing; a resumed one gets only the new words. */
export function composeDoubaoPrompt(turn: SendTurnInput, resumeId: string | undefined): string {
  if (resumeId) return turn.text;
  const core = turn.system ? `${turn.system}\n\n---\n\n${turn.text}` : turn.text;
  const replay = turn.transcript?.length ? replayTranscript(turn.transcript) : "";
  return replay ? `${replay}\n\n${core}` : core;
}

export function createDoubaoDriver(overrides: Partial<DoubaoDeps> = {}): ProviderDriver<DoubaoConfig> {
  return {
    driverKind: DRIVER_KIND,
    metadata: { displayName: "豆包 Doubao", supportsMultipleInstances: true, access: "subscription" },
    install: { docsUrl: "https://www.doubao.com/work/docs/zh-cn/doubao-cli" },
    decodeConfig,
    defaultConfig: () => decodeConfig({}),
    models: DOUBAO_MODELS,
    async create(input: DriverCreateInput<DoubaoConfig>): Promise<ProviderInstance> {
      const deps: DoubaoDeps = { ...defaultDeps(), ...overrides };
      const env: Record<string, string | undefined> = { ...process.env, ...input.environment, PATH: input.environment.PATH ?? augmentedPath() };
      const timeoutMs = Number(env.OMB_DOUBAO_TIMEOUT_MS) || DEFAULT_TURN_TIMEOUT_MS;
      const listeners = new Set<RuntimeEventListener>();
      const emit = (event: RuntimeEvent) => { for (const listener of Array.from(listeners)) { try { listener(event); } catch {} } };
      const threads = new Map<string, { sessionId?: string; chain: Promise<void> }>();
      const active = new Map<string, { turnId: string; aborted: boolean; child?: ChildProcess }>();
      let disposed = false;
      let cached: { at: number; snapshot: ProviderSnapshot } | undefined;

      /** The CLI's own environment: no control-plane variables, no update prompt. No key is added: the plan is the
       * account's, and the sign-in stays in the CLI's store. */
      const childEnv = (): NodeJS.ProcessEnv => {
        const merged: Record<string, string | undefined> = { ...env, DOUBAO_CLI_NO_UPDATE_CHECK: "1" };
        stripControlPlaneEnv(merged);
        return merged;
      };

      const threadOf = (threadId: string) => {
        let state = threads.get(threadId);
        if (!state) threads.set(threadId, state = { chain: Promise.resolve() });
        return state;
      };

      const stop = async (child: ChildProcess | undefined) => {
        if (!child) return;
        try { child.kill("SIGTERM"); } catch {}
        await killCliTree(child, 2_000).catch(() => false);
      };

      const runTurn = async (thread: { sessionId?: string }, turn: SendTurnInput, state: { turnId: string; aborted: boolean; child?: ChildProcess }) => {
        const base = () => ({ eventId: newEventId(), provider: DRIVER_KIND, threadId: turn.threadId, turnId: state.turnId, createdAt: new Date().toISOString() });
        const fail = (message: string, extra: Partial<{ limit: "engine"; setup: boolean }> = {}) => {
          emit({ ...base(), type: "runtime.error", message, ...extra } as RuntimeEvent);
          emit({ ...base(), type: "turn.completed", ok: false, stopReason: "error", cost: null } as RuntimeEvent);
        };
        const interrupted = () => {
          emit({ ...base(), type: "turn.completed", ok: false, stopReason: "interrupted", cost: null } as RuntimeEvent);
        };

        emit({ ...base(), type: "turn.started" } as RuntimeEvent);
        if (turn.sessionReset) thread.sessionId = undefined;
        const resumeId = turn.sessionReset ? undefined : thread.sessionId;
        emit({ ...base(), type: "session.started", sessionId: resumeId ?? turn.threadId, model: turn.model ?? DOUBAO_MODELS.default } as RuntimeEvent);

        if (turn.guestConfined) {
          fail("豆包不支持受限访客回合。", { setup: true });
          return;
        }
        const cli = resolveDoubaoCli(env, input.config.cli);
        if (!cli) {
          fail(INSTALL_NOTE, { setup: true });
          return;
        }
        const cwd = turn.cwd ?? input.config.workspace ?? userHome(env);
        try {
          mkdirSync(cwd, { recursive: true });
        } catch (error) {
          fail(`豆包的工作目录无法创建：${errorText(error)}`);
          return;
        }
        const root = doubaoSessionsRoot(env);
        let before: string[] = [];
        try { before = deps.listSessions(root); } catch {}
        const prompt = composeDoubaoPrompt(turn, resumeId);

        let child: ChildProcess;
        try {
          child = deps.spawn(cli, doubaoArgs({ prompt, cwd, model: turn.model, effort: turn.effort, resumeId }), { cwd, env: childEnv() });
        } catch (error) {
          fail(errorText(error));
          return;
        }
        state.child = child;

        let stdout = "";
        let stderr = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          if (stdout.length < MAX_STDOUT_CHARS) stdout += chunk.slice(0, MAX_STDOUT_CHARS - stdout.length);
        });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          if (stderr.length < MAX_STDOUT_CHARS) stderr += chunk.slice(0, MAX_STDOUT_CHARS - stderr.length);
        });

        let timedOut = false;
        const outcome = await new Promise<{ code: number | null; error?: NodeJS.ErrnoException }>((resolve) => {
          let settled = false;
          let timer: NodeJS.Timeout | undefined;
          const done = (value: { code: number | null; error?: NodeJS.ErrnoException }) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(value);
          };
          timer = setTimeout(() => {
            timedOut = true;
            void stop(child);
          }, timeoutMs);
          child.once("error", (error) => done({ code: null, error }));
          child.once("close", (code) => done({ code: code ?? null }));
        });
        state.child = undefined;

        if (state.aborted || disposed) {
          interrupted();
          return;
        }
        if (timedOut) {
          fail(`豆包 ${Math.round(timeoutMs / 1000)} 秒内没有完成。`);
          return;
        }
        if (outcome.error) {
          const described = describeSpawnFailure(outcome.error, cli, cwd);
          fail(described.message, described.setup ? { setup: true } : {});
          return;
        }

        const reply = cleanDoubaoReply(stdout);
        if (outcome.code === 0 && reply) {
          let after: string[] = [];
          try { after = deps.listSessions(root); } catch {}
          const added = after.filter((id) => !before.includes(id));
          if (added.length === 1) thread.sessionId = added[0];
          else if (added.length > 1) thread.sessionId = undefined;
          else if (!resumeId) thread.sessionId = undefined;
          emit({ ...base(), type: "content.delta", streamKind: "assistant_text", delta: reply } as RuntimeEvent);
          emit({ ...base(), type: "item.completed", itemType: "assistant_text", text: reply } as RuntimeEvent);
          emit({ ...base(), type: "turn.completed", ok: true, stopReason: "end_turn", cost: null } as RuntimeEvent);
          return;
        }

        const failure = classifyDoubaoFailure(outcome.code, stderr, stdout);
        fail(failure.message, {
          ...(failure.setup ? { setup: true } : {}),
          ...(failure.limit ? { limit: failure.limit } : {}),
        });
      };

      const adapter: ProviderInstance["adapter"] = {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "unsupported" as const },
        async sendTurn(turn: SendTurnInput): Promise<TurnStartResult> {
          if (disposed) throw new Error("豆包 instance was stopped");
          const turnId = newId();
          const state = { turnId, aborted: false };
          const thread = threadOf(turn.threadId);
          active.set(turn.threadId, state);
          thread.chain = thread.chain
            .then(() => {
              if (disposed) return;
              if (state.aborted) {
                emit({
                  eventId: newEventId(), provider: DRIVER_KIND, threadId: turn.threadId, turnId,
                  createdAt: new Date().toISOString(), type: "turn.completed", ok: false, stopReason: "interrupted", cost: null,
                } as RuntimeEvent);
                return;
              }
              return runTurn(thread, turn, state);
            })
            .catch(() => {})
            .finally(() => { if (active.get(turn.threadId) === state) active.delete(turn.threadId); });
          return { turnId };
        },
        async interruptTurn(threadId: string): Promise<void> {
          const state = active.get(threadId);
          if (!state) return;
          state.aborted = true;
          await stop(state.child);
        },
        respondToRequest: (): Promise<RequestOutcome> => Promise.resolve("unavailable"),
        hasSession: (threadId: string) => Boolean(threads.get(threadId)?.sessionId),
        async stopAll(): Promise<void> {
          for (const state of active.values()) state.aborted = true;
          await Promise.all([...active.values()].map((state) => stop(state.child)));
        },
        onEvent(listener: RuntimeEventListener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
      };

      const snapshot = async (): Promise<ProviderSnapshot> => {
        const now = deps.now();
        if (cached && now - cached.at < SNAPSHOT_TTL_MS) return cached.snapshot;
        const cli = resolveDoubaoCli(env, input.config.cli);
        let result: ProviderSnapshot;
        if (!cli) {
          result = { state: "unavailable", reason: INSTALL_NOTE };
        } else {
          try {
            const probed = await deps.exec(cli, ["auth", "status"], { env: childEnv(), timeout: AUTH_TIMEOUT_MS });
            const output = `${probed.stderr}\n${probed.stdout}`;
            if (probed.code === 0) {
              result = { state: "available", authenticated: true, billing: "subscription" };
            } else if (probed.code === 4 || /login_required|auth_unavailable/i.test(output)) {
              result = { state: "unavailable", authenticated: false, reason: SIGN_IN_NOTE };
            } else {
              const detail = tail(probed.stderr || probed.stdout);
              result = {
                state: "unavailable",
                authenticated: false,
                reason: redactSecretsInText(detail || `\`doubao auth status\` 退出码 ${probed.code ?? "unknown"}。`),
              };
            }
          } catch (error) {
            result = { state: "unavailable", reason: `无法运行 \`doubao auth status\`：${errorText(error)}` };
          }
        }
        cached = { at: now, snapshot: result };
        return result;
      };

      return {
        instanceId: input.instanceId,
        driverKind: DRIVER_KIND,
        displayName: input.displayName,
        enabled: input.enabled,
        models: DOUBAO_MODELS,
        adapter,
        snapshot,
        dispose: async () => { disposed = true; await adapter.stopAll(); },
      };
    },
  };
}

export const DoubaoAgentDriver: ProviderDriver<DoubaoConfig> = createDoubaoDriver();
