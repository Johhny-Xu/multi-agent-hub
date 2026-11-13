// Google Antigravity through its official ACP server: managed runtime, isolated Google profile,
// model/mode configuration and OAuth.
import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { antigravityAccount } from "./antigravity-account.ts";
import {
  newEventId,
  type DriverCreateInput,
  type ModelCatalog,
  type ProviderAdapter,
  type ProviderDriver,
  type ProviderInstance,
  type ProviderSnapshot,
  type SendTurnInput,
} from "../contracts.ts";
import type { RuntimeEvent, RuntimeEventListener } from "../../shared/runtime-events.ts";
import { DATA_DIR } from "../config.ts";
import { noticeFailure } from "../chat-notices.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./acp/core.ts";
import {
  AntigravityAuthController,
  antigravityProfileAuthenticated,
  prepareAntigravityProfile,
  probeAntigravityModels,
  isAddedAntigravityAccount,
  antigravityProfileDirectory,
  removeAntigravitySignIn,
  validateAntigravityRuntime,
} from "./antigravity-acp.ts";
import {
  antigravityManagedInstallAvailable,
  installAntigravityRuntime,
  resolveAntigravityRuntime,
} from "./antigravity-runtime.ts";
import { resolveAntigravityReleaseAsset } from "./antigravity-release.ts";
import { VERIFICATION_TEMP_KEY, scheduleAntigravityTempSweep } from "./antigravity-temp.ts";
import { augmentedPath } from "../env-path.ts";
import { AntigravityCliLoginController } from "./antigravity-cli-login.ts";
import {
  AntigravityBackendBook,
  ServedModelTracker,
  allAntigravityConversationDirs,
  antigravityConversationDirs,
  catalogWithBackendModels,
  type ServedModelReport,
} from "./antigravity-backend-model.ts";
import { bundledEngineCatalog } from "../model-manifest/bundled.ts";
import { currentEngineCatalog } from "../model-manifest/manifest.ts";

export const STATIC_ANTIGRAVITY_MODELS: ModelCatalog = bundledEngineCatalog("antigravity");

/** Bots saved before the thinking-level option hold ids like `gemini-3.8-flash-medium` or `gemini-4-argon-high`;
 * the official runtime offers only the base model with that option, so run the base at the saved level. A runtime
 * that still offers the suffixed id, or lacks the base, or a turn that chose its own level, keeps its selection. */
export function normalizeAntigravityTurn(turn: SendTurnInput, offeredModels: readonly string[]): SendTurnInput {
  if (turn.variant !== undefined) return turn;
  const match = turn.model?.match(/^(.+)-(low|medium|high)$/u);
  return match && offeredModels.includes(match[1]) && !offeredModels.includes(match[0])
    ? { ...turn, model: match[1], variant: match[2] }
    : turn;
}

/** Antigravity's session modes: `yolo` for Full, `auto_edit` for auto-accept edits, `default` otherwise (it has no reviewer for Auto).
 * The agy CLI from 1.5 renamed them: it offers `default`, `accept-edits` and `plan`, and Full is the
 * `--dangerously-skip-permissions` launch flag instead of a mode. Pass the offered values to get the one this runtime takes;
 * `null` means Full is carried by that flag and no mode is set. */
export function antigravityPermissionMode(fullAuto: boolean, approvalMode?: ApprovalMode): "yolo" | "auto_edit" | "default";
export function antigravityPermissionMode(fullAuto: boolean, approvalMode: ApprovalMode | undefined, offered: readonly string[]): string | null;
export function antigravityPermissionMode(fullAuto: boolean, approvalMode?: ApprovalMode, offered?: readonly string[]): string | null {
  const full = fullAuto || approvalMode === "full";
  if (!offered) {
    if (full) return "yolo";
    return approvalMode === "edits" ? "auto_edit" : "default";
  }
  if (full) return offered.includes("yolo") ? "yolo" : null;
  if (approvalMode === "edits") return ["accept-edits", "auto_edit"].find((mode) => offered.includes(mode)) ?? "default";
  return "default";
}

/** Full access on an agy CLI is a launch flag (1.5+ dropped the yolo session mode). */
export const ANTIGRAVITY_SKIP_PERMISSIONS_FLAG = "--dangerously-skip-permissions";

const managedAsset = resolveAntigravityReleaseAsset();

const support: AcpSupport = {
  driverKind: "antigravityAgent",
  // Named for what people look for: Google moved personal Gemini subscriptions (free, AI Pro, AI Ultra) from Gemini CLI to Antigravity on 2026-06-18.
  displayName: "Google Gemini (Antigravity)",
  get models() { return currentEngineCatalog("antigravity"); },
  defaultCli: "agy", // migration alias: resolveAntigravityRuntime treats it as managed
  nativeSource: "antigravity.acp",
  loginNote: "Antigravity needs a Google account — choose Sign in with Google in engine setup",
  install: {
    docsUrl: "https://github.com/agentclientprotocol/registry/tree/main/antigravity-acp",
    ...(managedAsset
      ? { managed: { label: "Install official Antigravity", downloadBytes: managedAsset.archiveBytes } }
      : {}),
  },
  images: true,
  spawnArgs: () => [],
  selectModel: { configId: "model" },
  modelVariants: true,
  normalizeSessionSelection: normalizeAntigravityTurn,
  // Google's server reads its new-session default from this variable (agy_acp_server 1.4.3
  // model_selection.get_default_model_id); a later switch re-fetches the model list (1.3-1.8 s).
  sessionModelEnv: "AGY_ACP_DEFAULT_MODEL",
  sessionScopedApproval: true,
  resumeMethod: "resume",
  clientFileSystem: true,
  sanitizeToolPayload: true,

  resolveCommand: async (env, config, instanceId) => {
    const runtime = await resolveAntigravityRuntime(config.cli, env);
    const profile = await prepareAntigravityProfile({ instanceId, runtime, baseEnv: env });
    if (profile.tempDirectory) scheduleAntigravityTempSweep(instanceId);
    return {
      command: runtime.executablePath,
      // The agy CLI takes Full as a flag on `acp`; the packaged ACP server keeps its yolo session mode.
      args: runtime.kind === "cli" && config.fullAuto
        ? [...runtime.spawnArgs, ANTIGRAVITY_SKIP_PERMISSIONS_FLAG]
        : runtime.spawnArgs,
      env: profile.environment,
    };
  },

  resolveModels: async (env, config, instanceId) => {
    const runtime = await resolveAntigravityRuntime(config.cli, env);
    const profile = await prepareAntigravityProfile({ instanceId, runtime, baseEnv: env });
    if (!(await antigravityProfileAuthenticated(profile))) throw new Error(support.loginNote);
    return probeAntigravityModels({
      runtime,
      profile,
      fallbackDefault: currentEngineCatalog("antigravity").default,
    });
  },

  pickAuthMethod: (methods) => methods.some((method) => method.id === "oauth-personal")
    ? "oauth-personal"
    : null,
  authFailure: "fail",
  requireAuthenticationBeforeSpawn: true,
  isAuthenticated: async (env, config, instanceId) => {
    try {
      const runtime = await resolveAntigravityRuntime(config.cli, env);
      const profile = await prepareAntigravityProfile({ instanceId, runtime, baseEnv: env });
      return antigravityProfileAuthenticated(profile);
    } catch {
      return false;
    }
  },
  snapshot: async (env, config, instanceId): Promise<ProviderSnapshot> => {
    try {
      const runtime = await resolveAntigravityRuntime(config.cli, env);
      const profile = await prepareAntigravityProfile({ instanceId, runtime, baseEnv: env });
      return {
        state: "available",
        version: runtime.version,
        authenticated: await antigravityProfileAuthenticated(profile),
        account: await antigravityAccount(profile.tokenPath),
      };
    } catch (error) {
      return { state: "unavailable", reason: error instanceof Error ? error.message : String(error) };
    }
  },

  configureSession: async ({ request, sessionId, config, turn, configOptions }) => {
    if (!Array.isArray(configOptions) || !configOptions.some(option => option?.id === "mode")) {
      return;
    }
    const modeOption = configOptions.find((option) => option?.id === "mode") as
      | ({ id?: unknown; currentValue?: unknown } & { options?: unknown })
      | undefined;
    const rawOffered = modeOption?.options;
    const offered: string[] = Array.isArray(rawOffered)
      ? (rawOffered as Array<{ value?: unknown }>).flatMap((option) => typeof option?.value === "string" ? [option.value] : [])
      : [];
    const wanted = antigravityPermissionMode(config.fullAuto, turn.approvalMode, offered);
    // Full on an agy CLI rides the launch flag; its session stays in the mode it opened in.
    if (wanted === null) return;
    const result = await request("session/set_config_option", {
      sessionId,
      configId: "mode",
      value: wanted,
    });
    const mode = Array.isArray(result?.configOptions)
      ? result.configOptions.find((option: any) => option?.id === "mode")?.currentValue
      : undefined;
    if (mode !== wanted) throw new Error(`Antigravity did not apply ${wanted} permission mode.`);
  },
};

const AcpAntigravityDriver = createAcpDriver(support);

/** Backend ids learned from finished generations, shared by every Antigravity account (one Google backend). */
export const antigravityBackendBook = new AntigravityBackendBook();
let backendScan: Promise<unknown> | undefined;
function learnBackendModelsOnce(): void {
  backendScan ??= antigravityBackendBook.scan(allAntigravityConversationDirs(DATA_DIR), 400).catch(() => 0);
}

/** Where this instance's agy process keeps its conversations (see prepareAntigravityProfile for the HOME rules). */
export function instanceConversationDirs(instanceId: string, environment: Record<string, string | undefined>, baseDir = DATA_DIR): string[] {
  const profile = antigravityProfileDirectory(instanceId, baseDir);
  const added = isAddedAntigravityAccount(instanceId);
  const home = added ? join(profile, "home") : environment.HOME?.trim() || process.env.HOME?.trim() || homedir();
  return [
    ...antigravityConversationDirs({ HOME: home, GEMINI_HOME: added ? join(home, ".gemini") : environment.GEMINI_HOME || process.env.GEMINI_HOME }),
    join(profile, "antigravity-cli", "conversations"),
    join(profile, "conversations"),
  ];
}

/** The per-turn chat line: which backend model answered, flagged when it is not the one the turn asked for. */
export function servedModelNotice(report: ServedModelReport): { message: string; text: NonNullable<Extract<RuntimeEvent, { type: "runtime.notice" }>["text"]> } {
  const served = report.served.join(", ");
  const label = report.label ?? served;
  return report.mismatch && report.requested
    ? noticeFailure("chat.notice.antigravityServedModelMismatch", { requested: report.requested, served, label })
    : noticeFailure("chat.notice.antigravityServedModel", { served, label });
}

const LATE_READS_MS = [500, 2_000, 5_000];

/**
 * Adds the backend id to each finished turn (`servedModel` on turn.completed, plus a chat notice only when it differs
 * from the model the turn asked for) and to each catalog
 * model the backend has been seen serving. Reads only agy's local conversation database: no sign-in, quota or switch.
 */
export function withServedModels(
  base: Pick<ProviderInstance, "adapter" | "driverKind" | "instanceId">,
  tracker: ServedModelTracker,
  schedule: (run: () => void, ms: number) => void = (run, ms) => { setTimeout(run, ms).unref?.(); },
): ProviderAdapter {
  const listeners = new Set<RuntimeEventListener>();
  const shownFor = new Map<string, RuntimeEvent[]>();
  const notice = (completed: RuntimeEvent, report: ServedModelReport): RuntimeEvent => ({
    eventId: newEventId(),
    provider: completed.provider,
    ...(completed.providerInstanceId ? { providerInstanceId: completed.providerInstanceId } : {}),
    threadId: completed.threadId,
    turnId: completed.turnId,
    createdAt: new Date().toISOString(),
    type: "runtime.notice",
    ...servedModelNotice(report),
  });
  // agy may still be writing the last generation when the turn ends: look again a few times, then let it go.
  const readLate = (completed: RuntimeEvent, attempt = 0) => {
    const turnId = completed.turnId!;
    if (attempt >= LATE_READS_MS.length) return tracker.forget(turnId);
    schedule(() => {
      let report: ServedModelReport | null = null;
      try { report = tracker.report(turnId); } catch { /* unreadable this time */ }
      if (!report) return readLate(completed, attempt + 1);
      if (!report.mismatch) return;
      const line = notice(completed, report);
      for (const listener of listeners) listener(line);
    }, LATE_READS_MS[attempt]!);
  };
  const present = (event: RuntimeEvent): RuntimeEvent[] => {
    if (event.type !== "session.started" && event.type !== "turn.completed") return [event];
    const seen = shownFor.get(event.eventId);
    if (seen) return seen;
    let shown: RuntimeEvent[] = [event];
    try {
      if (event.type === "session.started" && event.turnId) {
        tracker.started(event.turnId, event.sessionId, event.model);
      } else if (event.type === "turn.completed" && event.turnId && tracker.watching(event.turnId)) {
        const report = tracker.report(event.turnId);
        // servedModel always rides on the event; the chat line only appears when the backend did not serve what was asked.
        if (report) shown = [...(report.mismatch ? [notice(event, report)] : []), { ...event, servedModel: report.served[report.served.length - 1]! }];
        else if (event.ok) readLate(event);
        else tracker.forget(event.turnId);
      }
    } catch { /* the report is extra: never let it break the turn's own events */ }
    shownFor.set(event.eventId, shown);
    if (shownFor.size > 400) shownFor.delete(shownFor.keys().next().value!);
    return shown;
  };
  return {
    ...base.adapter,
    onEvent: (listener) => {
      listeners.add(listener);
      const off = base.adapter.onEvent((item) => { for (const shown of present(item)) listener(shown); });
      return () => { listeners.delete(listener); off(); };
    },
  };
}

export const AntigravityDriver: ProviderDriver<AcpConfig> = {
  ...AcpAntigravityDriver,
  async create(input: DriverCreateInput<AcpConfig>): Promise<ProviderInstance> {
    const base = await AcpAntigravityDriver.create(input);
    learnBackendModelsOnce();
    const withBackend = catalogWithBackendModels();
    const tracker = new ServedModelTracker({
      dirs: () => instanceConversationDirs(input.instanceId, input.environment),
      book: antigravityBackendBook,
      catalog: () => base.models,
    });
    const adapter = withServedModels(base, tracker);
    scheduleAntigravityTempSweep(input.instanceId);
    scheduleAntigravityTempSweep(VERIFICATION_TEMP_KEY);
    const auth = new AntigravityAuthController(() => void base.refreshModels?.());
    // An added agy CLI account signs in with `agy acp --login` in its own HOME (see prepareAntigravityProfile).
    const cliLogin = new AntigravityCliLoginController(() => void base.refreshModels?.());
    let cliLoginActive = false;
    let installFailure: string | undefined;
    const runtimeAndProfile = async () => {
      // A GUI launch's raw PATH may omit the official runtime the model picker found.
      const environment = { ...process.env, ...input.environment, PATH: augmentedPath() };
      const runtime = await resolveAntigravityRuntime(input.config.cli, environment);
      const profile = await prepareAntigravityProfile({
        instanceId: input.instanceId,
        runtime,
        baseEnv: environment,
      });
      return { runtime, profile };
    };
    return {
      ...base,
      adapter,
      get models() {
        return withBackend(base.models, antigravityBackendBook);
      },
      get modelsUnconfirmed() {
        return base.modelsUnconfirmed;
      },
      snapshot: async () => {
        const snapshot = await base.snapshot();
        if (snapshot.state === "available") installFailure = undefined;
        return snapshot.state === "unavailable" && installFailure
          ? { ...snapshot, reason: installFailure }
          : snapshot;
      },
      ...(antigravityManagedInstallAvailable()
        ? {
            installRuntime: async () => {
              installFailure = undefined;
              try {
                await installAntigravityRuntime({ validate: validateAntigravityRuntime });
              } catch (error) {
                installFailure = error instanceof Error ? error.message : String(error);
                throw error;
              }
            },
          }
        : {}),
      startAuthentication: async () => {
        const { runtime, profile } = await runtimeAndProfile();
        auth.cancel();
        cliLogin.cancel();
        cliLoginActive = runtime.kind === "cli" && isAddedAntigravityAccount(input.instanceId);
        return cliLoginActive ? cliLogin.start(runtime, profile) : auth.start(runtime, profile);
      },
      completeAuthentication: async (flowId, callbackUrl) => cliLoginActive
        ? cliLogin.complete(flowId, callbackUrl)
        : auth.complete(flowId, callbackUrl),
      cancelAuthentication: async () => {
        auth.cancel();
        cliLogin.cancel();
      },
      signOut: async () => {
        auth.cancel();
        cliLogin.cancel();
        await removeAntigravitySignIn(input.instanceId);
      },
      dispose: async () => {
        auth.cancel();
        cliLogin.cancel();
        await base.dispose();
      },
    };
  },
};
