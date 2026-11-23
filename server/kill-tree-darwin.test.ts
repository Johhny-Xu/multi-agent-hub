import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** macOS has no /proc: the tree is the whole process list `ps` gives, so `ps` is what this test fakes. */
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: mocks.spawn, execFileSync: mocks.execFile }));

import { captureCliTree, killCliTree, spawnCli } from "./procs.ts";

type Row = { parent: number; stat: string; lstart: string };
let processes: Map<number, Row>;
let signal: ReturnType<typeof vi.fn>;

function root(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid: 10001, exitCode: null, signalCode: null,
    stdin: new EventEmitter(), stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
  });
  mocks.spawn.mockReturnValue(child);
  return spawnCli("node", [], { stdio: "pipe" });
}

beforeEach(() => {
  processes = new Map([
    [10001, { parent: 9000, stat: "S", lstart: "Mon Nov 24 01:00:00 2026" }],
    [10002, { parent: 10001, stat: "S", lstart: "Mon Nov 24 01:00:01 2026" }],
    [10003, { parent: 10002, stat: "S", lstart: "Mon Nov 24 01:00:02 2026" }],
    [10004, { parent: 9000, stat: "S", lstart: "Mon Nov 24 01:00:03 2026" }],
  ]);
  mocks.execFile.mockImplementation((_file: string, args: string[]) => {
    const wanted = args[0] === "-p" ? args[1].split(",").map(Number) : [...processes.keys()];
    const rows = wanted.filter((pid) => processes.has(pid)).map((pid) => {
      const row = processes.get(pid)!;
      return `  ${pid} ${row.parent} ${row.stat} ${row.lstart}`;
    });
    return rows.length ? `${rows.join("\n")}\n` : "";
  });
  signal = vi.fn((pid: number, value: number | string) => {
    if (pid < 0 || !processes.has(pid)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    if (value !== 0) processes.delete(pid);
    return true;
  });
  vi.stubGlobal("process", { ...process, pid: 9000, platform: "darwin", kill: signal });
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("macOS CLI descendants", () => {
  it("captures the descendants of a CLI and stops them with it", async () => {
    const child = root();
    captureCliTree(child);
    Object.assign(child, { exitCode: 0 });

    await expect(killCliTree(child, 0)).resolves.toBe(true);
    expect(signal.mock.calls.filter(([pid, value]) => pid > 0 && value === "SIGTERM").map(([pid]) => pid)).toEqual([10003, 10002]);
    expect(processes.has(10002)).toBe(false);
    expect(processes.has(10003)).toBe(false);
  });

  it("leaves a process that is not a descendant of the CLI alone", async () => {
    const child = root();
    captureCliTree(child);
    Object.assign(child, { exitCode: 0 });

    await expect(killCliTree(child, 0)).resolves.toBe(true);
    expect(processes.has(10004)).toBe(true);
    expect(signal.mock.calls.some(([pid]) => pid === 10004)).toBe(false);
  });

  it("does not signal a captured PID after its start time changes", async () => {
    const child = root();
    captureCliTree(child);
    processes.delete(10001);
    processes.set(10002, { parent: 1, stat: "S", lstart: "Mon Nov 24 09:09:09 2026" });
    processes.set(10003, { parent: 1, stat: "S", lstart: "Mon Nov 24 09:09:09 2026" });
    Object.assign(child, { exitCode: 0 });

    await expect(killCliTree(child, 0)).resolves.toBe(true);
    expect(signal.mock.calls.some(([pid]) => pid === 10002 || pid === 10003)).toBe(false);
  });
});
