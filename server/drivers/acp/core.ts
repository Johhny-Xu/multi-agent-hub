// The shared ACP (JSON-RPC 2.0 over stdio) driver; per-CLI quirks live in an AcpSupport.
// ACP has no turn/completed: the session/prompt result (stopReason + usage) is the completion.
// session/load replays history as ordinary session/update notifications, so nothing emits before
// the prompt is sent and `_meta.isReplay` updates are dropped. Permissions fail closed: only an
// `allow`-kind option approves, and option order is never a security contract.
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

import { loadConfig, PROVIDER_CREDENTIAL_ENV, stripControlPlaneEnv, WORKSPACE_CREDENTIAL_ENV } from "../../config.ts";
import { applyCentralCliKeys } from "../../cli-keys.ts";
import { openStartupModelCatalog } from "../../startup-model-catalog.ts";
import { acpModelCatalog } from "./model-catalog.ts";
import { decodeInjectId } from "../local-inject.ts";
import { DeviceAuthController, deviceAuthInstanceSurface } from "../device-auth.ts";
import { deletePromptSplitReceipt, promptHalves, readPromptSplitReceipt, splitSessionPrompt, writePromptSplitReceipt } from "../prompt-split.ts";
import type { PromptSplitReceipt } from "../prompt-split.ts";
import { CLI_VERSION_TIMEOUT_MS, describeSpawnFailure, execCli, killCliTree, sharedBoxScope, spawnCli } from "../../procs.ts";
import { runAcpOneShot } from "./background-text.ts";
import { acpNativeLogMessage } from "./tool-log.ts";
import { stripLeakedSystemHarnessMessages } from "../../../shared/system-message-guard.ts";
import {
  classifyQuiet, describeQuiet, formatQuietLimit, quietNoticeText, lastSeenPhrase, LIMIT_WORDS, LogTail, promptIdleTimeoutMs, quietKey, quietNoticeMs, quietTickMs, quietVerdict, sampleProcessTree, toolDrainMs,
  type LogSignal, type ProcessSample, type QuietState,
} from "./quiet-status.ts";
import { readSessionReport } from "./session-reports.ts";
import { acpTurnSteering, advertisedCommands } from "./steer.ts";
import { pickSessionModel, SessionModelControls } from "./session-model-controls.ts";
import { notThisCli, versionFromProbe } from "./version-probe.ts"; import { engineHomes } from "../../engine-homes/engine-homes.ts";

export function skipSubscriptionAuthForLocalInject(model: string | undefined): boolean {
  return Boolean(decodeInjectId(model));
}

import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  RequestOutcome,
  TextGenerationOptions,
  TurnImageInput,
} from "../../contracts.ts";
import { newEventId, newId, TurnNotStartedError } from "../../contracts.ts";
import { augmentedPath } from "../../env-path.ts";
import { supportsApprovalMode } from "../../../shared/approval-mode.ts";
import { MAX_QUESTION_TEXT, parseAskQuestions, parseChoices, questionAnswersByQuestion } from "../../../shared/ask-question.ts";

import { appendNative } from "../native.ts";
import { acpSessionOperationKey, acpShellRequest, answersAlone, permissionLaunchCwd } from "../permission-command.ts"; import { acpReadPaths } from "../../own-file-reads.ts";
import { openQuestionRequest, questionRequestFor } from "./question-requests.ts";
import { commandSummary, toolDetailPreview } from "../../tool-summary.ts";
import { acpToolEndEvents } from "./tool-items.ts";
import { AcpHost } from "./host.ts";
import { exitDetail } from "./exit-report.ts";
import { endTurn, trackRunningTool, type AcpAskFinish, type AcpSession, type AcpTurn } from "./turn-state.ts";
import { recoveryPromptFor } from "../../resume-recovery.ts";
import { noticeFailure } from "../../chat-notices.ts";
import { armIdleClose, engineIdleMs, sessionIdlePolicy, stopIdleClose } from "../session-idle.ts";
import { startupFailureRecoverable } from "./startup-recovery.ts";
import { engineFailure, engineFailureKind } from "../engine-errors.ts";
import { acpRuntimeFailure, acpStopFailure } from "./failure-words.ts";
import { narrowsNativeTools, parseToolScope } from "../../../shared/tool-scope.ts";
import { acpMcpServers } from "../turn-mcp.ts"; import { acpToolOutput, acpToolProgress } from "../tool-progress.ts";
import { learnedToolCountLimit, mcpToolBudget, retryUnderToolLimit } from "../../tool-count-limit.ts"; import { instanceEnvNames } from "../../bot-box/env.ts";

import { isAccountError } from "./acp-support.ts";
import type { AcpConfig, AcpSupport } from "./acp-support.ts";

export type { AccountErrorCode, AcpConfig, AcpSupport } from "./acp-support.ts";

const envOr = (key: string, fallback: number): number => Number(process.env[key] ?? fallback);
const INIT_TIMEOUT = 300_000;
const SESSION_CONFIG_TIMEOUT = 300_000;
const NEW_SESSION_TIMEOUT = 300_000;
const LOAD_SESSION_TIMEOUT = 120_000;
const ACP_STUCK_AFTER_MS = 180_000;
const TOOL_DRAIN_TICK_MS = 100;
const SHARED_SESSIONS_MAX = 6, SHARED_SESSIONS_LIFETIME = 12;
/** Closing a session for these leaves its process fit for other threads' sessions; any other reason retires it. */
const HEALTHY_CLOSE = new Set(["idle", "reset", "contract", "stop", "stopAll", "dispose", "approval-unconfirmed"]);
/** ACP agents may compact their history silently; re-send the full prompt after this many bare turns. */
const ACP_PROMPT_RE_ANCHOR_TURNS = 8;
function isHermesReasoningReplay(chunk: string, streamed: string): boolean {
  const reply = streamed.trim();
  const replay = chunk.trim();
  return reply !== "" && /^(?:> |-# )?💭/.test(replay) && replay.endsWith(reply)
    && /\n\n[ \t]*$/.test(replay.slice(0, -reply.length));
}

/** `end_turn` with a tool call still in progress is not the end of the turn: agy 1.5.3's run_command moves a command
 * that outlives its foreground wait to a background task and answers end_turn without ever completing the call, so the
 * command's output would be lost and its silence mistaken for a finished turn. Wait for the call to drain, up to the
 * budget; a Stop or the session dying ends the wait. */
async function drainRunningTools(current: AcpTurn): Promise<boolean> {
  const deadline = Date.now() + toolDrainMs();
  while (current.runningTools.size > 0 && !current.state.settled && !current.state.stopped && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, TOOL_DRAIN_TICK_MS));
  }
  return current.runningTools.size === 0;
}

let unkeyedToolSeq = 0;
/** A synthetic id for a `tool_call` without `toolCallId`, paired FIFO with the first terminal update. */
function nextUnkeyedToolId(current: AcpTurn): string {
  const id = `acp-tool-unkeyed-${++unkeyedToolSeq}`;
  current.unkeyedToolIds.push(id);
  return id;
}
const CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024;

async function readAcpImageBlocks(images: readonly TurnImageInput[]) {
  return Promise.all(images.map(async (image) => ({
    type: "image" as const,
    data: (await readFile(image.path)).toString("base64"),
    mimeType: image.mime,
  })));
}

function decodeAcpConfig(defaultCli: string) {
  return (raw: unknown): AcpConfig => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      cli: typeof o.cli === "string" ? o.cli : defaultCli,
      fullAuto: o.fullAuto === true,
      workspace: typeof o.workspace === "string" ? o.workspace : undefined,
    };
  };
}

export function createAcpDriver(support: AcpSupport): ProviderDriver<AcpConfig> {
  if (support.sessionScopedApproval && !support.configureSession) {
    throw new Error(`${support.displayName}: sessionScopedApproval needs configureSession to apply each turn's mode`);
  }
  const DRIVER_KIND = support.driverKind;
  const SOURCE = support.nativeSource;
  const mcpCapable = support.mcp !== false;
  const decodeConfig = decodeAcpConfig(support.defaultCli);
  const DENY_TIMEOUT_NOTE =
    "OpenMausBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";
  const QUESTION_NO_MATCH_NOTE =
    "That answer isn't one of the choices this AI can take, so the question was closed and the turn stopped. Ask again and pick one of the options.";

  return {
    driverKind: DRIVER_KIND,
    metadata: {
      displayName: support.displayName,
      supportsMultipleInstances: true,
      access: support.access ?? "subscription", ...(support.cliVersion ? { cliVersion: support.cliVersion } : {}),
    },
    install: support.install,
    models: support.models,
    decodeConfig,
    defaultConfig: () => decodeConfig({}),

    async create(input: DriverCreateInput<AcpConfig>): Promise<ProviderInstance> {
      const { instanceId, config } = input;
      const childEnv = (activeConfig = config) => {
        const env: Record<string, string | undefined> = {
          ...process.env,
          ...input.environment,
          PATH: augmentedPath(),
        };
        const allowedCredentials = new Set(support.credentialEnv ?? []);
        // Foreign provider keys would flip billing off the CLI's login, and workspace credentials are
        // the harness's: only credentialEnv passes.
        for (const key of [...PROVIDER_CREDENTIAL_ENV, ...WORKSPACE_CREDENTIAL_ENV]) {
          if (!allowedCredentials.has(key)) delete env[key];
        }
        stripControlPlaneEnv(env);
        applyCentralCliKeys(env, loadConfig(), allowedCredentials, input.environment);
        support.transformEnv?.(env, activeConfig, instanceId, input.environment);
        return env;
      };
      const catalog = acpModelCatalog({
        instanceId,
        fixed: support.models,
        startFromSaved: Boolean(support.resolveModels) && support.resolveModelsOnCreate === false,
        resolve: support.resolveModels && ((fresh) => { const env = childEnv(); return support.resolveModels!(env, config, instanceId, fresh, instanceEnvNames(input.environment, env)); }),
      });
      const refreshModels = (fresh?: boolean) => catalog.refresh(fresh);
      let startupModelRefresh: Promise<void> | null = null;
      if (support.resolveModels && support.resolveModelsOnCreate !== false) {
        startupModelRefresh = (await openStartupModelCatalog({
          instanceId,
          use: (saved) => { catalog.models = saved; },
          current: () => catalog.models,
          refresh: refreshModels,
        }))?.pending ?? null;
      } else if (support.resolveModelsOnCreate !== false) {
        await refreshModels();
      }
      const deviceSignIn = support.deviceSignIn
        ? new DeviceAuthController(support.deviceSignIn, { cli: config.cli, environment: () => childEnv(), onAuthenticated: refreshModels })
        : null;
      const listeners = new Set<RuntimeEventListener>();
      let disposing = false;
      const requireRunning = () => {
        if (disposing) throw new Error(`${support.displayName} is shutting down`);
      };
      interface Turn {
        stop: () => void;
        interrupt: () => void;
        turnId: string;
        asks: Map<string, AcpAskFinish>;
      }
      const active = new Map<string, Turn>();
      const sessions = new Map<string, AcpSession>();
    // Retain every closing Qwen child until its tree is gone: closing drops the pool entry, not its native writer lease.
      const retiring = new Map<string, Set<ReturnType<typeof spawnCli>>>();
      const retireChild = async (threadId: string, child: ReturnType<typeof spawnCli>): Promise<boolean> => {
        let children = retiring.get(threadId);
        if (!children) retiring.set(threadId, children = new Set());
        children.add(child);
        const stopped = await killCliTree(child);
        if (stopped) {
          children.delete(child);
          if (!children.size && retiring.get(threadId) === children) retiring.delete(threadId);
        }
        return stopped;
      };
      const sessionIdle = sessionIdlePolicy("ACP");

      const closeSession = (threadId: string, why: string) => {
        const session = sessions.get(threadId);
        if (!session || session.closing) return;
        session.closing = true;
        stopIdleClose(`${instanceId}\0${threadId}`, session.idleTimer);
        appendNative(threadId, { dir: "out", source: SOURCE, msg: { close: why } });
        sessions.delete(threadId);
        const { host, sessionId } = session;
        if (!HEALTHY_CLOSE.has(why)) host.draining = true;
        session.acp.close();
        if (host.links.size) {
          host.retired += 1;
          recycleWhenIdle(host);
          if (sessionId && host.initResult?.agentCapabilities?.sessionCapabilities?.close) {
            session.closeConfirmed = host.request(null, "session/close", { sessionId }, why === "cancel-timeout" ? 5_000 : 30_000).then(() => true, () => false);
          }
          return;
        }
        host.draining = true;
      // EOF is no guaranteed exit: Qwen is tracked before another turn can resume its history.
        try {
          session.child.stdin.end();
        } catch {}
        if (support.restartOnMcpChange) void retireChild(threadId, session.child);
        else {
          const kill = setTimeout(() => {
            void killCliTree(session.child);
          }, 5_000);
          kill.unref?.();
        }
      };
      // A session that ignores session/cancel goes on working, and EOF on stdin does not stop it either. Only a confirmed
      // session/close or the end of its process stops it, and ending a shared process ends the other sessions' turns too.
      const endUncancelled = async (threadId: string, session: AcpSession): Promise<boolean> => {
        const { host } = session;
        closeSession(threadId, "cancel-timeout");
        if (host.links.size && await session.closeConfirmed) return true;
        for (const link of host.links) {
          const other = sessions.get(link.threadId);
          if (other?.host !== host) continue;
          const running = other.current;
          closeSession(link.threadId, "cancel-timeout");
          if (running) {
            emit({ ...base(link.threadId, running.turnId), type: "runtime.error", ...noticeFailure("chat.notice.acpRestarted", { provider: support.displayName }) });
            settle(link.threadId, other, false, "exit_before_result");
          }
        }
        if (await killCliTree(host.child)) return true;
        if (session.current) emit({ ...base(threadId, session.current.turnId), type: "runtime.error",
          ...noticeFailure("chat.notice.acpStopFailed", { provider: support.displayName }) });
        return false;
      };
      // A shared process holding closed sessions gives their memory back only by exiting: once none of its sessions has
      // run a turn for a while, it ends and each thread's next turn loads its session in a new one.
      const hostBusy = (host: AcpHost) => [...host.links].some((link) => sessions.get(link.threadId)?.current);
      const recycleWhenIdle = (host: AcpHost) => {
        if (!host.retired || host.recycle || hostBusy(host)) return;
        host.recycle = setTimeout(() => {
          if (!hostBusy(host)) {
            host.draining = true;
            for (const link of host.links) closeSession(link.threadId, "recycle");
          }
          host.recycle = null;
        }, envOr("OMB_ACP_SHARED_RECYCLE_MS", 60_000));
        host.recycle.unref?.();
      };
      const armIdle = (threadId: string) => {
        const session = sessions.get(threadId);
        if (!session) return;
        if (session.idleTimer) clearTimeout(session.idleTimer);
        session.idleTimer = armIdleClose(`${instanceId}\0${threadId}`, engineIdleMs(threadId, sessionIdle), { close: () => closeSession(threadId, "idle"),
          idle: () => sessions.get(threadId) === session && !session.closing && !session.current });
      };
    // Session allows the driver keeps when the agent offered no `allow_always`: exact operations per
    // thread, for the native session's life. A generic title with no input is never remembered.
      const sessionAllows = new Map<string, Set<string>>();

      const emit = (event: RuntimeEvent) => {
        for (const listener of listeners) listener(event);
      };

      const nativeLogMessage = (msg: any): unknown => acpNativeLogMessage(msg, support.sanitizeToolPayload === true);
      const base = (threadId: string, turnId: string) => ({
        eventId: newEventId(),
        provider: DRIVER_KIND,
        threadId,
        turnId,
        createdAt: new Date().toISOString(),
      });

      const startQuietWatch = (threadId: string, session: AcpSession, current: AcpTurn) => {
        const noticeAfterMs = quietNoticeMs();
        const tickMs = quietTickMs();
        const { sessionId } = session;
        const logPath = support.statusLog && sessionId ? support.statusLog.path(session.env, sessionId) : null;
        const tail = logPath ? new LogTail(logPath) : null;
        tail?.read();
        let logged: { signal: LogSignal; at: number } | null = null;
        let context: { tokens: number; threshold: number } | null = null;
        let previous: ProcessSample | null = null;
        let previousAt = 0;
        let shownKey: string | null = null;
        let noSignsSince: number | null = null;
        let notices = 0;
        let probing = false;
        let state: QuietState | null = null;
        const promptStartedAt = Date.now();
        let readAt = promptStartedAt;
        const tick = async () => {
          if (probing || current.state.settled || session.current !== current) return;
          const now = Date.now();
          for (const line of tail?.read() ?? []) {
            if (!support.statusLog!.shared) session.acp.touch();
            const signal = support.statusLog!.parse(line, sessionId!);
            if (signal?.kind === "context") context = { tokens: signal.tokens, threshold: signal.threshold };
            // A shared row was written some time after the last read; date it then, so a reply since clears it.
            else if (signal) logged = { signal, at: support.statusLog!.shared ? readAt : now };
          }
          readAt = now;
          const quietMs = now - Math.max(promptStartedAt, session.acp.lastInboundAt);
          if (quietMs < noticeAfterMs || current.asks.size || current.runningTools.size) {
            if (quietMs < noticeAfterMs && (!support.statusLog?.shared || session.acp.lastInboundAt > (logged?.at ?? 0))) logged = null;
            previous = null;
            shownKey = null;
            noSignsSince = null;
            state = null;
            return;
          }
          // Qwen's SDK retries on its own for about a minute before the next logged attempt.
          if (logged?.signal.kind === "retry"
              && now - logged.at > (logged.signal.delayMs ?? 60_000) + 120_000) logged = null;
          probing = true;
          const sample = session.child.pid ? await sampleProcessTree(session.child.pid) : { cpuMs: null, connections: null };
          probing = false;
          if (current.state.settled || session.current !== current) return;
          let next = classifyQuiet({
            logged: logged?.signal ?? null, context, sample, previous, sinceMs: previous ? now - previousAt : 0,
          });
          const first = previous === null;
          previous = sample;
          previousAt = now;
          if (first && next.kind === "unknown") return;
          // An SDK sleeping between retries holds no socket and burns no CPU (Qwen against a 429ing endpoint); waiting out a
          // usage limit, or no sign of life for minutes, ends the turn now rather than after the full silence guard.
          const verdict = quietVerdict({ next, logged, noSignsSince, now, quietMs, name: support.displayName, stuckAfterMs: ACP_STUCK_AFTER_MS });
          next = verdict.next; noSignsSince = verdict.noSignsSince;
          if (verdict.stop) return void session.acp.failAll(verdict.stop);
          state = next;
          const key = quietKey(next);
          if (key === shownKey || notices >= 12) return;
          shownKey = key;
          notices += 1;
          emit({
            ...base(threadId, current.turnId),
            type: "runtime.notice",
            message: describeQuiet(support.displayName, next, quietMs, promptIdleTimeoutMs()), text: quietNoticeText(support.displayName, next, quietMs),
          });
        };
        const timer = setInterval(() => { void tick(); }, tickMs);
        timer.unref?.();
        current.stopQuietWatch = () => clearInterval(timer);
        return { lastState: () => state };
      };

      const settle = (threadId: string, session: AcpSession, ok: boolean, stopReason: string | null) => {
        const current = session.current;
        if (!current || current.state.settled) return;
        current.state.settled = true;
        current.acknowledge();
        current.stopQuietWatch?.();
        if (current.interruptTimer) clearTimeout(current.interruptTimer);
        for (const finish of current.asks.values()) finish("cancel", "system");
        session.acp.failAll(new Error("turn settled"));
      // Detach before the final events: a listener may start the next turn synchronously.
        session.current = null;
        active.delete(threadId);
        const end = endTurn(current, ok, stopReason, support.displayName, support.outputTokenCap?.(session.env));
        if (end.error) emit({ ...base(threadId, current.turnId), type: "runtime.error", ...end.error });
        emit({ ...base(threadId, current.turnId), type: "turn.completed", ok: end.ok, stopReason: end.stopReason, cost: null });
        if (session.child.exitCode === null && !session.closing && !session.dead) {
          if (session.retireAfterTurn) closeSession(threadId, "idle");
          else {
            armIdle(threadId);
            recycleWhenIdle(session.host);
          }
        } else if (session.dead && sessions.get(threadId) === session) {
          sessions.delete(threadId);
        }
      };

      const hosts = new Set<AcpHost>();
      // Between turns nothing is brokered; the agent must never block on an unanswered request.
      const refuse = (msg: any, send: (obj: unknown) => void) => {
        const question = questionRequestFor(support.questionRequests, msg.method);
        send(msg.method === "session/request_permission"
          ? { jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } }
          : question
            ? { jsonrpc: "2.0", id: msg.id, result: question.cancelled }
            : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      };
      const sharedHost = (hostKey: string | null, threadId: string, cwd: string): AcpHost | null => {
        if (hostKey === null) return null;
        for (const host of hosts) if (host.key === hostKey && host.accepts(SHARED_SESSIONS_MAX, SHARED_SESSIONS_LIFETIME, threadId, cwd)) return host;
        return null;
      };
      const hostFor = (threadId: string, launch: { command: string }, argv: string[], env: Record<string, string | undefined>, cwd: string,
        hostKey: string | null): AcpHost => {
        const running = sharedHost(hostKey, threadId, cwd);
        if (running) return running;
        const child = spawnCli(launch.command, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"], box: { allowEnv: instanceEnvNames(input.environment, env), botThreads: hostKey !== null } }, "bot");
        const host = new AcpHost(child, hostKey, { source: SOURCE, logMessage: nativeLogMessage, unrouted: refuse });
        hosts.add(host);
        child.once("close", () => hosts.delete(host));
        child.once("error", () => hosts.delete(host));
        return host;
      };

      const openSession = (
        threadId: string,
        launch: { command: string; args?: string[] },
        argv: string[],
        env: Record<string, string | undefined>,
        cwd: string,
        contractKey: string,
        hostKey: string | null,
      ): AcpSession => {
        const commandCwd = permissionLaunchCwd(cwd);
        const host = hostFor(threadId, launch, argv, env, cwd, hostKey);
        const acp = host.link(threadId, cwd);
        const send = (obj: unknown) => acp.send(obj);

        const resolveClientPath = async (requestPath: unknown): Promise<string> => {
          if (typeof requestPath !== "string" || !isAbsolute(requestPath)) {
            throw new Error("ACP file paths must be absolute.");
          }
          const workspace = await realpath(cwd).catch(() => resolve(cwd));
          const requested = resolve(requestPath);
          const lexical = relative(resolve(cwd), requested);
          if (lexical === ".." || lexical.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(lexical)) {
            throw new Error("ACP file path is outside the session workspace.");
          }
          const suffix = [basename(requested)];
          let ancestor = dirname(requested);
          while (!(await lstat(ancestor).catch(() => null))) {
            const parent = dirname(ancestor);
            if (parent === ancestor) throw new Error("ACP file path has no accessible parent.");
            suffix.unshift(basename(ancestor));
            ancestor = parent;
          }
          const candidate = resolve(await realpath(ancestor), ...suffix);
          const rel = relative(workspace, candidate);
          if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
            throw new Error("ACP file path is outside the session workspace.");
          }
          const existing = await lstat(candidate).catch(() => null);
          if (existing?.isSymbolicLink()) throw new Error("ACP file path cannot be a symbolic link.");
          return candidate;
        };

        const handleClientFileRequest = async (msg: any): Promise<void> => {
          const fail = (error: unknown) => send({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32602, message: error instanceof Error ? error.message : String(error) },
          });
          try {
            if (!support.clientFileSystem) throw new Error("Client file access is disabled.");
            const params = msg.params ?? {};
            const path = await resolveClientPath(params.path);
            if (msg.method === "fs/read_text_file") {
              const info = await stat(path);
              if (!info.isFile() || info.size > CLIENT_FILE_MAX_BYTES) {
                throw new Error(`ACP can only read text files under ${CLIENT_FILE_MAX_BYTES} bytes.`);
              }
              const content = await readFile(path, "utf8");
              if (params.line == null && params.limit == null) {
                send({ jsonrpc: "2.0", id: msg.id, result: { content } });
                return;
              }
              const line = typeof params.line === "number" && Number.isInteger(params.line) && params.line > 0 ? params.line : 1;
              const limit = typeof params.limit === "number" && Number.isInteger(params.limit) && params.limit >= 0 ? params.limit : undefined;
              const lines = content.split("\n");
              const start = line - 1;
              send({
                jsonrpc: "2.0",
                id: msg.id,
                result: { content: lines.slice(start, limit === undefined ? undefined : start + limit).join("\n") },
              });
              return;
            }
            if (typeof params.content !== "string" || Buffer.byteLength(params.content) > CLIENT_FILE_MAX_BYTES) {
              throw new Error(`ACP can only write text files under ${CLIENT_FILE_MAX_BYTES} bytes.`);
            }
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, params.content, "utf8");
            send({ jsonrpc: "2.0", id: msg.id, result: {} });
          } catch (error) {
            fail(error);
          }
        };

        const handleServerRequest = (msg: any, current: AcpTurn) => {
          current.state.startupActivity = true; if (current.state.promptSent) current.acknowledge();
          if (msg.method === "fs/read_text_file" || msg.method === "fs/write_text_file") {
            void handleClientFileRequest(msg);
            return;
          }
          const question = questionRequestFor(support.questionRequests, msg.method);
          if (question) return openQuestionRequest(msg, question, current, send, emit, () => base(threadId, current.turnId));
          if (msg.method !== "session/request_permission") {
          // An unanswered server request blocks the agent.
            return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
          }
          const params = msg.params ?? {};
          current.flushAssistantText();
          const options: Array<{ optionId?: string; kind?: string; name?: string }> = Array.isArray(params.options) ? params.options : [];
          const optionFor = (want: "allow" | "reject") =>
            options.find((o) => o.kind === `${want}_once` && typeof o.optionId === "string")?.optionId
              ?? options.find((o) => String(o.kind ?? "").startsWith(want) && typeof o.optionId === "string")?.optionId
              ?? null;
          const optionAlways = options.find((o) => o.kind === "allow_always" && typeof o.optionId === "string")?.optionId ?? null;
          const cancelled = { outcome: { outcome: "cancelled" } };
          const missing = (want: string) =>
            emit({
              ...base(threadId, current.turnId),
              type: "runtime.error",
              message: `${support.displayName} offered no "${want}" permission option — cancelling the request instead of guessing`,
            });

          const toolCall = params.toolCall ?? {};
          const isQuestion = String(toolCall.toolCallId ?? "").startsWith("interaction_");
          if (current.turnConfig.fullAuto && current.turn.approvalMode === undefined && !isQuestion && answersAlone(toolCall.rawInput?.command)) {
            const allow = optionFor("allow");
            if (!allow) missing("allow");
            return send({ jsonrpc: "2.0", id: msg.id, result: allow ? { outcome: { outcome: "selected", optionId: allow } } : cancelled });
          }
          const kind = String(toolCall.kind ?? "");
          const operationKey = isQuestion || current.controlsHost ? null : acpSessionOperationKey(toolCall);
          if (operationKey && answersAlone(toolCall.rawInput?.command) && sessionAllows.get(threadId)?.has(operationKey)) {
            const allow = optionFor("allow");
            if (allow) {
              return send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: allow } } });
            }
          }
          const tool = kind === "execute" ? "shell" : kind === "edit" ? "edit" : kind || "tool";
          const isShellCommand = !isQuestion && kind === "execute" && !/^mcp(?:__|[.:])/i.test(String(toolCall.title ?? ""));
          const rawSummary = String(toolCall.rawInput?.command ?? toolCall.title ?? tool);
          const summary = rawSummary.slice(0, isQuestion ? MAX_QUESTION_TEXT : 200);
          const questionChoices = isQuestion
            ? options.flatMap((option) => typeof option.name === "string" && option.name.trim() ? [option.name.trim()] : [])
            : [];
          const askQuestions = isQuestion && questionChoices.length
            // An ACP question answers with one of its option ids, never free text.
            ? parseAskQuestions({ questions: [{ question: summary, options: questionChoices, custom: false }] }) ?? undefined
            : undefined;
          const requestId = newId();
          const finish = (
            behavior: string,
            source: "user" | "timeout" | "system" = "user",
            message?: string,
            always?: boolean,
          ): RequestOutcome => {
            if (!current.asks.delete(requestId)) return "unavailable";
            clearTimeout(timer);
            const want = behavior === "allow" ? "allow" : "reject";
            const forSession = want === "allow" && always === true && !isQuestion && !current.controlsHost;
            const picked = askQuestions
              ? questionAnswersByQuestion(message ?? "", askQuestions)[askQuestions[0]!.question] ?? message
              : message;
            const named = isQuestion && behavior === "answer"
              ? options.filter((option) => option.optionId === picked || parseChoices([option.name], 1)?.[0] === picked)
              : [];
            const optionId = behavior === "cancel"
              ? null
              : isQuestion
                ? named.length === 1 && typeof named[0].optionId === "string" ? named[0].optionId : null
                : forSession
                  ? optionAlways ?? optionFor("allow")
                  : optionFor(want);
            if (forSession && !optionAlways && optionId && operationKey) {
              const remembered = sessionAllows.get(threadId) ?? new Set<string>();
              remembered.add(operationKey);
              sessionAllows.set(threadId, remembered);
            }
            if (behavior !== "cancel" && !optionId) {
              if (!isQuestion) missing(want);
              else if (behavior === "answer") {
                emit({ ...base(threadId, current.turnId), type: "runtime.error", message: QUESTION_NO_MATCH_NOTE });
              }
            }
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: optionId ? { outcome: { outcome: "selected", optionId } } : cancelled,
            });
            // ACP means "cancelled" only while cancelling the prompt turn, so an agent may then wait for
            // session/cancel (Antigravity does): end the turn.
            if (!optionId && behavior !== "cancel" && session.current === current) active.get(threadId)?.interrupt();
            emit({
              ...base(threadId, current.turnId),
              type: "request.resolved",
              requestId,
              behavior: optionId && isQuestion ? "answer" : optionId && behavior === "allow" ? "allow" : "deny",
              source: optionId ? source : "system",
              approvalScope: current.controlsHost ? "local-computer" : undefined,
            });
            return !optionId ? "rejected" : isQuestion ? "answered" : behavior === "allow" ? "allowed-once" : "rejected";
          };
          const timer = setTimeout(() => {
            emit({ ...base(threadId, current.turnId), type: "runtime.error", message: DENY_TIMEOUT_NOTE });
            finish("deny", "timeout");
          }, 15 * 60_000);
          timer.unref?.();
          current.asks.set(requestId, finish);
          emit({
            ...base(threadId, current.turnId),
            type: "request.opened",
            requestId,
            requestType: isQuestion ? "question" : "permission",
            tool,
            summary,
            ...acpShellRequest(isShellCommand, isQuestion ? undefined : toolCall.rawInput, commandCwd), ...(!isQuestion && acpReadPaths(toolCall) ? { reads: acpReadPaths(toolCall) } : {}),
            requiresExplicitApproval: isShellCommand && (
              toolCall.rawInput?.dangerouslyDisableSandbox === true || toolCall.rawInput?.sandbox_permissions === "require_escalated"
            ) || undefined,
            choices: askQuestions?.[0]?.options.map(option => option.label) ?? (isQuestion ? questionChoices : undefined),
            ...(askQuestions ? { questions: askQuestions } : {}),
            approvalScope: current.controlsHost ? "local-computer" : undefined,
            allowSession: !isQuestion && !current.controlsHost ? true : undefined,
          });
        };

        const filterUpdate = support.updateFilter?.();
        const handleNotification = (msg: any) => {
          // Vendor side-channels (grok's `_x.ai/*`) are only teed to the native log.
          if (msg.method !== "session/update") return;
          const p = msg.params ?? {};
          if (p._meta?.isReplay === true) return;
          session.commands = advertisedCommands(p.update) ?? session.commands;
          const current = session.current;
          if (support.modelVariants && p.update?.sessionUpdate === "config_option_update") {
            if (current && !current.state.settled && session.sessionId && p.sessionId === session.sessionId) current.receiveModelVariants(p.update);
            return;
          }
          if (current && ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"].includes(p.update?.sessionUpdate)) {
            current.state.startupActivity = true; if (current.state.promptSent) current.acknowledge();
          }
          if (!current || !current.state.promptSent) return;
          const u = filterUpdate ? filterUpdate(p.update ?? {}) : p.update ?? {};
          if (!u || (u.sessionUpdate === "agent_message_chunk" && typeof u.content?.text === "string" && current.steering?.swallow(u.content.text))) return;
          const finished = u.status === "completed" || u.status === "failed";
          const toolEnded = (itemId: string | undefined) => {
            current.state.producedItem = true;
            for (const event of acpToolEndEvents(u, itemId, current.endedToolIds)) emit({ ...base(threadId, current.turnId), ...event });
          };
          switch (u.sessionUpdate) {
            case "agent_message_chunk": {
              const content = u.content;
              const delta = content?.text;
              if (content?.type === "image" && typeof content.data === "string" && content.data) {
                current.flushAssistantText();
                current.state.producedItem = true;
                emit({
                  ...base(threadId, current.turnId),
                  type: "item.completed",
                  itemType: "assistant_image",
                  data: content.data,
                  alt: "Generated image",
                });
              } else if (typeof delta === "string" && delta) {
                const messageId = typeof u.messageId === "string" ? u.messageId : null;
                if (support.resendsReasoningReply && messageId && messageId === current.state.textMessageId
                    && isHermesReasoningReplay(delta, current.state.text)) break;
                current.state.textMessageId = messageId;
                current.state.text += delta;
                const trimmed = current.state.text.trimStart();
                if (!trimmed.startsWith("<SYSTEM_MESSAGE") &&
                    !trimmed.startsWith("The following is a <SYSTEM_MESSAGE") &&
                    !trimmed.startsWith("<SYSTEM_NOTIFICATION")) {
                  emit({ ...base(threadId, current.turnId), type: "content.delta", streamKind: "assistant_text", delta });
                }
              }
              break;
            }
            case "agent_thought_chunk": {
              const delta = u.content?.text;
              if (typeof delta === "string" && delta) emit({ ...base(threadId, current.turnId), type: "content.delta", streamKind: "reasoning_text", delta });
              break;
            }
            case "tool_call": {
              current.flushAssistantText();
              trackRunningTool(current, u, "pending");
              // ACP can send a tool_call already marked completed or failed (e.g. on a denied permission) with no
              // tool_call_update after it.
              const itemId = (typeof u.toolCallId === "string" && u.toolCallId) ? u.toolCallId
                : finished ? `acp-tool-unkeyed-${++unkeyedToolSeq}` : nextUnkeyedToolId(current);
              emit({
                ...base(threadId, current.turnId),
                type: "item.started",
                itemType: "tool",
                itemId,
                title: String(u.rawInput?.command ?? u.title ?? "tool").slice(0, 80),
                summary: commandSummary(u.rawInput),
                input: toolDetailPreview(u.rawInput),
              });
              if (finished) toolEnded(itemId);
              break;
            }
            case "tool_call_update": {
              trackRunningTool(current, u);
              if (finished) toolEnded((typeof u.toolCallId === "string" && u.toolCallId) ? u.toolCallId : current.unkeyedToolIds.shift());
              break;
            }
            case "usage_update":
            case "session_info_update":
            case "plan": {
              const report = readSessionReport(u, p._meta, current.state, session);
              if (report.context) emit({ ...base(threadId, current.turnId), type: "thread.token-usage.updated", input: 0, output: 0, ...report.context });
              if (!report.step) break;
              current.flushAssistantText();
              const itemId = `plan-${newId()}`;
              emit({ ...base(threadId, current.turnId), type: "item.started", itemType: "tool", itemId, ...report.step });
              emit({ ...base(threadId, current.turnId), type: "item.completed", itemType: "tool", itemId, ok: true });
              break;
            }
          }
          // A call still running (its kind, file and diff so far) feeds the chat's status line.
          for (const live of [acpToolProgress(u), acpToolOutput(u)]) if (live) emit({ ...base(threadId, current.turnId), ...live });
        };

        const session: AcpSession = {
          child: host.child,
          host,
          acp,
          launch,
          env,
          cwd,
          contractKey,
          sessionKey: null,
          get sessionId() { return acp.sessionId; },
          set sessionId(id: string | null) { acp.sessionId = id; },
          sessionConfigResult: null,
          get initResult() { return host.initResult; },
          set initResult(result: any) { host.initResult = result; },
          get authenticated() { return host.authenticated; },
          set authenticated(done: boolean) { host.authenticated = done; },
          idleTimer: null,
          closing: false,
          dead: false,
          get stderr() { return host.stderrTail.text; },
          current: null,
        };
        acp.inbound = {
          request: (msg) => {
            const current = session.current;
            if (!current) refuse(msg, send);
            else handleServerRequest(msg, current);
          },
          notification: handleNotification,
          busy: () => Boolean(session.current?.asks.size || session.current?.runningTools.size),
          error: (e) => {
            session.dead = true;
            const current = session.current;
            if (!current || current.state.cancelling) return;
            emit({ ...base(threadId, current.turnId), type: "runtime.error", ...describeSpawnFailure(e, launch.command, cwd) });
            settle(threadId, session, false, "spawn_error");
          },
          exit: (code, signal) => {
            session.dead = true;
            const current = session.current;
            if (current?.state.cancelling) return;
            if (current) {
              if (!current.state.stopped) emit({
                ...base(threadId, current.turnId),
                type: "runtime.error",
                message: `${support.displayName} exited ${code ?? signal ?? "unexpectedly"} before the prompt result${exitDetail(code, signal, session.stderr)}`,
              });
              settle(threadId, session, current.state.stopped, current.state.stopped ? "cancelled" : "exit_before_result");
            } else if (sessions.get(threadId) === session) {
              // The identity check keeps an old child's exit from unlinking its replacement.
              sessions.delete(threadId);
            }
          },
        };
        return session;
      };

      const sendTurn = async (turn: SendTurnInput, retryOf?: string) => {
        requireRunning();
        if (startupModelRefresh) await startupModelRefresh;
        requireRunning();
        const parsedScope = parseToolScope(turn.toolScope);
        if (!parsedScope.ok) throw new Error(parsedScope.error);
        turn = { ...turn, toolScope: parsedScope.scope };
        if (narrowsNativeTools(turn.toolScope) && !support.toolScopeSessionParams) {
          throw new Error(`${support.displayName}: native tool selection is not supported by this engine. Keep native:* in the selection or choose a supported engine.`);
        }
        const { threadId } = turn;
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        const turnConfig = turn.approvalMode === undefined
          ? config
          : { ...config, fullAuto: turn.approvalMode === "full" && supportsApprovalMode(DRIVER_KIND, "full") };
        const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
        if (controlsHost && turnConfig.fullAuto && turn.approvalMode !== "full") {
          throw new Error("local computer control requires interactive provider approvals");
        }
        const turnId = retryOf ?? newId();
        const cwd = turn.cwd ?? turnConfig.workspace ?? homedir();
        const env = childEnv(turnConfig);
        if (
          support.requireAuthenticationBeforeSpawn
          && !skipSubscriptionAuthForLocalInject(turn.model)
        ) {
          const authenticated = await support.isAuthenticated(env, turnConfig, instanceId, instanceEnvNames(input.environment, env));
          requireRunning();
          if (!authenticated) {
            emit({ ...base(threadId, turnId), type: "turn.started" });
            emit({ ...base(threadId, turnId), type: "runtime.error", message: support.loginNote, setup: true });
            emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "auth_required", cost: null });
            return { turnId };
          }
        }
        const resolvedModel = support.resolveTurnModel?.(turn.model, env, catalog.models);
        const toolLimitKey = JSON.stringify([instanceId, resolvedModel ?? null]);
        const mcpServers = acpMcpServers(turn, { http: support.ownMcpOverHttp === true, engine: support.driverKind,
          toolBudget: mcpToolBudget(learnedToolCountLimit(toolLimitKey), support.engineTools ?? 32) });
        support.applyTurnEnv?.(env, {
          model: resolvedModel, requestedModel: turn.model, fullAuto: turnConfig.fullAuto === true, botId: turn.botId, cwd, toolScope: turn.toolScope,
          threadId, mcpServers,
        });
        let cliTurn =
          resolvedModel !== undefined && resolvedModel !== turn.model
            ? { ...turn, model: resolvedModel }
            : turn;
        let launch: { command: string; args?: string[]; env?: Record<string, string | undefined> };
        try {
          launch = support.resolveCommand
            ? await support.resolveCommand(env, turnConfig, instanceId)
            : { command: turnConfig.cli };
        } catch (error) {
          requireRunning();
          emit({ ...base(threadId, turnId), type: "turn.started" });
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: error instanceof Error ? error.message : String(error),
            setup: true,
          });
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "setup_required", cost: null });
          return { turnId };
        }

        requireRunning();
        const spawnArgs = support.spawnArgs(turnConfig, cliTurn);
        const spawnEnv = launch.env ?? env;
      // The child env is part of the spawn contract, hashed so secrets never sit in the key.
        const envFingerprint = createHash("sha256").update(JSON.stringify(spawnEnv)).digest("hex").slice(0, 16);
        const inheritedScopeFingerprint = narrowsNativeTools(turn.toolScope) && support.toolScopeCacheKey
          ? createHash("sha256").update(support.toolScopeCacheKey({ config: turnConfig, env, cwd })).digest("hex") : null;
        const processContract = [launch.command, launch.args ?? [], spawnArgs,
          support.sessionScopedApproval ? null : turnConfig.fullAuto === true, envFingerprint,
          support.spawnFingerprint?.(spawnEnv, turnConfig) ?? null];
        const contractKey = JSON.stringify([...processContract, cwd, turn.toolScope ?? null, inheritedScopeFingerprint]);
        const launchModel = support.sessionModelEnv && cliTurn.model && /^[\w.:/-]{1,200}$/u.test(cliTurn.model)
          && catalog.accountModels?.has(cliTurn.model) ? cliTurn.model : undefined;
        const launchEnv = support.sessionModelEnv && launchModel
          ? { ...spawnEnv, [support.sessionModelEnv]: launchModel }
          : spawnEnv;
        let launchedThisTurn = false;
        // The folder and the tool selection ride session/new, so threads differing only there can share a process (in the bot box, only one bot's); never two audiences of a Team Cloud, whose engine homes differ.
        const hostKey = support.shareProcess && inheritedScopeFingerprint === null ? JSON.stringify([...processContract, launchModel ?? null, engineHomes.scope(), sharedBoxScope(cwd)]) : null;
        const launchSession = () => {
          const opened = openSession(threadId, launch, [...(launch.args ?? []), ...spawnArgs], launchEnv, cwd, contractKey, hostKey);
          opened.launchModel = launchModel;
          launchedThisTurn = true;
          return opened;
        };
        const sessionKey = JSON.stringify([mcpServers, turn.toolScope ?? null, inheritedScopeFingerprint]);

        if (turn.sessionReset) {
          closeSession(threadId, "reset");
          sessionAllows.delete(threadId);
        }
        const pooled = sessions.get(threadId);
        let session: AcpSession;
        if (pooled && !pooled.dead && !pooled.closing && pooled.contractKey === contractKey
            && (!support.restartOnMcpChange || pooled.sessionKey === sessionKey)) {
          if (pooled.idleTimer) clearTimeout(pooled.idleTimer);
          pooled.idleTimer = null;
          session = pooled;
        } else {
          if (pooled) {
            if (pooled.dead) sessions.delete(threadId);
            else closeSession(threadId, "contract");
          }
          const joining = sharedHost(hostKey, threadId, cwd);
          await turn.engineAdmission?.(joining ? "session" : "process", joining?.child.pid);
          requireRunning();
          if (active.has(threadId)) throw new Error("a turn is already running on this thread");
          session = launchSession();
          sessions.set(threadId, session);
        }
      // `session` rebinds when the establishment retry respawns the child: never capture its connection.
        const request = (
          method: string,
          params: unknown,
          timeoutMs?: number,
          receive?: (result: any) => void,
          idleMs?: number,
          idleMessage?: string | (() => string),
        ): Promise<any> =>
          session.acp.request(method, params, timeoutMs, receive, idleMs, idleMessage);

        const state: AcpTurn["state"] = { settled: false, promptSent: false, text: "", textMessageId: null, producedItem: false, repliedText: false, startupActivity: false, stopped: false, usagePeak: null, usageLast: null, usageCompacted: false, cancelling: false, outputTokens: null };
        let acknowledge = () => {};
        let rejectStartup = (_error: TurnNotStartedError) => {};
        const startupAck = turn.startupRecovery ? new Promise<{ turnId: string }>((resolve, reject) => {
          acknowledge = () => resolve({ turnId });
          rejectStartup = reject;
        }) : null;
        const asks = new Map<string, AcpAskFinish>();
        let reportedModel = turn.model;
        let variant = turn.variant;
        let staleProcess = false;
      // Still set if configuring throws: the pooled session may keep an earlier turn's looser mode.
        let approvalUnconfirmed = false;
        const modelControls = new SessionModelControls({
          selection: support.selectModel, variants: support.modelVariants === true, displayName: support.displayName,
          model: () => cliTurn.model, reportedModel: () => reportedModel,
          state: () => session.sessionConfigResult, store: (result) => { session.sessionConfigResult = result; },
          report: (model, variants) => emit({ ...base(threadId, turnId), type: "session.model-variants", model, variants }),
        });
        const receiveModelVariants = (result: any, replace = false) => modelControls.receive(result, replace);
        const requestedVariantOption = () => modelControls.variant(variant);

        const flushAssistantText = () => {
          const raw = state.text;
          state.text = "";
          const text = stripLeakedSystemHarnessMessages(raw);
          if (!text.trim()) return;
          state.producedItem = true;
          state.repliedText = true;
          emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
        };
        const current: AcpTurn = {
          turnId,
          turn: cliTurn,
          turnConfig,
          controlsHost,
          state,
          acknowledge,
          asks,
          runningTools: new Set(),
          unkeyedToolIds: [],
          endedToolIds: new Set(),
          interruptTimer: null,
          stopQuietWatch: null,
          flushAssistantText,
          receiveModelVariants,
          steering: support.steer && acpTurnSteering(support.steer,
            () => state.promptSent && !state.settled && !state.stopped && !session.closing && session.commands?.has(support.steer!.command) === true,
            (text) => request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text }] }, undefined, undefined, promptIdleTimeoutMs())),
        };

        const interrupt = () => {
          state.stopped = true;
          if (session.sessionId) {
            session.acp.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: session.sessionId } });
            if (current.interruptTimer) clearTimeout(current.interruptTimer);
            current.interruptTimer = setTimeout(() => {
              state.cancelling = true;
              void endUncancelled(threadId, session).then((ended) => settle(threadId, session, ended, ended ? "cancelled" : "stop_failed"));
            }, 5_000);
            current.interruptTimer.unref?.();
          } else {
            closeSession(threadId, "stop");
          }
        };
        active.set(threadId, { stop: () => { state.stopped = true; closeSession(threadId, "stop"); }, interrupt, turnId, asks });
        if (retryOf === undefined) emit({ ...base(threadId, turnId), type: "turn.started" });
        session.current = current;

        (async () => {
          let pendingSplitReceipt: { key: string; receipt: PromptSplitReceipt; previous: PromptSplitReceipt | null } | null = null;
          try {
            const handshake = async (): Promise<boolean> => {
              for (const child of retiring.get(threadId) ?? []) {
                const stopped = await retireChild(threadId, child);
                if (state.settled || session.closing) throw new Error("session closed");
                if (!stopped) {
                  closeSession(threadId, "replace-failed");
                  throw new Error(`${support.displayName} could not close its previous tool session. Try again.`);
                }
              }
              if (state.settled || session.closing) throw new Error("session closed");
              if (!session.initResult) {
                session.initResult = await session.host.once("initialize", () => request(
                  "initialize",
                  {
                    protocolVersion: 1,
                    clientInfo: { name: "openmausbot", version: "0.0.0" },
                    clientCapabilities: {
                      fs: {
                        readTextFile: support.clientFileSystem === true,
                        writeTextFile: support.clientFileSystem === true,
                      },
                      terminal: false,
                      ...(support.clientCapabilitiesMeta ? { _meta: support.clientCapabilitiesMeta } : {}),
                    },
                  },
                  INIT_TIMEOUT,
                ));
              }
              if (!skipSubscriptionAuthForLocalInject(turn.model) && !session.authenticated) {
                const methods: Array<{ id?: string }> = Array.isArray(session.initResult?.authMethods)
                  ? session.initResult.authMethods
                  : [];
                const methodId = support.pickAuthMethod(methods, spawnEnv);
                if (methodId) {
                  try {
                    await session.host.once("authenticate", () => request("authenticate", { methodId }, INIT_TIMEOUT));
                    session.authenticated = true;
                  } catch {
                    if (support.authFailure !== "continue") throw new Error(support.loginNote);
                  }
                } else if (support.authFailure === "fail") {
                  throw new Error(support.loginNote);
                }
              }
              const images = turn.images ?? [];
              const accepts = session.initResult?.agentCapabilities?.promptCapabilities?.image === true ||
                support.acceptsUnadvertisedImages?.(session.initResult) === true;
              if (images.length && support.images === true && !accepts) {
                throw new Error(
                  `${support.displayName} is configured for image attachments, but this installed runtime does not advertise ACP image input. Update the ${support.displayName} CLI or send the message without an image.`,
                );
              }
              return accepts;
            };
            let runtimeAcceptsImages = await handshake();
            let init = session.initResult;

            const cursor = !turn.sessionReset && typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
            let promptTurn = turn;
            let rebuiltFromReplay = false;
            for (;;) {
              const liveSessionId = session.sessionId;
              if (liveSessionId !== null && session.sessionKey === sessionKey && (cursor === null || cursor === liveSessionId)) {
                break;
              }
              const selectionParams = narrowsNativeTools(turn.toolScope)
                ? support.toolScopeSessionParams!(turn, init, mcpServers.length > 0, { config: turnConfig, env, cwd }) : {};
              let loaded = false;
              if (cursor) {
                try {
                  await request(
                    support.resumeMethod === "resume" ? "session/resume" : "session/load",
                    { sessionId: cursor, cwd, mcpServers: support.mcpServersFromLaunch ? [] : mcpServers, ...selectionParams },
                    LOAD_SESSION_TIMEOUT,
                    (result) => {
                      if (result) {
                        loaded = true;
                        session.sessionId = cursor;
                        session.sessionKey = sessionKey;
                        receiveModelVariants(result, true);
                      }
                    },
                  );
                } catch (error) {
                  const classification = support.classifyError?.(error);
                  // OpenCode encodes ACPSessionNotFoundError as invalidParams with just the rejected
                  // sessionId; other invalidParams (model/config errors) must not erase history.
                  const data = (error as any)?.data;
                  const missingSession = data && typeof data === "object" && !Array.isArray(data)
                    && data.sessionId === cursor && Object.keys(data).length === 1;
                  if (classification === "invalid_credentials" || classification === "inactive_subscription"
                      || ((error as any)?.code === -32602 && !missingSession)) throw error;
                }
              }
              if (loaded) break;
              if (cursor && liveSessionId === cursor) {
                session.current = null;
                closeSession(threadId, "reestablish");
                session = launchSession();
                sessions.set(threadId, session);
                session.current = current;
                runtimeAcceptsImages = await handshake();
                init = session.initResult;
                continue;
              }
              sessionAllows.delete(threadId);
              if (cursor) {
                const recovery = recoveryPromptFor({
                  recoveryText: turn.recoveryText,
                  currentText: turn.text,
                  failure: "before-accept",
                });
                promptTurn = { ...turn, text: recovery.text };
                rebuiltFromReplay = recovery.replayed;
              }
              await request("session/new", { cwd, mcpServers: support.mcpServersFromLaunch ? [] : mcpServers, ...selectionParams }, NEW_SESSION_TIMEOUT, (result) => {
                session.sessionId = typeof result?.sessionId === "string" ? result.sessionId : null;
                session.sessionKey = sessionKey;
                receiveModelVariants(result, true);
              });
              break;
            }
            const sessionId = session.sessionId;
            if (sessionId === null) throw new Error("session/new returned no sessionId");
            let selectedModel: string | null = null;
            let sessionStarted = false;
            const emitSessionStarted = () => {
              if (sessionStarted) return;
              sessionStarted = true;
              emit({
                ...base(threadId, turnId),
                type: "session.started",
                sessionId,
                model: selectedModel ?? init?._meta?.modelState?.currentModelId ?? cliTurn.model ?? null,
                ...(rebuiltFromReplay ? { rebuilt: true } : {}),
              });
            };

            try {
              if (support.selectModel) {
                selectedModel = modelControls.modelOf(session.sessionConfigResult);
                // Committed before the setter runs: a failed switch still reports the session and respawns a stale process.
                const pick = pickSessionModel(support, {
                  configId: support.selectModel.configId, session, requested: turn, turn: cliTurn, variant, reportedModel,
                  catalog: catalog.models, launchedThisTurn,
                });
                if (pick.accountModels) catalog.accountModels = pick.accountModels;
                staleProcess = pick.staleProcess;
                if (pick.notice) emit({ ...base(threadId, turnId), type: "runtime.notice", message: pick.notice, text: pick.noticeText });
                ({ turn: cliTurn, variant, reportedModel } = pick);
                current.turn = cliTurn;
                selectedModel = await modelControls.select(request, sessionId, INIT_TIMEOUT);
              }

              if (support.configureSession) {
                approvalUnconfirmed = support.sessionScopedApproval === true;
                await support.configureSession({
                  request: async (method, params, timeoutMs) => {
                    const result = await request(method, params, timeoutMs ?? SESSION_CONFIG_TIMEOUT);
                    if (method === "session/set_model" && params && typeof params === "object" &&
                        "modelId" in params && typeof params.modelId === "string") {
                      session.sessionConfigResult = {
                        ...session.sessionConfigResult,
                        models: { ...session.sessionConfigResult?.models, currentModelId: params.modelId },
                      };
                    }
                    return result;
                  },
                  sessionId,
                  env: spawnEnv,
                  config: turnConfig,
                  turn: cliTurn,
                  sessionModels: Array.isArray(session.sessionConfigResult?.models?.availableModels)
                    ? session.sessionConfigResult.models.availableModels
                    : [],
                  currentModelId: session.sessionConfigResult?.models?.currentModelId,
                  configOptions: Array.isArray(session.sessionConfigResult?.configOptions)
                    ? session.sessionConfigResult.configOptions
                    : [],
                  notice: (message) => {
                    if (session.fallbackNotice === message) return;
                    session.fallbackNotice = message;
                    emit({ ...base(threadId, turnId), type: "runtime.notice", message });
                  },
                });
                approvalUnconfirmed = false;
                // initialize's currentModelId is the CLI default, not this turn's model.
                if (!selectedModel && cliTurn.model) selectedModel = cliTurn.model;
              }
              if (variant !== undefined) {
                const option = requestedVariantOption();
                await request(
                  "session/set_config_option",
                  { sessionId, configId: option.configId, value: variant },
                  SESSION_CONFIG_TIMEOUT,
                  receiveModelVariants,
                );
                if (requestedVariantOption().currentValue !== variant) {
                  throw new Error(`${support.displayName} did not apply variant ${variant}`);
                }
              }
            } catch (error) {
              // session.started is the only place the resume cursor is recorded.
              emitSessionStarted();
              throw error;
            }
            emitSessionStarted();
            const halves = promptHalves(turn);
            let promptInput = promptTurn;
            if (halves.stable !== null) {
              const receiptKey = JSON.stringify([threadId, sessionId]);
              const previousReceipt = readPromptSplitReceipt(DRIVER_KIND, receiptKey);
              state.usagePeak = previousReceipt?.peakUsed ?? previousReceipt?.lastUsed ?? null;
              const composed = splitSessionPrompt(
                halves.stable,
                halves.volatile,
                previousReceipt,
                promptTurn.system,
                promptTurn.text,
                Boolean(turn.mentionTurn),
                ACP_PROMPT_RE_ANCHOR_TURNS,
              );
              promptInput = { ...promptTurn, system: "", text: composed.text };
              pendingSplitReceipt = { key: receiptKey, receipt: composed.receipt, previous: previousReceipt };
            }
            const text = support.buildPromptText
              ? support.buildPromptText(promptInput)
              : promptInput.system
                ? `${promptInput.system}\n\n${promptInput.text}`
                : promptInput.text;
            const imageBlocks = support.images === true && runtimeAcceptsImages
              ? await readAcpImageBlocks(turn.images ?? [])
              : [];
            if (support.modelVariants && !modelControls.confirms(cliTurn.model)) {
              throw new Error(`${support.displayName} changed model before the prompt`);
            }
            if (variant !== undefined && requestedVariantOption().currentValue !== variant) {
              throw new Error(`${support.displayName} changed variant before the prompt`);
            }
            if (state.settled || state.stopped || session.closing) throw new Error("turn stopped");
            state.promptSent = true;
            if (!support.promptUnreachedModel) acknowledge();
            const promptIdleMs = promptIdleTimeoutMs();
            const quiet = startQuietWatch(threadId, session, current);
            const result = await request(
              "session/prompt",
              { sessionId, prompt: [{ type: "text", text }, ...imageBlocks] },
              undefined,
              undefined,
              promptIdleMs,
              () => {
                const last = quiet.lastState();
                return `${support.displayName} sent nothing for ${formatQuietLimit(promptIdleMs)} with no tool running, so the turn was stopped as stuck` +
                  `${last ? ` (last seen: ${lastSeenPhrase(last)})` : ""}. Send the message again to retry.`;
              },
              );
            const steersOut = current.steering?.promptAnswered();
            if (steersOut && !state.stopped) { current.flushAssistantText(); await steersOut; }
            if (pendingSplitReceipt) {
              // session/prompt resolving is the acceptance boundary: a rejected prompt leaves no receipt.
              if (state.usageCompacted) {
                deletePromptSplitReceipt(DRIVER_KIND, pendingSplitReceipt.key);
              } else {
                const previousLastUsed = typeof pendingSplitReceipt.previous?.lastUsed === "number"
                  ? pendingSplitReceipt.previous.lastUsed
                  : undefined;
                const lastUsed = state.usageLast ?? previousLastUsed;
                writePromptSplitReceipt(
                  DRIVER_KIND,
                  pendingSplitReceipt.key,
                  {
                    ...pendingSplitReceipt.receipt,
                    ...(lastUsed === undefined ? {} : { lastUsed }),
                    ...(state.usagePeak === null ? {} : { peakUsed: state.usagePeak }),
                  },
                );
              }
            }
            // opencode 1.18.18 reports usage at the result root; grok and gemini under _meta.
            const usage = result?.usage ?? result?._meta ?? {};
            if (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number") {
              // opencode 1.18.25 keeps only the uncached share in inputTokens and reports cache reads beside it (omitted when 0); other agents count them inside. Absent is not zero.
              const input = usage.inputTokens ?? 0;
              const output = usage.outputTokens ?? 0;
              if (typeof usage.outputTokens === "number") state.outputTokens = usage.outputTokens;
              const cachedRead = typeof usage.cachedReadTokens === "number" && usage.cachedReadTokens > 0
                ? usage.cachedReadTokens
                : null;
              const exclusive = cachedRead !== null
                && (typeof usage.totalTokens !== "number"
                  || usage.totalTokens >= input + output + cachedRead);
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: cachedRead !== null && exclusive ? input + cachedRead : input,
                output,
                ...(cachedRead !== null
                  ? { cachedInput: exclusive ? cachedRead : Math.min(cachedRead, input) }
                  : {}),
              });
            }
            const reason = result?.stopReason;
            const drained = reason === "end_turn" ? await drainRunningTools(current) : true;
            if (reason === "end_turn" && !drained && !state.settled && !state.stopped) {
              emit({ ...base(threadId, turnId), type: "runtime.notice",
                message: `${support.displayName} ended its turn while a command was still running; that command's output is not in this turn.` });
            }
            if (reason === "end_turn") settle(threadId, session, true, null);
            else if (reason === "cancelled" || state.stopped) settle(threadId, session, true, "cancelled");
            else {
              emit({
                ...base(threadId, turnId),
                type: "runtime.error",
                ...acpStopFailure(result, support.displayName),
              });
              settle(threadId, session, false, reason ?? "failed");
            }
          } catch (e) {
            if (pendingSplitReceipt && state.promptSent && state.usageCompacted) {
              deletePromptSplitReceipt(DRIVER_KIND, pendingSplitReceipt.key);
            }
            if (!state.settled && !state.cancelling) {
              const untouched = retryOf === undefined && !state.producedItem && !state.text && !current.runningTools.size && !asks.size && !state.stopped && !session.closing;
              if (untouched && retryUnderToolLimit(e, { key: toolLimitKey, model: resolvedModel, engine: DRIVER_KIND, retry: () => {
                acknowledge(); state.settled = true; session.current = null; active.delete(threadId); current.stopQuietWatch?.();
                return sendTurn({ ...turn, startupRecovery: undefined, sessionReset: undefined, resumeCursor: session.sessionId ?? turn.resumeCursor }, turnId);
              }, failed: (error) => { acknowledge(); emit({ ...base(threadId, turnId), type: "runtime.error", message: error instanceof Error ? error.message : String(error) });
                emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "rpc_error", cost: null }); } })) return;
              const message = e instanceof Error ? e.message : String(e);
              const code = support.classifyError?.(e) ?? (engineFailureKind(message) === "credits" ? "insufficient_funds" : undefined);
              const needsAuth = code === "invalid_credentials" || code === "inactive_subscription"
                || code === "insufficient_funds" || message === support.loginNote;
              const accountError = isAccountError(code);
              if (turn.startupRecovery && startupFailureRecoverable(e, message, code, { approvalUnconfirmed, promptSent: state.promptSent, promptUnreachedModel: support.promptUnreachedModel?.(e) === true })
                  && !needsAuth && !accountError && !state.startupActivity && !state.producedItem && !state.text
                  && !state.stopped && !session.closing && !asks.size && !current.runningTools.size) {
                // Quiesce first: the close must not publish a completion before the harness recovers.
                state.settled = true;
                session.current = null; current.stopQuietWatch?.();
                if (current.interruptTimer) clearTimeout(current.interruptTimer);
                closeSession(threadId, "startup-recovery");
                const stopped = session.host.links.size > 0 || await killCliTree(session.child).catch(() => false);
                if (current.interruptTimer) clearTimeout(current.interruptTimer);
                active.delete(threadId);
                if (stopped && !state.stopped) {
                  rejectStartup(new TurnNotStartedError(turnId, message));
                  return;
                }
                acknowledge();
                if (!state.stopped) emit({ ...base(threadId, turnId), type: "runtime.error", ...(engineFailure(support.displayName, message) ?? { message }) });
                emit({ ...base(threadId, turnId), type: "turn.completed", ok: state.stopped,
                  stopReason: state.stopped ? "cancelled" : "rpc_error", cost: null });
                return;
              }
              // After the person's Stop, a request the stop cut short is not an error.
              if (!state.stopped) emit({
                ...base(threadId, turnId), type: "runtime.error",
                ...acpRuntimeFailure(e, support.displayName, accountError ? { message: support.describeAccountError?.(code, cliTurn.model), text: support.accountErrorText?.(code) } : undefined),
                ...(needsAuth ? { setup: true } : {}), ...((e as any)?.acpPromptStall === true ? { stalled: true } : {}),
                ...((e as any)?.acpUsageLimit === true || (code === "quota_or_region_restriction" && LIMIT_WORDS.test(message)) ? support.limitFacts?.(message, cliTurn.model) ?? { limit: "engine" as const } : {}), // waited out, or the engine gave up: another AI can carry on
              });
              // Never replay an accepted prompt (it may have run tools); evict before listeners start the next turn.
              if (!needsAuth && !accountError && ((e as any)?.acpPromptStall === true || (e as any)?.acpUsageLimit === true || (e as any)?.acpSessionFailure === true
                  || code === "upstream_outage") && session.child.exitCode === null && !session.closing) {
                closeSession(threadId, (e as any)?.acpPromptStall === true ? "prompt-stall" : "rpc-failure");
              } else if (approvalUnconfirmed && session.child.exitCode === null && !session.closing) {
                closeSession(threadId, "approval-unconfirmed");
              } else if (staleProcess && !state.promptSent && session.child.exitCode === null && !session.closing) {
                closeSession(threadId, "stale-models");
              }
              settle(threadId, session, state.stopped, state.stopped ? "cancelled" : needsAuth ? "auth_required" : (e as any)?.acpUsageLimit === true ? "quota" : "rpc_error");
            }
          }
        })();

        return startupAck ?? { turnId };
      };

      const snapshot = async (): Promise<ProviderSnapshot> => {
        const env = childEnv();
        if (support.snapshot) return support.snapshot(env, config, instanceId);
        const probe = await new Promise<{ version?: string; reason?: string; other?: true }>((resolve) => {
          execCli(config.cli, ["--version"], { timeout: CLI_VERSION_TIMEOUT_MS, env }, (err, stdout, stderr) => {
            if (err) {
              const failure = err as NodeJS.ErrnoException & { killed?: boolean };
              const reason = failure.code === "ENOENT"
                ? `\`${config.cli}\` isn't installed, or isn't on this app's PATH. Install it for the user running OpenMausBot or use Set CLI, then check again.`
                : failure.code === "EACCES" || failure.code === "EPERM"
                  ? `\`${config.cli}\` isn't executable. Check its file permissions, then check again.`
                  : failure.killed && failure.code == null
                    ? `\`${config.cli}\` version check timed out after ${CLI_VERSION_TIMEOUT_MS / 1000} seconds. Check it in a terminal on the server, then try again.`
                    : `\`${config.cli}\` version check failed. Run it with --version on the server to diagnose the installation, then check again.`;
              // Do not echo arbitrary CLI output or its environment into Settings.
              resolve({ reason });
              return;
            }
            const version = versionFromProbe(stdout, stderr);
            resolve(!version ? { reason: `\`${config.cli}\` returned no version. Check the configured executable with --version, then try again.` } : support.cliVersion && !support.cliVersion.test(version) ? { reason: notThisCli(config.cli, support.displayName), other: true } : { version });
          });
        });
        if (!probe.version) return { state: "unavailable", reason: probe.reason, ...(probe.other ? { notEngineCli: true } : {}) };
        return { state: "available", version: probe.version, authenticated: await support.isAuthenticated(env, config, instanceId, instanceEnvNames(input.environment, env)) };
      };

    /** Memory upkeep's one-shot: a fresh process and session, no MCP servers, an empty folder, and
     * every tool, file or permission request refused. */
      const generateMemoryText = async (prompt: string, options: TextGenerationOptions = {}): Promise<string> => {
        if (startupModelRefresh) await startupModelRefresh;
        const turnConfig: AcpConfig = { ...config, fullAuto: false };
        const env = childEnv(turnConfig);
        if (support.requireAuthenticationBeforeSpawn && !(await support.isAuthenticated(env, turnConfig, instanceId, instanceEnvNames(input.environment, env)))) {
          throw new Error(support.loginNote);
        }
        const cwd = mkdtempSync(join(await support.oneShotFolder?.() ?? tmpdir(), "omb-acp-memory-"));
        try {
          const turn = { threadId: `memory-text-${newId()}`, text: prompt, approvalMode: "ask", cwd } as SendTurnInput;
          support.applyTurnEnv?.(env, { fullAuto: false, cwd, threadId: turn.threadId, mcpServers: [] });
          const launch = support.resolveCommand ? await support.resolveCommand(env, turnConfig, instanceId) : { command: turnConfig.cli };
          const spawnEnv = launch.env ?? env;
          return await runAcpOneShot({
            displayName: support.displayName,
            spawn: spawnCli, kill: killCliTree, box: { allowEnv: instanceEnvNames(input.environment, spawnEnv) },
            command: launch.command,
            argv: [...(launch.args ?? []), ...support.spawnArgs(turnConfig, turn)],
            env: spawnEnv,
            cwd,
            prompt,
            defaultModel: catalog.models.default,
            pickAuthMethod: (methods) => support.pickAuthMethod(methods, spawnEnv),
            authRequired: support.authFailure === "fail-request" ? "if-requested" : support.authFailure === "fail",
            loginNote: support.loginNote,
            clientCapabilitiesMeta: support.clientCapabilitiesMeta,
            ...(support.configureSession ? {
              configure: ({ request, sessionId, session }) => support.configureSession!({
                request,
                sessionId,
                env: spawnEnv,
                config: turnConfig,
                turn,
                sessionModels: Array.isArray(session?.models?.availableModels) ? session.models.availableModels : [],
                currentModelId: session?.models?.currentModelId,
                configOptions: Array.isArray(session?.configOptions) ? session.configOptions : [],
                notice: () => undefined,
              }),
            } : {}),
            options,
          });
        } finally {
          // On Windows the engine can hold the folder a moment after exit.
          try { rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
        }
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        displayName: input.displayName,
        ...(support.backgroundText === false ? {} : { generateMemoryText }),
        enabled: input.enabled,
        get models() {
          return catalog.models;
        },
        get modelsUnconfirmed() {
          return catalog.unconfirmed;
        },
        refreshModels: support.resolveModels ? () => refreshModels(true) : undefined,
        ...(startupModelRefresh ? { startupModelRefresh } : {}),
        ...(support.deviceSignIn && deviceSignIn ? deviceAuthInstanceSurface(deviceSignIn, support.deviceSignIn) : {}),
        snapshot,
        adapter: {
          provider: DRIVER_KIND,
          capabilities: {
            sessionModelSwitch: "unsupported",
            agentsMcp: mcpCapable,
            customMcp: mcpCapable,
            computerMcp: mcpCapable,
            composioMcp: mcpCapable,
            browserMcp: mcpCapable,
            dataMcp: mcpCapable, emailMcp: mcpCapable, deviceMcp: mcpCapable,
            images: support.images !== false,
            nativeImageInput: support.images === true,
            effortLevels: support.effortLevels,
            modelVariants: support.modelVariants === true,
            localComputerMcp: mcpCapable,
            contextReading: "meter",
            engineAdmission: true, ...(support.askTool ? { askTool: { kind: "native" as const, name: support.askTool } } : {}),
            ...(support.steer ? { queueing: true } : {}),
          },
          sendTurn,
          interruptTurn: async (threadId) => active.get(threadId)?.interrupt(),
          ...(support.steer ? { steer: async (threadId: string, text: string, images?: readonly TurnImageInput[]) =>
            images?.length ? "refused" as const : await sessions.get(threadId)?.current?.steering?.steer(text) ?? "refused" } : {}),
          respondToRequest: async (threadId, requestId, decision) => {
            const turn = active.get(threadId);
            const finish = turn?.asks.get(requestId);
            if (!finish) return "unavailable";
            return finish(decision.behavior, "user", decision.message, decision.always === true);
          },
          hasSession: (threadId) => active.has(threadId),
          enginePid: (threadId) => (active.has(threadId) ? sessions.get(threadId)?.child.pid : undefined),
          stopAll: async () => {
            for (const { stop } of active.values()) stop();
            for (const threadId of Array.from(sessions.keys())) closeSession(threadId, "stopAll");
            for (const [threadId, children] of retiring) {
              for (const child of children) void retireChild(threadId, child);
            }
          },
          closeIdleSessions: () => {
            let closed = 0;
            for (const [threadId, session] of Array.from(sessions)) {
              if (session.closing || session.dead) continue;
              if (session.current) {
                session.retireAfterTurn = true;
                continue;
              }
              closeSession(threadId, "idle");
              closed += 1;
            }
            return closed;
          },
          onEvent: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        dispose: async () => {
          disposing = true;
          await deviceSignIn?.dispose();
          const disposingSessions = Array.from(sessions);
          for (const { stop } of active.values()) stop();
          for (const [threadId, session] of disposingSessions) {
            closeSession(threadId, "dispose");
            settle(threadId, session, true, "cancelled");
          }
          for (const [threadId, children] of retiring) {
            for (const child of children) void retireChild(threadId, child);
          }
          listeners.clear();
        },
      };
    },
  };
}
