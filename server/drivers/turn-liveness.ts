// Whether a long turn is still working, decided by asking its processes, not by a clock.
//
// A turn used to be stopped once it ran past a fixed number of seconds (900 s for CodeArts, MiniMax Code, Meoo, Trae,
// Doubao and ZCode), so a model that thought for 16 minutes without printing was "timed out" while it was working.
// Now every ~30 s a running turn is looked at: is its process tree still there, did its CPU time move, did it read or
// write anything (Linux /proc/<pid>/io), does it hold a network connection to its model, did it print anything. A turn
// is only judged stuck when none of that happened for the whole stuck window (default 30 min, 0 = never), and the person
// is told why. A wall-clock cap still exists, but only when an env var asks for one.
//
// Self-contained on purpose: the bridges (codearts-acp, mcode-acp, meoo-acp, zcode-acp) import it in their own process.

import { readdirSync, readFileSync, readlinkSync } from "node:fs";

/** No activity of any kind this long: the turn is stuck (OMB_TURN_STUCK_MS overrides, 0 = never). */
export const DEFAULT_TURN_STUCK_MS = 30 * 60_000;
/** How often a running turn's processes are looked at (OMB_TURN_LIVENESS_TICK_MS overrides). */
export const DEFAULT_LIVENESS_TICK_MS = 30_000;
/** A quiet turn gets its first "still running" status after this long (OMB_TURN_STATUS_AFTER_MS overrides)… */
export const DEFAULT_STATUS_AFTER_MS = 10 * 60_000;
/** …and another this often while it stays quiet (OMB_TURN_STATUS_EVERY_MS overrides). */
export const DEFAULT_STATUS_EVERY_MS = 10 * 60_000;
/** Output this recent makes a status line pointless: the person is watching it work. */
const STATUS_QUIET_MS = 2 * 60_000;
const MAX_STATUS_NOTICES = 24;
/** CPU below this share of one core between two looks is an idle runtime's timers, not work. */
const CPU_ACTIVE_SHARE = 0.01;
const CPU_ACTIVE_FLOOR_MS = 100;
/** setTimeout treats anything above 2^31-1 ms as 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

type Env = Record<string, string | undefined>;

/** A duration from the first named env var that is set: milliseconds, or seconds for a name ending in _SEC. 0 (or a
 * negative number) means "never"; anything unreadable falls through to the next name, then to the fallback. */
export function durationFromEnv(env: Env, names: string[], fallbackMs: number): number {
  for (const name of names) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (value <= 0) return 0;
    const ms = name.endsWith("_SEC") ? value * 1000 : value;
    return Math.min(ms, MAX_TIMER_MS);
  }
  return fallbackMs;
}

/** The stuck window for one driver: its own variables first, then OMB_TURN_STUCK_MS, then 30 min. 0 = never. */
export function turnStuckMs(env: Env = process.env, ...names: string[]): number {
  return durationFromEnv(env, [...names, "OMB_TURN_STUCK_MS"], DEFAULT_TURN_STUCK_MS);
}

/** An opt-in wall-clock cap for one driver: off (0) unless a named variable or OMB_TURN_MAX_MS sets one. */
export function turnMaxTotalMs(env: Env = process.env, ...names: string[]): number {
  return durationFromEnv(env, [...names, "OMB_TURN_MAX_MS"], 0);
}

export function livenessTickMs(env: Env = process.env, stuckMs = DEFAULT_TURN_STUCK_MS): number {
  const configured = durationFromEnv(env, ["OMB_TURN_LIVENESS_TICK_MS"], DEFAULT_LIVENESS_TICK_MS) || DEFAULT_LIVENESS_TICK_MS;
  // A short window (a test's, or a person's) is still looked at a few times before it can end the turn.
  return stuckMs > 0 ? Math.max(50, Math.min(configured, Math.floor(stuckMs / 4))) : configured;
}

/** "40 s", "4 min", "1 h 05 min". */
export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}

export interface LivenessSample {
  /** The tree's root (or any process of its group) still runs; null when unknown. */
  alive: boolean | null;
  /** CPU time of the whole tree and process group, ms; null when unknown. */
  cpuMs: number | null;
  /** Bytes the tree read and wrote (sockets, pipes, files), from /proc/<pid>/io; null when unknown. */
  ioBytes: number | null;
  /** Established TCP connections the tree holds; null when unknown. */
  connections: number | null;
  /** Those of them to a non-loopback peer; null when the peers could not be read. */
  external: number | null;
}

export const UNKNOWN_SAMPLE: LivenessSample = { alive: null, cpuMs: null, ioBytes: null, connections: null, external: null };

/** Linux's /proc, read through these so a test can pass a fake tree. */
export interface ProcFs {
  read(path: string): string;
  list(path: string): string[];
  link(path: string): string;
}

const realProc: ProcFs = { read: (path) => readFileSync(path, "utf8"), list: (path) => readdirSync(path), link: (path) => readlinkSync(path) };
const PROC_TICKS = 100;

/** /proc/net/tcp{,6} remote address: loopback is 127.0.0.0/8, ::1 and ::ffff:127.x. */
export function loopbackPeer(hex: string): boolean {
  const addr = hex.split(":")[0] ?? "";
  if (addr.length === 8) return addr.slice(6, 8).toUpperCase() === "7F";
  if (addr.length === 32) {
    const upper = addr.toUpperCase();
    if (upper === "00000000000000000000000001000000") return true;
    // ::ffff:a.b.c.d is stored as four little-endian words; the IPv4 word is the last one.
    if (upper.startsWith("0000000000000000FFFF0000")) return upper.slice(30, 32) === "7F";
  }
  return false;
}

/** The tree under `root` plus every process in `root`'s process group (a detached child whose parent already exited). */
export function sampleLinux(root: number, proc: ProcFs = realProc): LivenessSample {
  let names: string[];
  try { names = proc.list("/proc"); } catch { return UNKNOWN_SAMPLE; }
  const rows: Array<{ pid: number; ppid: number; pgrp: number; cpuMs: number; zombie: boolean }> = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try { stat = proc.read(`/proc/${name}/stat`); } catch { continue; }
    // pid (comm) state ppid pgrp …: comm may hold spaces and parentheses; utime and stime are fields 14 and 15.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = (Number(fields[11]) || 0) + (Number(fields[12]) || 0);
    rows.push({ pid: Number(name), ppid: Number(fields[1]), pgrp: Number(fields[2]), cpuMs: ticks * (1000 / PROC_TICKS), zombie: fields[0] === "Z" });
  }
  const kids = new Map<number, number[]>();
  for (const row of rows) kids.set(row.ppid, [...(kids.get(row.ppid) ?? []), row.pid]);
  const members = new Set<number>();
  const queue = [root, ...rows.filter((row) => row.pgrp === root).map((row) => row.pid)];
  while (queue.length && members.size < 1024) {
    const pid = queue.shift()!;
    if (members.has(pid) || !rows.some((row) => row.pid === pid)) continue;
    members.add(pid);
    queue.push(...(kids.get(pid) ?? []));
  }
  const live = rows.filter((row) => members.has(row.pid));
  if (!live.length || live.every((row) => row.zombie)) return { ...UNKNOWN_SAMPLE, alive: false };
  const cpuMs = live.reduce((sum, row) => sum + row.cpuMs, 0);
  let ioBytes: number | null = 0;
  const sockets = new Set<string>();
  const namespaces = new Map<string, number>();
  for (const { pid } of live) {
    if (ioBytes !== null) {
      try {
        const io = proc.read(`/proc/${pid}/io`);
        ioBytes += Number(/^rchar:\s*(\d+)/m.exec(io)?.[1] ?? 0) + Number(/^wchar:\s*(\d+)/m.exec(io)?.[1] ?? 0);
      } catch { ioBytes = null; }
    }
    try { const ns = proc.link(`/proc/${pid}/ns/net`); if (!namespaces.has(ns)) namespaces.set(ns, pid); } catch {}
    let fds: string[];
    try { fds = proc.list(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      try { const inode = /^socket:\[(\d+)\]$/.exec(proc.link(`/proc/${pid}/fd/${fd}`))?.[1]; if (inode) sockets.add(inode); } catch {}
    }
  }
  let connections = 0, external = 0, readable = false;
  const seen = new Set<string>();
  for (const pid of namespaces.size ? namespaces.values() : [root]) {
    for (const table of ["tcp", "tcp6"]) {
      let text: string;
      try { text = proc.read(`/proc/${pid}/net/${table}`); readable = true; } catch { continue; }
      for (const line of text.split("\n").slice(1)) {
        // sl local_address rem_address st … inode: st 01 is ESTABLISHED.
        const cols = line.trim().split(/\s+/);
        if (cols.length < 10 || cols[3] !== "01" || !sockets.has(cols[9]!) || seen.has(cols[9]!)) continue;
        seen.add(cols[9]!);
        connections += 1;
        if (!loopbackPeer(cols[2]!)) external += 1;
      }
    }
  }
  return { alive: true, cpuMs, ioBytes, connections: readable ? connections : null, external: readable ? external : null };
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Linux reads /proc; macOS and Windows ask ps/lsof or PowerShell (CPU and connections, no I/O bytes), and fall back to
 * "is it still there" alone. Nothing readable is ever read as idle. */
export async function sampleTurnTree(pid: number): Promise<LivenessSample> {
  if (process.platform === "linux") {
    try { return sampleLinux(pid); } catch { return { ...UNKNOWN_SAMPLE, alive: pidAlive(pid) }; }
  }
  const alive = pidAlive(pid);
  if (!alive) return { ...UNKNOWN_SAMPLE, alive };
  try {
    const { sampleProcessTree } = await import("./acp/quiet-status.ts");
    const sample = await sampleProcessTree(pid);
    return { alive, cpuMs: sample.cpuMs, ioBytes: null, connections: sample.connections, external: null };
  } catch {
    return { ...UNKNOWN_SAMPLE, alive };
  }
}

/** What the person is shown; key and params let the chat translate it. */
export interface TurnNotice {
  message: string;
  key: "chat.notice.turnStillRunning" | "chat.notice.turnStuck";
  params: Record<string, string>;
}

export type LivenessVerdict =
  | { kind: "running"; active: string[]; status: TurnNotice | null }
  | { kind: "stuck"; notice: TurnNotice; quietMs: number }
  | { kind: "over-cap"; message: string };

export interface ActivityRules {
  countIo?: boolean;
  cpuShare?: number;
}

export interface TurnLivenessOptions extends ActivityRules {
  /** Shown to the person: "CodeArts", "MiniMax Code". */
  name: string;
  stuckMs: number;
  /** Opt-in wall-clock cap; 0 or absent is none. */
  maxTotalMs?: number;
  /** The env var that set maxTotalMs, named in its message. */
  maxTotalVar?: string;
  /** The process whose tree is the turn; absent when the work is remote (an HTTP stream): output alone then counts. */
  pid?: () => number | undefined;
  sample?: (pid: number) => Promise<LivenessSample>;
  now?: () => number;
  statusAfterMs?: number;
  statusEveryMs?: number;
}

/** The same words as CHAT_NOTICE["chat.notice.turnStuck"] (server/chat-notices.ts), which the chat translates. */
export function stuckNotice(name: string, quietMs: number): TurnNotice {
  const window = formatSpan(quietMs);
  return {
    message: `${name} was judged stuck by a status check: no CPU use, output or network activity for ${window}, so the turn was stopped. Send the message again to retry.`,
    key: "chat.notice.turnStuck",
    params: { name, window },
  };
}

/** The same words as CHAT_NOTICE["chat.notice.turnStillRunning"]. */
export function statusNotice(name: string, input: { elapsedMs: number; cpuMs: number | null; windowMs: number; connections: number | null; outputAgoMs: number }): TurnNotice {
  const elapsed = formatSpan(input.elapsedMs);
  const cpu = input.cpuMs === null ? "?" : `${(input.cpuMs / 1000).toFixed(1)} s`;
  const window = formatSpan(input.windowMs);
  const connections = input.connections === null ? "?" : String(input.connections);
  const idle = formatSpan(input.outputAgoMs);
  return {
    message: `${name} is still running · ${elapsed} · CPU +${cpu} in the last ${window} · ${connections} network connections · last output ${idle} ago`,
    key: "chat.notice.turnStillRunning",
    params: { name, elapsed, cpu, window, connections, idle },
  };
}

/** One running turn's status queries. Call output() for every line or event the turn shows, check() on a timer. */
export class TurnLiveness {
  readonly startedAt: number;
  private readonly opts: TurnLivenessOptions;
  private lastOutputAt: number;
  private lastActiveAt: number;
  private lastCheckAt: number;
  private previous: LivenessSample | null = null;
  private lastStatusAt = 0;
  private statuses = 0;
  private outputSinceCheck = false;
  private aliveSinceCheck = false;
  /** CPU used between the last two looks, for the status line. */
  private cpuWindow: { ms: number | null; span: number } = { ms: null, span: 0 };

  constructor(opts: TurnLivenessOptions) {
    this.opts = opts;
    const at = this.now();
    this.startedAt = at;
    this.lastOutputAt = at;
    this.lastActiveAt = at;
    this.lastCheckAt = at;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  output(): void {
    const at = this.now();
    this.lastOutputAt = at;
    this.lastActiveAt = at;
    this.outputSinceCheck = true;
  }

  /** The engine's own status says it is working (a desktop app's "generating" flag), without new output to show. */
  alive(): void {
    this.lastActiveAt = this.now();
    this.aliveSinceCheck = true;
  }

  get quietMs(): number {
    return this.now() - this.lastActiveAt;
  }

  /** What changed since the last look, as words: "cpu", "io", "network". `countIo: false` for a process the caller
   * itself talks to all the time (a polled app server), whose bytes would always move; `cpuShare` raises the CPU bar
   * for one that also spends a little CPU answering those polls. */
  static activity(previous: LivenessSample | null, sample: LivenessSample, spanMs: number, how: ActivityRules = {}): string[] {
    const active: string[] = [];
    const share = how.cpuShare ?? CPU_ACTIVE_SHARE, countIo = how.countIo ?? true;
    if (previous && sample.cpuMs !== null && previous.cpuMs !== null
        && sample.cpuMs - previous.cpuMs >= Math.max(CPU_ACTIVE_FLOOR_MS, spanMs * share)) active.push("cpu");
    if (countIo && previous && sample.ioBytes !== null && previous.ioBytes !== null && sample.ioBytes !== previous.ioBytes) active.push("io");
    // A connection to a remote peer is a model request in flight. Through a local proxy only the bytes moving show it,
    // so a loopback connection counts by itself only where bytes cannot be read.
    if ((sample.external ?? 0) > 0 || (sample.ioBytes === null && sample.external === null && (sample.connections ?? 0) > 0)) active.push("network");
    return active;
  }

  async check(): Promise<LivenessVerdict> {
    const pid = this.opts.pid?.();
    const sample = pid ? await (this.opts.sample ?? sampleTurnTree)(pid).catch(() => UNKNOWN_SAMPLE) : null;
    const at = this.now();
    const span = at - this.lastCheckAt;
    const measured = sample ? TurnLiveness.activity(this.previous, sample, span, this.opts) : [];
    // Output and the engine's own status already moved lastActiveAt when they happened; a measurement moves it now.
    if (measured.length) this.lastActiveAt = at;
    const active = [...(this.outputSinceCheck ? ["output"] : []), ...(this.aliveSinceCheck ? ["status"] : []), ...measured];
    this.outputSinceCheck = false;
    this.aliveSinceCheck = false;
    if (sample) {
      this.cpuWindow = { ms: sample.cpuMs !== null && this.previous?.cpuMs != null ? sample.cpuMs - this.previous.cpuMs : null, span };
      this.previous = sample;
    }
    this.lastCheckAt = at;
    // An unreadable tree (null everywhere) proves nothing either way: only output counts then, as before.
    const maxTotal = this.opts.maxTotalMs ?? 0;
    if (maxTotal > 0 && at - this.startedAt >= maxTotal) {
      return { kind: "over-cap", message: `${this.opts.name} ran for ${formatSpan(at - this.startedAt)}, the total limit set by ${this.opts.maxTotalVar ?? "OMB_TURN_MAX_MS"}, so the turn was stopped.` };
    }
    const quietMs = at - this.lastActiveAt;
    if (this.opts.stuckMs > 0 && quietMs >= this.opts.stuckMs) {
      return { kind: "stuck", quietMs, notice: stuckNotice(this.opts.name, quietMs) };
    }
    const after = this.opts.statusAfterMs ?? DEFAULT_STATUS_AFTER_MS, every = this.opts.statusEveryMs ?? DEFAULT_STATUS_EVERY_MS;
    let status: TurnNotice | null = null;
    if (at - this.startedAt >= after && at - this.lastOutputAt >= STATUS_QUIET_MS && at - this.lastStatusAt >= every && this.statuses < MAX_STATUS_NOTICES) {
      this.lastStatusAt = at;
      this.statuses += 1;
      status = statusNotice(this.opts.name, {
        elapsedMs: at - this.startedAt, cpuMs: this.cpuWindow.ms, windowMs: this.cpuWindow.span,
        connections: sample?.connections ?? null, outputAgoMs: at - this.lastOutputAt,
      });
    }
    return { kind: "running", active, status };
  }
}

export interface TurnWatch {
  output(): void;
  stop(): void;
  readonly liveness: TurnLiveness;
}

/** Runs a TurnLiveness on a timer: onStatus for a long quiet turn, onStuck (once, then the watch stops) when it is
 * judged stuck or reaches an opt-in cap. The caller still owns killing the process group and answering the turn. */
export function watchTurn(opts: TurnLivenessOptions & {
  tickMs?: number;
  onStatus?: (notice: TurnNotice) => void;
  onStuck: (verdict: Exclude<LivenessVerdict, { kind: "running" }>) => void;
}): TurnWatch {
  const liveness = new TurnLiveness(opts);
  let stopped = false, checking = false;
  const tick = async () => {
    if (stopped || checking) return;
    checking = true;
    let verdict: LivenessVerdict;
    try { verdict = await liveness.check(); } finally { checking = false; }
    if (stopped) return;
    if (verdict.kind === "running") {
      if (verdict.status) opts.onStatus?.(verdict.status);
      return;
    }
    stop();
    opts.onStuck(verdict);
  };
  // The shortest window in force decides how often to look, so a short cap or window is still checked in time.
  const windows = [opts.stuckMs, opts.maxTotalMs ?? 0].filter((ms) => ms > 0);
  const timer = setInterval(() => { void tick().catch(() => {}); }, opts.tickMs ?? livenessTickMs(process.env, windows.length ? Math.min(...windows) : 0));
  timer.unref?.();
  const stop = () => { stopped = true; clearInterval(timer); };
  return { output: () => liveness.output(), stop, liveness };
}

/** The ACP session/update a bridge sends for a status line; the shared ACP driver shows it as a notice. */
export function statusUpdate(notice: TurnNotice): Record<string, unknown> {
  return { sessionUpdate: "omb_turn_status", message: notice.message, notice: { key: notice.key, params: notice.params } };
}

/** The ACP error data a bridge attaches when it stops a stuck turn, so the chat can show the reason in its own language. */
export function stuckErrorData(notice: TurnNotice): Record<string, unknown> {
  return { ombNotice: { key: notice.key, params: notice.params } };
}
