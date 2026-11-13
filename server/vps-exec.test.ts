import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BACKGROUND_SCRIPT, createVpsExecRelay, FOREGROUND_SCRIPT, STATUS_SCRIPT, VPS_EXEC_TOOLS, vpsExecCallProblem, vpsExecDockerArgs,
  withVpsExecTools, type VpsExecRun,
} from "./vps-exec.ts";

const CONTAINER = "openmausbot-vps-bot-0123456789ab";
const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text);

function fakeRun(answers: Array<{ code: number | null; stdout?: string; stderr?: string; timedOut?: boolean }>) {
  const calls: Array<{ args: string[]; input: string; timeoutMs: number }> = [];
  const run: VpsExecRun = async (args, input, timeoutMs) => {
    calls.push({ args, input, timeoutMs });
    const next = answers.shift() ?? { code: 0 };
    return { code: next.code, stdout: next.stdout ?? "", stderr: next.stderr ?? "", timedOut: next.timedOut ?? false };
  };
  return { run, calls };
}

describe("withVpsExecTools", () => {
  it("adds exec and exec_status to the driver's tools/list answer", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", id: 3, result: { tools: [{ name: "screenshot", inputSchema: { type: "object" } }] } });
    const frame = JSON.parse(withVpsExecTools(line));
    expect(frame.id).toBe(3);
    expect(frame.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["screenshot", "exec", "exec_status"]);
  });

  it("leaves requests, other answers, and a list that already has exec unchanged", () => {
    const request = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
    const call = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "tools" }] } });
    const own = JSON.stringify({ jsonrpc: "2.0", id: 4, result: { tools: [{ name: "exec" }] } });
    expect(withVpsExecTools(request)).toBe(request);
    expect(withVpsExecTools(call)).toBe(call);
    expect(withVpsExecTools(own)).toBe(own);
    expect(withVpsExecTools("not json \"tools\"")).toBe("not json \"tools\"");
  });
});

describe("vpsExecCallProblem", () => {
  it("accepts the advertised arguments and refuses anything else", () => {
    expect(vpsExecCallProblem({ name: "exec", arguments: { command: "hostname" } })).toBeNull();
    expect(vpsExecCallProblem({ name: "exec", arguments: { command: "make", timeout_seconds: 600, background: false } })).toBeNull();
    expect(vpsExecCallProblem({ name: "exec", arguments: { command: "" } })).toMatch(/needs command/);
    expect(vpsExecCallProblem({ name: "exec", arguments: { command: "x", timeout_seconds: 601 } })).toMatch(/timeout_seconds/);
    expect(vpsExecCallProblem({ name: "exec", arguments: { command: "x", cwd: "/" } })).toMatch(/takes command/);
    expect(vpsExecCallProblem({ name: "exec_status", arguments: { process_id: "omb-0123456789abcdef", wait_seconds: 5 } })).toBeNull();
    expect(vpsExecCallProblem({ name: "exec_status", arguments: { process_id: "../../etc" } })).toMatch(/process_id/);
    expect(vpsExecCallProblem({ name: "exec_status", arguments: { process_id: "omb-0123456789abcdef", wait_seconds: 61 } })).toMatch(/wait_seconds/);
  });

  it("advertises schemas whose required fields match what it checks", () => {
    expect(VPS_EXEC_TOOLS.map((tool) => [tool.name, tool.inputSchema.required])).toEqual([["exec", ["command"]], ["exec_status", ["process_id"]]]);
  });
});

describe("vpsExecDockerArgs", () => {
  it("runs bash in the bot's container as the desktop user over the SSH alias, with the command kept out of argv", () => {
    expect(vpsExecDockerArgs("cloud-a", CONTAINER, FOREGROUND_SCRIPT, ["120"])).toEqual([
      "-H", "ssh://cloud-a", "exec", "-i", "-u", "cua", "-w", "/home/cua", "-e", "HOME=/home/cua", "-e", "DISPLAY=:1",
      CONTAINER, "bash", "-c", FOREGROUND_SCRIPT, "omb-exec", "120",
    ]);
  });

  it("refuses an alias or container that could become an option", () => {
    expect(() => vpsExecDockerArgs("-oProxyCommand=x", CONTAINER, FOREGROUND_SCRIPT)).toThrow(/invalid/);
    expect(() => vpsExecDockerArgs("cloud-a", "--privileged", FOREGROUND_SCRIPT)).toThrow(/invalid/);
  });
});

describe("createVpsExecRelay", () => {
  it("passes every driver tool through", () => {
    const { run, calls } = fakeRun([]);
    const relay = createVpsExecRelay({ alias: "cloud-a", container: CONTAINER, run });
    expect(relay({ name: "screenshot", arguments: {} })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("runs a command and answers its exit code and output", async () => {
    const { run, calls } = fakeRun([{ code: 0, stdout: "f6961c957c57\ncua\n" }]);
    const relay = createVpsExecRelay({ alias: "cloud-a", container: CONTAINER, run });
    const result = await relay({ name: "exec", arguments: { command: "hostname; whoami" } })!;
    expect(result.isError).toBeUndefined();
    expect(parse(result)).toEqual({ ok: true, exitCode: 0, stdout: "f6961c957c57\ncua\n", stderr: "" });
    expect(calls[0]!.input).toBe("hostname; whoami");
    expect(calls[0]!.args.slice(-2)).toEqual(["omb-exec", "120"]);
    expect(calls[0]!.timeoutMs).toBe(140_000);
  });

  it("reports a failing command as an error with its code and stderr", async () => {
    const { run } = fakeRun([{ code: 2, stderr: "ls: cannot access 'x'\n" }]);
    const relay = createVpsExecRelay({ alias: "cloud-a", container: CONTAINER, run });
    const result = await relay({ name: "exec", arguments: { command: "ls x" } })!;
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ ok: false, exitCode: 2, stderr: "ls: cannot access 'x'\n" });
  });

  it("says when the command was stopped by its timeout or the transport", async () => {
    const { run, calls } = fakeRun([{ code: 124 }, { code: null, timedOut: true }]);
    const relay = createVpsExecRelay({ alias: "cloud-a", container: CONTAINER, run });
    const stopped = parse(await relay({ name: "exec", arguments: { command: "sleep 99", timeout_seconds: 5 } })!);
    expect(stopped).toMatchObject({ ok: false, exitCode: 124, timedOut: true });
    expect(calls[0]!.args.at(-1)).toBe("5");
    const lost = parse(await relay({ name: "exec", arguments: { command: "sleep 99", timeout_seconds: 5 } })!);
    expect(lost).toMatchObject({ ok: false, exitCode: null, timedOut: true });
  });

  it("refuses bad arguments without touching the computer", async () => {
    const { run, calls } = fakeRun([]);
    const relay = createVpsExecRelay({ alias: "cloud-a", container: CONTAINER, run });
    const result = await relay({ name: "exec", arguments: { command: 42 } })!;
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("starts a background command and follows it with exec_status", async () => {
    const { run, calls } = fakeRun([
      { code: 0, stdout: "started\n" },
      { code: 0, stdout: "running\n---omb-stdout---\npart\n\n---omb-stderr---\n" },
      { code: 0, stdout: "code 0\n---omb-stdout---\ndone\n\n---omb-stderr---\nwarn\n" },
      { code: 0, stdout: "missing\n" },
    ]);
    const relay = createVpsExecRelay({ alias: "cloud-a", container: CONTAINER, run, newId: () => "omb-00000000000000aa" });
    const started = parse(await relay({ name: "exec", arguments: { command: "make all", background: true } })!);
    expect(started).toMatchObject({ ok: true, process_id: "omb-00000000000000aa", status: "running" });
    expect(calls[0]!.args).toContain(BACKGROUND_SCRIPT);
    expect(calls[0]!.input).toBe("make all");
    const running = parse(await relay({ name: "exec_status", arguments: { process_id: "omb-00000000000000aa" } })!);
    expect(running).toEqual({ process_id: "omb-00000000000000aa", status: "running", stdout: "part", stderr: "" });
    const finished = parse(await relay({ name: "exec_status", arguments: { process_id: "omb-00000000000000aa", wait_seconds: 30 } })!);
    expect(finished).toEqual({ process_id: "omb-00000000000000aa", status: "finished", exitCode: 0, ok: true, stdout: "done", stderr: "warn" });
    expect(calls[2]!.args).toContain(STATUS_SCRIPT);
    expect(calls[2]!.args.slice(-2)).toEqual(["omb-00000000000000aa", "30"]);
    const missing = await relay({ name: "exec_status", arguments: { process_id: "omb-00000000000000aa" } })!;
    expect(missing.isError).toBe(true);
  });
});

// The scripts run inside the container's bash; here a local bash stands in for `docker exec ... bash -c`.
function bash(script: string, args: string[], input = "") {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("bash", ["-c", script, "omb-exec", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe.skipIf(process.platform === "win32")("exec scripts in a real bash", () => {
  const made: string[] = [];
  afterEach(async () => {
    await Promise.all(made.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("the foreground script keeps quotes, pipes and the exit code of the command it reads from stdin", async () => {
    const result = await bash(FOREGROUND_SCRIPT, ["10"], `printf '%s|' "a b" 'c"d'; echo oops >&2; exit 3`);
    expect(result).toEqual({ code: 3, stdout: 'a b|c"d|', stderr: "oops\n" });
  });

  it("the foreground script stops a command at its timeout with code 124", async () => {
    const result = await bash(FOREGROUND_SCRIPT, ["1"], "sleep 20");
    expect(result.code).toBe(124);
  }, 15_000);

  it("the background and status scripts run a detached job and read its result", async () => {
    // The scripts write under /tmp/omb-exec; a unique id keeps this run's files apart.
    const id = `omb-${Date.now().toString(16).padStart(16, "0").slice(-16)}`;
    made.push(...[".cmd", ".out", ".err", ".code"].map((suffix) => join("/tmp/omb-exec", id + suffix)));
    const started = await bash(BACKGROUND_SCRIPT, [id], "echo out-$((6*7)); echo err >&2; exit 5");
    expect(started.stdout).toContain("started");
    const status = await bash(STATUS_SCRIPT, [id, "10"]);
    expect(status.stdout).toMatch(/^code 5\n---omb-stdout---\nout-42\n\n---omb-stderr---\nerr\n?$/);
    const missing = await bash(STATUS_SCRIPT, ["omb-ffffffffffffffff", "0"]);
    expect(missing.stdout.trim()).toBe("missing");
  }, 20_000);
});
