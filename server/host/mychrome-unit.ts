// The shared My Chrome of a self-hosted box (CDP 127.0.0.1:9333) runs as the systemd user unit omb-mychrome, which no
// longer restarts itself: the person may close it. It is started here when a bot's browser needs it, and stopped again
// once no bot has used it for a while and no turn holds a browser attached to it.
//   OMB_MYCHROME_UNIT      the unit to start and stop (default omb-mychrome; "off" turns all of this off)
//   OMB_MYCHROME_IDLE_MIN  idle minutes before it is stopped (default 10; 0 never stops it)
// A Chrome nobody here has used since the last stop (one the person opened for themselves) is never stopped.
import { execFile } from "node:child_process";

import { cdpUrlPort } from "../cloud-cdp-scope.ts";

const CDP_URL = "http://127.0.0.1:9333";
/** How long a start waits for /json/version to answer. */
const START_WAIT_MS = 20_000;
const PROBE_EVERY_MS = 300;
const SWEEP_EVERY_MS = 60_000;

function systemctl(args: string[], timeoutMs = 15_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("systemctl", ["--user", ...args], { timeout: timeoutMs }, (error, _stdout, stderr) => {
      resolve(error ? (String(stderr).trim() || error.message) : null);
    });
  });
}

async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

export class MyChromeUnit {
  readonly url = CDP_URL;
  readonly port = 9333;
  private readonly unit: string;
  private readonly idleMs: number;
  private last = Date.now();
  /** A bot used it since it was last started or stopped here: only then may the idle sweep stop it. */
  private used = false;
  private starting: Promise<boolean> | null = null;
  /** The idle stop under way: a start waits for it, so a bot never attaches to a Chrome about to be stopped. */
  private stopping: Promise<boolean> | null = null;
  private readonly busy: Array<() => boolean> = [];
  private readonly beforeStopHooks: Array<() => Promise<void>> = [];

  private readonly log: (line: string) => void;

  constructor(env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = (line) => console.info(line)) {
    this.log = log;
    const unit = env.OMB_MYCHROME_UNIT?.trim();
    this.unit = unit === undefined || unit === "" ? "omb-mychrome" : unit;
    const minutes = Number(env.OMB_MYCHROME_IDLE_MIN ?? 10);
    this.idleMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
  }

  get enabled(): boolean {
    return this.unit !== "off";
  }

  /** Whether a CDP url reaches this Chrome directly. */
  serves(url: string | undefined): boolean {
    if (!url) return false;
    try {
      const host = new URL(url).hostname;
      return (host === "127.0.0.1" || host === "localhost") && cdpUrlPort(url) === this.port;
    } catch {
      return false;
    }
  }

  touch(): void {
    this.last = Date.now();
    this.used = true;
  }

  /** A check that says a bot is using this Chrome right now; the sweep never stops it while one says yes. */
  addBusy(check: () => boolean): void {
    this.busy.push(check);
  }

  /** Runs before an idle stop, e.g. to close the bots' idle connections to it. */
  beforeStop(hook: () => Promise<void>): void {
    this.beforeStopHooks.push(hook);
  }

  /** Makes sure the Chrome answers, starting its unit when it does not; false when it could not be started. */
  ensure(): Promise<boolean> {
    if (!this.enabled) return Promise.resolve(true);
    this.touch();
    this.starting ??= this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async start(): Promise<boolean> {
    if (this.stopping) await this.stopping;
    if (await answers(this.url)) return true;
    const failed = await systemctl(["start", this.unit]);
    if (failed) {
      this.log(`mychrome: systemctl --user start ${this.unit} failed: ${failed}`);
      return false;
    }
    const until = Date.now() + START_WAIT_MS;
    while (Date.now() < until) {
      if (await answers(this.url)) {
        this.log(`mychrome: started ${this.unit} on demand`);
        this.touch();
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, PROBE_EVERY_MS));
    }
    this.log(`mychrome: ${this.unit} started but ${this.url} did not answer within ${START_WAIT_MS / 1000}s`);
    return false;
  }

  private isBusy(): boolean {
    return this.busy.some((check) => {
      try { return check(); } catch { return true; }
    });
  }

  /** One idle check; returns whether it stopped the unit. */
  async tick(): Promise<boolean> {
    if (!this.enabled || this.idleMs === 0 || !this.used || this.starting || this.stopping) return false;
    if (this.isBusy()) {
      this.last = Date.now();
      return false;
    }
    if (Date.now() - this.last < this.idleMs) return false;
    this.stopping = this.stop().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  private async stop(): Promise<boolean> {
    for (const hook of this.beforeStopHooks) await hook().catch(() => undefined);
    // A bot may have taken it while the hooks ran.
    if (this.starting || this.isBusy() || Date.now() - this.last < this.idleMs) return false;
    const failed = await systemctl(["stop", this.unit], 30_000);
    if (failed) {
      this.log(`mychrome: systemctl --user stop ${this.unit} failed: ${failed}`);
      return false;
    }
    this.used = false;
    this.log(`mychrome: no bot used it for ${Math.round(this.idleMs / 60_000)} min, stopped ${this.unit}`);
    return true;
  }

  startIdleSweep(everyMs = SWEEP_EVERY_MS): () => void {
    const timer = setInterval(() => { void this.tick(); }, everyMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}

/** The one My Chrome unit this server starts and stops. */
export const myChromeUnit = new MyChromeUnit();
