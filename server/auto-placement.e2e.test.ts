// The real server on a machine that reports the load the test states: an Auto turn's one computer selection
// must say why it stayed here or moved, and the reason must reach both the route and the saved task pin.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { writeFileAtomic } from "./atomic.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe.skipIf(process.platform === "win32")("Auto placement by this computer's load", () => {
  let home = "";
  let data = "";
  let stateFile = "";
  let dumpFile = "";
  let finishFile = "";
  let output = "";
  let child: ChildProcess | null = null;
  let base = "";

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const apiOk = async (method: string, path: string, body?: unknown) => {
    const result = await api(method, path, body);
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBeLessThan(400);
    return result.body;
  };
  async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, what: string): Promise<T> {
    const end = Date.now() + 20_000;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() >= end) throw new Error(`${what} never happened: ${JSON.stringify(value)}\n${output.slice(-2000)}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  const dumpFor = (text: string) => until<any>(() => {
    if (!existsSync(dumpFile)) return null;
    try {
      const sent = JSON.parse(readFileSync(dumpFile, "utf8"));
      return JSON.stringify(sent.prompt ?? "").includes(text) ? sent : null;
    } catch { return null; }
  }, Boolean, `the turn for "${text}"`);
  const savedTask = (botId: string, threadId: string) =>
    (JSON.parse(readFileSync(join(data, "bots.json"), "utf8")) as any[])
      .find((bot: any) => bot.id === botId)?.tasks.find((task: any) => task.threadId === threadId);

  async function start(load: { cpu: number; memAvailPct: number; memAvailMb: number }) {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    output = "";
    const proc = spawn(process.execPath, ["--import", pathToFileURL(join(ROOT, "server/testing/group-local-vm-hooks.mjs")).href,
      "--import", pathToFileURL(join(ROOT, "server/testing/desktop-parent.mjs")).href, join(ROOT, "server/index.ts")], {
      cwd: ROOT, env: {
        PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, OMB_DATA_DIR: data,
        APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
        TEMP: home, TMP: home, TMPDIR: home,
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: join(home, "static"),
        OMB_TEST_VM_STATE: stateFile, OMB_TEST_DESKTOP_CUA_CONNECTION: join(home, "user-data", "cua-connection.json"),
        OMB_TEST_HOST_LOAD: JSON.stringify(load),
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    proc.stdout!.on("data", chunk => { output += chunk; });
    proc.stderr!.on("data", chunk => { output += chunk; });
    await until(async () => {
      if (proc.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
      try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
    }, Boolean, "the server starting");
    const seeded = (await apiOk("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.chiefOfStaff);
    if (seeded) await apiOk("PATCH", `/api/bots/${seeded.id}`, { chiefOfStaff: false });
  }
  async function stop() {
    if (!child) return;
    const proc = child;
    child = null;
    writeFileSync(finishFile, "finish");
    await waitForExit(proc, { signal: "SIGTERM" });
    rmSync(finishFile, { force: true });
  }
  const send = async (botId: string, text: string) => {
    const { task } = await apiOk("POST", `/api/bots/${botId}/tasks`, {});
    await apiOk("POST", `/api/bots/${botId}/messages`, { text, threadId: task.threadId });
    return task.threadId as string;
  };

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "omb-auto-placement-"));
    data = join(home, "data");
    stateFile = join(home, "vm.json");
    dumpFile = join(home, "dump.json");
    finishFile = join(home, "finish");
    mkdirSync(data);
    mkdirSync(join(home, "static"), { recursive: true });
    writeFileSync(join(home, "static", "index.html"), "<title>Auto placement</title>");
    writeFileAtomic(stateFile, JSON.stringify({ noContainers: true }));
    mkdirSync(join(home, "user-data"), { recursive: true });
    writeFileSync(join(home, "user-data", "cua-connection.json"), JSON.stringify({
      mode: "embedded", status: "ready", socketPath: join(home, "cua.sock"),
      mcpCommand: "/fixture/cua-driver", mcpArgs: ["mcp"], mcpEnv: {},
    }), { mode: 0o600 });
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { claude: {
      driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") },
      environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_DUMP: dumpFile, FAKE_CLAUDE_SLOW_FINISH_GATE: finishFile },
    } } }));
  });
  afterAll(async () => {
    await stop();
    if (home) await removeTempDir(home);
  });
  afterEach(async () => {
    await stop();
    rmSync(dumpFile, { force: true });
  });

  it("keeps a calm machine's Auto turn here and says so", async () => {
    await start({ cpu: 10, memAvailPct: 60, memAvailMb: 8_000 });
    // One threshold changed alone: the rest keep their defaults and the settings page reads them back.
    await apiOk("PUT", "/api/config", { autoPlacement: { cpuHigh: 90 } });
    expect((await api("GET", "/api/config")).body.autoPlacement)
      .toEqual({ enabled: true, cpuHigh: 90, cpuLow: 60, memHighPct: 15, memLowPct: 25, memMinMb: 1_500 });
    const { bot } = await apiOk("POST", "/api/bots", { name: "Calm host bot", browser: false });
    const threadId = await send(bot.id, "Read the local file.");
    const sent = await dumpFor("Read the local file.");
    const token = sent.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN as string;
    const select = (surface?: string) => fetch(`${base}/api/internal/computer/select`, {
      method: surface === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, ...(surface === undefined ? {} : { "content-type": "application/json" }) },
      ...(surface === undefined ? {} : { body: JSON.stringify({ surface }) }),
    });
    const offered = await (await select()).json() as any;
    // Linux offers no local desktop in this fixture (its driver record is a macOS one), so the fallback is the VM.
    const onThisMachine = offered.options.find((option: any) => option.surface === "local")?.available === true;
    const surface = onThisMachine ? "local" : "vm";
    const reason = onThisMachine ? "本机 CPU 10%，可用内存 60%，留在本地" : "本机 CPU 10%，可用内存 60%，本机不可用，用本地虚拟机";
    const picked = await (await select("auto")).json() as any;
    expect(picked).toMatchObject({ status: "pending", surface, placementReason: reason });
    // The turn's one decision is kept: asking again this turn returns the same place and reason.
    expect(await (await select("auto")).json()).toMatchObject({ status: "pending", surface, placementReason: reason });
    expect(await (await select()).json()).toMatchObject({ placementReason: reason });
    expect(savedTask(bot.id, threadId)?.surface).toBeUndefined();
  }, 60_000);

  it("reports a busy machine and the cloud it could not reach", async () => {
    await start({ cpu: 92, memAvailPct: 40, memAvailMb: 6_000 });
    const { bot } = await apiOk("POST", "/api/bots", { name: "Busy host bot", browser: false });
    await send(bot.id, "Read the local file.");
    const sent = await dumpFor("Read the local file.");
    const token = sent.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN as string;
    const offered = await (await fetch(`${base}/api/internal/computer/select`, { headers: { authorization: `Bearer ${token}` } })).json() as any;
    const onThisMachine = offered.options.find((option: any) => option.surface === "local")?.available === true;
    const picked = await (await fetch(`${base}/api/internal/computer/select`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ surface: "auto" }) })).json() as any;
    expect(picked).toMatchObject({ status: "pending", surface: onThisMachine ? "local" : "vm",
      placementReason: onThisMachine ? "本机 CPU 92%，云端不可用，留在本地" : "本机 CPU 92%，云端不可用，用本地虚拟机" });
  }, 60_000);
});
