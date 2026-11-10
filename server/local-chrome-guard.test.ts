import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";

import { CHROME_NAMES, guardedBotEnv, headlessChromesUnder, shimScript, startHeadlessChromeSweep, writeChromeShims, writeGuardState, type ProcInfo } from "./local-chrome-guard.ts";

describe("Chrome shims for bot engines (E73)", () => {
  it("writes an executable shim for every Chrome name, idempotently", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "omb-shims-")), "bin");
    writeChromeShims(dir);
    writeChromeShims(dir);
    for (const name of CHROME_NAMES) {
      expect(readFileSync(join(dir, name), "utf8")).toBe(shimScript());
      expect(statSync(join(dir, name)).mode & 0o111).not.toBe(0);
    }
  });

  it("puts the shims first on a bot's PATH once and says where the cloud Chrome is", () => {
    const env = guardedBotEnv({ PATH: ["/x/shim", "/usr/bin"].join(delimiter), HOME: "/h" }, "/x/shim", "/x/state", { cdpUrl: "http://127.0.0.1:9341" });
    expect(env.PATH).toBe(["/x/shim", "/usr/bin"].join(delimiter));
    expect(env).toMatchObject({ HOME: "/h", PUPPETEER_EXECUTABLE_PATH: "/x/shim/chrome", CHROME_PATH: "/x/shim/chrome", OMB_CLOUD_STATE: "/x/state",
      OMB_CLOUD_CDP_URL: "http://127.0.0.1:9341" });
    expect(guardedBotEnv({ PATH: "/usr/bin" }, "/x/shim", "/x/state", { cdpUrl: null })).not.toHaveProperty("OMB_CLOUD_CDP_URL");
  });

  it.runIf(process.platform === "linux")("refuses with directions while a cloud Chrome answers, and runs the real one niced otherwise", () => {
    const base = mkdtempSync(join(tmpdir(), "omb-shim-run-"));
    const shims = writeChromeShims(join(base, "shim"));
    const real = join(base, "real");
    mkdirSync(real);
    writeFileSync(join(real, "chromium"), "#!/bin/sh\necho REAL $(nice) \"$@\"\n");
    chmodSync(join(real, "chromium"), 0o755);
    const state = join(base, "state");
    const env = guardedBotEnv({ PATH: [real, "/usr/bin", "/bin"].join(delimiter) }, shims, state, { cdpUrl: null });
    writeGuardState(state, { cdpUrl: "http://127.0.0.1:9341" });
    let refused = "";
    try {
      execFileSync(join(shims, "chromium"), ["--headless"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      refused = String((error as { stderr?: string }).stderr);
      expect((error as { status?: number }).status).toBe(3);
    }
    expect(refused).toContain("connectOverCDP('http://127.0.0.1:9341')");
    expect(refused).toContain("file:///");
    writeGuardState(state, { cdpUrl: null });
    expect(execFileSync(join(shims, "chromium"), ["--headless"], { env, encoding: "utf8" }).trim()).toBe("REAL 19 --headless");
  });
});

describe("headless Chrome sweep (E73)", () => {
  const procs: ProcInfo[] = [
    { pid: 100, ppid: 1, comm: "node", cmdline: "" },
    { pid: 200, ppid: 100, comm: "opencode", cmdline: "" },
    { pid: 300, ppid: 200, comm: "node", cmdline: "" },
    { pid: 400, ppid: 300, comm: "chrome", cmdline: "/opt/chrome --headless=new --use-angle=swiftshader" },
    { pid: 401, ppid: 400, comm: "chrome", cmdline: "/opt/chrome --type=renderer" },
    { pid: 500, ppid: 1, comm: "chrome", cmdline: "/opt/chrome --headless --remote-debugging-port=9333" },
    { pid: 600, ppid: 100, comm: "chrome", cmdline: "/opt/chrome --user-data-dir=/x" },
  ];

  it("finds headless Chrome and its helpers under this server only", () => {
    expect(headlessChromesUnder(procs, 100).sort()).toEqual([400, 401]);
    expect(headlessChromesUnder(procs, 999)).toEqual([]);
  });

  it("sweeps on start with the process table it is given", () => {
    const seen: number[] = [];
    // pids past pid_max, so the sweep can never renice a real process on the test machine
    const far = procs.map((proc) => ({ ...proc, pid: proc.pid + 4_194_400, ppid: proc.ppid === 1 ? 1 : proc.ppid + 4_194_400 }));
    const stop = startHeadlessChromeSweep({ root: 100 + 4_194_400, read: () => { seen.push(1); return far; }, intervalMs: 60_000 });
    stop();
    expect(seen.length).toBe(1);
  });
});
