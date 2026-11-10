// Trae Code — drives ByteDance's Trae CN desktop IDE (`trae-cn`, a VSCode fork) the way the mah product did: through
// a TraeClaw HTTP bridge (github firerlAGI/TraeClaw, MIT; default http://127.0.0.1:8787) that holds a CDP session on
// the desktop app (started under a virtual display with --remote-debugging-port). The IDE has no headless agent
// interface of its own — its `chat` subcommand opens a desktop window and it has no ACP mode — so the bridge types the
// prompt into the chat box and presses send, and this driver reads the reply back out of the page over the same CDP
// port, because the bridge's own answer is only the first-paint placeholder ("TRAE 思考中") since Trae 1.107.
//
// One desktop app holds one visible conversation, so turns run one at a time: a turn from a different thread (or a
// reset) starts a fresh Trae task first, and a follow-up on the same thread continues the open one. Sign-in lives in
// the desktop app; this server never reads or writes it — only the presence of the IDE's JWT file is tested.
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { newEventId, newId } from "../contracts.ts";
import type {
  DriverCreateInput, ModelCatalog, ProviderDriver, ProviderInstance, ProviderSnapshot,
  RequestOutcome, RuntimeEvent, RuntimeEventListener, SendTurnInput, TurnStartResult,
} from "../contracts.ts";
import { userHome } from "../env-path.ts";

export interface TraecodeConfig {
  cli: string;
  fullAuto: boolean;
  workspace?: string;
  /** The TraeClaw bridge; else OMB_TRAECODE_GATEWAY / TRAE_GATEWAY, else http://127.0.0.1:8787. */
  gatewayUrl?: string;
  /** The desktop app's CDP endpoint; else OMB_TRAECODE_CDP, else http://127.0.0.1:9222. */
  cdpUrl?: string;
}

/** The desktop app answers with whatever model is selected in its own chat box. */
export const TRAECODE_MODELS: ModelCatalog = {
  default: "trae-desktop",
  options: [{ id: "trae-desktop", label: "Trae (desktop's selected model)" }],
};

const DEFAULT_GATEWAY = "http://127.0.0.1:8787";
const DEFAULT_CDP = "http://127.0.0.1:9222";
const DEFAULT_TURN_TIMEOUT_MS = 900_000;
const MAX_REPLY_CHARS = 20_000;

const SIGN_IN_NOTE =
  "Trae is not signed in on this server — open the Trae CN desktop window (the server's VNC desktop) and sign in, then check again.";
const QUEUE_MARKERS = ["排队提醒", "当前模型请求量较高", "升级权益等待中"];

/** The IDE's own JWT (`~/.trae-cn/trae-jwt-token`, legacy `~/.trae`); its presence is the sign-in,
 * and no token is read here. */
export function traecodeSignedIn(env: Record<string, string | undefined>): boolean {
  const home = userHome(env);
  return [join(home, ".trae-cn", "trae-jwt-token"), join(home, ".trae", "trae-jwt-token")]
    .some((path) => existsSync(path));
}

/** What the instance runs: an absolute `cli` (or OMB_TRAECODE_CLI) decides alone, else the IDE's
 * standard install paths. Existence checks only — the desktop app is started by its own service, not here. */
export function resolveTraecodeCli(env: Record<string, string | undefined>, cli: string): string | null {
  const explicit = [cli, env.OMB_TRAECODE_CLI]
    .find((entry) => typeof entry === "string" && entry.length > 0 && (isAbsolute(entry) || entry.includes("/")));
  if (typeof explicit === "string") return existsSync(explicit) ? explicit : null;
  const home = userHome(env);
  return ["/usr/bin/trae-cn", "/usr/share/trae-cn/bin/trae-cn", join(home, ".local", "bin", "traecode"), join(home, ".local", "bin", "trae")]
    .find((path) => existsSync(path)) ?? null;
}

const trimSlash = (url: string) => url.replace(/\/+$/, "");

export function traecodeEndpoints(env: Record<string, string | undefined>, config: TraecodeConfig): { gateway: string; cdp: string } {
  const pick = (...values: Array<string | undefined>) => values.find((v) => typeof v === "string" && v.trim().length > 0)?.trim();
  return {
    gateway: trimSlash(pick(config.gatewayUrl, env.OMB_TRAECODE_GATEWAY, env.TRAE_GATEWAY) ?? DEFAULT_GATEWAY),
    cdp: trimSlash(pick(config.cdpUrl, env.OMB_TRAECODE_CDP) ?? DEFAULT_CDP),
  };
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "[::1]" || host === "::1" || host.startsWith("127.");
  } catch {
    return false;
  }
}

/** The local half of the snapshot: an IDE on this box, signed in. Skipped when the bridge lives on another machine. */
export function traecodeLocalSnapshot(env: Record<string, string | undefined>, config: TraecodeConfig): ProviderSnapshot | null {
  if (!isLoopback(traecodeEndpoints(env, config).gateway)) return null;
  if (!resolveTraecodeCli(env, config.cli)) {
    return {
      state: "unavailable",
      reason: "Trae Code (the Trae CN desktop IDE) isn't installed on this server. Install it from https://www.trae.cn, then check again.",
    };
  }
  if (!traecodeSignedIn(env)) return { state: "unavailable", reason: SIGN_IN_NOTE };
  return null;
}

/** What one read of the Trae page found: the newest agent turn and whether it has finished. */
export interface TraePageReading {
  count: number;
  text: string;
  done: boolean;
  generating: boolean;
  composer: boolean;
}

/** Reads the newest `.turn__agent-message`: its markdown blocks (thinking left out), finished once the turn grows its
 * footer bar (`由 AI 生成`, actions, context meter) and the send button is no longer a stop button. */
export const TRAE_READ_EXPRESSION = `(() => {
  const turns = [...document.querySelectorAll('.turn__agent-message')];
  const composer = !!document.querySelector('.chat-input-v2-input-box-editable');
  const send = document.querySelector('button.chat-input-v2-send-button');
  const sendIcon = send ? ((send.innerHTML.match(/data-testid="([^"]+)"/) || [])[1] || '') : '';
  const generating = /stop|pause|loading/i.test(sendIcon + ' ' + (send ? String(send.className) : ''));
  const last = turns[turns.length - 1];
  if (!last) return { count: 0, text: '', done: false, generating, composer };
  const blocks = [...last.querySelectorAll('.markdown-renderer')].filter((el) =>
    !el.closest('[class*="think"], [class*="reason"]') && !(el.parentElement && el.parentElement.closest('.markdown-renderer')));
  let text = blocks.map((el) => (el.innerText || el.textContent || '').trim()).filter(Boolean).join('\\n\\n');
  if (!text) {
    const copy = last.cloneNode(true);
    copy.querySelectorAll('.agent-message__header, .latest-assistant-bar, [class*="think"], [class*="reason"]').forEach((el) => el.remove());
    text = (copy.innerText || copy.textContent || '').trim();
  }
  const done = !!last.querySelector('.latest-assistant-bar, .assistant-action-bar, .core-finish-card');
  return { count: turns.length, text: text.slice(0, ${MAX_REPLY_CHARS}), done, generating, composer };
})()`;

/** Clicks the send button while it is a stop button; nothing otherwise. */
const TRAE_STOP_EXPRESSION = `(() => {
  const send = document.querySelector('button.chat-input-v2-send-button');
  if (!send) return false;
  const icon = (send.innerHTML.match(/data-testid="([^"]+)"/) || [])[1] || '';
  if (!/stop|pause/i.test(icon + ' ' + String(send.className))) return false;
  send.click();
  return true;
})()`;

/** `思考中` and friends: the first paint of a turn, never its answer. */
export function isTraePlaceholder(text: string): boolean {
  const condensed = String(text ?? "").replace(/\s+/g, "");
  if (!condensed) return true;
  if (condensed.length > 24) return false;
  return /思考中|生成中|thinking/i.test(condensed) || /^TRAE$/i.test(condensed);
}

/** The visible reply without the turn's own chrome (the agent name header, the AI disclaimer, the context meter). */
export function cleanTraeReply(text: string): string {
  return String(text ?? "")
    .replace(/^\s*TRAE\s*\n/, "")
    .replace(/\n\s*由 AI 生成\s*(\n\s*\d+\s*%\s*)?$/, "")
    .replace(/\n\s*\d+\s*%\s*$/, "")
    .trim();
}

export interface TraecodeDeps {
  fetch: typeof fetch;
  /** Evaluates an expression in the Trae page over CDP and returns its value. */
  evaluate: (cdpUrl: string, expression: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollMs: number;
}

/** One Runtime.evaluate over a short-lived CDP socket on the desktop app's chat page. */
export async function cdpEvaluate(cdpUrl: string, expression: string): Promise<unknown> {
  const list = await (await fetch(`${cdpUrl}/json/list`, { signal: AbortSignal.timeout(5_000) })).json() as Array<Record<string, string>>;
  const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const page = pages.find((t) => /solo|workbench/.test(t.url ?? "") || t.title === "Agent") ?? pages[0];
  if (!page) throw new Error("Trae desktop exposes no page on its debugging port");
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("Trae page did not answer over CDP")); }, 10_000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: unknown }; exceptionDetails?: unknown } };
      if (message.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (message.result?.exceptionDetails) reject(new Error("Trae page read failed"));
      else resolve(message.result?.result?.value);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("Trae debugging port refused the connection")); };
  });
}

const defaultDeps = (): TraecodeDeps => ({
  fetch: (...args) => fetch(...args),
  evaluate: cdpEvaluate,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  pollMs: 2_000,
});

function asReading(value: unknown): TraePageReading {
  const o = (value ?? {}) as Record<string, unknown>;
  return {
    count: typeof o.count === "number" ? o.count : 0,
    text: typeof o.text === "string" ? o.text : "",
    done: o.done === true,
    generating: o.generating === true,
    composer: o.composer === true,
  };
}

function decodeConfig(raw: unknown): TraecodeConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const url = (value: unknown) => (typeof value === "string" && /^https?:\/\//.test(value.trim()) ? trimSlash(value.trim()) : undefined);
  return {
    cli: typeof o.cli === "string" ? o.cli : "traecode",
    fullAuto: o.fullAuto === true,
    workspace: typeof o.workspace === "string" ? o.workspace : undefined,
    gatewayUrl: url(o.gatewayUrl),
    cdpUrl: url(o.cdpUrl),
  };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createTraecodeDriver(overrides: Partial<TraecodeDeps> = {}): ProviderDriver<TraecodeConfig> {
  return {
    driverKind: "traecodeAgent",
    metadata: { displayName: "Trae Code", supportsMultipleInstances: true, access: "subscription" },
    install: { docsUrl: "https://www.trae.cn" },
    decodeConfig,
    defaultConfig: () => decodeConfig({}),
    models: TRAECODE_MODELS,
    async create(input: DriverCreateInput<TraecodeConfig>): Promise<ProviderInstance> {
      const deps: TraecodeDeps = { ...defaultDeps(), ...overrides };
      const env = input.environment;
      const { gateway, cdp } = traecodeEndpoints(env, input.config);
      const timeoutMs = Math.max(30_000, Number(env.OMB_TRAECODE_TIMEOUT_MS) || DEFAULT_TURN_TIMEOUT_MS);
      const listeners = new Set<RuntimeEventListener>();
      const emit = (event: RuntimeEvent) => { for (const listener of Array.from(listeners)) { try { listener(event); } catch {} } };
      const active = new Map<string, { turnId: string; aborted: boolean }>();
      // The desktop shows one conversation: the thread it belongs to, and a chain that runs turns one at a time.
      let openThread: string | null = null;
      let chain: Promise<void> = Promise.resolve();
      let disposed = false;

      const read = async (): Promise<TraePageReading> => asReading(await deps.evaluate(cdp, TRAE_READ_EXPRESSION));

      const postChat = async (text: string, newChat: boolean): Promise<string> => {
        let body: any;
        try {
          const response = await deps.fetch(`${gateway}/v1/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: text, ...(newChat ? { newChat: true } : {}), sessionMetadata: { client: "omb" } }),
            signal: AbortSignal.timeout(120_000),
          });
          body = await response.json();
        } catch (error) {
          throw new Error(`Can't reach the Trae bridge at ${gateway} (${errorText(error)}). Check that the Trae CN desktop and its TraeClaw gateway are running.`);
        }
        if (!body || typeof body !== "object") throw new Error("The Trae bridge gave no answer");
        if (body.success === false || body.error) {
          throw new Error(`The Trae bridge refused the prompt: ${String(body.message ?? body.error ?? body.code ?? "unknown error").slice(0, 300)}`);
        }
        const result = body.data?.result ?? {};
        const status = String(result.status ?? body.data?.session?.status ?? "").toLowerCase();
        if (status === "error" || status === "failed") throw new Error(`Trae failed the prompt: ${String(result.error ?? status).slice(0, 300)}`);
        return typeof result.response?.text === "string" ? result.response.text : typeof result.text === "string" ? result.text : "";
      };

      const runTurn = async (turn: SendTurnInput, turnId: string, state: { aborted: boolean }) => {
        const base = () => ({ eventId: newEventId(), provider: "traecodeAgent" as const, threadId: turn.threadId, turnId, createdAt: new Date().toISOString() });
        const fail = (message: string, extra: Partial<{ limit: "engine"; setup: boolean }> = {}) => {
          emit({ ...base(), type: "runtime.error", message, ...extra } as RuntimeEvent);
          emit({ ...base(), type: "turn.completed", ok: false, stopReason: "error", cost: null } as RuntimeEvent);
        };
        // The live stream shows the delta; the thread keeps the reply from item.completed.
        const say = (text: string) => {
          emit({ ...base(), type: "content.delta", streamKind: "assistant_text", delta: text } as RuntimeEvent);
          emit({ ...base(), type: "item.completed", itemType: "assistant_text", text } as RuntimeEvent);
        };
        emit({ ...base(), type: "turn.started" } as RuntimeEvent);
        emit({ ...base(), type: "session.started", sessionId: turn.threadId, model: TRAECODE_MODELS.default } as RuntimeEvent);
        const local = traecodeLocalSnapshot(env, input.config);
        if (local) return fail(local.reason ?? SIGN_IN_NOTE, { setup: true });
        const newChat = turn.sessionReset === true || openThread !== turn.threadId;
        // Only the turn's own words go in: the harness's system prompt is written for engines with a system channel, and
        // typed into the desktop chat box it would bury the task.
        const prompt = turn.text;
        let baseline = 0;
        try {
          if (!newChat) baseline = (await read()).count;
          // The bridge's own answer is the first paint ("TRAE 思考中"); the reply is read from the page below.
          await postChat(prompt, newChat);
          openThread = turn.threadId;
          if (newChat) baseline = 0;
          const deadline = deps.now() + timeoutMs;
          let last = "";
          let stable = 0;
          let reading: TraePageReading | null = null;
          while (!state.aborted && !disposed) {
            if (deps.now() > deadline) {
              const partial = cleanTraeReply(last);
              if (partial) say(partial);
              return fail(`Trae didn't finish within ${Math.round(timeoutMs / 60_000)} min${partial ? " (its reply so far is above)" : ""}.`);
            }
            await deps.sleep(deps.pollMs);
            try { reading = await read(); } catch { reading = null; continue; }
            if (!reading.composer && reading.count === 0) continue;
            if (reading.count <= baseline) continue;
            const text = reading.text;
            if (isTraePlaceholder(cleanTraeReply(text))) { stable = 0; continue; }
            if (text === last) stable += 1; else { last = text; stable = 0; }
            if (reading.done && !reading.generating && stable >= 1) break;
          }
          if (state.aborted || disposed) {
            emit({ ...base(), type: "turn.completed", ok: false, stopReason: "interrupted", cost: null } as RuntimeEvent);
            return;
          }
          const reply = cleanTraeReply(last);
          if (QUEUE_MARKERS.some((marker) => reply.includes(marker))) {
            return fail(`Trae is queueing requests right now: ${reply.slice(0, 200)}`, { limit: "engine" });
          }
          say(reply);
          emit({ ...base(), type: "turn.completed", ok: true, stopReason: "end_turn", cost: null } as RuntimeEvent);
        } catch (error) {
          if (newChat) openThread = null;
          fail(errorText(error));
        }
      };

      const adapter = {
        provider: "traecodeAgent" as const,
        capabilities: { sessionModelSwitch: "unsupported" as const },
        async sendTurn(turn: SendTurnInput): Promise<TurnStartResult> {
          if (disposed) throw new Error("Trae Code instance was stopped");
          const turnId = newId();
          const state = { turnId, aborted: false };
          active.set(turn.threadId, state);
          chain = chain.then(() => (state.aborted ? undefined : runTurn(turn, turnId, state)))
            .catch(() => {})
            .finally(() => { if (active.get(turn.threadId) === state) active.delete(turn.threadId); });
          return { turnId };
        },
        async interruptTurn(threadId: string): Promise<void> {
          const state = active.get(threadId);
          if (!state) return;
          state.aborted = true;
          try { await deps.evaluate(cdp, TRAE_STOP_EXPRESSION); } catch {}
        },
        respondToRequest: (): Promise<RequestOutcome> => Promise.resolve("unavailable"),
        hasSession: (threadId: string) => openThread === threadId,
        async stopAll(): Promise<void> {
          for (const state of active.values()) state.aborted = true;
        },
        onEvent(listener: RuntimeEventListener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
      };

      const snapshot = async (): Promise<ProviderSnapshot> => {
        const local = traecodeLocalSnapshot(env, input.config);
        if (local) return local;
        try {
          const response = await deps.fetch(`${gateway}/ready`, { signal: AbortSignal.timeout(8_000) });
          const body = await response.json() as any;
          const details = body?.data?.automation?.details ?? body?.data?.automation ?? {};
          if (body?.success && body?.data?.automation?.ready !== false && details.composerFound !== false) {
            return { state: "available", authenticated: true, billing: "subscription" };
          }
          return {
            state: "unavailable",
            reason: details.composerFound === false
              ? `The Trae desktop is up but shows no chat box — it may be signed out or on another screen. ${SIGN_IN_NOTE}`
              : `The Trae bridge at ${gateway} isn't ready: ${String(body?.message ?? body?.code ?? "unknown").slice(0, 200)}`,
          };
        } catch (error) {
          return {
            state: "unavailable",
            reason: `Can't reach the Trae bridge at ${gateway} (${errorText(error)}). Start the Trae CN desktop with --remote-debugging-port and its TraeClaw gateway.`,
          };
        }
      };

      return {
        instanceId: input.instanceId,
        driverKind: "traecodeAgent",
        displayName: input.displayName,
        enabled: input.enabled,
        models: TRAECODE_MODELS,
        adapter,
        snapshot,
        dispose: async () => { disposed = true; await adapter.stopAll(); },
      };
    },
  };
}

export const TraecodeAgentDriver: ProviderDriver<TraecodeConfig> = createTraecodeDriver();
