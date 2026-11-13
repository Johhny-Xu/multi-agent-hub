// Shell commands for an SSH VPS computer. The Cua driver in the bot's VPS container only serves screen tools, so a bot that
// had to run `hostname` there drove a terminal by clicks for minutes. The bridge answers `exec` and `exec_status` itself
// over the same Docker-over-SSH connection, inside the same container and as the same `cua` user the desktop runs as.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isValidSshAlias } from "./config.ts";
import type { ToolCall } from "./mcp-bridge.ts";

export const VPS_EXEC_DEFAULT_TIMEOUT_SECONDS = 120;
export const VPS_EXEC_MAX_TIMEOUT_SECONDS = 600;
export const VPS_EXEC_STATUS_WAIT_MAX_SECONDS = 60;
export const VPS_EXEC_STDOUT_TAIL_CHARS = 20_000;
export const VPS_EXEC_STDERR_TAIL_CHARS = 8_000;
const PROCESS_ID = /^omb-[0-9a-f]{16}$/;
const PROCESS_ID_PATTERN = "^omb-[0-9a-f]{16}$";
// The far end gets this long past the command's own timeout to answer before the local Docker client is stopped.
const TRANSPORT_GRACE_MS = 20_000;
// Background runs keep their output here inside the container, never on the host.
const JOBS_DIR = "/tmp/omb-exec";
// Same shapes vps-computer.ts accepts for the container: a name or a hex id.
const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]) =>
  ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } });

export const VPS_EXEC_TOOLS = [
  tool("exec", "Run a shell command (bash) on this VPS computer, as its desktop user in its home folder, and wait for the exit code, stdout and stderr. Use this instead of opening a terminal on the screen for anything you can do in a shell: running programs, tests, builds, installs, reading or writing files. For a command that may run longer than a few minutes, set background: true; it answers at once with a process_id to follow with exec_status. Completion does not resume this turn by itself: if the result matters, call exec_status with wait_seconds until it finishes.", {
    command: { type: "string", minLength: 1, maxLength: 8000 },
    timeout_seconds: { type: "integer", minimum: 1, maximum: VPS_EXEC_MAX_TIMEOUT_SECONDS, description: `Stop the command after this many seconds (default ${VPS_EXEC_DEFAULT_TIMEOUT_SECONDS}). Ignored with background.` },
    background: { type: "boolean", description: "Start the command and answer at once with a process_id, instead of waiting for it to finish." },
  }, ["command"]),
  tool("exec_status", `Check a command started with exec and background: true: running or finished, its exit code, and the end of its stdout and stderr (the last ${VPS_EXEC_STDOUT_TAIL_CHARS.toLocaleString("en-US")} and ${VPS_EXEC_STDERR_TAIL_CHARS.toLocaleString("en-US")} characters).`, {
    process_id: { type: "string", pattern: PROCESS_ID_PATTERN },
    wait_seconds: { type: "integer", minimum: 0, maximum: VPS_EXEC_STATUS_WAIT_MAX_SECONDS, description: "Wait up to this many seconds for it to finish before answering." },
  }, ["process_id"]),
];
const OWN_TOOLS = new Set(VPS_EXEC_TOOLS.map((entry) => entry.name));

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export type VpsExecResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const text = (body: unknown, isError: boolean): VpsExecResult =>
  ({ content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }], ...(isError ? { isError: true } : {}) });

/** One MCP stdio frame from the driver: a tools/list answer gains exec and exec_status unless the driver already lists its own. */
export function withVpsExecTools(line: string): string {
  if (!line.includes('"tools"')) return line;
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return line;
  }
  if (!isObject(frame) || "method" in frame || !isObject(frame.result) || !Array.isArray(frame.result.tools)) return line;
  const listed: unknown[] = frame.result.tools;
  if (listed.some((entry) => isObject(entry) && OWN_TOOLS.has(String(entry.name)))) return line;
  return JSON.stringify({ ...frame, result: { ...frame.result, tools: [...listed, ...VPS_EXEC_TOOLS] } });
}

/** The arguments the advertised schema allows, or why not. Checked here because the bridge, not the driver, runs them. */
export function vpsExecCallProblem(call: ToolCall): string | null {
  const a = call.arguments;
  const keys = Object.keys(a);
  if (call.name === "exec") {
    if (keys.some((key) => !["command", "timeout_seconds", "background"].includes(key))) return "exec takes command, and optionally timeout_seconds or background.";
    if (typeof a.command !== "string" || !a.command.trim() || a.command.length > 8000 || a.command.includes("\0")) return "exec needs command: one shell command line of up to 8000 characters.";
    if (a.timeout_seconds !== undefined && (!Number.isInteger(a.timeout_seconds) || (a.timeout_seconds as number) < 1 || (a.timeout_seconds as number) > VPS_EXEC_MAX_TIMEOUT_SECONDS)) {
      return `timeout_seconds must be a whole number from 1 to ${VPS_EXEC_MAX_TIMEOUT_SECONDS}.`;
    }
    if (a.background !== undefined && typeof a.background !== "boolean") return "background must be true or false.";
    return null;
  }
  if (call.name === "exec_status") {
    if (keys.some((key) => !["process_id", "wait_seconds"].includes(key))) return "exec_status takes process_id, and optionally wait_seconds.";
    if (typeof a.process_id !== "string" || !PROCESS_ID.test(a.process_id)) return "process_id must be the id exec answered with.";
    if (a.wait_seconds !== undefined && (!Number.isInteger(a.wait_seconds) || (a.wait_seconds as number) < 0 || (a.wait_seconds as number) > VPS_EXEC_STATUS_WAIT_MAX_SECONDS)) {
      return `wait_seconds must be a whole number from 0 to ${VPS_EXEC_STATUS_WAIT_MAX_SECONDS}.`;
    }
    return null;
  }
  return "Unknown VPS exec tool.";
}

/** `docker exec` in the bot's container. The script is fixed; the model's command reaches it on stdin, never in argv,
 * so no shell on either machine parses it as arguments and `ps` never shows it. */
export function vpsExecDockerArgs(alias: string, container: string, script: string, args: string[] = []): string[] {
  if (!isValidSshAlias(alias) || !CONTAINER_NAME.test(container)) throw new Error("invalid VPS exec connection");
  return ["-H", `ssh://${alias}`, "exec", "-i", "-u", "cua", "-w", "/home/cua", "-e", "HOME=/home/cua", "-e", "DISPLAY=:1",
    container, "bash", "-c", script, "omb-exec", ...args];
}

// Foreground: read the command from stdin, run it under timeout(1) so the far end stops it too, and report its own status.
export const FOREGROUND_SCRIPT = 'cmd=$(cat); timeout -k 5 "$1" bash -c "$cmd" </dev/null';
// Background: detach with setsid so the docker exec can return; the exit code lands in <id>.code when it finishes. Only the
// launch is backgrounded: a backgrounded list would read its stdin from /dev/null and save an empty command.
export const BACKGROUND_SCRIPT = `mkdir -p ${JOBS_DIR} && cmd=$(cat) && printf %s "$cmd" > ${JOBS_DIR}/"$1".cmd && ` +
  `{ setsid nohup bash -c 'bash -c "$(cat "$0.cmd")" >"$0.out" 2>"$0.err" </dev/null; echo $? >"$0.code"' ${JOBS_DIR}/"$1" >/dev/null 2>&1 </dev/null & } && echo started`;
// Status: wait up to $2 seconds for the code file, then print a small header and both tails, separated by markers.
export const STATUS_SCRIPT = `f=${JOBS_DIR}/"$1"; [ -e "$f.cmd" ] || { echo missing; exit 0; }; i=0; ` +
  `while [ ! -e "$f.code" ] && [ "$i" -lt "$2" ]; do sleep 1; i=$((i+1)); done; ` +
  `if [ -e "$f.code" ]; then echo "code $(cat "$f.code")"; else echo running; fi; ` +
  `echo "---omb-stdout---"; tail -c ${VPS_EXEC_STDOUT_TAIL_CHARS} "$f.out" 2>/dev/null; echo; echo "---omb-stderr---"; tail -c ${VPS_EXEC_STDERR_TAIL_CHARS} "$f.err" 2>/dev/null`;

export interface VpsExecRun {
  (args: string[], input: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;
}

const tail = (value: string, max: number) => value.length > max ? `…(${value.length - max} earlier characters cut)\n${value.slice(-max)}` : value;

/** Spawns the local Docker client with the PATH whose `ssh` shares the bridge's SSH master. */
export function spawnVpsExecRun(env: NodeJS.ProcessEnv): VpsExecRun {
  return (args, input, timeoutMs) => new Promise((resolve) => {
    const child = spawn("docker", args, { shell: false, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const cap = 4 * VPS_EXEC_STDOUT_TAIL_CHARS;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-cap); });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-cap); });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 3_000).unref?.(); }, timeoutMs);
    timer.unref?.();
    const done = (code: number | null, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: stderr + extra, timedOut });
    };
    child.on("error", (error) => done(null, `could not start docker: ${error.message}`));
    child.on("close", (code) => done(code));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** The bridge's relay for exec and exec_status; every other call goes to the driver unchanged. */
export function createVpsExecRelay(options: { alias: string; container: string; run: VpsExecRun; newId?: () => string }) {
  const newId = options.newId ?? (() => `omb-${randomBytes(8).toString("hex")}`);
  const docker = (script: string, args: string[], input: string, timeoutMs: number) =>
    options.run(vpsExecDockerArgs(options.alias, options.container, script, args), input, timeoutMs);
  return (call: ToolCall): Promise<VpsExecResult> | null => {
    if (!OWN_TOOLS.has(call.name)) return null;
    return (async () => {
      const problem = vpsExecCallProblem(call);
      if (problem) return text(problem, true);
      const a = call.arguments;
      if (call.name === "exec" && a.background === true) {
        const id = newId();
        const started = await docker(BACKGROUND_SCRIPT, [id], String(a.command), 60_000);
        if (started.code !== 0 || !started.stdout.includes("started")) {
          return text({ ok: false, error: "The command could not be started in the background.", stderr: tail(started.stderr.trim(), VPS_EXEC_STDERR_TAIL_CHARS) }, true);
        }
        return text({ ok: true, process_id: id, status: "running", next: "Call exec_status with this process_id and wait_seconds to follow it." }, false);
      }
      if (call.name === "exec") {
        const seconds = (a.timeout_seconds as number | undefined) ?? VPS_EXEC_DEFAULT_TIMEOUT_SECONDS;
        const result = await docker(FOREGROUND_SCRIPT, [String(seconds)], String(a.command), seconds * 1000 + TRANSPORT_GRACE_MS);
        // timeout(1) answers 124 when it stopped the command; a lost transport has no code at all.
        const timedOut = result.timedOut || result.code === 124;
        const body = {
          ok: result.code === 0 && !result.timedOut,
          exitCode: result.timedOut ? null : result.code,
          stdout: tail(result.stdout, VPS_EXEC_STDOUT_TAIL_CHARS),
          stderr: tail(result.stderr, VPS_EXEC_STDERR_TAIL_CHARS),
          ...(timedOut ? { timedOut: true, note: `The command was stopped after ${seconds} seconds. For long work use background: true and exec_status.` } : {}),
        };
        return text(body, !body.ok);
      }
      const wait = (a.wait_seconds as number | undefined) ?? 0;
      const status = await docker(STATUS_SCRIPT, [String(a.process_id), String(wait)], "", wait * 1000 + TRANSPORT_GRACE_MS + 10_000);
      if (status.code !== 0) return text({ ok: false, error: "The status could not be read.", stderr: tail(status.stderr.trim(), 2000) }, true);
      const [head = "", rest = ""] = status.stdout.split("\n---omb-stdout---\n");
      if (head.trim() === "missing") return text("No command with this process_id was started on this computer.", true);
      const [out = "", err = ""] = rest.split("\n---omb-stderr---\n");
      const code = /^code (\d+)/.exec(head.trim());
      return text({
        process_id: a.process_id,
        status: code ? "finished" : "running",
        ...(code ? { exitCode: Number(code[1]), ok: Number(code[1]) === 0 } : {}),
        stdout: out.replace(/\n$/, ""),
        stderr: err.replace(/\n$/, ""),
      }, Boolean(code) && Number(code![1]) !== 0);
    })();
  };
}
