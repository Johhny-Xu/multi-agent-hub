// The bots' browser runs on agent-browser or, with browserEngine.engine set to "chrome", on OpenMausBot's own Chrome
// driver. A session's spec says which: the new engine's names the profile it drives. Everything that reaches a browser
// goes through the two routers here, which keep the agent-browser engine's API.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { browserRunInputSchema, type BrowserFailureReason, type BrowserRunResult } from "../../shared/browser-automation.ts";
import type { BrowserLive } from "../browser-live.ts";
import type { BrowserRuntime, BrowserSpawnSpec } from "../browser-runtime.ts";
import type { StepContext } from "../browser-steps.ts";
import type { FillLoginDeps } from "../login-fill.ts";
import { LocalBackend } from "./backends.ts";
import { sandboxDisabled } from "./chrome/host-setup.ts";
import type { HostKind } from "./chrome/flags.ts";
import { ChromeLauncher } from "./chrome/launcher.ts";
import { ProcessRegistry, sweep } from "./chrome/processes.ts";
import { browserRoot } from "./chrome/profile.ts";
import { browserLanguage, browserTimeZone, languageList } from "./chrome/wrapper.ts";
import { displayScreen } from "./display.ts";
import type { Download } from "./cdp/downloads.ts";
import { BrowserService, type BrowserTarget } from "./service.ts";
import type { BrowserGateway } from "./jev.ts";
import type { BrowserScope } from "./jev-types.ts";
import { browserToolList } from "./tools.ts";
import { LiveV1 } from "./viewers/live-v1.ts";
import { StreamV2, type StreamRequest } from "./viewers/stream-v2.ts";

/** A spec's command when the new engine runs the session; its one argument is the profile key. */
export const CHROME_ENGINE = "omb-cdp";

type Spec = Pick<BrowserSpawnSpec, "command" | "env"> & { args?: readonly string[] };

export function chromeTarget(session: string, spec: { command: string; args?: readonly string[] } | undefined): BrowserTarget | null {
  const key = spec?.command === CHROME_ENGINE ? spec.args?.[0] : undefined;
  return key ? { session, key } : null;
}

/** The profile a bot's browser is on the new engine: its own, a shared one, or a temporary one. */
export function profileKey(botId: string, session: string, profile: { guest: boolean; partitionId: string | null }): string {
  if (profile.guest) return `temp:${session}`;
  return profile.partitionId ? `shared:${profile.partitionId}` : `bot:${botId}`;
}

const MAX_RUNNING: Record<HostKind, number> = { desktop: 6, server: 4, container: 2 };
const SWEEP_MS = 60_000;

export interface ChromeEngineOptions {
  dataDir: string;
  host: HostKind;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  egressPort(key: string): Promise<number>;
  idleMs(): number;
  held?(session: string): boolean;
  egressNotice(key: string): string | null;
  log?: (line: string) => void;
}

/** The new engine: one Chrome launcher (no agent-browser wrapper), the browser service, its live views and its sweep. */
export class ChromeEngine {
  readonly launcher: ChromeLauncher;
  readonly service: BrowserService;
  readonly live: LiveV1;
  readonly stream: StreamV2;
  readonly #targets = new Map<string, string>();
  readonly #registry: ProcessRegistry;
  readonly #options: ChromeEngineOptions;
  #timer: ReturnType<typeof setInterval> | null = null;
  #inUse = false;
  #cleared = false;

  constructor(options: ChromeEngineOptions) {
    this.#options = options;
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const sandbox = !sandboxDisabled(env);
    this.launcher = new ChromeLauncher({ dataDir: options.dataDir, env, platform, engine: () => ({ managed: true }), wrapper: false, sandbox, ...(options.log ? { log: options.log } : {}) });
    this.#registry = new ProcessRegistry(browserRoot(options.dataDir));
    let screen: ReturnType<typeof displayScreen> | null = null;
    const locale = browserLanguage(env) ?? null;
    const backend = new LocalBackend({
      dataDir: options.dataDir,
      host: options.host,
      platform,
      binary: async () => {
        const binary = await this.launcher.binary();
        return { path: binary.path, identity: { ...binary.identity, product: binary.product } };
      },
      screen: () => (screen ??= displayScreen(options.host, { platform, env })),
      locale: () => locale,
      acceptLanguages: () => languageList(locale ?? undefined),
      timezone: () => browserTimeZone(env, platform) ?? null,
      egressPort: (key) => options.egressPort(key),
      registry: this.#registry,
      sandbox,
      ...(options.log ? { log: options.log } : {}),
    });
    const maxRunning = Number(env.OMB_BROWSER_MAX_RUNNING) || MAX_RUNNING[options.host];
    this.service = new BrowserService({
      dataDir: options.dataDir,
      backend: () => backend,
      maxRunning,
      idleMs: options.idleMs,
      held: options.held,
      egressNotice: options.egressNotice,
      ...(options.log ? { log: options.log } : {}),
    });
    this.live = new LiveV1({ service: this.service, target: (session) => this.target(session) });
    this.stream = new StreamV2({ service: this.service });
  }

  /** The spec a session gets on the new engine, remembered so its live view finds the profile. */
  spec(session: string, key: string): { command: string; args: string[]; env: Record<string, string> } {
    this.#targets.set(session, key);
    return { command: CHROME_ENGINE, args: [key], env: {} };
  }

  target(session: string): BrowserTarget | null {
    const key = this.#targets.get(session);
    return key ? { session, key } : null;
  }

  /**
   * In use, it prepares Chrome before a bot needs it. In use, or while a Chrome it started still runs, it closes idle
   * browsers and stray processes every minute. Otherwise it only clears, once, what an earlier run of the engine left
   * behind, so a server that never turned it on lists no processes.
   */
  start({ inUse, prepare }: { inUse: boolean; prepare: boolean }): void {
    const starting = inUse && !this.#inUse;
    this.#inUse = inUse;
    if (!inUse && !this.#cleared && this.#everUsed()) this.#tick();
    this.#cleared = true;
    if (inUse && prepare && this.launcher.plan().kind !== "legacy") void this.launcher.prepare();
    if (starting) this.#tick();
    this.#timer ??= setInterval(() => { if (this.#inUse || this.#running()) this.#tick(); }, SWEEP_MS);
    this.#timer.unref?.();
  }

  #tick(): void {
    void this.service.closeIdle().catch(() => undefined);
    void sweep({ root: browserRoot(this.#options.dataDir), registry: this.#registry }).catch(() => undefined);
  }

  #running(): boolean {
    return this.service.profiles().some((profile) => profile.run || profile.starting) || this.#registry.list().length > 0;
  }

  /** Whether this engine ever made a profile in this data folder. */
  #everUsed(): boolean {
    const root = browserRoot(this.#options.dataDir);
    return existsSync(join(root, "profiles")) || existsSync(join(root, "temp"));
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.live.closeAll();
    this.stream.closeAll();
    await this.service.closeAll();
  }

  /** A deleted bot's or profile's browser: stopped, and its folder, downloads and screenshots gone. */
  async erase(request: { kind: "bot" | "profile"; id: string; partitionId: string }): Promise<boolean> {
    const key = request.kind === "bot" ? `bot:${request.id}` : `shared:${request.partitionId}`;
    if (!this.#everUsed()) return true;
    try {
      await this.service.erase(key);
      return true;
    } catch (error) {
      this.#options.log?.(`browser cleanup: could not erase ${key}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** For the browser status: what the new engine will run here. */
  summary(): { kind: "engine"; version: string; chrome: string } | { kind: "unavailable"; reason: string } {
    const plan = this.launcher.plan();
    if (plan.kind === "legacy") return { kind: "unavailable", reason: `Chrome is needed for the new browser: ${plan.reason}` };
    return { kind: "engine", version: "omb-cdp", chrome: this.launcher.describe() };
  }

  /** fill_login's reads and typing on the new engine. */
  loginDeps(session: string): Pick<FillLoginDeps, "engine" | "insertText" | "press" | "click"> | null {
    const target = this.target(session);
    return target ? this.service.loginDeps(target) : null;
  }
}

export interface RuntimeRouterOptions {
  /** What a tool call is told instead of reaching either engine, or null to run it. */
  refusal?(session: string, spec: BrowserSpawnSpec, params: unknown, ctx?: StepContext): string | null;
  /** Asked each time beforeDispatch ran, so after it claimed the session for this call's turn and before anything reaches
   * the engine: what a refusal that depends on who is calling tells the call, or null to run it. */
  afterClaim?(session: string, spec: BrowserSpawnSpec): string | null;
  /** The new engine's browser automation: tools/list offers agent_browser_run where automation is ready and the gateway
   * answers it, and tools/call runs it there after the exact tools' authorization chain. gateway is null for a target
   * whose transport cannot observe the page fast enough, so the run tool is neither offered nor answered there. */
  jev?: {
    automationReady(): boolean;
    gateway(target: BrowserTarget): BrowserGateway | null;
    scope(session: string, spec: BrowserSpawnSpec, ctx?: StepContext): BrowserScope;
  };
  /** A tool call's answer as the bot gets it, from either engine. */
  annotate?(spec: BrowserSpawnSpec, result: unknown): unknown;
  /** The annotated answer, last, for what only the session's host knows about it. */
  afterCall?(session: string, spec: BrowserSpawnSpec, result: unknown): unknown;
}

/** afterClaim's refusal, thrown out of the engine's dispatch and answered as the call's result. */
class ClaimRefused extends Error {}

const RUN_TOOL = "agent_browser_run";

function isRunCall(params: unknown): boolean {
  return typeof params === "object" && params !== null && (params as { name?: unknown }).name === RUN_TOOL;
}

/** Why a run stopped, as the bot reads it; a reason outside the map is named as its fixed token. */
const RUN_REASONS: Partial<Record<BrowserFailureReason, string>> = {
  "cancelled": "the task was cancelled",
  "disabled": "browser automation is switched off in the settings",
  "done-unverified": "the task judged itself done, but no expect conditions were given to verify it",
  "budget": "the task used up its step or time budget",
  "expectation-unmet": "the task judged itself done, but the expected conditions did not hold",
  "invalid-decision": "the decision model chose an element that is no longer on the page",
  "low-confidence": "the decision model was not confident enough to choose the next action",
  "no-progress": "the task ran out of steps before reaching the goal",
  "not-ready": "the decision model for browser automation is not set up",
  "permission-denied": "an action the task needed is not permitted",
  "permission-required": "an action needs a permission that has not been granted",
  "stale-observation": "the page changed before the chosen action could run",
  "text-model-failed": "no text could be produced for the field it stopped at",
  "unknown-outcome": "an action was sent but its outcome is unknown",
  "unsupported-observation": "the page could not be observed for automation; is a page open?",
  "blocked": "the decision model judged the task blocked, such as by a sign-in, captcha or payment",
};

/** A run's outcome as the bot reads it: what happened, why it stopped, and the call that continues it. */
function browserRunResult(result: BrowserRunResult): { content: Array<{ type: "text"; text: string }>; isError?: true } {
  const steps = result.steps.length
    ? ` Steps: ${result.steps.map((step, index) => `${step.stepNumber ?? index + 1}. ${step.action} (${step.state})`).join("; ")}.`
    : "";
  const why = result.reason ? RUN_REASONS[result.reason] ?? result.reason : "";
  const text = (() => {
    switch (result.status) {
      case "completed":
        return `The browser task completed, and every expect condition held.${steps}`;
      case "needs-input": {
        const field = result.pendingField;
        return [
          "The browser task paused for text to put in a field before it can go on.",
          field ? `It stopped at the ${field.field.role} named "${field.field.label}". ${field.instruction} Call agent_browser_run again with textReply set to { requestId: "${field.requestId}", value: { text: "the text" } }, with text null to leave the field empty, to continue where it stopped.` : "",
          why,
        ].filter(Boolean).join(" ") + steps;
      }
      case "needs-agent":
        return `The browser task stopped before finishing and is back with you: ${why || "no reason given"}.${steps} Take a fresh agent_browser_snapshot and continue with the exact tools.`;
      case "interrupted":
        return `The browser task was cancelled before finishing; what it already did may have taken effect.${steps} Check the page before repeating anything.`;
      case "uncertain":
        return `The browser task stopped with an action's outcome unknown.${steps} Do not repeat the last action yet: check the page with a fresh snapshot or read first.`;
    }
  })();
  return { content: [{ type: "text", text }], ...(result.status === "interrupted" || result.status === "uncertain" ? { isError: true as const } : {}) };
}

/** BrowserRuntime's API, each call going to the engine its session runs on. */
export class RuntimeRouter {
  readonly #old: BrowserRuntime;
  readonly #chrome: ChromeEngine;
  readonly #refusal: RuntimeRouterOptions["refusal"];
  readonly #afterClaim: RuntimeRouterOptions["afterClaim"];
  readonly #jev: RuntimeRouterOptions["jev"];
  readonly #annotate: RuntimeRouterOptions["annotate"];
  readonly #afterCall: RuntimeRouterOptions["afterCall"];

  constructor(old: BrowserRuntime, chrome: ChromeEngine, options: RuntimeRouterOptions = {}) {
    this.#old = old;
    this.#chrome = chrome;
    this.#refusal = options.refusal;
    this.#afterClaim = options.afterClaim;
    this.#jev = options.jev;
    this.#annotate = options.annotate;
    this.#afterCall = options.afterCall;
  }

  async agentRpc(session: string, spec: BrowserSpawnSpec, method: "tools/list" | "tools/call", params: unknown, beforeDispatch?: () => void, ctx?: StepContext): Promise<unknown> {
    const refusal = method === "tools/call" ? this.#refusal?.(session, spec, params, ctx) : null;
    if (refusal) return { isError: true, content: [{ type: "text", text: refusal }] };
    const afterClaim = method === "tools/call" ? this.#afterClaim : undefined;
    const dispatch = afterClaim ? () => {
      beforeDispatch?.();
      const text = afterClaim(session, spec);
      if (text) throw new ClaimRefused(text);
    } : beforeDispatch;
    const target = chromeTarget(session, spec);
    if (method === "tools/call" && target && this.#jev && isRunCall(params)) {
      const result = await this.#runBrowserTask(this.#jev, session, spec, params, dispatch, target, ctx);
      const annotated = this.#annotate ? this.#annotate(spec, result) : result;
      return this.#afterCall ? this.#afterCall(session, spec, annotated) : annotated;
    }
    let result: unknown;
    try {
      result = await (target ? this.#chrome.service.agentRpc(target, method, params, dispatch) : this.#old.agentRpc(session, spec, method, params, dispatch, ctx));
    } catch (error) {
      if (error instanceof ClaimRefused) return { isError: true, content: [{ type: "text", text: error.message }] };
      throw error;
    }
    if (method !== "tools/call") {
      const tools = (result as { tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> } | null)?.tools;
      if (target && this.#jev && this.#jev.automationReady() && this.#jev.gateway(target) && Array.isArray(tools)) {
        return { tools: browserToolList(tools, { automationReady: true, capabilities: { mode: "dom-fast" } }) };
      }
      return result;
    }
    const annotated = this.#annotate ? this.#annotate(spec, result) : result;
    return this.#afterCall ? this.#afterCall(session, spec, annotated) : annotated;
  }

  /** tools/call agent_browser_run: the bounded automation run, after the input is checked and the exact tools'
   * authorization chain has gone through (refusal above, then dispatch's beforeDispatch and afterClaim). */
  async #runBrowserTask(jev: NonNullable<RuntimeRouterOptions["jev"]>, session: string, spec: BrowserSpawnSpec, params: unknown, dispatch: (() => void) | undefined, target: BrowserTarget, ctx?: StepContext): Promise<unknown> {
    const gateway = jev.gateway(target);
    if (!gateway) return { isError: true, content: [{ type: "text", text: `${RUN_TOOL} is not offered for this browser.` }] };
    const parsed = browserRunInputSchema.safeParse((params as { arguments?: unknown } | null)?.arguments);
    if (!parsed.success) {
      const problems = parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
      return { isError: true, content: [{ type: "text", text: `${RUN_TOOL} got arguments it cannot use (${problems}).` }] };
    }
    try {
      dispatch?.();
    } catch (error) {
      if (error instanceof ClaimRefused) return { isError: true, content: [{ type: "text", text: error.message }] };
      throw error;
    }
    return browserRunResult(await gateway.run(jev.scope(session, spec, ctx), parsed.data));
  }

  previewFrame<T>(session: string, capture: () => Promise<T>, spec: { command: string; args?: readonly string[] }): Promise<T | { png: string; format: "jpeg" }> {
    return chromeTarget(session, spec) ? this.#chrome.service.previewFrame(session) : this.#old.previewFrame(session, capture);
  }

  withSecretInput<T extends { ok: boolean; text: string; held?: { url: string; ms: number } }>(session: string, spec: Spec, fn: () => Promise<T>, ctx?: StepContext): Promise<T> {
    const target = chromeTarget(session, spec);
    return target ? this.#chrome.service.withSecretInput(target, fn) : this.#old.withSecretInput(session, spec, fn, ctx);
  }

  heldBy(session: string): string | null {
    return this.#chrome.service.heldBy(session) ?? this.#old.heldBy(session);
  }

  working(session: string): boolean {
    return this.#chrome.service.working(session) || this.#old.working(session);
  }

  interrupted(session: string): boolean {
    return this.#chrome.service.interrupted(session) || this.#old.interrupted(session);
  }

  interruptedCount(): number {
    return this.#chrome.service.interruptedCount() + this.#old.interruptedCount();
  }

  /** The new engine closes its own idle browsers. */
  closeIfIdle(session: string, idleMs: number, spec?: Spec & { args?: readonly string[] }, options?: { attached?: boolean }): Promise<boolean> {
    if (chromeTarget(session, spec)) return Promise.resolve(false);
    return this.#old.closeIfIdle(session, idleMs, spec ? { command: spec.command, args: spec.args ?? [], env: spec.env } : undefined, options);
  }

  /** Closes a session's browser now unless a call, an agent or a person is using it. */
  closeUnused(session: string, spec: Spec & { args?: readonly string[] }): Promise<boolean> {
    if (chromeTarget(session, spec)) return this.#chrome.service.closeUnused(session);
    return this.#old.closeIfIdle(session, 1, { command: spec.command, args: spec.args ?? [], env: spec.env });
  }

  async close(session: string): Promise<void> {
    await Promise.all([this.#chrome.service.close(session), this.#old.close(session)]);
  }

  async closeAll(): Promise<void> {
    await Promise.all([this.#chrome.close(), this.#old.closeAll()]);
  }
}

type OpenOptions = Parameters<BrowserLive["open"]>[0];
type SessionSpec = { session: string; spec: { command: string; args?: readonly string[] } };

/**
 * BrowserLive's API: a viewer of a new-engine session gets the v1 adapter, every other the agent-browser one. The v2
 * stream, its file pickers and its downloads exist on the new engine only.
 */
export class LiveRouter {
  readonly #old: BrowserLive;
  readonly #chrome: ChromeEngine;

  constructor(old: BrowserLive, chrome: ChromeEngine) {
    this.#old = old;
    this.#chrome = chrome;
  }

  open(options: OpenOptions): Promise<void> {
    if (chromeTarget(options.session, options.spec)) {
      const { spec: _spec, ...rest } = options;
      return this.#chrome.live.open(rest);
    }
    return this.#old.open(options);
  }

  action(options: { viewerId: string; botId: string; owner: string; body: unknown }): Promise<unknown> {
    return this.#chrome.live.has(options.viewerId) ? this.#chrome.live.action(options) : this.#old.action(options);
  }

  /** False when the session runs on agent-browser, whose only view is v1. */
  stream({ session, spec, ...request }: SessionSpec & Omit<StreamRequest, "target">): boolean {
    const target = chromeTarget(session, spec);
    if (!target) return false;
    this.#chrome.stream.open({ ...request, target });
    return true;
  }

  fileChooserOffered({ session, spec }: SessionSpec, owner: string, chooserId: string): boolean {
    return chromeTarget(session, spec) ? this.#chrome.service.fileChooserOffered(session, owner, chooserId) : false;
  }

  answerFileChooser({ session, spec }: SessionSpec, owner: string, chooserId: string, paths: readonly string[]): Promise<boolean> {
    return chromeTarget(session, spec) ? this.#chrome.service.answerFileChooser(session, owner, chooserId, paths) : Promise.resolve(false);
  }

  download({ session, spec }: SessionSpec, id: string): Download | undefined {
    return chromeTarget(session, spec) ? this.#chrome.service.download(session, id) : undefined;
  }

  handBack(session: string): void { this.#chrome.live.handBack(session); this.#old.handBack(session); }
  closeForSession(session: string): void { this.#chrome.live.closeForSession(session); this.#chrome.stream.closeForSession(session); this.#old.closeForSession(session); }
  closeForOwner(owner: string): void { this.#chrome.live.closeForOwner(owner); this.#chrome.stream.closeForOwner(owner); this.#old.closeForOwner(owner); }
  closeForBot(botId: string): void { this.#chrome.live.closeForBot(botId); this.#chrome.stream.closeForBot(botId); this.#old.closeForBot(botId); }
  closeAll(): void { this.#chrome.live.closeAll(); this.#chrome.stream.closeAll(); this.#old.closeAll(); }
  /** Who may see what changed: every v2 view that no longer shows its browser to a person allowed to see it closes now. */
  recheck(): void { this.#chrome.stream.recheck(); }
}
