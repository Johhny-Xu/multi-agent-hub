import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAcpDriver } from "./acp/core.ts";
import { AdapterProcessGroups, isProcessGroupAlive } from "./adapter-process-group.ts";
import { captureCliTree, killCliTree, spawnCli } from "../procs.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const CODEARTS_BRIDGE = resolve(HERE, "codearts-acp.ts");
const MCODE_BRIDGE = resolve(HERE, "mcode-acp.ts");
const ZCODE_BRIDGE = resolve(HERE, "zcode-acp.ts");
const CODEARTS_PY = resolve(REPO_ROOT, "drivers/codearts_cli.py");

interface PidRecord {
  pid: number;
  pgid: number;
  start: string | null;
}

const tempDirs: string[] = [];
const trackedPids = new Map<number, string | null>();

function readProcStat(pid: number): { pgrp: number; start: string; state: string } | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return {
      state: fields[0] ?? "",
      pgrp: Number(fields[2]),
      start: fields[19] ?? "",
    };
  } catch {
    return null;
  }
}

function recordPidForCleanup(pid: number | undefined, expectedStart?: string | null): void {
  if (!pid || pid <= 1 || pid === process.pid) return;
  const start = expectedStart !== undefined ? expectedStart : (readProcStat(pid)?.start ?? null);
  trackedPids.set(pid, start);
}

function isPidAlive(pid: number, expectedStart?: string | null): boolean {
  if (pid <= 1) return false;
  if (process.platform === "linux") {
    const stat = readProcStat(pid);
    if (!stat) return false;
    if (expectedStart && stat.start !== expectedStart) return false;
    return stat.state !== "Z" && stat.state !== "X";
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Timed out after ${timeoutMs} ms`);
}

function makeScratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function readJsonFile<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as T;
    const maybePid = (raw as { pid?: unknown })?.pid;
    const maybeStart = (raw as { start?: unknown })?.start;
    if (typeof maybePid === "number") {
      recordPidForCleanup(maybePid, typeof maybeStart === "string" ? maybeStart : undefined);
    }
    return raw;
  } catch {
    return null;
  }
}

function spawnBystander(): { child: ChildProcess; pid: number; start: string | null } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
    detached: process.platform !== "win32",
  });
  const pid = child.pid!;
  const start = readProcStat(pid)?.start ?? null;
  recordPidForCleanup(pid, start);
  return { child, pid, start };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const [pid, start] of trackedPids) {
    if (isPidAlive(pid, start)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  trackedPids.clear();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe.skipIf(process.platform === "win32")("ORPHAN-KILLTREE process group cleanup", () => {
  describe("AdapterProcessGroups signal hygiene", () => {
    it("never signals a process group that has already exited", async () => {
      const dir = makeScratch("omb-orphan-exited-");
      const childFile = join(dir, "child.json");
      const grandFile = join(dir, "grand.json");
      const script = join(dir, "quick-tree.mjs");
      writeFileSync(script, `
        import { spawn } from "node:child_process";
        import { readFileSync, writeFileSync } from "node:fs";
        const stat = (pid) => {
          const raw = readFileSync(\`/proc/\${pid}/stat\`, "utf8");
          const f = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
          return { pid, pgid: Number(f[2]), start: f[19] };
        };
        if (process.argv[2] === "grand") {
          writeFileSync(${JSON.stringify(grandFile)}, JSON.stringify(stat(process.pid)));
          setTimeout(() => process.exit(0), 30);
        } else {
          writeFileSync(${JSON.stringify(childFile)}, JSON.stringify(stat(process.pid)));
          const g = spawn(process.execPath, [${JSON.stringify(script)}, "grand"], { stdio: "ignore" });
          g.on("exit", () => process.exit(0));
        }
      `);
      const groups = new AdapterProcessGroups();
      const child = spawn(process.execPath, [script], { stdio: "ignore", detached: true });
      recordPidForCleanup(child.pid);
      groups.track(child, true);

      const childInfo = await waitJson(childFile);
      const grandInfo = await waitJson(grandFile);
      await waitFor(() => !isPidAlive(childInfo.pid, childInfo.start) && !isPidAlive(grandInfo.pid, grandInfo.start));
      expect(isProcessGroupAlive(childInfo.pgid, childInfo.start)).toBe(false);

      const realKill = process.kill.bind(process);
      const signalsSent: Array<{ target: number; signal: string | number | undefined }> = [];
      vi.spyOn(process, "kill").mockImplementation(((target: number, sig?: string | number) => {
        if (sig !== 0 && sig !== undefined) signalsSent.push({ target, signal: sig });
        return realKill(target, sig as any);
      }) as typeof process.kill);

      await groups.kill(child, 100);
      await groups.killAll(100);
      groups.signalAllSync("SIGTERM");

      expect(signalsSent).toEqual([]);
    });

    it("sends SIGTERM once without SIGKILL when the group exits within grace, and does not re-signal", async () => {
      const dir = makeScratch("omb-orphan-grace-");
      const childFile = join(dir, "child.json");
      const grandFile = join(dir, "grand.json");
      const script = join(dir, "polite-tree.mjs");
      writeFileSync(script, `
        import { spawn } from "node:child_process";
        import { readFileSync, writeFileSync } from "node:fs";
        const stat = (pid) => {
          const raw = readFileSync(\`/proc/\${pid}/stat\`, "utf8");
          const f = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
          return { pid, pgid: Number(f[2]), start: f[19] };
        };
        if (process.argv[2] === "grand") {
          writeFileSync(${JSON.stringify(grandFile)}, JSON.stringify(stat(process.pid)));
          process.on("SIGTERM", () => process.exit(0));
          setInterval(() => {}, 1000);
        } else {
          writeFileSync(${JSON.stringify(childFile)}, JSON.stringify(stat(process.pid)));
          spawn(process.execPath, [${JSON.stringify(script)}, "grand"], { stdio: "ignore" });
          process.on("SIGTERM", () => process.exit(0));
          setInterval(() => {}, 1000);
        }
      `);
      const groups = new AdapterProcessGroups();
      const child = spawn(process.execPath, [script], { stdio: "ignore", detached: true });
      recordPidForCleanup(child.pid);
      groups.track(child, true);

      const childInfo = await waitJson(childFile);
      const grandInfo = await waitJson(grandFile);

      const realKill = process.kill.bind(process);
      const signalsSent: Array<{ target: number; signal: string | number }> = [];
      vi.spyOn(process, "kill").mockImplementation(((target: number, sig?: string | number) => {
        if (sig !== 0 && sig !== undefined) signalsSent.push({ target, signal: sig });
        return realKill(target, sig as any);
      }) as typeof process.kill);

      await groups.kill(child, 800);
      expect(isPidAlive(childInfo.pid, childInfo.start)).toBe(false);
      expect(isPidAlive(grandInfo.pid, grandInfo.start)).toBe(false);
      expect(signalsSent).toEqual([{ target: -childInfo.pgid, signal: "SIGTERM" }]);

      // Calling kill / killAll again on an already-reaped child sends zero signals.
      await groups.kill(child, 800);
      await groups.killAll(800);
      groups.signalAllSync("SIGTERM");
      expect(signalsSent).toEqual([{ target: -childInfo.pgid, signal: "SIGTERM" }]);
    });

    it("escalates SIGTERM -> SIGKILL when a grandchild ignores SIGTERM, leaving bystanders untouched", async () => {
      const dir = makeScratch("omb-orphan-stubborn-");
      const childFile = join(dir, "child.json");
      const grandFile = join(dir, "grand.json");
      const sigFile = join(dir, "grand.signals");
      const script = join(dir, "stubborn-tree.mjs");
      writeFileSync(script, `
        import { spawn } from "node:child_process";
        import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
        const stat = (pid) => {
          const raw = readFileSync(\`/proc/\${pid}/stat\`, "utf8");
          const f = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
          return { pid, pgid: Number(f[2]), start: f[19] };
        };
        if (process.argv[2] === "grand") {
          process.on("SIGTERM", () => {
            appendFileSync(${JSON.stringify(sigFile)}, "SIGTERM\\n");
          });
          writeFileSync(${JSON.stringify(grandFile)}, JSON.stringify(stat(process.pid)));
          setInterval(() => {}, 1000);
        } else {
          writeFileSync(${JSON.stringify(childFile)}, JSON.stringify(stat(process.pid)));
          spawn(process.execPath, [${JSON.stringify(script)}, "grand"], { stdio: "ignore" });
          setInterval(() => {}, 1000);
        }
      `);
      const bystander = spawnBystander();
      const groups = new AdapterProcessGroups();
      const child = spawn(process.execPath, [script], { stdio: "ignore", detached: true });
      recordPidForCleanup(child.pid);
      groups.track(child, true);

      const childInfo = await waitJson(childFile);
      const grandInfo = await waitJson(grandFile);
      expect(grandInfo.pgid).toBe(childInfo.pgid);

      await groups.kill(child, 150);

      expect(readFileSync(sigFile, "utf8")).toContain("SIGTERM");
      expect(isPidAlive(childInfo.pid, childInfo.start)).toBe(false);
      expect(isPidAlive(grandInfo.pid, grandInfo.start)).toBe(false);
      expect(isPidAlive(bystander.pid, bystander.start)).toBe(true);
    });
  });

  describe("Adapters clean up child process groups on SIGTERM and stdin close", () => {
    for (const trigger of ["SIGTERM", "stdin-close"] as const) {
      it(`codearts-acp + codearts_cli.py reaps fake CLI and stubborn grandchild on ${trigger}`, async () => {
        const dir = makeScratch(`omb-ca-${trigger}-`);
        const cliInfoFile = join(dir, "cli.json");
        const grandInfoFile = join(dir, "grand.json");
        const sigFile = join(dir, "signals.log");
        const fakeCli = writeFakeCodeartsCli(dir, { cliInfoFile, grandInfoFile, sigFile, mode: "hang-stubborn" });
        const bystander = spawnBystander();

        const adapter = spawnRpcBridge(CODEARTS_BRIDGE, ["--script", CODEARTS_PY, "--cli", fakeCli, "--timeout", "30"], {
          HOME: dir,
          OMB_CODEARTS_HOME: dir,
          OMB_ADAPTER_KILL_GRACE_MS: "150",
        });

        await adapter.request("initialize", { protocolVersion: 1 });
        const opened = await adapter.request("session/new", { cwd: dir });
        adapter.notifyPrompt(opened.sessionId, "run hanging task");

        const cliInfo = await waitJson(cliInfoFile);
        const grandInfo = await waitJson(grandInfoFile);
        // AGENTHUB_OWNED_POSIX_GROUP=1 must keep `codearts run` and its grandchild in Python's group.
        expect(grandInfo.pgid).toBe(cliInfo.pgid);
        expect(cliInfo.pgid).not.toBe(adapter.pid);

        if (trigger === "SIGTERM") adapter.child.kill("SIGTERM");
        else adapter.child.stdin.end();

        await waitFor(() => adapter.child.exitCode !== null || adapter.child.signalCode !== null);
        await waitFor(() => !isPidAlive(cliInfo.pid, cliInfo.start) && !isPidAlive(grandInfo.pid, grandInfo.start));
        expect(readFileSync(sigFile, "utf8")).toContain("SIGTERM");
        expect(isPidAlive(bystander.pid, bystander.start)).toBe(true);
      });

      it(`mcode-acp reaps fake mcode and stubborn grandchild on ${trigger}`, async () => {
        const dir = makeScratch(`omb-mcode-${trigger}-`);
        const cliInfoFile = join(dir, "cli.json");
        const grandInfoFile = join(dir, "grand.json");
        const sigFile = join(dir, "signals.log");
        const fakeMcode = writeFakeMcodeCli(dir, { cliInfoFile, grandInfoFile, sigFile });
        const bystander = spawnBystander();

        const adapter = spawnRpcBridge(MCODE_BRIDGE, ["--cli", fakeMcode, "--timeout", "30"], {
          HOME: dir,
          OMB_MCODE_HOME: dir,
          OMB_ADAPTER_KILL_GRACE_MS: "150",
        });

        await adapter.request("initialize", { protocolVersion: 1 });
        const opened = await adapter.request("session/new", { cwd: dir });
        adapter.notifyPrompt(opened.sessionId, "run hanging mcode");

        const cliInfo = await waitJson(cliInfoFile);
        const grandInfo = await waitJson(grandInfoFile);
        expect(grandInfo.pgid).toBe(cliInfo.pgid);

        if (trigger === "SIGTERM") adapter.child.kill("SIGTERM");
        else adapter.child.stdin.end();

        await waitFor(() => adapter.child.exitCode !== null || adapter.child.signalCode !== null);
        await waitFor(() => !isPidAlive(cliInfo.pid, cliInfo.start) && !isPidAlive(grandInfo.pid, grandInfo.start));
        expect(readFileSync(sigFile, "utf8")).toContain("SIGTERM");
        expect(isPidAlive(bystander.pid, bystander.start)).toBe(true);
      });

      it(`zcode-acp reaps fake app-server and stubborn grandchild on ${trigger}`, async () => {
        const dir = makeScratch(`omb-zcode-${trigger}-`);
        const cliInfoFile = join(dir, "cli.json");
        const grandInfoFile = join(dir, "grand.json");
        const sigFile = join(dir, "signals.log");
        const fakeZcode = writeFakeZcodeCli(dir, { cliInfoFile, grandInfoFile, sigFile });
        const bystander = spawnBystander();

        const adapter = spawnRpcBridge(ZCODE_BRIDGE, ["--cli", fakeZcode, "--mode", "yolo", "--timeout", "30"], {
          HOME: dir,
          OMB_ZCODE_HOME: dir,
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(dir, "providers.json"),
          OMB_ZCODE_STDIN_GRACE_MS: "80",
          OMB_ADAPTER_KILL_GRACE_MS: "150",
        });

        await adapter.request("initialize", { protocolVersion: 1 });
        await adapter.request("session/new", { cwd: dir });

        const cliInfo = await waitJson(cliInfoFile);
        const grandInfo = await waitJson(grandInfoFile);
        expect(grandInfo.pgid).toBe(cliInfo.pgid);

        if (trigger === "SIGTERM") adapter.child.kill("SIGTERM");
        else adapter.child.stdin.end();

        await waitFor(() => adapter.child.exitCode !== null || adapter.child.signalCode !== null);
        await waitFor(() => !isPidAlive(cliInfo.pid, cliInfo.start) && !isPidAlive(grandInfo.pid, grandInfo.start));
        expect(readFileSync(sigFile, "utf8")).toContain("SIGTERM");
        expect(isPidAlive(bystander.pid, bystander.start)).toBe(true);
      });
    }
  });

  describe("Bridge ending an adapter terminates detached child process groups", () => {
    it("createAcpDriver stopAll, closeIdleSessions, and dispose terminate adapter + codearts_cli.py + CLI group", async () => {
      const dir = makeScratch("omb-bridge-driver-");
      mkdirSync(join(dir, ".codeartsdoer", "cli-data"), { recursive: true });
      writeFileSync(join(dir, ".codeartsdoer", "cli-data", "auth.json"), "{}\n");

      const cliInfoFile = join(dir, "cli.json");
      const grandInfoFile = join(dir, "grand.json");
      const sigFile = join(dir, "signals.log");
      const modeFile = join(dir, "mode.txt");
      writeFileSync(modeFile, "complete-with-orphan");
      const fakeCli = writeFakeCodeartsCli(dir, { cliInfoFile, grandInfoFile, sigFile, modeFile });
      const bystander = spawnBystander();

      const driver = createAcpDriver({
        driverKind: "codearts",
        displayName: "CodeArts Test",
        defaultCli: fakeCli,
        nativeSource: "codearts",
        mcp: false,
        images: false,
        backgroundText: false,
        resolveModelsOnCreate: false,
        models: { default: "glm-5", supported: ["glm-5"] },
        loginNote: "not signed in",
        authFailure: "continue",
        isAuthenticated: async () => true,
        pickAuthMethod: () => null,
        resolveCommand: async (env) => ({
          command: process.execPath,
          args: ["--experimental-strip-types", CODEARTS_BRIDGE, "--script", CODEARTS_PY, "--cli", fakeCli, "--timeout", "30"],
          env: {
            ...env,
            HOME: dir,
            OMB_CODEARTS_HOME: dir,
            OMB_ADAPTER_KILL_GRACE_MS: "150",
            OMB_ACP_CLOSE_GRACE_MS: "400",
            OMB_ACP_KILL_GRACE_MS: "250",
          },
        }),
        spawnArgs: () => [],
      });

      const events: any[] = [];
      const instance = await driver.create({
        instanceId: "codearts-orphan-test",
        displayName: "CodeArts Test",
        enabled: true,
        config: { cli: fakeCli, fullAuto: true },
        environment: {},
      });
      instance.adapter.onEvent((event) => events.push(event));

      // Case 1: Turn completes normally, leaving a stray background helper in the task group;
      // task close + closeIdleSessions reaps both the helper and the pooled adapter.
      const first = await instance.adapter.sendTurn({ threadId: "t-orphan-1", text: "hello", cwd: dir });
      await waitFor(() => events.find((e) => e.type === "turn.completed" && e.turnId === first.turnId));
      const firstGrand = await waitJson(grandInfoFile);
      await waitFor(() => !isPidAlive(firstGrand.pid, firstGrand.start));
      expect(instance.adapter.closeIdleSessions?.()).toBe(1);

      // Case 2: Active hanging turn (`codearts run` + SIGTERM-ignoring grandchild) ended by bridge `stopAll()`
      // and `dispose()` (simulating session teardown / Hub shutdown).
      rmSync(cliInfoFile, { force: true });
      rmSync(grandInfoFile, { force: true });
      rmSync(sigFile, { force: true });
      writeFileSync(modeFile, "hang-stubborn");

      await instance.adapter.sendTurn({ threadId: "t-orphan-2", text: "hang now", cwd: dir });
      const cliInfo = await waitJson(cliInfoFile);
      const grandInfo = await waitJson(grandInfoFile);
      const adapterPid = instance.adapter.enginePid?.("t-orphan-2");
      recordPidForCleanup(adapterPid);
      const adapterStart = adapterPid ? readProcStat(adapterPid)?.start ?? null : null;

      await instance.adapter.stopAll();
      await instance.dispose();

      if (adapterPid) expect(isPidAlive(adapterPid, adapterStart)).toBe(false);
      expect(isPidAlive(cliInfo.pid, cliInfo.start)).toBe(false);
      expect(isPidAlive(grandInfo.pid, grandInfo.start)).toBe(false);
      expect(readFileSync(sigFile, "utf8")).toContain("SIGTERM");
      expect(isPidAlive(bystander.pid, bystander.start)).toBe(true);
    }, 20_000);

    it("killCliTree reaps a reparented detached child group even if the adapter crashes before cleanup, without re-signaling", async () => {
      const dir = makeScratch("omb-bridge-crash-");
      const groupFile = join(dir, "group.json");
      const grandFile = join(dir, "grand.json");
      const sigFile = join(dir, "signals.log");
      const script = join(dir, "crashing-adapter.mjs");
      writeFileSync(script, `
        import { spawn } from "node:child_process";
        import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
        const stat = (pid) => {
          const raw = readFileSync(\`/proc/\${pid}/stat\`, "utf8");
          const f = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
          return { pid, pgid: Number(f[2]), start: f[19] };
        };
        const role = process.argv[2] ?? "adapter";
        if (role === "grand") {
          process.on("SIGTERM", () => appendFileSync(${JSON.stringify(sigFile)}, "SIGTERM\\n"));
          writeFileSync(${JSON.stringify(grandFile)}, JSON.stringify(stat(process.pid)));
          setInterval(() => {}, 1000);
        } else if (role === "worker") {
          writeFileSync(${JSON.stringify(groupFile)}, JSON.stringify(stat(process.pid)));
          spawn(process.execPath, [${JSON.stringify(script)}, "grand"], { stdio: "ignore" });
          setInterval(() => {}, 1000);
        } else {
          spawn(process.execPath, [${JSON.stringify(script)}, "worker"], { stdio: "ignore", detached: true });
          setInterval(() => {}, 1000);
        }
      `);

      const bystander = spawnBystander();
      const adapter = spawnCli(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"], box: false });
      recordPidForCleanup(adapter.pid);

      const workerInfo = await waitJson(groupFile);
      const grandInfo = await waitJson(grandFile);
      expect(grandInfo.pgid).toBe(workerInfo.pgid);
      expect(workerInfo.pgid).not.toBe(adapter.pid);

      // Bridge captures tree before adapter dies abruptly (e.g. SIGKILL / crash), reparenting worker group to PID 1.
      captureCliTree(adapter);
      process.kill(adapter.pid!, "SIGKILL");
      await waitFor(() => adapter.exitCode !== null || adapter.signalCode !== null);
      expect(isPidAlive(workerInfo.pid, workerInfo.start)).toBe(true);
      expect(isPidAlive(grandInfo.pid, grandInfo.start)).toBe(true);

      const stopped = await killCliTree(adapter, 150);
      expect(stopped).toBe(true);
      expect(readFileSync(sigFile, "utf8")).toContain("SIGTERM");
      expect(isPidAlive(workerInfo.pid, workerInfo.start)).toBe(false);
      expect(isPidAlive(grandInfo.pid, grandInfo.start)).toBe(false);
      expect(isPidAlive(bystander.pid, bystander.start)).toBe(true);

      // Subsequent killCliTree on the stopped adapter sends zero signals.
      const realKill = process.kill.bind(process);
      const repeatSignals: Array<{ target: number; signal: string | number }> = [];
      vi.spyOn(process, "kill").mockImplementation(((target: number, sig?: string | number) => {
        if (sig !== 0 && sig !== undefined) repeatSignals.push({ target, signal: sig });
        return realKill(target, sig as any);
      }) as typeof process.kill);

      expect(await killCliTree(adapter, 150)).toBe(true);
      expect(repeatSignals).toEqual([]);
    });
  });
});

async function waitJson(file: string): Promise<PidRecord> {
  return waitFor(() => readJsonFile<PidRecord>(file));
}

function spawnRpcBridge(
  bridgePath: string,
  args: string[],
  extraEnv: Record<string, string>,
): {
  child: ChildProcess & { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream };
  pid: number;
  request: (method: string, params: unknown) => Promise<any>;
  notifyPrompt: (sessionId: string, text: string) => void;
} {
  const child = spawn(process.execPath, ["--experimental-strip-types", bridgePath, ...args], {
    env: { ...process.env, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  recordPidForCleanup(child.pid);
  child.stderr.resume();
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let seq = 1;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg?.id === undefined) return;
    const entry = pending.get(Number(msg.id));
    if (!entry) return;
    pending.delete(Number(msg.id));
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
    else entry.resolve(msg.result);
  });
  child.once("close", () => {
    lines.close();
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("bridge closed"));
    }
    pending.clear();
  });
  return {
    child: child as any,
    pid: child.pid!,
    request: (method, params) => new Promise((resolveReq, rejectReq) => {
      const id = seq++;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectReq(new Error(`RPC timeout: ${method}`));
      }, 8_000);
      pending.set(id, { resolve: resolveReq, reject: rejectReq, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    }),
    notifyPrompt: (sessionId, text) => {
      const id = seq++;
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text }] },
      })}\n`);
    },
  };
}

function writeFakeCodeartsCli(
  dir: string,
  opts: { cliInfoFile: string; grandInfoFile: string; sigFile: string; mode?: string; modeFile?: string },
): string {
  const cliPath = join(dir, "fake-codearts");
  writeFileSync(cliPath, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const stat = (pid) => {
  const raw = readFileSync(\`/proc/\${pid}/stat\`, "utf8");
  const f = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  return { pid, pgid: Number(f[2]), start: f[19] };
};

if (process.argv[2] === "__grand__") {
  process.on("SIGTERM", () => appendFileSync(${JSON.stringify(opts.sigFile)}, "SIGTERM\\n"));
  writeFileSync(${JSON.stringify(opts.grandInfoFile)}, JSON.stringify(stat(process.pid)));
  setInterval(() => {}, 1000);
} else if (process.argv[2] === "--version") {
  console.log("codearts 26.9.12-fake");
  process.exit(0);
} else if (process.argv[2] === "models") {
  console.log("glm-5");
  process.exit(0);
} else if (process.argv[2] === "run") {
  const mode = ${opts.modeFile ? `existsSync(${JSON.stringify(opts.modeFile)}) ? readFileSync(${JSON.stringify(opts.modeFile)}, "utf8").trim() : "hang-stubborn"` : JSON.stringify(opts.mode ?? "hang-stubborn")};
  writeFileSync(${JSON.stringify(opts.cliInfoFile)}, JSON.stringify(stat(process.pid)));
  spawn(process.execPath, [process.argv[1], "__grand__"], { stdio: "ignore" });
  if (mode === "complete-with-orphan") {
    setTimeout(() => {
      console.log(JSON.stringify({ type: "text", part: { text: "done ok" } }));
      console.log(JSON.stringify({ type: "step_finish", part: { reason: "stop" } }));
      process.exit(0);
    }, 60);
  } else {
    process.on("SIGTERM", () => appendFileSync(${JSON.stringify(opts.sigFile)}, "CLI_SIGTERM\\n"));
    setInterval(() => {}, 1000);
  }
}
`);
  chmodSync(cliPath, 0o755);
  return cliPath;
}

function writeFakeMcodeCli(
  dir: string,
  opts: { cliInfoFile: string; grandInfoFile: string; sigFile: string },
): string {
  const cliPath = join(dir, "fake-mcode");
  writeFileSync(cliPath, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const stat = (pid) => {
  const raw = readFileSync(\`/proc/\${pid}/stat\`, "utf8");
  const f = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  return { pid, pgid: Number(f[2]), start: f[19] };
};

if (process.argv[2] === "__grand__") {
  process.on("SIGTERM", () => appendFileSync(${JSON.stringify(opts.sigFile)}, "SIGTERM\\n"));
  writeFileSync(${JSON.stringify(opts.grandInfoFile)}, JSON.stringify(stat(process.pid)));
  setInterval(() => {}, 1000);
} else if (process.argv[2] === "--version") {
  console.log("mcode 0.6.12-fake");
  process.exit(0);
} else {
  process.on("SIGTERM", () => appendFileSync(${JSON.stringify(opts.sigFile)}, "CLI_SIGTERM\\n"));
  writeFileSync(${JSON.stringify(opts.cliInfoFile)}, JSON.stringify(stat(process.pid)));
  spawn(process.execPath, [process.argv[1], "__grand__"], { stdio: "ignore" });
  console.log(JSON.stringify({ type: "session.started", sessionId: "mcode-fake-1" }));
  setInterval(() => {}, 1000);
}
`);
  chmodSync(cliPath, 0o755);
  return cliPath;
}

function writeFakeZcodeCli(
  dir: string,
  opts: { cliInfoFile: string; grandInfoFile: string; sigFile: string },
): string {
  const cliPath = join(dir, "fake-zcode");
  writeFileSync(cliPath, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const stat = (pid) => {
  const raw = readFileSync(\`/proc/\${pid}/stat\`, "utf8");
  const f = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  return { pid, pgid: Number(f[2]), start: f[19] };
};

if (process.argv[2] === "__grand__") {
  process.on("SIGTERM", () => appendFileSync(${JSON.stringify(opts.sigFile)}, "SIGTERM\\n"));
  writeFileSync(${JSON.stringify(opts.grandInfoFile)}, JSON.stringify(stat(process.pid)));
  setInterval(() => {}, 1000);
} else if (process.argv[2] === "--version") {
  console.log("0.17.0");
  process.exit(0);
} else {
  // Ignore stdin EOF and SIGTERM so shutdown must escalate SIGTERM -> SIGKILL on the group.
  process.on("SIGTERM", () => appendFileSync(${JSON.stringify(opts.sigFile)}, "CLI_SIGTERM\\n"));
  writeFileSync(${JSON.stringify(opts.cliInfoFile)}, JSON.stringify(stat(process.pid)));
  spawn(process.execPath, [process.argv[1], "__grand__"], { stdio: "ignore" });
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg?.id) return;
    if (msg.method === "session/create") {
      process.stdout.write(JSON.stringify({
        id: msg.id,
        result: {
          session: { sessionId: "z-1" },
          // Same catalog shape the real app server returns (catalogFromSnapshot reads settings.model.available);
          // without it the bridge stops at MODEL_CATALOG_UNAVAILABLE before the process groups are exercised.
          settings: {
            model: {
              available: [{ ref: { providerId: "p1", modelId: "glm-5" }, label: "GLM-5", reasoning: { levels: [{ value: "medium" }], defaultLevel: "medium" } }],
              current: { providerId: "p1", modelId: "glm-5" },
            },
          },
        },
      }) + "\\n");
    } else {
      process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");
    }
  });
  setInterval(() => {}, 1000);
}
`);
  chmodSync(cliPath, 0o755);
  return cliPath;
}
