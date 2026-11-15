import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

interface LinuxStat {
  pid: number;
  pgrp: number;
  start: string;
  state: string;
}

interface TrackedGroup {
  child: ChildProcess;
  pgid: number | undefined;
  ownGroup: boolean;
  leaderStart: string | null;
  retired: boolean;
  stopping: Promise<void> | null;
}

const DEFAULT_KILL_GRACE_MS = 2_000;
const POST_KILL_WAIT_MS = 500;
const POLL_STEP_MS = 25;

function defaultGraceMs(): number {
  const configured = Number(process.env.OMB_ADAPTER_KILL_GRACE_MS ?? DEFAULT_KILL_GRACE_MS);
  if (!Number.isFinite(configured)) return DEFAULT_KILL_GRACE_MS;
  return Math.min(30_000, Math.max(25, Math.trunc(configured)));
}

function readLinuxStat(pid: number): LinuxStat | null {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
  const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  const state = fields[0];
  const pgrp = Number(fields[2]);
  const start = fields[19];
  if (!state || !start || !Number.isInteger(pgrp)) return null;
  return { pid, pgrp, start, state };
}

/**
 * Checks whether a recorded POSIX process group still has at least one live (non-zombie) member.
 * On Linux, `expectedLeaderStart` guards against PID reuse if the original group leader exited and
 * the kernel later recycled the numeric ID for an unrelated process.
 */
export function isProcessGroupAlive(pgid: number, expectedLeaderStart?: string | null): boolean {
  if (process.platform === "win32") return false;
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) return false;
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  if (process.platform !== "linux") return true;
  if (expectedLeaderStart) {
    try {
      const leader = readLinuxStat(pgid);
      if (leader && leader.start !== expectedLeaderStart) return false;
    } catch {
      return false;
    }
  }
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readLinuxStat(Number(entry));
      if (stat && stat.pgrp === pgid && stat.state !== "Z" && stat.state !== "X") return true;
    } catch {
      // Concurrent exits in /proc are normal while a group is winding down.
    }
  }
  return false;
}

function waitOrClose(child: ChildProcess, ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolveWait) => {
    const done = () => {
      clearTimeout(timer);
      child.off("close", done);
      child.off("exit", done);
      resolveWait();
    };
    const timer = setTimeout(done, ms);
    child.once("close", done);
    child.once("exit", done);
  });
}

/**
 * Tracks only the child processes and detached POSIX process groups started by a single ACP
 * adapter instance, so cancellation, stdin EOF, and SIGTERM/SIGINT reclaim every descendant
 * (`SIGTERM` first, then `SIGKILL` after grace) without ever signaling by process name or
 * re-signaling an already-exited group.
 */
export class AdapterProcessGroups {
  private readonly entries = new Map<ChildProcess, TrackedGroup>();

  track(child: ChildProcess, ownGroup = process.platform !== "win32"): void {
    const pgid = typeof child.pid === "number" && child.pid > 1 ? child.pid : undefined;
    let leaderStart: string | null = null;
    if (process.platform === "linux" && ownGroup && pgid !== undefined) {
      try {
        leaderStart = readLinuxStat(pgid)?.start ?? null;
      } catch {
        leaderStart = null;
      }
    }
    this.entries.set(child, {
      child,
      pgid,
      ownGroup,
      leaderStart,
      retired: false,
      stopping: null,
    });
  }

  kill(child: ChildProcess, graceMs?: number): Promise<void> {
    const entry = this.entries.get(child);
    if (!entry || entry.retired) return Promise.resolve();
    if (entry.stopping) return entry.stopping;
    const run = this.stopEntry(entry, graceMs).finally(() => {
      entry.stopping = null;
      entry.retired = true;
      this.entries.delete(child);
    });
    entry.stopping = run;
    return run;
  }

  async killAll(graceMs?: number): Promise<void> {
    await Promise.all([...this.entries.keys()].map((child) => this.kill(child, graceMs)));
  }

  /** Last-resort synchronous `SIGTERM` for `process.once("exit")` when Node exits unexpectedly. */
  signalAllSync(sig: NodeJS.Signals = "SIGTERM"): void {
    for (const [child, entry] of this.entries) {
      if (entry.retired) continue;
      entry.retired = true;
      this.entries.delete(child);
      if (process.platform === "win32") {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill();
          } catch {}
        }
        continue;
      }
      if (entry.ownGroup && entry.pgid !== undefined) {
        if (!isProcessGroupAlive(entry.pgid, entry.leaderStart)) continue;
        try {
          process.kill(-entry.pgid, sig);
        } catch {}
      } else if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill(sig);
        } catch {}
      }
    }
  }

  private async stopEntry(entry: TrackedGroup, graceMs?: number): Promise<void> {
    const { child, pgid, ownGroup, leaderStart } = entry;
    const termGraceMs = graceMs === undefined ? defaultGraceMs() : Math.max(0, graceMs);

    if (process.platform === "win32") {
      if (child.exitCode !== null || child.signalCode !== null || pgid === undefined) return;
      const killer = spawn("taskkill.exe", ["/PID", String(pgid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      await new Promise<void>((resolveKill) => {
        const finish = () => {
          clearTimeout(timer);
          killer.off("close", finish);
          killer.off("error", finish);
          resolveKill();
        };
        const timer = setTimeout(finish, 1_500);
        killer.once("close", finish);
        killer.once("error", finish);
      });
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill();
        } catch {}
      }
      return;
    }

    if (ownGroup && pgid !== undefined) {
      // Never emit a signal to a group whose members have already exited.
      if (!isProcessGroupAlive(pgid, leaderStart)) return;
      try {
        process.kill(-pgid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGTERM");
          } catch {}
        }
      }
      const termDeadline = Date.now() + termGraceMs;
      while (Date.now() < termDeadline) {
        if (!isProcessGroupAlive(pgid, leaderStart)) return;
        await waitOrClose(child, Math.min(POLL_STEP_MS, termDeadline - Date.now()));
      }
      if (!isProcessGroupAlive(pgid, leaderStart)) return;
      try {
        process.kill(-pgid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      }
      const killDeadline = Date.now() + POST_KILL_WAIT_MS;
      while (Date.now() < killDeadline) {
        if (!isProcessGroupAlive(pgid, leaderStart)) return;
        await waitOrClose(child, Math.min(POLL_STEP_MS, killDeadline - Date.now()));
      }
      return;
    }

    // Shared POSIX group (`AGENTHUB_OWNED_POSIX_GROUP=1`): only the direct child may be signaled here.
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
    const termDeadline = Date.now() + termGraceMs;
    while (child.exitCode === null && child.signalCode === null && Date.now() < termDeadline) {
      await waitOrClose(child, Math.min(POLL_STEP_MS, termDeadline - Date.now()));
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGKILL");
    } catch {
      return;
    }
    await waitOrClose(child, POST_KILL_WAIT_MS);
  }
}

/**
 * Wires idempotent adapter teardown on `SIGTERM`, `SIGINT`, and `stdin` close/EOF. Unlike a
 * synchronous `process.exit(0)`, this waits for `onShutdown` and `groups.killAll()` (`SIGTERM` ->
 * grace -> `SIGKILL`) before exiting so detached child process groups cannot outlive the adapter.
 */
export function installAdapterShutdown(
  groups: AdapterProcessGroups,
  onShutdown?: () => Promise<void> | void,
): () => Promise<void> {
  let shuttingDown: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (!shuttingDown) {
      shuttingDown = (async () => {
        try {
          await onShutdown?.();
        } finally {
          await groups.killAll();
        }
      })();
    }
    return shuttingDown;
  };
  const exitAfterShutdown = (): void => {
    void shutdown().finally(() => {
      process.exit(0);
    });
  };
  process.once("SIGTERM", exitAfterShutdown);
  process.once("SIGINT", exitAfterShutdown);
  process.stdin.once("end", exitAfterShutdown);
  process.stdin.once("close", exitAfterShutdown);
  process.once("exit", () => {
    groups.signalAllSync("SIGTERM");
  });
  return shutdown;
}
