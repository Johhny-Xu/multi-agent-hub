// FEAT-cloud-offload / E72 / E73: an Auto bot's browser runs on a cloud machine (the configured VPS computers and
// Simular boxes), never on this host while one is up. Each SSH machine gets one headless Chrome on its
// own loopback (REMOTE_CDP_PORT) and one SSH tunnel to it from here; the least loaded machine that answers wins, a
// session keeps the machine it started on while that one still answers, and only when none answers does the browser
// fall back to this host's own Chrome. The pick is what the chat header shows ("浏览器 · <machine> / <profile>").
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { boxDownScript, boxKickScript, boxSshConfig, boxUpScript, parseBoxPub, parseCfAccessEnv, relayHostDownScript, relayHostScript, sshResolve, type CfAccessToken } from "./cloud-box-relay.ts";
import type { AppConfig } from "./config.ts";

/** Where every cloud machine's Chrome listens, on that machine's own loopback only. */
export const REMOTE_CDP_PORT = 9335;
/** Where CLIs reach the nth SSH machine's Chrome: the CDP proxy (cloud-cdp-proxy.ts) on LOCAL_CDP_BASE + n. */
export const LOCAL_CDP_BASE = 9341;
/** The proxy's upstream: the nth machine's SSH tunnel ends here on TUNNEL_CDP_BASE + n, internal to this host. */
export const TUNNEL_CDP_BASE = 19341;
/** A Simular box relayed through an SSH machine (cloud-box-relay.ts): its proxy door, this host's tunnel end, and the
 * relay host's loopback port that reaches the box's Chrome, each + n for the nth box. Apart from 9343/9344 (mychrome,
 * fallback). */
export const BOX_LOCAL_CDP_BASE = 9351;
export const BOX_TUNNEL_CDP_BASE = 19351;
export const BOX_RELAY_PORT_BASE = 19400;
/** The Simular box's own proxies on its loopback: it has no direct route out. */
const BOX_HTTP_PROXY_PORT = 3128;
const BOX_SOCKS_PORT = 1080;
/** Sites that need a sign-in: an Auto browser opening one goes to this host's signed-in mychrome instead of a cloud
 * Chrome, whose profile has no sign-ins. Cookies are never copied to a cloud machine (country hops lock accounts). */
export const DEFAULT_AUTH_DOMAINS: readonly string[] = [
  "google.com", "github.com", "x.com", "twitter.com", "doubao.com", "meoo.com", "qoder.com", "qoder.com.cn",
  "codebuddy.ai", "codebuddy.cn", "minimax.io", "minimaxi.com", "z.ai", "bigmodel.cn", "perchai.app", "trae.cn",
  "trae.com.cn", "huaweicloud.com", "kimi.com",
];
/** How long a machine's health stays good enough to pick it without asking again. */
const HEALTH_TTL_MS = 30_000;
/** A relayed box's check costs two MCP calls and an SSH round trip (~9 s, measured), and every pick waits for it:
 * it is asked again only every 5 minutes. A browser call that fails on it invalidates the answer sooner. */
const BOX_HEALTH_TTL_MS = 5 * 60_000;
/** Initial read-only probe timeout for relay health checks (V2). */
export const BOX_INITIAL_PROBE_MS = 3_000;
/** E115: delay before rechecking a failed relayed check. */
export const BOX_RECHECK_DELAY_MS = 3_000;
/** E115: a relayed box's /json/version crosses one multiplexed ssh stream that busy pages (screenshots) can hold up for
 * seconds: an open tunnel that misses the quick probe is given this long before it is called dead and reopened. */
export const BOX_SLOW_PROBE_MS = 10_000;
/** Cooldown after consecutive relay failures before another bring-up is allowed (V2). */
export const BOX_QUARANTINE_MS = 30_000;
/** Grace window for in-flight HTTP/WS leases to finish before physical teardown (V2). */
export const RELAY_DRAIN_GRACE_MS = 5_000;
/** Maximum time a single browser request waits for relay bring-up or recovery (V2). */
export const RELAY_SINGLE_REQUEST_WAIT_MS = 45_000;
/** Shared cap on a single bring-up / recovery attempt across waiters (V2). */
export const RELAY_BRINGUP_BUDGET_MS = 90_000;
const PROBE_MAX_BYTES = 65_536;

export interface CloudBrowserMachine {
  id: string;
  name: string;
  kind: "ssh" | "mcp";
  sshAlias?: string;
  /** A DevTools URL the person configured for a machine with no SSH (a Simular box with its own tunnel). */
  cdpUrl?: string;
  /** This host's tunnel port for an SSH machine (internal; CLIs use proxyPort). */
  localPort?: number;
  /** This host's CDP proxy port for an SSH machine, the URL a browser attaches to. */
  proxyPort?: number;
  /** A relayed box: its MCP server, the SSH machine its Chrome is relayed through, and the relay's port there. */
  mcpServer?: string;
  relayAlias?: string;
  relayPort?: number;
  /** The dedicated, locked-down account the box logs in to the relay host as (cloudOffload.boxRelayUser); unset, the
   * box gets the relay host's own login as this host's ssh config has it. */
  relayUser?: string;
  /** E88: the relay host's Cloudflare tunnel ssh hostname (cloudOffload.boxRelayCfHostname) and this host's file with
   * the Access service token the box presents there; unset, the box dials the relay host's SSH port as before. */
  relayCfHostname?: string;
  relayCfTokenFile?: string;
}

/** Where this host keeps the Access service token for the Cloudflare relay route (0600, never printed). */
export const DEFAULT_CF_TOKEN_FILE = "~/.config/omb-relay/cf-access.env";

/** The Access service token for the Cloudflare relay route, or null when the file is missing or malformed. */
export function readCfAccessToken(file: string = DEFAULT_CF_TOKEN_FILE, home: string = homedir()): CfAccessToken | null {
  try {
    return parseCfAccessEnv(readFileSync(file.startsWith("~/") ? `${home}/${file.slice(2)}` : file, "utf8"));
  } catch {
    return null;
  }
}

export interface MachineHealth {
  ok: boolean;
  /** One-minute load per core, 0–n; lower is idler. */
  load?: number;
  cdpUrl?: string;
  /** Why it is not usable: "没有 Chrome", "SSH 不通", "无 CDP 通道". */
  detail?: string;
  /** A relayed box that is awake but whose relay is not up (E80): it can be picked, and is brought up only then. */
  cold?: boolean;
}

export type RelayPhase = "cold" | "ready" | "suspect" | "draining" | "quarantined";
export type ProbePhase = "probe" | "ensureRemote" | "ensureTunnel" | "probeBox";
export type ProbeOutcome = "ok" | "timeout" | "refused" | "invalid" | "aborted";
export type RelayDrainReason = "idle" | "health" | "close";
export type RelayErrorCode = "RELAY_QUARANTINED" | "RELAY_RECOVERY_TIMEOUT" | "RELAY_CANCELLED" | "RELAY_UNAVAILABLE";

export interface RelayProbeResult {
  phase: ProbePhase;
  outcome: ProbeOutcome;
  cdpUrl?: string;
  latencyMs: number;
  detail?: string;
}

export interface ProbeContext {
  deadline?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RelayTimingConfig {
  initialProbeMs: number;
  recheckDelayMs: number;
  slowProbeMs: number;
  quarantineMs: number;
  drainGraceMs: number;
  singleRequestWaitMs: number;
  bringupBudgetMs: number;
}

export class RelayError extends Error {
  readonly code: RelayErrorCode;
  readonly phase: string;
  readonly waitedSec: number;
  readonly sent: boolean;

  constructor(code: RelayErrorCode, details: { message?: string; phase: string; waitedSec: number; sent: boolean }) {
    super(details.message ?? `${code} (${details.phase}, waited ${details.waitedSec}s)`);
    this.name = "RelayError";
    this.code = code;
    this.phase = details.phase;
    this.waitedSec = details.waitedSec;
    this.sent = details.sent;
  }
}

export function formatRelayError(error: RelayError, sent = error.sent): string {
  const stateNote = sent ? "动作可能已发送、结果未知，请先检查页面再决定是否重试" : "动作尚未发送，可安全重试或切换其它可用机器";
  if (error.code === "RELAY_QUARANTINED") return `云端浏览器中继隔离冷却中（等待 ${error.waitedSec}s；${stateNote}）。`;
  if (error.code === "RELAY_CANCELLED") return `云端浏览器连接已取消（等待 ${error.waitedSec}s；${stateNote}）。`;
  if (error.code === "RELAY_RECOVERY_TIMEOUT") return `云端浏览器中继等待超时（phase=${error.phase}，已等待 ${error.waitedSec}s；${stateNote}）。`;
  return `云端浏览器中继不可用（phase=${error.phase}；${stateNote}）。`;
}

/** Read-only HTTP /json/version probe bounded by timeout, deadline, signal, and byte limit (header + body). */
export async function probeRelayUrl(
  url: string,
  options: ProbeContext & { maxBytes?: number; phase?: ProbePhase } = {},
): Promise<RelayProbeResult> {
  const phase = options.phase ?? "probe";
  const maxBytes = options.maxBytes ?? PROBE_MAX_BYTES;
  const started = Date.now();
  if (options.signal?.aborted) return { phase, outcome: "aborted", latencyMs: 0, detail: "aborted" };
  let budgetMs = options.timeoutMs ?? BOX_INITIAL_PROBE_MS;
  if (options.deadline !== undefined) budgetMs = Math.min(budgetMs, options.deadline - started);
  if (budgetMs <= 0) return { phase, outcome: "timeout", latencyMs: 0, detail: "deadline elapsed" };

  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, budgetMs);
  timer.unref?.();

  try {
    const target = `${url.replace(/\/$/, "")}/json/version`;
    const response = await fetch(target, { signal: controller.signal });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return { phase, outcome: "refused", latencyMs, detail: `HTTP ${response.status}` };
    }
    const reader = response.body?.getReader();
    let rawText: string;
    if (!reader) {
      rawText = await response.text();
    } else {
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          return { phase, outcome: "invalid", latencyMs: Date.now() - started, detail: "response too large" };
        }
        chunks.push(Buffer.from(value));
      }
      rawText = Buffer.concat(chunks).toString("utf8");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return { phase, outcome: "invalid", latencyMs: Date.now() - started, detail: "invalid json" };
    }
    const wsUrl = (parsed && typeof parsed === "object" ? (parsed as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl : undefined);
    if (typeof wsUrl !== "string") {
      return { phase, outcome: "invalid", latencyMs: Date.now() - started, detail: "missing webSocketDebuggerUrl" };
    }
    try {
      const parsedWs = new URL(wsUrl);
      if (parsedWs.protocol !== "ws:" && parsedWs.protocol !== "wss:") {
        return { phase, outcome: "invalid", latencyMs: Date.now() - started, detail: "bad ws protocol" };
      }
    } catch {
      return { phase, outcome: "invalid", latencyMs: Date.now() - started, detail: "malformed ws url" };
    }
    return { phase, outcome: "ok", cdpUrl: url, latencyMs: Date.now() - started };
  } catch (error) {
    const latencyMs = Date.now() - started;
    if (options.signal?.aborted) return { phase, outcome: "aborted", latencyMs, detail: "aborted" };
    if (timedOut || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))) {
      return { phase, outcome: "timeout", latencyMs, detail: "timeout" };
    }
    return { phase, outcome: "refused", latencyMs, detail: error instanceof Error ? error.message.slice(0, 60) : "refused" };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}

export interface CloudBrowserPick {
  /** The machine the browser runs on: a cloud machine's name, or "本机". */
  machine: string;
  /** Matched configured machine id when cloud is true. */
  machineId?: string;
  cloud: boolean;
  /** The DevTools URL to attach to; null means this host's own browser as configured. */
  cdpUrl: string | null;
  reason: string;
}

export interface CloudBrowserDeps {
  /** Starts the machine's Chrome when it is not up and reports its load; never throws. */
  ensureRemote(machine: CloudBrowserMachine, ctx?: ProbeContext): Promise<MachineHealth>;
  /** Keeps a tunnel from localPort here to the machine's Chrome (and its file port back); idempotent. */
  ensureTunnel(machine: CloudBrowserMachine, ctx?: ProbeContext): Promise<boolean>;
  /** Whether a DevTools address answers /json/version; `timeoutMs` defaults to a quick 3 s. */
  probe(url: string, timeoutMs?: number, ctx?: ProbeContext): Promise<boolean>;
  /** Optional structured probe result used by V2 health checks. */
  probeRelay?(url: string, ctx?: ProbeContext): Promise<RelayProbeResult>;
  now(): number;
  log?(line: string): void;
  /** A relayed box's load without starting anything on it, its relay or Chrome (E80); never wakes a sleeping box. */
  probeBox?(machine: CloudBrowserMachine, ctx?: ProbeContext): Promise<MachineHealth>;
  /** Ends a relayed box's relay and Chrome, and this host's tunnel to it (idle teardown, E80). */
  teardown?(machine: CloudBrowserMachine, ctx?: ProbeContext): Promise<void>;
  /** E115: clears a relayed box's stuck relay (legacy V1 only; skipped on V2 first failure). */
  repair?(machine: CloudBrowserMachine): Promise<void>;
  /** Waits between a failed relayed check and its recheck (tests pass a no-op). */
  sleep?(ms: number): Promise<void>;
  /** Enables hardened relay recovery V2 state machine when true (or via getter for hot-reload). */
  relayRecoveryV2?: boolean | (() => boolean);
  /** Injectable timing overrides for deterministic tests. */
  timing?: Partial<RelayTimingConfig>;
}

/** A pick for a browser call ("demand") may bring a relayed box's relay up; the guard's background pick ("passive")
 * uses one only while it is already up and recently checked, and never asks it anything (E80). */
export interface PickOptions { passive?: boolean; deadline?: number; signal?: AbortSignal }

export function cloudOffloadOn(cfg: Pick<AppConfig, "cloudOffload">): boolean {
  return cfg.cloudOffload?.enabled !== false;
}

/** On, and with a cloud machine configured to run browsers on: without one the offload leaves this host as it was. */
export function cloudOffloadActive(cfg: Pick<AppConfig, "cloudOffload" | "vps">): boolean {
  return cloudOffloadOn(cfg) && cloudBrowserMachines(cfg).length > 0;
}

/** The sign-in sites as configured (lowercase hosts), the defaults while the person set none. */
export function authDomains(cfg: Pick<AppConfig, "cloudOffload">): string[] {
  const set = cfg.cloudOffload?.authDomains;
  return (Array.isArray(set) ? set : DEFAULT_AUTH_DOMAINS).map((domain) => domain.trim().toLowerCase()).filter(Boolean);
}

/** The sign-in site `url` opens (the configured entry it matches), or null. Subdomains match: accounts.google.com. */
export function authDomainOf(url: string, domains: readonly string[]): string | null {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  return domains.find((domain) => host === domain || host.endsWith(`.${domain}`)) ?? null;
}

/** What the settings page shows and edits. */
export function cloudOffloadSettings(cfg: Pick<AppConfig, "cloudOffload">): { enabled: boolean; guard: boolean; authDomains: string[] } {
  return { enabled: cloudOffloadOn(cfg), guard: cfg.cloudOffload?.guard !== false, authDomains: authDomains(cfg) };
}

/** The cloud machines a browser may run on, in the order the person added them; SSH machines get tunnel ports. */
export function cloudBrowserMachines(cfg: Pick<AppConfig, "vps"> & Partial<Pick<AppConfig, "cloudOffload">>): CloudBrowserMachine[] {
  const instances = (cfg.vps as { instances?: Array<Record<string, unknown>> } | undefined)?.instances ?? [];
  // The SSH machine boxes are relayed through, named by its id or name in the settings; off while unset. "ssh:<alias>"
  // names a relay-only host from this host's ssh config instead: never a VPS computer, never a browser machine.
  const via = cfg.cloudOffload?.boxRelayVia;
  const relayOnly = via?.startsWith("ssh:") ? via.slice(4) : undefined;
  const relay = via && !relayOnly ? instances.find((instance) => instance.kind === "ssh" && (instance.id === via || instance.name === via)) : undefined;
  const aliasOf = relayOnly ?? relay?.sshAlias;
  const relayAlias = typeof aliasOf === "string" && /^[A-Za-z0-9_.-]+$/.test(aliasOf) ? aliasOf : undefined;
  const user = cfg.cloudOffload?.boxRelayUser;
  const relayUser = typeof user === "string" && /^[a-z_][a-z0-9_-]{0,31}$/.test(user) ? user : undefined;
  const cfHost = cfg.cloudOffload?.boxRelayCfHostname;
  const relayCfHostname = typeof cfHost === "string" && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(cfHost) ? cfHost : undefined;
  const cfFile = cfg.cloudOffload?.boxRelayCfTokenFile;
  const relayCf = relayCfHostname ? { relayCfHostname, relayCfTokenFile: typeof cfFile === "string" && /^(~\/|\/)[A-Za-z0-9._\/-]+$/.test(cfFile) && !cfFile.includes("..") ? cfFile : DEFAULT_CF_TOKEN_FILE } : {};
  let ssh = 0;
  let boxes = 0;
  const machines: CloudBrowserMachine[] = [];
  for (const instance of instances) {
    const id = typeof instance.id === "string" ? instance.id : "";
    const name = typeof instance.name === "string" && instance.name.trim() ? instance.name.trim() : id;
    if (!id) continue;
    const cdpUrl = typeof instance.browserCdpUrl === "string" && /^https?:\/\/[^\s]+$/.test(instance.browserCdpUrl) ? instance.browserCdpUrl : undefined;
    if (instance.kind === "ssh" && typeof instance.sshAlias === "string" && /^[A-Za-z0-9_.-]+$/.test(instance.sshAlias)) {
      machines.push({ id, name, kind: "ssh", sshAlias: instance.sshAlias, localPort: TUNNEL_CDP_BASE + ssh, proxyPort: LOCAL_CDP_BASE + ssh });
      ssh++;
    } else if (instance.kind === "mcp") {
      const server = typeof instance.mcpServer === "string" ? instance.mcpServer : "";
      if (!cdpUrl && relayAlias && server && instance.adapter === "simular-box") {
        machines.push({ id, name, kind: "mcp", mcpServer: server, relayAlias, relayPort: BOX_RELAY_PORT_BASE + boxes, localPort: BOX_TUNNEL_CDP_BASE + boxes, proxyPort: BOX_LOCAL_CDP_BASE + boxes, ...(relayUser ? { relayUser } : {}), ...relayCf });
        boxes++;
      } else machines.push({ id, name, kind: "mcp", ...(cdpUrl ? { cdpUrl } : {}) });
    }
  }
  return machines;
}

const pct = (load: number | undefined) => load === undefined ? "?" : `${Math.round(load * 100)}%`;

interface MachineState {
  phase: RelayPhase;
  generation: number;
  lastSuccessSeq: number;
  failures: number;
  quarantineUntil: number;
  waiters: number;
  leases: Set<string>;
  leaseZeroWaiters: Array<() => void>;
  drainPromise: Promise<void> | null;
  lastMachine?: CloudBrowserMachine;
  lightInflight?: Promise<MachineHealth>;
}

function abortedPromise(signal: AbortSignal | undefined): Promise<never> | null {
  if (!signal) return null;
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

async function sleepWithSignal(ms: number, sleepFn?: (ms: number) => Promise<void>, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  if (ms <= 0) return true;
  if (sleepFn) {
    try {
      const waiter = sleepFn(ms);
      const aborted = abortedPromise(signal);
      if (aborted) await Promise.race([waiter, aborted]);
      else await waiter;
      return !signal?.aborted;
    } catch {
      return false;
    }
  }
  return await new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Chooses, and remembers, where each browser session runs. */
export class CloudBrowserPool {
  readonly #deps: CloudBrowserDeps;
  readonly #health = new Map<string, { at: number; health: MachineHealth }>();
  readonly #sticky = new Map<string, string>();
  readonly #inflight = new Map<string, Promise<MachineHealth>>();
  /** Relayed boxes whose relay a demand pick brought up and no teardown has ended since (E80). */
  readonly #warm = new Set<string>();
  /** A cold relayed box's light answer (awake, load), kept as long as a relayed box's full one. */
  readonly #light = new Map<string, { at: number; health: MachineHealth }>();
  readonly #states = new Map<string, MachineState>();
  readonly #sharedBringupStarted = new Map<string, number>();
  readonly #closingController = new AbortController();
  readonly #poolV2?: boolean | (() => boolean);

  constructor(deps: CloudBrowserDeps, options?: { relayRecoveryV2?: boolean | (() => boolean) }) {
    this.#deps = deps;
    this.#poolV2 = options?.relayRecoveryV2;
  }

  #isV2(): boolean {
    const flag = this.#deps.relayRecoveryV2 ?? this.#poolV2;
    return typeof flag === "function" ? flag() : flag === true;
  }

  #timing(): RelayTimingConfig {
    const t = this.#deps.timing;
    return {
      initialProbeMs: t?.initialProbeMs ?? BOX_INITIAL_PROBE_MS,
      recheckDelayMs: t?.recheckDelayMs ?? BOX_RECHECK_DELAY_MS,
      slowProbeMs: t?.slowProbeMs ?? BOX_SLOW_PROBE_MS,
      quarantineMs: t?.quarantineMs ?? BOX_QUARANTINE_MS,
      drainGraceMs: t?.drainGraceMs ?? RELAY_DRAIN_GRACE_MS,
      singleRequestWaitMs: t?.singleRequestWaitMs ?? RELAY_SINGLE_REQUEST_WAIT_MS,
      bringupBudgetMs: t?.bringupBudgetMs ?? RELAY_BRINGUP_BUDGET_MS,
    };
  }

  #state(machineId: string): MachineState {
    let state = this.#states.get(machineId);
    if (!state) {
      state = {
        phase: this.#warm.has(machineId) ? "ready" : "cold",
        generation: 1,
        lastSuccessSeq: 0,
        failures: 0,
        quarantineUntil: 0,
        waiters: 0,
        leases: new Set(),
        leaseZeroWaiters: [],
        drainPromise: null,
      };
      this.#states.set(machineId, state);
    }
    return state;
  }

  phaseOf(machineId: string): RelayPhase {
    return this.#states.get(machineId)?.phase ?? (this.#warm.has(machineId) ? "ready" : "cold");
  }

  generationOf(machineId: string): number {
    return this.#states.get(machineId)?.generation ?? 1;
  }

  quarantineRemainingMs(machineId: string): number {
    const until = this.#states.get(machineId)?.quarantineUntil ?? 0;
    return Math.max(0, until - this.#deps.now());
  }

  leaseCount(machineId: string): number {
    return this.#states.get(machineId)?.leases.size ?? 0;
  }

  waiterCount(machineId: string): number {
    return this.#states.get(machineId)?.waiters ?? 0;
  }

  /** Refreshes health freshness when an actual CDP HTTP/WS request succeeds on the active generation. */
  noteCdpSuccess(machineId: string, generation?: number, seq?: number): boolean {
    if (!this.#isV2()) return false;
    const state = this.#state(machineId);
    if (generation !== undefined && generation !== state.generation) return false;
    state.lastSuccessSeq = seq !== undefined ? Math.max(state.lastSuccessSeq + 1, seq) : state.lastSuccessSeq + 1;
    state.failures = 0;
    if (state.phase === "suspect" || state.phase === "ready") {
      state.phase = "ready";
      this.#warm.add(machineId);
      const prev = this.#health.get(machineId)?.health;
      if (prev?.cdpUrl) {
        this.#health.set(machineId, { at: this.#deps.now(), health: { ...prev, ok: true } });
      } else if (state.lastMachine?.localPort) {
        this.#health.set(machineId, { at: this.#deps.now(), health: { ok: true, cdpUrl: `http://127.0.0.1:${state.lastMachine.localPort}` } });
      }
    }
    return true;
  }

  /** Tracks an active request or WebSocket lease so drain can grant a short grace window before teardown. */
  acquireLease(machineId: string, leaseId = `lease-${Math.random().toString(36).slice(2)}`): { generation: number; release: () => void } | null {
    const state = this.#state(machineId);
    if (this.#isV2() && (state.phase === "draining" || state.phase === "quarantined")) return null;
    const gen = state.generation;
    state.leases.add(leaseId);
    let released = false;
    return {
      generation: gen,
      release: () => {
        if (released) return;
        released = true;
        state.leases.delete(leaseId);
        if (state.leases.size === 0) {
          for (const notify of state.leaseZeroWaiters.splice(0)) notify();
        }
      },
    };
  }

  #fresh(entry: { at: number; health: MachineHealth } | undefined, machine: CloudBrowserMachine): MachineHealth | undefined {
    return entry && this.#deps.now() - entry.at < (machine.relayAlias ? BOX_HEALTH_TTL_MS : HEALTH_TTL_MS) ? entry.health : undefined;
  }

  async #probeV2(url: string, timeoutMs: number | undefined, ctx?: ProbeContext): Promise<{ ok: boolean; detail?: string }> {
    if (this.#deps.probeRelay) {
      const res = await this.#deps.probeRelay(url, { ...ctx, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }).catch((): RelayProbeResult => ({
        phase: "probe", outcome: "refused", latencyMs: 0, detail: "probe threw",
      }));
      return { ok: res.outcome === "ok", ...(res.detail ? { detail: res.detail } : {}) };
    }
    const ok = await this.#deps.probe(url, timeoutMs, ctx).catch(() => false);
    return { ok, ...(!ok ? { detail: "隧道不通" } : {}) };
  }

  /** "passive": never asks a relayed box anything; "light": a cold relayed box only says whether it is awake and how
   * busy; "up": the machine is made usable, a relayed box's relay and Chrome brought up. Others ignore the mode. */
  async #check(machine: CloudBrowserMachine, mode: "passive" | "light" | "up", ctx?: ProbeContext): Promise<MachineHealth> {
    if (this.#isV2()) return await this.#checkV2(machine, mode, ctx);
    if (machine.relayAlias && !this.#warm.has(machine.id)) {
      if (mode === "passive") return { ok: false, detail: "空闲未连" };
      if (mode === "light") {
        const known = this.#fresh(this.#light.get(machine.id), machine);
        if (known) return known;
        if (!this.#deps.probeBox) return { ok: true, load: 1, cold: true };
        const light = await this.#deps.probeBox(machine).catch((): MachineHealth => ({ ok: false, detail: "MCP 不通" }));
        const health: MachineHealth = light.ok ? { ...light, cold: true } : light;
        this.#light.set(machine.id, { at: this.#deps.now(), health });
        return health;
      }
    }
    const cached = this.#fresh(this.#health.get(machine.id), machine);
    if (cached) return cached;
    // A warm box whose answer went stale is not asked from the background: asking would keep its relay busy.
    if (machine.relayAlias && mode === "passive") return { ok: false, detail: "空闲未连" };
    const running = this.#inflight.get(machine.id);
    if (running) return running;
    const once = async (): Promise<MachineHealth> => {
      if (machine.kind === "mcp" && !machine.relayAlias) {
        if (!machine.cdpUrl) return { ok: false, detail: "无 CDP 通道" };
        return await this.#deps.probe(machine.cdpUrl) ? { ok: true, load: 0.5, cdpUrl: machine.cdpUrl } : { ok: false, detail: "CDP 不通" };
      }
      const remote = await this.#deps.ensureRemote(machine);
      if (!remote.ok) return remote;
      const url = `http://127.0.0.1:${machine.localPort}`;
      if (!(await this.#deps.ensureTunnel(machine))) return { ok: false, detail: "隧道起不来" };
      if (!(await this.#deps.probe(url, machine.relayAlias ? BOX_SLOW_PROBE_MS : undefined))) return { ok: false, detail: "隧道不通" };
      return { ok: true, ...(remote.load !== undefined ? { load: remote.load } : {}), cdpUrl: url };
    };
    const work = (async (): Promise<MachineHealth> => {
      const first = await once();
      // E115: a relayed box whose relay was up (or is being brought up) and whose tunnel misses one check is not torn down
      // on that alone: its stuck relay is cleared, the box made to dial now, and it is checked once more.
      if (first.ok || !machine.relayAlias || (first.detail !== "隧道起不来" && first.detail !== "隧道不通")) return first;
      this.#deps.log?.(`cloud browser: ${machine.name} relay check failed (${first.detail}); repairing and checking once more (E115)`);
      await this.#deps.repair?.(machine).catch(() => {});
      await (this.#deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(BOX_RECHECK_DELAY_MS);
      const second = await once();
      if (second.ok) this.#deps.log?.(`cloud browser: ${machine.name} relay answered on the recheck (E115)`);
      return second;
    })().catch((error: unknown) => ({ ok: false, detail: error instanceof Error ? error.message.slice(0, 80) : "出错" }));
    this.#inflight.set(machine.id, work);
    try {
      const health = await work;
      this.#health.set(machine.id, { at: this.#deps.now(), health });
      if (machine.relayAlias) {
        this.#light.delete(machine.id);
        if (health.ok) this.#warm.add(machine.id);
        else {
          // A bring-up that did not get through must not leave the box dialing the relay host on its own (E80).
          const wasWarm = this.#warm.delete(machine.id);
          if (mode === "up" || wasWarm) void this.#deps.teardown?.(machine).catch(() => {});
        }
      }
      return health;
    } finally {
      this.#inflight.delete(machine.id);
      this.#sharedBringupStarted.delete(machine.id);
    }
  }

  async #checkV2(machine: CloudBrowserMachine, mode: "passive" | "light" | "up", ctx?: ProbeContext): Promise<MachineHealth> {
    const state = this.#state(machine.id);
    state.lastMachine = machine;
    const timing = this.#timing();

    if (machine.kind === "mcp" && !machine.relayAlias) {
      const cached = this.#fresh(this.#health.get(machine.id), machine);
      if (cached) return cached;
      if (!machine.cdpUrl) return { ok: false, detail: "无 CDP 通道" };
      const ok = await this.#probeV2(machine.cdpUrl, undefined, ctx);
      const health: MachineHealth = ok.ok ? { ok: true, load: 0.5, cdpUrl: machine.cdpUrl } : { ok: false, detail: "CDP 不通" };
      this.#health.set(machine.id, { at: this.#deps.now(), health });
      return health;
    }

    if (machine.relayAlias) {
      if (state.phase === "quarantined") {
        if (this.#deps.now() < state.quarantineUntil) {
          return { ok: false, detail: "隔离冷却中" };
        }
        if (mode === "passive") return { ok: false, detail: "空闲未连" };
        state.phase = "cold";
        state.failures = 0;
        state.quarantineUntil = 0;
        this.#health.delete(machine.id);
        this.#light.delete(machine.id);
      }

      if (state.phase === "draining") {
        if (mode === "passive") return { ok: false, detail: "正在清理连接" };
        if (state.drainPromise) {
          await state.drainPromise.catch(() => {});
          if (state.phase === "quarantined" && this.#deps.now() < state.quarantineUntil) {
            return { ok: false, detail: "隔离冷却中" };
          }
        }
      }

      if (state.phase === "cold" && !this.#warm.has(machine.id)) {
        if (mode === "passive") return { ok: false, detail: "空闲未连" };
        if (mode === "light") {
          const known = this.#fresh(this.#light.get(machine.id), machine);
          if (known) return known;
          if (state.lightInflight) return state.lightInflight;
          const lightTask = (async (): Promise<MachineHealth> => {
            if (!this.#deps.probeBox) return { ok: true, load: 1, cold: true };
            const light = await this.#deps.probeBox(machine, ctx).catch((): MachineHealth => ({ ok: false, detail: "MCP 不通" }));
            const health: MachineHealth = light.ok ? { ...light, cold: true } : light;
            this.#light.set(machine.id, { at: this.#deps.now(), health });
            return health;
          })().finally(() => {
            state.lightInflight = undefined;
          });
          state.lightInflight = lightTask;
          return await lightTask;
        }
      }
    }

    if (state.phase === "ready") {
      const cached = this.#fresh(this.#health.get(machine.id), machine);
      if (cached) return cached;
    }
    if (machine.relayAlias && mode === "passive") return { ok: false, detail: "空闲未连" };

    const running = this.#inflight.get(machine.id);
    if (running) return running;

    const work = (async (): Promise<MachineHealth> => {
      const isColdBringUp = machine.relayAlias ? (state.phase === "cold" && !this.#warm.has(machine.id)) : true;
      if (machine.relayAlias && isColdBringUp) {
        state.generation += 1;
        this.#sharedBringupStarted.set(machine.id, this.#deps.now());
      }
      const checkGen = state.generation;
      const seqBefore = state.lastSuccessSeq;
      const url = `http://127.0.0.1:${machine.localPort}`;
      let remoteLoad = this.#health.get(machine.id)?.health.load;
      let remoteStarted = false;

      const cdpRecoveredInSameGen = (): MachineHealth | null => {
        if (state.generation === checkGen && state.lastSuccessSeq > seqBefore) {
          state.phase = "ready";
          state.failures = 0;
          this.#warm.add(machine.id);
          return { ok: true, ...(remoteLoad !== undefined ? { load: remoteLoad } : {}), cdpUrl: url };
        }
        return null;
      };

      const runAttempt = async (probeTimeoutMs: number | undefined, runRemote: boolean): Promise<{ health: MachineHealth; retryable: boolean; remoteFailed?: boolean }> => {
        if (runRemote) {
          const remote = await this.#deps.ensureRemote(machine, ctx);
          if (!remote.ok) {
            const nonRetryableDetails = new Set(["休眠中", "无 MCP", "没有 Chrome", "没有 SSH", "缺 CF Access 令牌"]);
            const retryable = !nonRetryableDetails.has(remote.detail ?? "") && !remote.detail?.includes("中继主机");
            return { health: remote, retryable, remoteFailed: true };
          }
          remoteStarted = true;
          if (remote.load !== undefined) remoteLoad = remote.load;
        }
        if (!(await this.#deps.ensureTunnel(machine, { ...ctx, ...(probeTimeoutMs !== undefined ? { timeoutMs: probeTimeoutMs } : {}) }))) {
          return { health: { ok: false, detail: "隧道起不来" }, retryable: true };
        }
        const probed = await this.#probeV2(url, probeTimeoutMs, ctx);
        if (!probed.ok) {
          return { health: { ok: false, detail: probed.detail ?? "隧道不通" }, retryable: true };
        }
        return { health: { ok: true, ...(remoteLoad !== undefined ? { load: remoteLoad } : {}), cdpUrl: url }, retryable: false };
      };

      const firstTimeout = machine.relayAlias ? timing.initialProbeMs : undefined;
      const needRemoteFirst = !machine.relayAlias || isColdBringUp;
      const first = await runAttempt(firstTimeout, needRemoteFirst);
      const recovered1 = cdpRecoveredInSameGen();
      if (recovered1) return recovered1;
      if (first.health.ok) {
        state.phase = "ready";
        state.failures = 0;
        return first.health;
      }

      if (!machine.relayAlias || !first.retryable) {
        if (machine.relayAlias && isColdBringUp && mode === "up" && remoteStarted) {
          await this.#drainV2(machine, "health", checkGen, seqBefore, false);
        }
        return first.health;
      }

      state.phase = "suspect";
      state.failures = 1;
      this.#deps.log?.(`cloud browser: ${machine.name} probe failed once (${first.health.detail}); entering suspect and rechecking in ${timing.recheckDelayMs}ms`);
      const slept = await sleepWithSignal(timing.recheckDelayMs, this.#deps.sleep, this.#closingController.signal);
      const recoveredAfterSleep = cdpRecoveredInSameGen();
      if (recoveredAfterSleep) return recoveredAfterSleep;
      if (!slept) return { ok: false, detail: "已取消" };

      const second = await runAttempt(timing.slowProbeMs, Boolean(first.remoteFailed));
      const recovered2 = cdpRecoveredInSameGen();
      if (recovered2) return recovered2;
      if (second.health.ok) {
        state.phase = "ready";
        state.failures = 0;
        this.#deps.log?.(`cloud browser: ${machine.name} recovered on slow recheck (${timing.slowProbeMs}ms)`);
        return second.health;
      }

      state.failures = 2;
      const wasWarm = this.#warm.has(machine.id);
      if (mode === "up" || wasWarm || remoteStarted) {
        const tornDown = await this.#drainV2(machine, "health", checkGen, seqBefore, true);
        if (!tornDown && state.phase === "ready") {
          return { ok: true, ...(remoteLoad !== undefined ? { load: remoteLoad } : {}), cdpUrl: url };
        }
      } else {
        state.phase = "quarantined";
        state.quarantineUntil = this.#deps.now() + timing.quarantineMs;
      }
      return second.health;
    })().catch((error: unknown): MachineHealth => ({
      ok: false, detail: error instanceof Error ? error.message.slice(0, 80) : "出错",
    }));

    this.#inflight.set(machine.id, work);
    try {
      const health = await work;
      if (state.phase !== "quarantined" && state.phase !== "draining") {
        this.#health.set(machine.id, { at: this.#deps.now(), health });
      } else if (!health.ok) {
        this.#health.delete(machine.id);
      }
      if (machine.relayAlias) {
        this.#light.delete(machine.id);
        if (health.ok) this.#warm.add(machine.id);
        else this.#warm.delete(machine.id);
      }
      return health;
    } finally {
      this.#inflight.delete(machine.id);
      this.#sharedBringupStarted.delete(machine.id);
    }
  }

  /**
   * Serializes idle, health, and close teardowns per machine.
   * Returns true if physical teardown executed, false if cancelled (idle demand or health recovery).
   */
  async requestDrain(
    machineId: string,
    reason: RelayDrainReason,
    expectedGeneration?: number,
    machineSnapshot?: CloudBrowserMachine,
  ): Promise<boolean> {
    if (!this.#isV2()) {
      const snapshot = machineSnapshot ?? this.#states.get(machineId)?.lastMachine;
      this.release(machineId);
      if (snapshot) await this.#deps.teardown?.(snapshot).catch(() => {});
      return true;
    }
    const state = this.#state(machineId);
    if (machineSnapshot) state.lastMachine = machineSnapshot;
    if (expectedGeneration !== undefined && expectedGeneration !== state.generation) return false;
    if (state.drainPromise) {
      await state.drainPromise;
      return false;
    }
    const snapshot = machineSnapshot ?? state.lastMachine;
    if (!snapshot) {
      this.release(machineId);
      return true;
    }
    return await this.#drainV2(snapshot, reason, state.generation, state.lastSuccessSeq, false);
  }

  async #drainV2(
    machine: CloudBrowserMachine,
    reason: RelayDrainReason,
    expectedGeneration: number,
    seqAtStart: number,
    alreadyRechecked: boolean,
  ): Promise<boolean> {
    const state = this.#state(machine.id);
    state.lastMachine = machine;
    if (expectedGeneration !== state.generation) return false;
    if (state.drainPromise) {
      await state.drainPromise;
      return false;
    }
    if (reason === "idle" && (state.leases.size > 0 || state.waiters > 0)) return false;

    const timing = this.#timing();
    let tornDown = false;
    const drainTask = (async () => {
      state.phase = "draining";
      const waitedForLeases = state.leases.size > 0 && reason !== "close";
      if (waitedForLeases) {
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            const idx = state.leaseZeroWaiters.indexOf(finish);
            if (idx >= 0) state.leaseZeroWaiters.splice(idx, 1);
            resolve();
          };
          state.leaseZeroWaiters.push(finish);
          const timer = setTimeout(finish, timing.drainGraceMs);
          timer.unref?.();
        });
      }

      if (reason === "idle" && (state.leases.size > 0 || state.waiters > 0)) {
        state.phase = "ready";
        this.#warm.add(machine.id);
        return;
      }

      if (reason === "health") {
        if (state.generation === expectedGeneration && state.lastSuccessSeq > seqAtStart) {
          state.phase = "ready";
          state.failures = 0;
          this.#warm.add(machine.id);
          return;
        }
        if (waitedForLeases || !alreadyRechecked) {
          const url = machine.localPort ? `http://127.0.0.1:${machine.localPort}` : machine.cdpUrl;
          if (url) {
            const finalProbe = await this.#probeV2(url, timing.initialProbeMs);
            if (finalProbe.ok || (state.generation === expectedGeneration && state.lastSuccessSeq > seqAtStart)) {
              state.phase = "ready";
              state.failures = 0;
              this.#warm.add(machine.id);
              return;
            }
          }
        }
      }

      state.generation += 1;
      this.#warm.delete(machine.id);
      this.#health.delete(machine.id);
      this.#light.delete(machine.id);
      for (const [session, id] of this.#sticky) if (id === machine.id) this.#sticky.delete(session);
      await this.#deps.teardown?.(machine).catch(() => {});
      tornDown = true;

      if (reason === "health") {
        state.phase = "quarantined";
        state.quarantineUntil = this.#deps.now() + timing.quarantineMs;
      } else {
        state.phase = "cold";
        state.failures = 0;
        state.quarantineUntil = 0;
      }
    })().finally(() => {
      state.drainPromise = null;
    });

    state.drainPromise = drainTask;
    await drainTask;
    return tornDown;
  }

  /**
   * Waits for an already-selected machine's relay to become ready within the caller's deadline and 45 s single-request
   * limit, respecting quarantine and drain fences without firing actions after deadline exhaustion.
   */
  async awaitRelayReady(
    machine: CloudBrowserMachine,
    options: { deadline?: number; signal?: AbortSignal; ensureBringUp?: boolean } = {},
  ): Promise<{ cdpUrl: string; generation: number }> {
    const state = this.#state(machine.id);
    state.lastMachine = machine;
    const timing = this.#timing();
    const enteredAt = this.#deps.now();
    const waitLimitAt = enteredAt + timing.singleRequestWaitMs;
    const callerDeadline = options.deadline !== undefined ? Math.min(options.deadline, waitLimitAt) : waitLimitAt;

    if (options.signal?.aborted || this.#closingController.signal.aborted) {
      throw new RelayError("RELAY_CANCELLED", { phase: state.phase, waitedSec: 0, sent: false });
    }
    if (this.#isV2() && state.phase === "quarantined" && this.#deps.now() < state.quarantineUntil) {
      throw new RelayError("RELAY_QUARANTINED", { phase: "quarantined", waitedSec: 0, sent: false });
    }
    if (callerDeadline - this.#deps.now() <= 0) {
      throw new RelayError("RELAY_RECOVERY_TIMEOUT", { phase: state.phase, waitedSec: 0, sent: false });
    }

    state.waiters += 1;
    try {
      const sharedStart = this.#sharedBringupStarted.get(machine.id) ?? enteredAt;
      const sharedDeadline = sharedStart + timing.bringupBudgetMs;
      const workDeadline = Math.min(callerDeadline, sharedDeadline);

      const waitWithCallerRace = async <T>(work: Promise<T>): Promise<T> => {
        const remaining = Math.max(0, callerDeadline - this.#deps.now());
        if (remaining <= 0) {
          throw new RelayError("RELAY_RECOVERY_TIMEOUT", {
            phase: state.phase, waitedSec: Math.round((this.#deps.now() - enteredAt) / 1000), sent: false,
          });
        }
        return await new Promise<T>((resolve, reject) => {
          let settled = false;
          const cleanup = () => {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
            this.#closingController.signal.removeEventListener("abort", onAbort);
          };
          const onAbort = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new RelayError("RELAY_CANCELLED", {
              phase: state.phase, waitedSec: Math.round((this.#deps.now() - enteredAt) / 1000), sent: false,
            }));
          };
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new RelayError("RELAY_RECOVERY_TIMEOUT", {
              phase: state.phase, waitedSec: Math.round((this.#deps.now() - enteredAt) / 1000), sent: false,
            }));
          }, remaining);
          timer.unref?.();
          options.signal?.addEventListener("abort", onAbort, { once: true });
          this.#closingController.signal.addEventListener("abort", onAbort, { once: true });
          work.then(
            (val) => { if (!settled) { settled = true; cleanup(); resolve(val); } },
            (err) => { if (!settled) { settled = true; cleanup(); reject(err); } },
          );
        });
      };

      const checkResult = await waitWithCallerRace((async () => {
        if (state.phase === "draining" && state.drainPromise) {
          await state.drainPromise.catch(() => {});
        }
        if (state.phase === "quarantined" && this.#deps.now() < state.quarantineUntil) {
          throw new RelayError("RELAY_QUARANTINED", {
            phase: "quarantined", waitedSec: Math.round((this.#deps.now() - enteredAt) / 1000), sent: false,
          });
        }
        if (options.ensureBringUp === false && !this.#inflight.get(machine.id)) {
          if (state.phase === "ready" && this.#health.get(machine.id)?.health.cdpUrl) {
            return this.#health.get(machine.id)!.health;
          }
        }
        return await this.#check(machine, "up", { deadline: sharedDeadline, signal: this.#closingController.signal });
      })());

      if (!checkResult.ok || !checkResult.cdpUrl) {
        const code: RelayErrorCode = state.phase === "quarantined" ? "RELAY_QUARANTINED" : "RELAY_UNAVAILABLE";
        throw new RelayError(code, {
          phase: state.phase,
          waitedSec: Math.round((this.#deps.now() - enteredAt) / 1000),
          sent: false,
          ...(checkResult.detail ? { message: checkResult.detail } : {}),
        });
      }
      return { cdpUrl: checkResult.cdpUrl, generation: state.generation };
    } finally {
      state.waiters = Math.max(0, state.waiters - 1);
    }
  }

  /** Aborts internal sleeps/waiters when the server shuts down. */
  close(): void {
    this.#closingController.abort();
  }

  /** Forget a machine's health (all with no id), e.g. after a browser call to it failed. */
  invalidate(machineId?: string, expectedGeneration?: number): void {
    if (machineId === undefined) {
      this.#health.clear();
      this.#light.clear();
    } else {
      const state = this.#states.get(machineId);
      if (expectedGeneration !== undefined && state && expectedGeneration !== state.generation) return;
      this.#health.delete(machineId);
      this.#light.delete(machineId);
    }
  }

  /** E115: resolves once a check (a bring-up, a recheck) of this machine that is under way has finished, or at once
   * when none is; never rejects. A browser call reaching a box mid-rebuild waits for it instead of hanging on the relay. */
  async settled(machineId: string): Promise<void> {
    await this.#inflight.get(machineId)?.catch(() => undefined);
  }

  /** The relayed boxes whose relay is up, as far as this pool knows. */
  warmBoxes(): string[] {
    return [...this.#warm];
  }

  /** A relayed box's relay was ended (idle teardown): it is cold again, and its sessions pick afresh. */
  release(machineId: string): void {
    this.#warm.delete(machineId);
    this.invalidate(machineId);
    const state = this.#states.get(machineId);
    if (state) {
      state.generation += 1;
      state.phase = "cold";
      state.failures = 0;
      state.quarantineUntil = 0;
    }
    for (const [session, id] of this.#sticky) if (id === machineId) this.#sticky.delete(session);
  }

  /** The machine for `session`: the one it already runs on while that answers, else the idlest that answers. A cold
   * relayed box counts with its load and is brought up only when it is the one chosen; a passive pick skips it. */
  async pick(machines: readonly CloudBrowserMachine[], session: string, localName = "本机", options: PickOptions = {}): Promise<CloudBrowserPick> {
    const mode = options.passive ? "passive" : "light";
    const ctx: ProbeContext | undefined = options.deadline !== undefined || options.signal ? {
      ...(options.deadline !== undefined ? { deadline: options.deadline } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    } : undefined;
    for (const m of machines) this.#state(m.id).lastMachine = m;
    const checked = await Promise.all(machines.map(async (machine) => ({ machine, health: await this.#check(machine, mode, ctx) })));
    const usable = checked.filter((entry) => entry.health.ok && (entry.health.cdpUrl || entry.health.cold));
    const stuck = this.#sticky.get(session);
    const kept = usable.find((entry) => entry.machine.id === stuck && entry.health.cdpUrl);
    const order = kept ? [kept] : [...usable].sort((a, b) => (a.health.load ?? 1) - (b.health.load ?? 1));
    let chosen: (typeof checked)[number] | undefined;
    for (const entry of order) {
      if (entry.health.cdpUrl) {
        chosen = entry;
        break;
      }
      const up = await this.#check(entry.machine, "up", ctx);
      entry.health = up;
      if (up.ok && up.cdpUrl) {
        chosen = entry;
        break;
      }
    }
    if (chosen) {
      this.#sticky.set(session, chosen.machine.id);
      const others = usable.filter((entry) => entry !== chosen && entry.health.ok).map((entry) => `${entry.machine.name} ${pct(entry.health.load)}`);
      const why = kept ? `沿用 ${chosen.machine.name}` : `${chosen.machine.name} 最空闲（负载 ${pct(chosen.health.load)}${others.length ? `；${others.join("，")}` : ""}）`;
      return { machine: chosen.machine.name, machineId: chosen.machine.id, cloud: true, cdpUrl: chosen.health.cdpUrl!, reason: `云端优先：${why}` };
    }
    this.#sticky.delete(session);
    const down = checked.map((entry) => `${entry.machine.name}：${entry.health.detail ?? "不可用"}`).join("；");
    return { machine: localName, cloud: false, cdpUrl: null, reason: machines.length ? `云端浏览器都不可用（${down}），回落${localName}` : `没有云端机器，用${localName}` };
  }
}

/** The script that makes sure an SSH machine's Chrome is up and prints "OMB_OK <load1> <cores>" or "OMB_ERR <why>". */
export function remoteChromeScript(port = REMOTE_CDP_PORT): string {
  return [
    `P=${port}`,
    `B=$(command -v chromium || command -v chromium-browser || command -v google-chrome || command -v google-chrome-stable)`,
    `[ -z "$B" ] && { echo "OMB_ERR 没有 Chrome"; exit 0; }`,
    `up() { curl -s -m 2 "http://127.0.0.1:$P/json/version" >/dev/null 2>&1; }`,
    `if ! up; then mkdir -p "$HOME/.omb-cloud-chrome"; setsid nohup "$B" --headless=new --remote-debugging-address=127.0.0.1 --remote-debugging-port=$P --user-data-dir="$HOME/.omb-cloud-chrome" --no-first-run --no-default-browser-check --disable-dev-shm-usage --lang=zh-CN about:blank >/tmp/omb-cloud-chrome.log 2>&1 </dev/null & for i in 1 2 3 4 5 6 7 8 9 10 11 12; do sleep 0.5; up && break; done; fi`,
    `up && echo "OMB_OK $(cut -d' ' -f1 /proc/loadavg) $(nproc 2>/dev/null || echo 1)" || echo "OMB_ERR Chrome 起不来"`,
  ].join("\n");
}

export function parseRemoteAnswer(out: string): MachineHealth {
  const ok = /OMB_OK\s+([\d.]+)\s+(\d+)/.exec(out);
  if (ok) {
    const load = Number(ok[1]) / Math.max(1, Number(ok[2]));
    return { ok: true, load: Number.isFinite(load) ? load : undefined };
  }
  const err = /OMB_ERR\s+(.+)/.exec(out);
  return { ok: false, detail: err ? err[1]!.trim().slice(0, 60) : "SSH 不通" };
}

/** The ssh argv of a machine's tunnel: its Chrome's loopback port to this host's. Reverse forwards are not used:
 * some SSH gateways refuse them, so this host's files reach the cloud Chrome through the CDP proxy instead. The link
 * crosses the Pacific (~190 ms): compression shrinks CDP's JSON and screenshots, the AEAD ciphers are the cheapest on
 * this host's weak CPU, and a 10 s heartbeat ends a dead link within 20 s so it is opened again (onTunnelExit). */
export function tunnelArgs(alias: string, localPort: number, remotePort = REMOTE_CDP_PORT): string[] {
  return [
    "-N", "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2",
    "-o", "TCPKeepAlive=yes", "-o", "Compression=yes", "-o", "Ciphers=chacha20-poly1305@openssh.com,aes128-gcm@openssh.com", "-o", "ConnectTimeout=10",
    "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    alias,
  ];
}

/** The real deps: ssh for the remote Chrome and the tunnels, fetch for the probe. */
/** A box reached over its MCP server: whether it is awake (a check must not wake a hibernated box) and a shell in it. */
export interface BoxShell {
  running(server: string): Promise<boolean>;
  shell(server: string, command: string): Promise<string>;
}

export function sshCloudBrowserDeps(options: {
  log?: (line: string) => void;
  onTunnelExit?: (machine: CloudBrowserMachine, generation?: number) => void;
  box?: BoxShell;
  relayRecoveryV2?: boolean | (() => boolean);
  allowRelayHostKill?: boolean;
  ownerTag?: string;
} = {}): CloudBrowserDeps & { close(): void } {
  const tunnels = new Map<string, ReturnType<typeof spawn>>();
  const tunnelGenerations = new Map<string, number>();
  /** Tunnels this host ended on purpose (idle teardown or replacement): their exit is not a dead link to reopen. */
  const ended = new WeakSet<ReturnType<typeof spawn>>();
  const ownerTag = options.ownerTag ?? `omb-${process.pid}`;
  let closing = false;
  const isV2 = () => typeof options.relayRecoveryV2 === "function" ? options.relayRecoveryV2() : options.relayRecoveryV2 === true;
  const probeRelay = async (url: string, ctx?: ProbeContext): Promise<RelayProbeResult> => await probeRelayUrl(url, ctx);
  const probe = async (url: string, timeoutMs = BOX_INITIAL_PROBE_MS, ctx?: ProbeContext) => {
    if (isV2()) {
      const res = await probeRelayUrl(url, { ...ctx, timeoutMs });
      return res.outcome === "ok";
    }
    try {
      const response = await fetch(`${url.replace(/\/$/, "")}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
      return response.ok;
    } catch {
      return false;
    }
  };
  const runSsh = (alias: string, script: string, ctx?: ProbeContext) => new Promise<string>((done) => {
    if (ctx?.signal?.aborted) { done(""); return; }
    const remaining = ctx?.deadline !== undefined ? ctx.deadline - Date.now() : 25_000;
    if (remaining <= 0) { done(""); return; }
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", alias, "bash -s"], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx?.signal?.removeEventListener("abort", onAbort);
      done(value);
    };
    const onAbort = () => { child.kill("SIGTERM"); finish(""); };
    const timer = setTimeout(() => { child.kill("SIGTERM"); }, Math.min(25_000, Math.max(100, remaining)));
    ctx?.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.on("error", () => finish(""));
    child.on("close", () => finish(out));
    child.stdin.end(script);
  });
  return {
    now: () => Date.now(),
    probe,
    probeRelay,
    ...(options.relayRecoveryV2 !== undefined ? { relayRecoveryV2: options.relayRecoveryV2 } : {}),
    ...(options.log ? { log: options.log } : {}),
    async ensureRemote(machine, ctx) {
      if (ctx?.signal?.aborted) return { ok: false, detail: "已取消" };
      const owner = isV2() ? ownerTag : undefined;
      if (machine.kind === "mcp" && machine.relayAlias && machine.mcpServer && machine.relayPort) {
        if (!options.box) return { ok: false, detail: "无 MCP" };
        if (!(await options.box.running(machine.mcpServer).catch(() => false))) return { ok: false, detail: "休眠中" };
        const relay = await sshResolve(machine.relayAlias);
        if (!relay) return { ok: false, detail: "中继主机不明" };
        // E88: through the relay host's Cloudflare tunnel when one is configured; its Access token must be on hand.
        let cfSsh: { hostname: string; httpProxyPort: number } | undefined;
        let cfUp: { token: CfAccessToken } | undefined;
        if (machine.relayCfHostname) {
          const token = readCfAccessToken(machine.relayCfTokenFile);
          if (!token) return { ok: false, detail: "缺 CF Access 令牌" };
          cfSsh = { hostname: machine.relayCfHostname, httpProxyPort: BOX_HTTP_PROXY_PORT };
          cfUp = { token };
        }
        if (machine.relayUser) {
          // A dedicated relay account: the box gets only that account and its own key, never this host's login there.
          // The box goes first (it makes its key), then the key is authorized; its relay loop retries within seconds.
          const target = { cdpPort: REMOTE_CDP_PORT, relayPort: machine.relayPort, httpProxyPort: BOX_HTTP_PROXY_PORT, socksPort: BOX_SOCKS_PORT };
          const answer = await options.box.shell(machine.mcpServer, boxUpScript(target, boxSshConfig({ ...relay, user: machine.relayUser }, BOX_SOCKS_PORT, cfSsh), cfUp, ...(owner ? [{ owner }] : []))).catch(() => "");
          const health = parseRemoteAnswer(answer);
          if (!health.ok) return health;
          const pub = parseBoxPub(answer);
          if (!pub) return { ok: false, detail: "盒子中继密钥不明" };
          const host = await runSsh(machine.relayAlias, relayHostScript({ user: machine.relayUser, relayPort: machine.relayPort, pub, tag: machine.id.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64) || "box" }), ctx);
          if (!/OMB_RELAY_OK/.test(host)) return { ok: false, detail: /OMB_RELAY_ERR\s+(.+)/.exec(host)?.[1]?.trim().slice(0, 40) ?? "中继主机不通" };
          // E115: a key authorized just now was refused by the loop's first dials, which put it into backoff: dial now.
          if (/OMB_RELAY_NEW/.test(host)) {
            const kick = await options.box.shell(machine.mcpServer, boxKickScript(REMOTE_CDP_PORT, ...(owner ? [{ owner }] : []))).catch(() => "");
            options.log?.(`cloud browser: ${machine.name} relay key authorized, loop kicked (${/OMB_KICK\s+(\d)/.exec(kick)?.[1] ?? "?"})`);
          }
          return health;
        }
        if (!/OMB_RELAY_OK/.test(await runSsh(machine.relayAlias, relayHostScript(), ctx))) return { ok: false, detail: "中继主机不通" };
        const script = boxUpScript({ cdpPort: REMOTE_CDP_PORT, relayPort: machine.relayPort, httpProxyPort: BOX_HTTP_PROXY_PORT, socksPort: BOX_SOCKS_PORT }, boxSshConfig(relay, BOX_SOCKS_PORT, cfSsh), cfUp, ...(owner ? [{ owner }] : []));
        return parseRemoteAnswer(await options.box.shell(machine.mcpServer, script).catch(() => ""));
      }
      if (!machine.sshAlias) return { ok: false, detail: "没有 SSH" };
      return parseRemoteAnswer(await runSsh(machine.sshAlias, remoteChromeScript(), ctx));
    },
    async ensureTunnel(machine, ctx) {
      if (ctx?.signal?.aborted) return false;
      const alias = machine.sshAlias ?? machine.relayAlias;
      if (!alias || !machine.localPort) return false;
      const url = `http://127.0.0.1:${machine.localPort}`;
      const open = tunnels.get(machine.id);
      const alive = open && open.exitCode === null && !open.killed;
      if (isV2()) {
        if (alive) return true;
      } else {
        if (alive && await probe(url)) return true;
        // E115: a relayed tunnel carries every page of the box over one stream; a busy one may answer slowly. Reopening it
        // would cut every live connection, so it gets a longer look first.
        if (alive && machine.relayPort && await probe(url, BOX_SLOW_PROBE_MS)) return true;
      }
      if (open) {
        ended.add(open);
        open.kill("SIGTERM");
      } else if (await probe(url, ctx?.timeoutMs ?? BOX_INITIAL_PROBE_MS, ctx)) {
        return true;
      }
      const nextGen = (tunnelGenerations.get(machine.id) ?? 0) + 1;
      tunnelGenerations.set(machine.id, nextGen);
      const child = spawn("ssh", tunnelArgs(alias, machine.localPort, machine.relayPort ?? REMOTE_CDP_PORT), { stdio: "ignore" });
      child.on("error", () => {});
      child.on("exit", (code) => {
        const isCurrent = tunnels.get(machine.id) === child;
        if (isCurrent) tunnels.delete(machine.id);
        options.log?.(`cloud browser: tunnel to ${machine.name} exited (${code})`);
        if (!closing && !ended.has(child) && (!isV2() || isCurrent)) options.onTunnelExit?.(machine, nextGen);
      });
      tunnels.set(machine.id, child);
      for (let i = 0; i < 16; i++) {
        if (ctx?.signal?.aborted || (ctx?.deadline !== undefined && Date.now() >= ctx.deadline)) {
          ended.add(child);
          if (tunnels.get(machine.id) === child) tunnels.delete(machine.id);
          child.kill("SIGTERM");
          return false;
        }
        await new Promise((r) => setTimeout(r, 500));
        if (child.exitCode !== null) return false;
        if (await probe(url, ctx?.timeoutMs ?? BOX_INITIAL_PROBE_MS, ctx)) return true;
      }
      ended.add(child);
      if (tunnels.get(machine.id) === child) tunnels.delete(machine.id);
      child.kill("SIGTERM");
      return false;
    },
    async probeBox(machine, ctx) {
      if (ctx?.signal?.aborted) return { ok: false, detail: "已取消" };
      if (!options.box || !machine.mcpServer) return { ok: false, detail: "无 MCP" };
      if (!(await options.box.running(machine.mcpServer).catch(() => false))) return { ok: false, detail: "休眠中" };
      return parseRemoteAnswer(await options.box.shell(machine.mcpServer, `echo "OMB_OK $(cut -d' ' -f1 /proc/loadavg) $(nproc 2>/dev/null || echo 1)"`).catch(() => ""));
    },
    async repair(machine) {
      const owner = isV2() ? ownerTag : undefined;
      if (options.allowRelayHostKill === true || !isV2()) {
        if (machine.relayAlias && machine.relayPort) {
          const host = await runSsh(machine.relayAlias, relayHostDownScript(machine.relayPort));
          options.log?.(`cloud browser: ${machine.name} relay host side cleared (${/OMB_RELAY_DOWN\s+(\d+)/.exec(host)?.[1] ?? "?"} left)`);
        }
      }
      if (options.box && machine.mcpServer && await options.box.running(machine.mcpServer).catch(() => false)) {
        const kick = await options.box.shell(machine.mcpServer, boxKickScript(REMOTE_CDP_PORT, { session: !isV2(), ...(owner ? { owner } : {}) })).catch(() => "");
        options.log?.(`cloud browser: ${machine.name} relay loop kicked (${/OMB_KICK\s+(\d)/.exec(kick)?.[1] ?? "?"})`);
      }
    },
    async teardown(machine) {
      const owner = isV2() ? ownerTag : undefined;
      if (options.box && machine.mcpServer && await options.box.running(machine.mcpServer).catch(() => false)) {
        const out = await options.box.shell(machine.mcpServer, boxDownScript(REMOTE_CDP_PORT, owner ? { owner } : {})).catch(() => "");
        options.log?.(`cloud browser: ${machine.name} relay ended on the box (${/OMB_DOWN\s+(\d+)/.exec(out)?.[1] ?? "?"} left)`);
      }
      if (options.allowRelayHostKill === true || !isV2()) {
        if (machine.relayAlias && machine.relayPort) await runSsh(machine.relayAlias, relayHostDownScript(machine.relayPort));
      }
      const child = tunnels.get(machine.id);
      if (child) {
        ended.add(child);
        tunnels.delete(machine.id);
        child.kill("SIGTERM");
      }
    },
    close() {
      closing = true;
      for (const child of tunnels.values()) {
        ended.add(child);
        child.kill("SIGTERM");
      }
      tunnels.clear();
    },
  };
}
