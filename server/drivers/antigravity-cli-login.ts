// Headless Google sign-in for an added agy CLI account: `agy acp --login` prints the authorization URL and reads the
// authorization code (or the landing page URL) from stdin. The CLI cannot open a browser on a headless host, and its
// ACP `authenticate` would reuse the first account, so added accounts sign in through this flow instead.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AntigravityRuntime } from "./antigravity-runtime.ts";
import type { AntigravityProfile } from "./antigravity-acp.ts";
import type { ProviderAuthenticationStart as AntigravityAuthStart, ProviderAuthenticationStatus } from "../contracts.ts";

const AUTH_URL = /https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s"'<>]+/u;
const FLOW_TTL_MS = 10 * 60_000;
const EXPIRED = "Google sign-in expired. Start sign-in again.";

type Spawn = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string; stdio: ["pipe", "pipe", "pipe"] }) => ChildProcess;

interface CliLoginFlow {
  id: string;
  child: ChildProcess;
  exited: Promise<void>;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  verifying: boolean;
}

/** Last meaningful CLI line, without anything that looks like a URL or token. */
function safeFailure(output: string): string {
  const line = output.split(/\r?\n/u).map((part) => part.trim()).filter(Boolean).pop() ?? "";
  const clean = line.replace(/https?:\/\/\S+/gu, "").slice(0, 300);
  return clean || "Antigravity sign-in failed.";
}

export class AntigravityCliLoginController {
  private flow: CliLoginFlow | null = null;
  private ended: ProviderAuthenticationStatus | null = null;

  private readonly onSignedIn: () => void;
  private readonly spawnLogin: Spawn;
  private readonly startupTimeoutMs: number;
  private readonly completeTimeoutMs: number;

  constructor(
    onSignedIn: () => void = () => {},
    spawnLogin: Spawn = spawn as unknown as Spawn,
    startupTimeoutMs = 30_000,
    completeTimeoutMs = 60_000,
  ) {
    this.onSignedIn = onSignedIn;
    this.spawnLogin = spawnLogin;
    this.startupTimeoutMs = startupTimeoutMs;
    this.completeTimeoutMs = completeTimeoutMs;
  }

  async start(runtime: AntigravityRuntime, profile: AntigravityProfile): Promise<AntigravityAuthStart> {
    this.cancel();
    const child = this.spawnLogin(runtime.executablePath, ["acp", "--login"], {
      env: profile.environment,
      cwd: profile.directory,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    const exited = new Promise<void>((resolveExit, rejectExit) => {
      child.once("error", (error) => rejectExit(error));
      child.once("exit", (code) => (code === 0 ? resolveExit() : rejectExit(new Error(safeFailure(output)))));
    });
    exited.catch(() => {});
    const outcome = await new Promise<{ kind: "url"; url: string } | { kind: "done" }>((resolveStart, rejectStart) => {
      const timer = setTimeout(() => rejectStart(new Error("Google sign-in did not start in time.")), this.startupTimeoutMs);
      timer.unref?.();
      const onData = (chunk: Buffer | string) => {
        output = (output + chunk.toString()).slice(-16_384);
        const match = AUTH_URL.exec(output);
        if (match) {
          clearTimeout(timer);
          resolveStart({ kind: "url", url: match[0] });
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      exited.then(
        () => { clearTimeout(timer); resolveStart({ kind: "done" }); },
        (error) => { clearTimeout(timer); rejectStart(error); },
      );
    }).catch((error) => {
      child.kill();
      throw error;
    });
    if (outcome.kind === "done") {
      this.onSignedIn();
      return { phase: "succeeded", flowId: null, authorizationUrl: null, expiresAt: null };
    }
    const expiresAt = Date.now() + FLOW_TTL_MS;
    const flow: CliLoginFlow = {
      id: randomUUID(),
      child,
      exited,
      expiresAt,
      verifying: false,
      timer: setTimeout(() => {
        if (this.flow !== flow) return;
        this.flow = null;
        this.ended = { phase: "expired", flowId: flow.id, authorizationUrl: null, expiresAt: null, message: EXPIRED };
        if (flow.child.exitCode === null) flow.child.kill();
      }, FLOW_TTL_MS),
    };
    flow.timer.unref?.();
    this.flow = flow;
    void exited.then(() => {
      if (this.flow !== flow) return;
      clearTimeout(flow.timer);
      this.flow = null;
      this.ended = { phase: "succeeded", flowId: flow.id, authorizationUrl: null, expiresAt: null };
    }, (error) => {
      if (this.flow !== flow) return;
      clearTimeout(flow.timer);
      this.flow = null;
      this.ended = {
        phase: "failed", flowId: flow.id, authorizationUrl: null, expiresAt: null,
        message: safeFailure(error instanceof Error ? error.message : String(error)),
      };
    });
    return { phase: "waiting", flowId: flow.id, authorizationUrl: outcome.url, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** The browser controller's status protocol, so a CLI flow is never answered as an unknown browser flow. */
  async get(flowId: string): Promise<ProviderAuthenticationStatus> {
    const flow = this.flow;
    if (flow && flow.id === flowId) {
      if (Date.now() >= flow.expiresAt) return { phase: "expired", flowId, authorizationUrl: null, expiresAt: null, message: EXPIRED };
      return {
        phase: flow.verifying ? "verifying" : "waiting",
        flowId,
        authorizationUrl: null,
        expiresAt: new Date(flow.expiresAt).toISOString(),
      };
    }
    if (this.ended?.flowId === flowId) return { ...this.ended };
    return { phase: "expired", flowId, authorizationUrl: null, expiresAt: null, message: EXPIRED };
  }

  /** `code` is the authorization code or the full URL of the page Google lands on. */
  async complete(flowId: string, code: string): Promise<void> {
    const flow = this.flow;
    if (!flow || flow.id !== flowId || Date.now() >= flow.expiresAt) {
      throw new Error("This Google sign-in is no longer active. Start again.");
    }
    const answer = code.trim();
    if (!answer || answer.length > 16_384 || /[\r\n\0]/u.test(answer)) {
      throw new Error("Paste the authorization code or the full URL of the page you landed on.");
    }
    flow.verifying = true;
    flow.child.stdin?.write(`${answer}\n`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        flow.exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Google sign-in did not finish in time.")), this.completeTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      this.ended = {
        phase: "failed", flowId: flow.id, authorizationUrl: null, expiresAt: null,
        message: safeFailure(error instanceof Error ? error.message : String(error)),
      };
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (this.flow === flow) {
        clearTimeout(flow.timer);
        this.flow = null;
      }
      if (flow.child.exitCode === null) flow.child.kill();
    }
    this.ended = { phase: "succeeded", flowId: flow.id, authorizationUrl: null, expiresAt: null };
    this.onSignedIn();
  }

  cancel(): void {
    const flow = this.flow;
    this.flow = null;
    if (!flow) return;
    clearTimeout(flow.timer);
    this.ended = { phase: "cancelled", flowId: flow.id, authorizationUrl: null, expiresAt: null };
    if (flow.child.exitCode === null) flow.child.kill();
  }
}
