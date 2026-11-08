// One health check on an SSH host: open the connection and run `true`, so the round trip is the host's own answer.
import { DATA_DIR, isValidSshAlias } from "./config.ts";
import { augmentedPath } from "./env-path.ts";
import { killCliTree, spawnCli } from "./procs.ts";
import { prepareVpsSsh } from "./vps-ssh.ts";

export interface SshRoundTrip {
  ok: boolean;
  /** How long the round trip took, online or not. */
  latencyMs?: number;
  reason?: "timeout" | "unreachable";
  error?: string;
}

export type SshRunner = (
  args: string[],
  options: { timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>;

/** `BatchMode` keeps a password prompt from blocking the check, and the command runs `true` on the host. */
export function sshRoundTripArgs(alias: string): string[] {
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", alias, "true"];
}

const MAX_OUTPUT_CHARS = 4_000;

function defaultSshRunner(args: string[], options: { timeoutMs: number }): Promise<{ stdout: string; stderr: string }> {
  const ssh = prepareVpsSsh(DATA_DIR, augmentedPath());
  return new Promise((resolve, reject) => {
    const child = spawnCli("ssh", args, {
      shell: false,
      env: { ...process.env, PATH: ssh.path },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (failure: Error | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (!failure) return resolve({ stdout, stderr });
      void killCliTree(child, 2_000).then(() => reject(failure), () => reject(failure));
    };
    timer = setTimeout(() => finish(new Error("The SSH command timed out")), options.timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
    });
    child.on("error", (error: Error) => finish(new Error(`SSH could not start: ${error.message}`)));
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) return finish(null);
      const detail = stderr.trim() || `ssh exited ${code ?? signal ?? "without a status"}`;
      finish(new Error(detail.slice(-300)));
    });
  });
}

/** How long the host takes to answer: the connection plus one `true` on the far side. */
export async function sshRoundTrip(
  alias: string,
  options: { timeoutMs?: number; runner?: SshRunner } = {},
): Promise<SshRoundTrip> {
  if (!isValidSshAlias(alias)) return { ok: false, reason: "unreachable", error: "This SSH alias is not a valid host name." };
  const timeoutMs = options.timeoutMs ?? 10_000;
  const runner = options.runner ?? defaultSshRunner;
  const startedAt = Date.now();
  try {
    await runner(sshRoundTripArgs(alias), { timeoutMs });
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    if (/timed out/i.test(message)) {
      const budget = timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} seconds`;
      return { ok: false, latencyMs, reason: "timeout", error: `The host did not answer within ${budget}.` };
    }
    return { ok: false, latencyMs, reason: "unreachable", error: message };
  }
}
