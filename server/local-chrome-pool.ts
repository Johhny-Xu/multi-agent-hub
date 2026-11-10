// FEAT-cloud-offload: when no cloud machine's Chrome answers, an Auto bot's browser falls back to this host, the
// low-power host. That host is a weak CPU with little memory, so its fallback Chrome is deliberately tiny: one instance
// for the whole server, memory and CPU capped by a systemd scope, closed after 90 idle seconds, and closed as a
// whole process group so no renderer outlives it. How many pages it serves at once is the CDP proxy's job, not
// this pool's.
import { mkdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";

/** This host's fallback Chrome listens here, on loopback only. */
export const LOCAL_CHROME_PORT = 9339;
/** How long the fallback Chrome may sit with no DevTools connection before it is closed. */
export const LOCAL_CHROME_IDLE_MS = 90_000;

/** How often the port is probed while Chrome is starting up. */
const READY_PROBE_MS = 300;
/** How often the port is probed while waiting for Chrome to die. */
const DEATH_PROBE_MS = 200;
/** How long Chrome gets to leave on SIGTERM before its group is SIGKILLed. */
const STOP_GRACE_MS = 3_000;
/** How long the pool waits after SIGKILL before it forgets the process either way. */
const KILL_GRACE_MS = 1_000;
/** The idle sweep's period; the caller's timer calls tick() this often. */
const SWEEP_INTERVAL_MS = 15_000;
/** Chrome builds to try, in the order a person is most likely to have installed. */
const CHROME_BINARIES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"] as const;

export interface LocalChromeArgvInput {
  binary: string;
  port: number;
  userDataDir: string;
  systemdRun: boolean;
}

/** Chrome's flags, in one fixed order so a diff of them stays readable; about:blank keeps the first page empty. */
function chromeFlags(port: number, userDataDir: string): string[] {
  return [
    "--headless=new",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--renderer-process-limit=2",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--mute-audio",
    "--lang=zh-CN",
    "about:blank",
  ];
}

/** Returns [command, ...args]: under systemd-run the caps travel with the process group, otherwise Chrome runs bare. */
export function localChromeArgv(input: LocalChromeArgvInput): string[] {
  const flags = chromeFlags(input.port, input.userDataDir);
  if (!input.systemdRun) return [input.binary, ...flags];
  // --scope keeps the caps on this transient unit only and --collect drops it the moment Chrome exits, so a
  // crashed fallback never leaves a unit behind for the next one to trip over.
  return [
    "systemd-run",
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    "-p",
    "MemoryMax=1536M",
    "-p",
    "MemoryHigh=1200M",
    "-p",
    "CPUQuota=150%",
    "--",
    input.binary,
    ...flags,
  ];
}

export interface LocalChromePoolDeps {
  /** Starts a process: must be detached (its own process group) with stdio ignored; returns the pid, throws on failure. */
  spawn(command: string, args: string[]): { pid: number; onExit(cb: (code: number | null) => void): void };
  /** kill(-pgid, signal); a group that no longer exists is not an error. */
  killGroup(pgid: number, signal: NodeJS.Signals): void;
  /** Whether GET <url>/json/version answers. */
  probe(url: string): Promise<boolean>;
  /** How many outside connections this DevTools still has, as the CDP proxy counts them. */
  connections(): number;
  hasSystemdRun(): boolean;
  /** The google-chrome / chromium binary to run, or null when this host has none. */
  chromeBinary(): string | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  log?(line: string): void;
}

/** A Chrome this pool started, so it may kill the whole group; adopted Chrome has no entry here. */
interface OwnedChrome {
  pid: number;
  exited: boolean;
}

export class LocalChromePool {
  private readonly port: number;
  private readonly userDataDir: string;
  private readonly idleMs: number;
  private readonly readyTimeoutMs: number;
  private readonly deps: LocalChromePoolDeps;
  private owned: OwnedChrome | null = null;
  /** True while the port answers but the process is somebody else's (a leftover from an earlier run). */
  private adopted = false;
  private starting: Promise<string | null> | null = null;
  private lastActivity: number;

  constructor(options: {
    port?: number;
    userDataDir: string;
    idleMs?: number;
    readyTimeoutMs?: number;
    deps: LocalChromePoolDeps;
  }) {
    this.port = options.port ?? LOCAL_CHROME_PORT;
    this.userDataDir = options.userDataDir;
    this.idleMs = options.idleMs ?? LOCAL_CHROME_IDLE_MS;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
    this.deps = options.deps;
    this.lastActivity = this.deps.now();
  }

  /** The DevTools URL to attach to, or null when this host has no fallback Chrome to give. */
  async ensure(): Promise<string | null> {
    if (this.starting) return this.starting;
    const starting = this.ensureInner();
    this.starting = starting;
    try {
      return await starting;
    } finally {
      this.starting = null;
    }
  }

  /** Records a use, so the idle clock restarts; called on every turn that runs on this Chrome. */
  touch(): void {
    this.lastActivity = this.deps.now();
  }

  /** Whether something answers for this pool right now, ours or adopted. */
  running(): boolean {
    return this.owned !== null || this.adopted;
  }

  /** Closes the fallback Chrome as a whole process group; an adopted one is only forgotten, never killed. */
  async stop(): Promise<void> {
    const owned = this.owned;
    if (!owned) {
      this.adopted = false;
      return;
    }
    await this.stopOwned(owned);
  }

  /** One idle check: closes the Chrome once nothing has connected for idleMs. Returns whether this tick closed it. */
  async tick(): Promise<boolean> {
    if (this.starting) return false;
    if (!this.owned && !this.adopted) return false;
    if (this.deps.connections() > 0) return false;
    if (this.deps.now() - this.lastActivity < this.idleMs) return false;
    if (this.adopted) {
      // Not ours to kill: forget it and let the next ensure probe the port again.
      this.adopted = false;
      this.log("本机回落 Chrome 是外部进程，只停止跟踪");
      return false;
    }
    this.log(`本机回落 Chrome 空闲 ${Math.round(this.idleMs / 1000)}s，已整组关闭`);
    await this.stop();
    return true;
  }

  /** Starts the caller's idle sweep and returns the function that stops it. */
  startIdleSweep(intervalMs: number = SWEEP_INTERVAL_MS): () => void {
    const timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    // The sweep must never be the reason this server stays alive.
    timer.unref();
    return () => clearInterval(timer);
  }

  private async ensureInner(): Promise<string | null> {
    const url = this.url();
    // Probe first: a Chrome that already answers on this port is used as it stands, whether this pool started it
    // or an earlier run left it behind.
    if (await this.deps.probe(url)) {
      this.adopted = this.owned === null;
      this.touch();
      if (this.adopted) this.log("本机回落 Chrome 由外部进程提供，直接使用");
      return url;
    }
    // Ours but deaf: the group is gone or wedged, so close it before a fresh one takes the port.
    if (this.owned) await this.stop();
    return this.start();
  }

  private async start(): Promise<string | null> {
    const binary = this.deps.chromeBinary();
    if (!binary) {
      this.log("本机没有 Chrome，无法回落");
      return null;
    }
    mkdirSync(this.userDataDir, { recursive: true });
    const systemdRun = this.deps.hasSystemdRun();
    const [command, ...args] = localChromeArgv({ binary, port: this.port, userDataDir: this.userDataDir, systemdRun });
    let child: { pid: number; onExit(cb: (code: number | null) => void): void };
    try {
      child = this.deps.spawn(command, args);
    } catch (error) {
      this.log(`本机回落 Chrome 启动失败：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    const owned: OwnedChrome = { pid: child.pid, exited: false };
    this.owned = owned;
    child.onExit(() => this.onExit(owned));
    this.log(`本机回落 Chrome 已启动（pid ${owned.pid}，${systemdRun ? "systemd 限额 1536M/150%" : "无 systemd 限额"}）`);
    const url = this.url();
    const deadline = this.deps.now() + this.readyTimeoutMs;
    while (this.deps.now() < deadline) {
      await this.deps.sleep(READY_PROBE_MS);
      if (owned.exited) break;
      if (await this.deps.probe(url)) {
        this.touch();
        return url;
      }
    }
    this.log(`本机回落 Chrome 启动超时（${this.readyTimeoutMs}ms），已整组关闭`);
    if (!owned.exited) await this.stopOwned(owned);
    return null;
  }

  private onExit(owned: OwnedChrome): void {
    owned.exited = true;
    if (this.owned === owned) this.owned = null;
    this.log(`本机回落 Chrome 已退出（pid ${owned.pid}）`);
  }

  private async stopOwned(owned: OwnedChrome): Promise<void> {
    this.deps.killGroup(owned.pid, "SIGTERM");
    if (await this.waitGone(owned, STOP_GRACE_MS)) {
      if (this.owned === owned) this.owned = null;
      return;
    }
    this.deps.killGroup(owned.pid, "SIGKILL");
    await this.waitGone(owned, KILL_GRACE_MS);
    if (this.owned === owned) this.owned = null;
  }

  /** Waits until the group is gone: the process exited, or the port stopped answering. */
  private async waitGone(owned: OwnedChrome, timeoutMs: number): Promise<boolean> {
    const deadline = this.deps.now() + timeoutMs;
    while (this.deps.now() < deadline) {
      if (owned.exited) return true;
      if (!(await this.deps.probe(this.url()))) return true;
      await this.deps.sleep(DEATH_PROBE_MS);
    }
    return owned.exited;
  }

  private url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private log(line: string): void {
    this.deps.log?.(line);
  }
}

/** Finds `name` on PATH by looking, never by exec'ing a lookup tool. */
function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

export function realLocalChromeDeps(connections: () => number, log?: (line: string) => void): LocalChromePoolDeps {
  return {
    spawn(command, args) {
      // Detached: Chrome leads its own process group, so killGroup takes its renderers with it; ignored stdio
      // keeps a dead pipe from reaching this server. unref keeps the server's exit from waiting on it.
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.unref();
      if (child.pid === undefined) throw new Error(`${command} 没有返回 pid`);
      return {
        pid: child.pid,
        onExit(cb) {
          // A binary that never execs reports 'error' with no 'exit'; both mean this fallback Chrome is gone.
          child.on("exit", (code) => cb(code));
          child.on("error", () => cb(null));
        },
      };
    },
    killGroup(pgid, signal) {
      try {
        process.kill(-pgid, signal);
      } catch (error) {
        // ESRCH: the group is already gone, which is the outcome the caller wanted anyway.
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    },
    async probe(url) {
      try {
        const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(2000) });
        return response.ok;
      } catch {
        return false;
      }
    },
    connections,
    hasSystemdRun() {
      // The caps only exist under a systemd user manager; everywhere else Chrome runs bare.
      return process.platform === "linux" && onPath("systemd-run") !== null;
    },
    chromeBinary() {
      for (const name of CHROME_BINARIES) {
        const found = onPath(name);
        if (found) return found;
      }
      return null;
    },
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log,
  };
}
