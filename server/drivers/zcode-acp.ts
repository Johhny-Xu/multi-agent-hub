#!/usr/bin/env node
// ACP bridge for ZCode, whose CLI speaks the official ZCode Protocol (`zcode app-server`, NDJSON
// over stdio) instead of ACP. OpenMausBot's shared ACP driver owns the client side; this process is
// the ACP *agent* it spawns and translates each ACP session into one ZCode app-server session.
//
// The protocol shape follows agenthub's verified `drivers/zcode_rpc.mjs` adapter: create with an
// explicit model and thinking level, subscribe before sending, poll `session/events` for the
// terminal turn event, and never resend a task whose transport outcome is unknown. Unlike that
// one-task adapter this bridge keeps the native session alive across prompts, so a bot thread keeps
// its context. ZCode's own sign-in stays with the CLI. The keys deployed in OpenMausBot's settings
// replace ZCode's own BYOK store there. The desktop app's coding-plan key is handed to the CLI only
// when OMB_ZCODE_PLAN_KEY_FALLBACK=1: policy (2026-11-09) runs zcode on the account's own Start Plan
// and forbids the coding-plan key by default. Neither kind of key is logged or sent anywhere else.
//
// The account's own Start Plan follows the desktop host's protocol (CLI 0.17.x): a spawned
// app-server keeps every `zhipu-account` provider fail-closed until its client pushes an
// entitlement snapshot (`provider/updateAccountConfig`), and asks the client for
// `interaction/requestProviderRuntimeHeaders` before each model attempt on one. This bridge
// mirrors both, answering with the account's own JWT read from the CLI's credential store; that
// value only ever travels to the app server's stdin and is never logged or sent anywhere else.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createDecipheriv, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type { ModelCatalog, ModelVariantOption } from "../contracts.ts";

const DEFAULT_IDLE_TIMEOUT_SEC = 900;
/** How long a finished turn's app server may sit idle before the bridge recycles it. Every idle
 * one holds the CLI's whole footprint (~0.5 GB) and several concurrent threads exhaust the host
 * (E52); a prompt inside the window reuses the process instead. */
const DEFAULT_RECYCLE_IDLE_SEC = 120;
const DEFAULT_EVENT_POLL_TIMEOUT_MS = 30_000;
const HEARTBEAT_MS = 20_000;
const REPLY_CHUNK = 4_000;
const TURN_POLL_MS = 300;
const STARTUP_TIMEOUT_MS = 60_000;

/** How long one `session/events` poll may take before the turn treats it as a transient failure.
 * The bridge's own knob: the default is the vendor's client timeout, and a test shortens it to
 * exercise the retry path without waiting a whole poll window. */
function eventPollTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = Number(env.OMB_ZCODE_EVENT_POLL_TIMEOUT_MS ?? "");
  if (!Number.isFinite(raw) || raw < 50) return DEFAULT_EVENT_POLL_TIMEOUT_MS;
  return Math.min(raw, 300_000);
}

/** The first backoff before a turn the plan's concurrency cap refused is resent in the same native
 * session (E64); each retry doubles it. Node clamps an out-of-range setTimeout delay to 1 ms,
 * which would retry in a tight loop, so the override has a 10 ms floor and a 5-minute ceiling. */
function zcodeConcurrencyRetryMs(env: Record<string, string | undefined>): number {
  const raw = Number(env.OMB_ZCODE_CONCURRENCY_RETRY_MS ?? "");
  if (!Number.isFinite(raw) || raw < 10) return 20_000;
  return Math.min(raw, 300_000);
}

/** How many times a concurrency-limited turn may be resent (E64). */
function zcodeConcurrencyRetries(env: Record<string, string | undefined>): number {
  const text = env.OMB_ZCODE_CONCURRENCY_RETRIES?.trim();
  const raw = text ? Number(text) : NaN;
  if (!Number.isInteger(raw) || raw < 0) return 3;
  return raw;
}

/** The recycle quiet period, overridable with OMB_ZCODE_RECYCLE_IDLE_SEC (seconds). Node resets an
 * out-of-range setTimeout delay to 1 ms, which would tear a just-finished app server down at once,
 * so the override is capped at a day. */
export function zcodeRecycleIdleMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.OMB_ZCODE_RECYCLE_IDLE_SEC ?? "");
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_RECYCLE_IDLE_SEC * 1_000;
  return Math.min(raw, 86_400) * 1_000;
}

/** The ZCode plan's model ids, most preferred first. A plan-enabled account lists them beside the
 * personal providers; the picker then opens on Flash instead of whatever the app-server last used. */
const PLAN_MODEL_IDS = ["GLM-5.3-Flash", "GLM-5.3"];

/** The account's own Start Plan providers, most preferred first. The spawned CLI's builtin config
 * declares the `account:*` providers, but the app server starts them fail-closed and only lists
 * one once this bridge pushes its entitlement (pushAccountProviders); `builtin:bigmodel-start-plan`
 * is the desktop-era id the CLI still migrates model refs from. */
const START_PLAN_PROVIDER_IDS = ["account:bigmodel-start-plan", "builtin:bigmodel-start-plan"];

function bareModelId(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}

/** Whether a catalog entry's provider is the account's own Start Plan. */
export function isZcodeStartPlanProvider(providerId: string | undefined): boolean {
  return typeof providerId === "string"
    && START_PLAN_PROVIDER_IDS.some((wanted) => wanted.toLowerCase() === providerId.toLowerCase());
}

/** Stable reorder putting each model's Start Plan entry ahead of the same model on other providers
 * (the injected coding-plan key). The account's Start Plan must serve GLM whenever the CLI lists
 * it; the injected provider only backs models the account does not offer. Groups keep the order in
 * which their bare model id first appears. */
export function preferZcodeStartPlanModels<T extends { modelId?: string; providerId?: string }>(models: T[]): T[] {
  const groupOf = new Map<string, number>();
  return models
    .map((model, index) => {
      const bare = bareModelId(model.modelId ?? "").toLowerCase();
      if (!groupOf.has(bare)) groupOf.set(bare, groupOf.size);
      return { model, index, group: groupOf.get(bare)! };
    })
    .sort((a, b) => a.group - b.group
      || Number(isZcodeStartPlanProvider(b.model.providerId)) - Number(isZcodeStartPlanProvider(a.model.providerId))
      || a.index - b.index)
    .map(({ model }) => model);
}

/** What the app server asks the client once at startup; the same conservative values agenthub uses. */
const RUNTIME_PREFERENCES = {
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: false,
  modelContextBudgetStrategy: "preflight-v1",
};

class ZcodeRpcError extends Error {
  readonly code: string;
  readonly detail: unknown;
  constructor(code: string, detail?: unknown) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

/** A native session the app server no longer holds. Deferred sessions are dropped when a turn is
 * abandoned, so a retry must open a new one instead of reusing the dead id. */
export function isStaleZcodeSessionError(error: unknown): boolean {
  const detail = (error as { detail?: unknown } | undefined)?.detail;
  const detailMessage = detail && typeof detail === "object" ? (detail as { message?: unknown }).message : undefined;
  const text = [
    error instanceof Error ? error.message : String(error ?? ""),
    typeof detailMessage === "string" ? detailMessage : "",
  ].join(" ");
  return /session(?: is)? not (?:active|resident)|sessionNotFound|session_not_found|no such session|session (?:does not exist|no longer exists)/i.test(text);
}

/** Whether a failed `session/events` poll is a transient condition the turn may retry. A poll that
 * timed out — ours or the app server's — says nothing about the turn itself: the app server can
 * be busy and still answer the next poll. A stale session, a cancelled turn and a dead app server
 * are final, so they keep failing the turn at once. */
export function isTransientPollError(error: unknown): boolean {
  if (!error) return false;
  if (isStaleZcodeSessionError(error)) return false;
  const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "";
  if (code === "RPC_TIMEOUT") return true;
  // Only an RPC-level failure can be transient; the app server's lifecycle failures are final.
  if (code && !code.startsWith("RPC_")) return false;
  const detail = (error as { detail?: unknown } | undefined)?.detail;
  const detailMessage = detail && typeof detail === "object" ? (detail as { message?: unknown }).message : undefined;
  const text = [
    error instanceof Error ? error.message : String(error ?? ""),
    typeof detailMessage === "string" ? detailMessage : "",
  ].join(" ");
  if (/\bRPC_TIMEOUT\b/.test(text)) return true;
  return /\btimed?\s*out\b|\btimeout\b|\btemporar(?:y|ily)\b|\boverloaded\b|\brate limit\b|\btoo many requests\b|\bconnection reset\b|\bsocket hang up\b|\bECONNRESET\b|\bETIMEDOUT\b|\bEAGAIN\b/i.test(text);
}

/** The app server refused a send because this native session still runs an earlier prompt
 * ("session/send rejected: active prompt exists"). That turn is the work the caller wants: an
 * earlier bridge prompt that ended on a client-side error (an RPC timeout under load) left it
 * running, and OpenMausBot's automatic retry of the same request lands here. (E18) */
export function isActivePromptError(error: unknown): boolean {
  const detail = (error as { detail?: unknown } | undefined)?.detail;
  const detailMessage = detail && typeof detail === "object" ? (detail as { message?: unknown }).message : undefined;
  const text = [
    error instanceof Error ? error.message : String(error ?? ""),
    typeof detailMessage === "string" ? detailMessage : "",
  ].join(" ");
  return /active prompt exists|prompt (?:is )?already (?:active|running)|activePromptExists/i.test(text);
}

/** A safe, coarse reason for an RPC rejection: enough to tell a dead session from a provider
 * refusal, and never carrying the vendor error text, which can embed request or account detail. */
export function classifyZcodeRpcRejection(error: unknown): string {
  const detail = (error as { detail?: unknown } | undefined)?.detail;
  const readableReason = detail && typeof detail === "object" ? (detail as { readableReason?: unknown }).readableReason : undefined;
  if (typeof readableReason === "string" && readableReason.trim()) return readableReason;
  const detailMessage = detail && typeof detail === "object" ? (detail as { message?: unknown }).message : undefined;
  const detailCode = detail && typeof detail === "object" ? (detail as { code?: unknown }).code : undefined;
  const text = [
    error instanceof Error ? error.message : String(error ?? ""),
    typeof detailMessage === "string" ? detailMessage : "",
    typeof detailCode === "string" ? detailCode : "",
  ].join(" ");
  if (!text.trim()) return "";
  if (isStaleZcodeSessionError(error)) return "the native session expired";
  if (/Provider Registry|MODEL_UNAVAILABLE|MODEL_AMBIGUOUS|ModelNotFound|model-not-found|blocked_model/i.test(text)) return "the model or provider is unavailable";
  if (/quota|credit|usage limit|entitlement|unusual activity|insufficient/i.test(text)) return "the provider plan or quota refused the request";
  if (/permission|denied|forbidden|unauthorized|invalid request/i.test(text)) return "rejected by permissions or authentication";
  if (/ZodError|not supported|unsupported/i.test(text)) return "the request was rejected as invalid";
  if (isZcodeConcurrencyRejection(error)) return "the plan's concurrency limit was hit (429); try again shortly";
  if (/\b1005\b|exceed(?:ed)? (?:the )?quota|quota (?:limit|exceeded)/i.test(nestedZcodeErrorText(error))) {
    return "the plan's quota is used up (1005)";
  }
  return "rejected by the app server";
}

/** Every string and number in an error object, however it is nested: the vendor buries its
 * plan-quota business code inside turn.failed's error object (CLI 0.16.9 nests it as
 * error.cause.context.providerCode), past the flat message checks above. Depth ≤ 4 and a visited
 * set keep the walk bounded and cycle-safe. */
function nestedZcodeErrorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > 4 || !value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const entry of Object.values(value)) {
      if (typeof entry === "string" || typeof entry === "number") parts.push(String(entry));
      else walk(entry, depth + 1);
    }
  };
  walk(error, 0);
  return parts.join(" ");
}

/** The vendor's signals that a turn was refused by the plan's per-account concurrency cap (E64):
 * the nested status wording, or a 429 beside any concurrency wording. */
function isZcodeConcurrencyRejection(error: unknown): boolean {
  const nested = nestedZcodeErrorText(error);
  if (/concurrency limit|too many concurrent|concurrent (?:request|session)s? (?:limit|exceeded)/i.test(nested)) return true;
  return /\b429\b/.test(nested) && /concurren/i.test(nested);
}

/** The vendor's wire signal that a turn died on the output-token cap: after its three output
 * continuations come back empty, the CLI fails the turn with model_error "The model's response
 * exceeded the output token maximum." and attribution.reason `model_output_limit_exceeded`
 * (CLI 0.16.9). The turn.failed payload carries this inside `error`, not as a top-level code. */
function zcodeTurnHitOutputLimit(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const attribution = record.attribution as Record<string, unknown> | undefined;
  if (attribution?.reason === "model_output_limit_exceeded" || attribution?.providerErrorCode === "model_output_limit_exceeded") return true;
  return typeof record.message === "string" && /exceeded the output token maximum/i.test(record.message);
}

/** The reason shown for an output-cap failure. The limit is named only when the turn ran on a
 * deployed-key provider, whose cap this bridge set itself. */
function zcodeOutputLimitReason(limit: number | undefined): string {
  return typeof limit === "number"
    ? `模型输出被截断:思考超过输出上限 ${limit} tokens(stop: length)`
    : "模型输出被截断:思考超过了单回合的输出上限(stop: length)";
}

interface ZcodeModel {
  pickerId: string;
  providerId: string;
  modelId: string;
  label: string;
  providerLabel?: string;
  contextWindow?: number;
  levels: string[];
  defaultLevel?: string;
}

interface CatalogSnapshot {
  models: ZcodeModel[];
  defaultId?: string;
}

interface BridgeSession {
  id: string;
  cwd: string;
  mode: string;
  mcpServers: unknown[];
  model?: string;
  thoughtLevel?: string;
  app?: ZcodeAppServer;
  storage?: string;
  catalog?: ZcodeModel[];
  defaultModelId?: string;
  zcodeSessionId?: string;
  zcodeSessionModel?: string;
  lastSeq: number;
  busy: boolean;
  cancelled: boolean;
  closed: boolean;
  recycleTimer?: ReturnType<typeof setTimeout>;
}

interface TurnTerminal {
  ok: true;
  /** Text still unsent: empty when the turn already streamed its whole answer. */
  text: string;
  usage?: Record<string, number>;
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

/** Every home the CLI's own login and provider list could live in. Nothing in them is read here. */
function accountHomes(env: Record<string, string | undefined>): string[] {
  const candidates: string[] = [];
  if (env.OMB_ZCODE_HOME) candidates.push(env.OMB_ZCODE_HOME);
  if (env.HOME) candidates.push(env.HOME);
  try {
    candidates.push(userInfo().homedir);
  } catch {
    // No passwd entry: env.HOME is all there is.
  }
  candidates.push(homedir());
  return [...new Set(candidates.filter((home) => home.length > 0))];
}

/** The installed CLI, in the order a person names it: their own path, the environment, then the
 * locations the ZCode desktop app installs the CLI into. */
export function resolveZcodeCli(env: Record<string, string | undefined>, cli?: string): string {
  const explicit = cli?.trim() ?? "";
  if (explicit && (isAbsolute(explicit) || explicit.includes("/") || explicit.includes("\\")) && existsSync(explicit)) {
    return explicit;
  }
  if (env.OMB_ZCODE_CLI && existsSync(env.OMB_ZCODE_CLI)) return env.OMB_ZCODE_CLI;
  for (const home of accountHomes(env)) {
    for (const candidate of [
      join(home, ".zcode", "server", "agents", "glm", "zcode.cjs"),
      join(home, "zcode-app", "opt", "ZCode", "resources", "glm", "zcode.cjs"),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  if (process.platform === "win32" && env.LOCALAPPDATA) {
    const candidate = join(env.LOCALAPPDATA, "Programs", "ZCode", "resources", "glm", "zcode.cjs");
    if (existsSync(candidate)) return candidate;
  }
  return explicit || "zcode";
}

/** Whether a CLI path is a Node script that needs this process's own runtime to execute. */
function isNodeScript(cli: string): boolean {
  return /\.(?:cjs|mjs|js)$/i.test(cli);
}

function launchSpec(cli: string, args: string[]): { command: string; args: string[] } {
  return isNodeScript(cli) ? { command: process.execPath, args: [cli, ...args] } : { command: cli, args };
}

/** The bundled provider definitions the official CLI needs when launched outside the desktop app. */
export function resolveBuiltinProviderConfig(
  env: Record<string, string | undefined>,
  cli: string,
): string | undefined {
  const explicit = env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  if (explicit && existsSync(explicit)) return explicit;
  if (isNodeScript(cli)) {
    const dir = dirname(cli);
    for (const candidate of [
      join(dir, "..", "config", "provider", "zcode-builtin.json"),
      join(dir, "..", "provider", "zcode-builtin.json"),
      join(dir, "..", "..", "config", "provider", "zcode-builtin.json"),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const home of accountHomes(env)) {
    const candidate = join(home, ".zcode", "v2", "runtime", "provider", "bundled", "zcode-builtin.json");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

interface PlanProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

/** Desktop providers that carry GLM plan quota, most useful first. The CLI signs coding-plan calls
 * with an `id.secret` key; the desktop's OAuth-style JWT (two dots) is not one, so it is skipped. */
const PLAN_PROVIDERS: Array<[string, string]> = [
  ["builtin:bigmodel-coding-plan", "BigModel Coding Plan"],
  ["builtin:zai-coding-plan", "Z.ai Coding Plan"],
  ["builtin:bigmodel-start-plan", "BigModel Coding Plan"],
  ["builtin:zai-start-plan", "Z.ai Coding Plan"],
];

function planModelRank(id: string): number {
  const bare = bareModelId(id).toLowerCase();
  const index = PLAN_MODEL_IDS.findIndex((wanted) => wanted.toLowerCase() === bare);
  return index === -1 ? PLAN_MODEL_IDS.length : index;
}

/** OpenMausBot policy (2026-11-09): zcode must run on the account's own Start Plan and must not use
 * a coding-plan key. The desktop's coding-plan key is therefore injected only when the deployment
 * opts in with OMB_ZCODE_PLAN_KEY_FALLBACK=1. */
export function zcodePlanKeyFallbackEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.OMB_ZCODE_PLAN_KEY_FALLBACK === "1";
}

/** The desktop app's GLM plan provider whose key the CLI can sign with, if it has one. A provider
 * the desktop disabled or marked not entitled is skipped even though its key is still stored: the
 * desktop keeps the key after the entitlement lapses, but the provider is unavailable there and
 * must not be used here either. */
export function planProviderFromConfig(config: any): PlanProvider | undefined {
  const providers = config?.provider;
  if (!providers || typeof providers !== "object") return undefined;
  for (const [id, fallbackName] of PLAN_PROVIDERS) {
    const entry = (providers as Record<string, any>)[id];
    if (!entry || entry.enabled === false || entry.systemDisabledReason) continue;
    const apiKey = entry?.options?.apiKey;
    const baseUrl = entry?.options?.baseURL;
    if (typeof apiKey !== "string" || apiKey.split(".").length !== 2) continue;
    if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) continue;
    const declared = Object.keys(entry.models ?? {}).filter((model) => /^GLM-/i.test(model));
    return {
      name: typeof entry.name === "string" && entry.name ? entry.name : fallbackName,
      baseUrl,
      apiKey,
      models: (declared.length ? declared : [...PLAN_MODEL_IDS]).sort((a, b) => planModelRank(a) - planModelRank(b) || a.localeCompare(b)),
    };
  }
  return undefined;
}

/** The user's provider store with one coding-plan rule added, so the CLI lists the plan models.
 * Callers reach this only when OMB_ZCODE_PLAN_KEY_FALLBACK=1 (see zcodePlanKeyFallbackEnabled):
 * policy (2026-11-09) forbids the coding-plan key by default and runs zcode on the account's own
 * Start Plan instead. The rule is appended last in providerOrder and the bridge's model selection
 * points GLM-5.3-Flash / GLM-5.3 at the Start Plan entry whenever the catalog offers one. */
export function withPlanProvider(config: any, plan: PlanProvider): any {
  const next = config && typeof config === "object" ? structuredClone(config) : { schemaVersion: 1, config: {} };
  const settings = (next.config ??= {});
  const rules = (settings.providerConfigRules ??= {});
  const kept = (Array.isArray(rules.providerRules) ? rules.providerRules : []).filter((rule: any) => rule?.providerId !== "omb-zcode-plan");
  kept.push({
    providerId: "omb-zcode-plan",
    providerName: plan.name,
    config: {
      group: "standard-personal",
      access: { type: "zhipu-coding-plan-api-key", apiKey: plan.apiKey },
      api: { type: "anthropic-messages", baseUrl: plan.baseUrl },
      personalModelIds: plan.models,
      modelOrder: plan.models,
    },
  });
  rules.providerRules = kept;
  settings.providerOrder = [
    ...(Array.isArray(settings.providerOrder) ? settings.providerOrder.filter((id: any) => id !== "omb-zcode-plan") : []),
    "omb-zcode-plan",
  ];
  return withModelConfigRules(next);
}

export interface ByokProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

/** The vendor's personal-provider decoder reads `config.modelConfigRules` unconditionally and its
 * strict model-rule schema makes `tnr(F3i(undefined))` throw, so a store without the key fails to
 * decode; the CLI's provider repository swallows that error and serves an empty store, dropping
 * every injected provider (CLI 0.16.9/0.17.1 `decodeProviderConfigFile`). Model-level settings for
 * the listed models come from the builtin config's catch-all rule, so an empty rule list is all
 * the CLI needs. */
function withModelConfigRules(store: any): any {
  const settings = (store.config ??= {});
  settings.modelConfigRules ??= { providerModelRules: [], manualProviderModelRules: [] };
  return store;
}

/** The providers OpenMausBot's deployed keys define; a ZCode provider lists its own model ids. */
export function byokProvidersFromEnv(env: Record<string, string | undefined>): ByokProvider[] {
  const providers: ByokProvider[] = [];
  const zhipuKey = env.OMB_CLI_ZHIPU_KEY?.trim();
  const zhipuUrl = env.OMB_CLI_ZHIPU_URL?.trim();
  const zhipuModels = (env.OMB_CLI_ZHIPU_MODELS ?? "").split(",").map((model) => model.trim()).filter(Boolean);
  if (zhipuKey && zhipuUrl && zhipuModels.length) {
    providers.push({ id: "omb-zhipu", name: "Zhipu", baseUrl: zhipuUrl, apiKey: zhipuKey, models: zhipuModels });
  }
  const compatKey = env.OMB_CLI_OPENAI_COMPAT_KEY?.trim();
  const compatUrl = env.OMB_CLI_OPENAI_COMPAT_URL?.trim();
  const compatModels = (env.OMB_CLI_OPENAI_COMPAT_MODELS ?? "").split(",").map((model) => model.trim()).filter(Boolean);
  if (compatKey && compatUrl && compatModels.length) {
    let name = "OpenAI-compatible";
    try { name = `OpenAI-compatible (${new URL(compatUrl).host})`; } catch { /* keep the plain name */ }
    providers.push({ id: "omb-openai-compat", name, baseUrl: compatUrl, apiKey: compatKey, models: compatModels });
  }
  return providers;
}

/** The output-token cap the bridge writes into its deployed-key providers' model rules. The
 * vendor's builtin catch-all rule caps every personal model at 32000, and a long design prompt can
 * spend that whole budget on reasoning before the first visible token, so the turn comes back
 * truncated (FIX-E54). Neither session/create nor session/send takes an output limit on CLI
 * 0.16.9 (their schemas are strict), so the store rule is the only lever. */
const DEFAULT_BYOK_MAX_OUTPUT_TOKENS = 64_000;

export function byokMaxOutputTokens(env: Record<string, string | undefined>): number {
  const parsed = Number(env.OMB_BYOK_MAX_OUTPUT_TOKENS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_BYOK_MAX_OUTPUT_TOKENS;
}

/** Appends a deployed-key provider; ZCode's own-key rule shape is `access: api-key`. A positive
 * `outputLimit` also gives the provider's models a personal model rule raising the output cap: the
 * vendor overlays rules in list order with the personal store last, so the per-model max wins over
 * the builtin catch-all's 32000 while the builtin api rule's max_completion_tokens patch survives
 * (per-field overlay, CLI 0.16.9 `$Ke.overlay`). */
export function withByokProvider(config: any, provider: ByokProvider, outputLimit?: number): any {
  const next = config && typeof config === "object" ? structuredClone(config) : { schemaVersion: 1, config: {} };
  const settings = (next.config ??= {});
  const rules = (settings.providerConfigRules ??= {});
  const kept = (Array.isArray(rules.providerRules) ? rules.providerRules : []).filter((rule: any) => rule?.providerId !== provider.id);
  kept.push({
    providerId: provider.id,
    providerName: provider.name,
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: provider.apiKey },
      api: { type: "openai-chat-completions", baseUrl: provider.baseUrl },
      personalModelIds: provider.models,
      modelOrder: provider.models,
    },
  });
  rules.providerRules = kept;
  settings.providerOrder = [
    ...(Array.isArray(settings.providerOrder) ? settings.providerOrder.filter((id: any) => id !== provider.id) : []),
    provider.id,
  ];
  withModelConfigRules(next);
  if (Number.isInteger(outputLimit) && outputLimit! > 0) {
    const modelRules = (Array.isArray(settings.modelConfigRules.providerModelRules) ? settings.modelConfigRules.providerModelRules : [])
      .filter((rule: any) => !(rule?.providerId === provider.id && provider.models.includes(rule?.modelId)));
    for (const modelId of provider.models) {
      modelRules.push({
        providerId: provider.id,
        modelId,
        config: { enabled: true, optionSpecs: { maxOutputTokens: { max: outputLimit } } },
      });
    }
    settings.modelConfigRules.providerModelRules = modelRules;
  }
  return next;
}

/** The desktop's plan provider, if the CLI can sign with its key. */
function desktopPlan(env: Record<string, string | undefined>): PlanProvider | undefined {
  const desktop = accountHomes(env).map((home) => join(home, ".zcode", "v2", "config.json")).find(existsSync);
  if (!desktop) return undefined;
  try {
    return planProviderFromConfig(JSON.parse(readFileSync(desktop, "utf8")));
  } catch {
    return undefined;
  }
}

/** Writes the provider store into the session's own temp directory. Deployed keys replace ZCode's
 *  own BYOK store entirely; the desktop's coding-plan rule is merged in only when
 *  OMB_ZCODE_PLAN_KEY_FALLBACK=1 (see zcodePlanKeyFallbackEnabled). */
export function providerFile(storage: string, env: Record<string, string | undefined>): string | undefined {
  if (env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) return undefined;
  const byok = byokProvidersFromEnv(env);
  const plan = zcodePlanKeyFallbackEnabled(env) ? desktopPlan(env) : undefined;
  if (!byok.length) {
    if (!plan) return undefined;
    const personal = accountHomes(env).map((home) => join(home, ".zcode", "v2", "provider_config.json")).find(existsSync);
    let store: any = { schemaVersion: 1, config: {} };
    if (personal) {
      try {
        store = JSON.parse(readFileSync(personal, "utf8"));
      } catch {
        return undefined;
      }
    }
    const rules = store?.config?.providerConfigRules?.providerRules;
    if (Array.isArray(rules) && rules.some((rule: any) => rule?.config?.api?.baseUrl === plan.baseUrl)) return undefined;
    return writeProviderFile(storage, withPlanProvider(store, plan));
  }
  let store: any = { schemaVersion: 1, config: {} };
  const outputLimit = byokMaxOutputTokens(env);
  for (const provider of byok) store = withByokProvider(store, provider, outputLimit);
  if (plan) store = withPlanProvider(store, plan);
  return writeProviderFile(storage, store);
}

function writeProviderFile(storage: string, store: unknown): string | undefined {
  const file = join(storage, "personal-providers.json");
  try {
    writeFileSync(file, JSON.stringify(store), { mode: 0o600 });
  } catch {
    return undefined;
  }
  return file;
}

/** The data directory the CLI resolves its own files against (the vendor's rule, mirrored). */
export function zcodeDataBaseDir(env: Record<string, string | undefined>): string {
  return env.ZCODE_DATA_BASE_DIR?.trim() || homedir();
}

function zcodeCredentialsFile(env: Record<string, string | undefined>): string {
  return join(zcodeDataBaseDir(env), ".zcode", "v2", "credentials.json");
}

function credentialCipherKey(env: Record<string, string | undefined>): Buffer {
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // No passwd entry: the vendor's fallback uses the same "unknown".
  }
  const secret = env.ZCODE_CREDENTIAL_SECRET?.trim()
    || `zcode-credential-fallback:${process.platform}:${homedir()}:${username}`;
  return createHash("sha256").update(secret).digest();
}

/** Decrypts one vendor credential-store value (`enc:v1:<iv>.<tag>.<ciphertext>`, AES-256-GCM);
 * plaintext values pass through. A value that fails to decrypt yields undefined — never an error,
 * so a store written by another secret simply reads as not-logged-in. */
export function decryptZcodeCredentialValue(value: unknown, env: Record<string, string | undefined>): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (!value.startsWith("enc:v1:")) return value;
  const [iv, tag, body] = value.slice("enc:v1:".length).split(".");
  if (!iv || !tag || !body) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", credentialCipherKey(env), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf-8");
  } catch {
    return undefined;
  }
}

export interface ZcodeAccountCredentials {
  jwt: string;
  accessToken: string;
}

/** The bigmodel account login held in the CLI's own credential store, read-only. Both values must
 * decrypt: the JWT authenticates start-plan model requests, the OAuth token proves the login. */
export function readZcodeAccountCredentials(env: Record<string, string | undefined>): ZcodeAccountCredentials | undefined {
  const file = zcodeCredentialsFile(env);
  if (!existsSync(file)) return undefined;
  let store: any;
  try {
    store = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (!store || typeof store !== "object") return undefined;
  const jwt = decryptZcodeCredentialValue(store["zcodejwttoken"], env)?.trim();
  const accessToken = decryptZcodeCredentialValue(store["oauth:bigmodel:access_token"], env)?.trim();
  if (!jwt || !accessToken) return undefined;
  return { jwt, accessToken };
}

/** The `provider/updateAccountConfig` snapshot that makes the account's Start Plan visible to the
 * spawned app server — the same push the desktop host performs. The app server starts account
 * providers fail-closed and ignores a push whose `basedOnZCodeBuiltinRevision` does not match its
 * builtin config (`zcode-builtin:<file revision>:sha256 of the active file path`), so the exact
 * path the CLI was given is part of the snapshot. Undefined when there is no login to serve. */
export function zcodeStartPlanAccountPush(
  builtinPath: string | undefined,
  credentials: ZcodeAccountCredentials | undefined,
): Record<string, unknown> | undefined {
  if (!credentials || !builtinPath) return undefined;
  let revision: unknown;
  try {
    revision = JSON.parse(readFileSync(builtinPath, "utf8"))?.revision;
  } catch {
    return undefined;
  }
  const revisionLabel = typeof revision === "string" ? revision.trim()
    : typeof revision === "number" && Number.isFinite(revision) ? String(revision) : "";
  if (!revisionLabel) return undefined;
  return {
    revision: `omb-bridge-${Date.now()}-${randomUUID()}`,
    basedOnZCodeBuiltinRevision: `zcode-builtin:${revisionLabel}:${createHash("sha256").update(resolve(builtinPath)).digest("hex")}`,
    providers: {
      "account:bigmodel-start-plan": { access: { type: "zhipu-account", entitled: true } },
    },
    states: {
      "account:bigmodel-start-plan": { availability: "available", entitled: true, current: true },
    },
  };
}

/** `zcode --version` (or the script through Node) must answer with the CLI's own version. */
export function zcodeLaunchForVersion(env: Record<string, string | undefined>, cli: string): { command: string; args: string[] } {
  return launchSpec(resolveZcodeCli(env, cli), ["--version"]);
}

/** A signed-in CLI is one that has its own credentials, or at least one saved API-key provider. */
export function zcodeHasAccount(env: Record<string, string | undefined>): boolean {
  for (const home of accountHomes(env)) {
    if (existsSync(join(home, ".zcode", "v2", "credentials.json"))) return true;
    if (existsSync(join(home, ".zcode", "v2", "provider_config.json"))) return true;
  }
  return false;
}

interface ZcodePendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Present on requests whose timer is a silence window that every `session/event` restarts. */
  refresh?: () => void;
}

/** One long-lived `zcode app-server` child and its JSON-RPC client. */
export class ZcodeAppServer {
  readonly child: ChildProcess;
  readonly notifications: Array<Record<string, unknown>> = [];
  readonly ownGroup = process.platform !== "win32" && process.env.AGENTHUB_OWNED_POSIX_GROUP !== "1";
  private readonly pending = new Map<string, ZcodePendingRequest>();
  private readonly builtinProviderConfig: string | undefined;
  private readonly accountCredentials: ZcodeAccountCredentials | undefined;
  private nextId = 0;
  private closed = false;

  constructor(input: {
    cli: string;
    cwd: string;
    storage: string;
    env: Record<string, string | undefined>;
  }) {
    const spec = launchSpec(input.cli, ["app-server", "--cwd", input.cwd]);
    const env: Record<string, string | undefined> = { ...process.env, ...input.env, ZCODE_STORAGE_DIR: input.storage };
    const providerConfig = resolveBuiltinProviderConfig(input.env, input.cli);
    if (providerConfig) env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = providerConfig;
    const personal = providerFile(input.storage, env);
    if (personal) env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personal;
    else if (!env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) {
      // Naming the CLI's own provider-config path explicitly keeps the builtin revision it reports
      // deterministic, which the account push below must be based on. Same file the CLI would
      // discover by itself.
      env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = join(zcodeDataBaseDir(env), ".zcode", "v2", "provider_config.json");
    }
    // The deployed keys became a 0600 provider file; the CLI itself has no use for them.
    for (const name of Object.keys(env)) if (name.startsWith("OMB_CLI_")) delete env[name];
    this.builtinProviderConfig = providerConfig;
    this.accountCredentials = readZcodeAccountCredentials(env);
    this.child = spawn(spec.command, spec.args, {
      cwd: input.cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: this.ownGroup,
    });
    // Vendor stderr can carry private settings; never forward its raw text.
    this.child.stderr?.resume();
    const lines = createInterface({ input: this.child.stdout! });
    lines.on("line", (line) => this.receive(line));
    const rejectPending = (code: string) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new ZcodeRpcError(code));
      }
      this.pending.clear();
    };
    this.child.stdin?.on("error", () => rejectPending("APP_SERVER_STDIN_FAILED"));
    this.child.once("error", () => {
      this.closed = true;
      rejectPending("APP_SERVER_START_FAILED");
    });
    this.child.once("close", () => {
      this.closed = true;
      rejectPending("APP_SERVER_EXITED");
      lines.close();
    });
  }

  private write(message: unknown): void {
    if (!this.child.stdin?.destroyed) this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (typeof message.id === "string" && typeof message.method === "string") {
      if (message.method === "session/requestRuntimePreferences") {
        this.write({ id: message.id, result: RUNTIME_PREFERENCES });
      } else if (message.method === "interaction/requestProviderRuntimeHeaders") {
        this.respondProviderRuntimeHeaders(message.id, message.params);
      } else {
        // This bridge answers no other interactive request: a permission question must fail closed.
        this.write({ id: message.id, error: { code: -32601, message: "This adapter does not approve interactive requests" } });
      }
      return;
    }
    if (typeof message.id === "string" && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new ZcodeRpcError("RPC_REJECTED", message.error));
      else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
      else pending.reject(new ZcodeRpcError("RPC_INVALID_RESPONSE"));
      return;
    }
    if (message.method === "session/event" && message.params && typeof message.params === "object") {
      this.notifications.push(message.params as Record<string, unknown>);
      for (const pending of this.pending.values()) pending.refresh?.();
    }
  }

  /** Before each model attempt on an account provider the CLI asks its client for the request
   * auth. The desktop host answers with the account's own JWT for its Start Plan; this bridge
   * mirrors that for the one provider it pushed, and refuses everything else. The JWT is only
   * ever written to the app server's stdin. */
  private respondProviderRuntimeHeaders(id: unknown, params: unknown): void {
    const request = (params ?? {}) as Record<string, any>;
    const providerId = typeof request.providerId === "string" ? request.providerId : "";
    const access = request.accountAccess as Record<string, unknown> | undefined;
    if (providerId === "account:bigmodel-start-plan" && access?.mode === "start-plan" && this.accountCredentials) {
      this.write({ id, result: { headersApplied: true, requestAuth: { apiKey: this.accountCredentials.jwt } } });
      return;
    }
    this.write({ id, error: { code: -32601, message: "This adapter does not approve interactive requests" } });
  }

  /** Makes the account's Start Plan visible to this app server. A rejection (an older CLI without
   * the method, a stale builtin revision) keeps today's behavior: the plan stays out of the
   * catalog, and with the coding-plan fallback off (policy 2026-11-09) GLM turns then fail with
   * the Start Plan unavailable error instead of running another provider. */
  async pushAccountProviders(): Promise<boolean> {
    const push = zcodeStartPlanAccountPush(this.builtinProviderConfig, this.accountCredentials);
    if (!push) return false;
    try {
      await this.request("provider/updateAccountConfig", push, 15_000);
      return true;
    } catch {
      return false;
    }
  }

  /** A dead child can never answer again; the bridge respawns it for the next prompt. */
  get alive(): boolean {
    return !this.closed && this.child.exitCode === null;
  }

  /** With `renewOnEvent`, `timeoutMs` is a silence window instead of a fixed limit: every
   * `session/event` the app server emits restarts it, so a request whose answer may lag a
   * still-running turn's events is not cut while the turn keeps moving; only total silence for
   * the whole window rejects it. */
  request(method: string, params: unknown, timeoutMs = 30_000, options?: { renewOnEvent?: boolean }): Promise<any> {
    if (this.closed) return Promise.reject(new ZcodeRpcError("APP_SERVER_EXITED"));
    const id = `omb-${++this.nextId}`;
    return new Promise((resolveRequest, rejectRequest) => {
      const fire = (): void => {
        this.pending.delete(id);
        rejectRequest(new ZcodeRpcError("RPC_TIMEOUT"));
      };
      const pending: ZcodePendingRequest = {
        resolve: resolveRequest,
        reject: rejectRequest,
        timer: setTimeout(fire, Math.max(1, timeoutMs)),
      };
      if (options?.renewOnEvent) {
        pending.refresh = (): void => {
          clearTimeout(pending.timer);
          pending.timer = setTimeout(fire, Math.max(1, timeoutMs));
        };
      }
      this.pending.set(id, pending);
      this.write({ id, method, params });
    });
  }

  async shutdown(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ZcodeRpcError("APP_SERVER_STOPPED"));
    }
    this.pending.clear();
    if (this.child.exitCode !== null || this.closed) return;
    this.child.stdin?.end();
    await this.waitForExit(1_500);
    if (this.child.exitCode !== null || this.closed) return;
    if (process.platform === "win32") {
      const kill = spawn("taskkill.exe", ["/PID", String(this.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      await new Promise<void>((resolveKill) => {
        const finish = () => {
          clearTimeout(timer);
          kill.off("close", finish);
          kill.off("error", finish);
          resolveKill();
        };
        const timer = setTimeout(finish, 1_500);
        kill.once("close", finish);
        kill.once("error", finish);
      });
    } else if (this.ownGroup) {
      try {
        process.kill(-this.child.pid!, "SIGTERM");
      } catch {
        this.child.kill("SIGTERM");
      }
    } else {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }
    await this.waitForExit(500);
    if (process.platform !== "win32" && this.child.exitCode === null && !this.closed) {
      if (this.ownGroup) {
        try {
          process.kill(-this.child.pid!, "SIGKILL");
        } catch {
          this.child.kill("SIGKILL");
        }
      } else {
        try {
          this.child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
      await this.waitForExit(500);
    }
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    if (this.closed || this.child.exitCode !== null) return Promise.resolve();
    return new Promise((resolveWait) => {
      const finish = () => {
        clearTimeout(timer);
        this.child.off("close", finish);
        resolveWait();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.child.once("close", finish);
    });
  }
}

/** Maps a saved model id onto the live session's picker ids. A bare plan id (`GLM-5.3-Flash`, kept
 * by older bots and the hub's default) maps onto the account's Start Plan entry when the catalog
 * offers one; when it does not, the id must not silently run on another provider, so with the
 * coding-plan fallback off (policy 2026-11-09, see zcodePlanKeyFallbackEnabled) this throws and
 * fails the turn. A saved provider-qualified Start Plan id still matches a catalog that shows the
 * same model bare (one provider only). Ids already offered, or otherwise provider-qualified, pass
 * through unchanged. */
export function normalizeZcodeSessionModel(model: string | undefined, offered: readonly string[]): string | undefined {
  if (!model || !offered.length || offered.includes(model)) return model;
  const lower = model.toLowerCase();
  if (START_PLAN_PROVIDER_IDS.some((provider) => lower.startsWith(`${provider.toLowerCase()}/`))) {
    // The catalog qualifies ids only when two providers offer the model; a catalog with just the
    // Start Plan shows the bare id, which would otherwise reject the saved qualified id.
    const bare = bareModelId(model).toLowerCase();
    return offered.find((id) => !id.includes("/") && id.toLowerCase() === bare) ?? model;
  }
  if (model.includes("/")) return model;
  const matches = offered.filter((id) => bareModelId(id).toLowerCase() === lower);
  const startPlan = matches.find((id) => START_PLAN_PROVIDER_IDS.some((provider) => id.toLowerCase().startsWith(`${provider.toLowerCase()}/`)));
  if (startPlan) return startPlan;
  if (isZcodePlanModel(model) && !zcodePlanKeyFallbackEnabled()) {
    throw new Error(`ZCode Start Plan 不可用: this session's catalog has no Start Plan entry for ${model}, and the coding-plan key fallback is disabled (set OMB_ZCODE_PLAN_KEY_FALLBACK=1 to restore it).`);
  }
  return matches.length ? matches[0] : model;
}

/** Whether a picker id (possibly `providerId/modelId`) names one of the plan's models. */
export function isZcodePlanModel(id: string): boolean {
  const bare = bareModelId(id).toLowerCase();
  return PLAN_MODEL_IDS.some((wanted) => wanted.toLowerCase() === bare);
}

/** Puts the plan models first (Flash, then 5.3) and makes Flash the default. A catalog without plan
 * models is returned untouched, so a personal-provider-only account keeps its own default. */
export function preferZcodePlanModels<T extends { id: string }>(
  defaultId: string,
  options: T[],
): { default: string; options: T[] } {
  const ranked = PLAN_MODEL_IDS.flatMap((wanted) => options.filter((option) => bareModelId(option.id).toLowerCase() === wanted.toLowerCase()));
  if (!ranked.length) return { default: defaultId, options };
  const rest = options.filter((option) => !ranked.includes(option));
  return { default: ranked[0]!.id, options: [...ranked, ...rest] };
}

/** The picker id a new session should open on: the plan's Flash when the account offers it. When
 * several providers carry the same plan model, the account's own Start Plan wins and the injected
 * coding-plan key stays a fallback. */
export function preferredZcodeModelId(catalog: Array<{ pickerId: string; providerId?: string }>): string | undefined {
  const startPlanFirst = (candidates: Array<{ pickerId: string; providerId?: string }>): string | undefined =>
    (candidates.find((model) => isZcodeStartPlanProvider(model.providerId)) ?? candidates[0])?.pickerId;
  for (const wanted of PLAN_MODEL_IDS) {
    const bare = bareModelId(wanted).toLowerCase();
    const match = startPlanFirst(catalog.filter((model) => model.pickerId.toLowerCase() === bare))
      ?? startPlanFirst(catalog.filter((model) => bareModelId(model.pickerId).toLowerCase() === bare));
    if (match) return match;
  }
  return undefined;
}

function levelLabel(value: string): string {
  switch (value.toLowerCase()) {
    case "disabled": return "None";
    case "enabled": return "Enabled";
    case "low": return "Low";
    case "medium": return "Medium";
    case "high": return "High";
    case "xhigh": return "X-High";
    case "max": return "Max";
    default: return value.charAt(0).toUpperCase() + value.slice(1);
  }
}

/** Turns one `session/create` snapshot into the picker's model list. Provider/model ids are
 * preserved; duplicate bare model ids (two providers can offer the same name) become
 * `providerId/modelId` so every picker id is unique, and the account's Start Plan entries are always
 * qualified so saved Start Plan ids stay valid whatever else the session lists (E65). */
export function catalogFromSnapshot(snapshot: any): CatalogSnapshot {
  const available = snapshot?.settings?.model?.available;
  if (!Array.isArray(available)) return { models: [] };
  const rows = available.filter((entry: any) => typeof entry?.ref?.providerId === "string"
    && typeof entry?.ref?.modelId === "string");
  const nameCounts = new Map<string, number>();
  for (const entry of rows) nameCounts.set(entry.ref.modelId, (nameCounts.get(entry.ref.modelId) ?? 0) + 1);
  const models: ZcodeModel[] = [];
  for (const entry of rows) {
    const providerId = entry.ref.providerId as string;
    const modelId = entry.ref.modelId as string;
    const duplicate = (nameCounts.get(modelId) ?? 0) > 1;
    // E65: the Start Plan entry is always provider-qualified, whether or not another provider offers the
    // same name, so a bot saved on `account:bigmodel-start-plan/<model>` keeps matching the session's
    // picker when the coding-plan key is not injected (policy 2026-11-09) and the plan stands alone.
    const qualified = duplicate || isZcodeStartPlanProvider(providerId);
    const levels = Array.isArray(entry.reasoning?.levels)
      ? entry.reasoning.levels.flatMap((level: any) => typeof level?.value === "string" ? [level.value as string] : [])
      : [];
    const defaultLevel = typeof entry.reasoning?.defaultLevel === "string" ? entry.reasoning.defaultLevel : undefined;
    models.push({
      pickerId: qualified ? `${providerId}/${modelId}` : modelId,
      providerId,
      modelId,
      label: duplicate && entry.providerLabel ? `${entry.label ?? modelId} — ${entry.providerLabel}` : (entry.label ?? modelId),
      ...(typeof entry.providerLabel === "string" ? { providerLabel: entry.providerLabel } : {}),
      ...(typeof entry.contextWindow === "number" ? { contextWindow: entry.contextWindow } : {}),
      levels,
      ...(defaultLevel ? { defaultLevel } : {}),
    });
  }
  const current = snapshot?.settings?.model?.current;
  const currentMatch = typeof current?.providerId === "string" && typeof current?.modelId === "string"
    ? models.find((model) => model.providerId === current.providerId && model.modelId === current.modelId)
    : undefined;
  return { models, ...(currentMatch ? { defaultId: currentMatch.pickerId } : models[0] ? { defaultId: models[0].pickerId } : {}) };
}

function modelLevels(model: ZcodeModel | undefined): ModelVariantOption[] {
  return (model?.levels ?? []).map((level) => ({ id: level, label: levelLabel(level) }));
}

function thoughtConfig(model: ZcodeModel | undefined, current?: string) {
  const variants = modelLevels(model);
  if (!variants.length) return [];
  return [{
    id: "thought_level",
    type: "select",
    category: "thought_level",
    name: "Thinking",
    currentValue: current ?? model?.defaultLevel ?? variants[0]!.id,
    options: variants.map((variant) => ({ value: variant.id, name: variant.label })),
  }];
}

function modelsResult(catalog: ZcodeModel[], currentId?: string) {
  const ordered = preferZcodeStartPlanModels([...catalog].sort((a, b) => planModelRank(a.pickerId) - planModelRank(b.pickerId)));
  return {
    availableModels: ordered.map((model) => ({
      modelId: model.pickerId,
      name: model.label,
      ...(model.providerLabel ? { provider: model.providerLabel } : {}),
    })),
    ...(currentId ? { currentModelId: currentId } : {}),
  };
}

function findModel(catalog: ZcodeModel[], wanted: string | undefined): ZcodeModel | undefined {
  if (!wanted) return undefined;
  const exact = catalog.find((model) => model.pickerId === wanted);
  if (exact) return exact;
  const full = catalog.find((model) => `${model.providerId}/${model.modelId}` === wanted);
  if (full) return full;
  const matches = catalog.filter((model) => model.modelId === wanted);
  return matches.length === 1 ? matches[0] : undefined;
}

/** ACP mcpServers carry env and headers as name/value pairs; ZCode's session input takes objects. */
function zcodeMcpServers(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  // The app-server validates `env`/`headers` as ACP-style [{name,value}] lists: a {name:value}
  // object is rejected with a Zod -32602 on session/create, which fails every turn that carries
  // MCP servers. Both keys must stay present, even when empty.
  const pairList = (value: unknown): Array<{ name: string; value: string }> => {
    if (Array.isArray(value)) {
      return value.flatMap((entry) => {
        const pair = entry as { name?: unknown; value?: unknown };
        return typeof pair?.name === "string" && typeof pair?.value === "string" ? [{ name: pair.name, value: pair.value }] : [];
      });
    }
    if (value && typeof value === "object") {
      return Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => typeof entry === "string")
        .map(([name, entry]) => ({ name, value: entry as string }));
    }
    return [];
  };
  return raw.flatMap((entry): unknown[] => {
    if (!entry || typeof entry !== "object") return [];
    const server = entry as Record<string, unknown>;
    if (typeof server.name !== "string") return [];
    if (server.type === "http" || typeof server.url === "string") {
      return [{
        type: "http",
        name: server.name,
        url: server.url ?? "",
        headers: pairList(server.headers),
      }];
    }
    return [{
      name: server.name,
      command: server.command ?? "",
      args: Array.isArray(server.args) ? server.args : [],
      env: pairList(server.env),
    }];
  });
}

function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  return prompt.flatMap((block) => block && typeof block === "object"
    && (block as { type?: unknown }).type === "text"
    && typeof (block as { text?: unknown }).text === "string"
    ? [(block as { text: string }).text]
    : []).join("\n");
}

/** One catalog read from a short deferred session, used by the driver's live model refresh. */
export async function discoverZcodeModels(
  cli: string,
  env: Record<string, string | undefined>,
): Promise<ModelCatalog> {
  const resolvedCli = resolveZcodeCli(env, cli);
  const storage = mkdtempSync(join(tmpdir(), "omb-zcode-catalog-"));
  const app = new ZcodeAppServer({ cli: resolvedCli, cwd: storage, storage, env });
  await app.pushAccountProviders();
  let sessionId: string | undefined;
  try {
    const snapshot = await app.request("session/create", {
      workspace: { workspacePath: storage, workspaceKey: `omb-catalog-${randomUUID()}` },
      persistence: "deferred",
      mode: "plan",
      mcpServers: [],
      toolDenylist: [],
    }, STARTUP_TIMEOUT_MS);
    sessionId = typeof snapshot?.session?.sessionId === "string" ? snapshot.session.sessionId : undefined;
    const { models, defaultId } = catalogFromSnapshot(snapshot);
    if (!models.length) throw new Error("ZCode returned no models for this account");
    const ordered = preferZcodeStartPlanModels(models);
    return preferZcodePlanModels(defaultId ?? ordered[0]!.pickerId, ordered.map((model) => ({
      id: model.pickerId,
      label: model.label,
      ...(model.providerLabel ? { provider: model.providerLabel } : {}),
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(modelLevels(model).length ? { variants: modelLevels(model) } : {}),
    })));
  } finally {
    if (sessionId) await app.request("session/close", { sessionId, expectedPersistence: "deferred" }, 5_000).catch(() => {});
    await app.shutdown().catch(() => {});
    try {
      rmSync(storage, { recursive: true, force: true });
    } catch {
      // A still-held temp directory must not mask the catalog result.
    }
  }
}

/** The part of a bridge session the idle recycle touches; the tests double this shape. */
export interface ZcodeRecyclableSession {
  busy: boolean;
  closed: boolean;
  lastSeq: number;
  app?: { shutdown(): Promise<void> };
  storage?: string;
  zcodeSessionId?: string;
  recycleTimer?: ReturnType<typeof setTimeout>;
}

/** Drops a pending recycle so the next prompt keeps the app server, its native session and its
 * context (FIX-E52). */
export function cancelZcodeAppServerRecycle(session: ZcodeRecyclableSession): void {
  if (session.recycleTimer === undefined) return;
  clearTimeout(session.recycleTimer);
  session.recycleTimer = undefined;
}

/** Tears one idle session's app server down — the same SIGTERM→SIGKILL shutdown a session close
 * uses — and clears the native session reference and the session's temp storage, so the next
 * prompt respawns a fresh app server. Only the app and directory captured here are touched: a
 * prompt that arrives while the shutdown runs spawns its own, and the async tail must not delete
 * those. */
export async function recycleZcodeAppServer(session: ZcodeRecyclableSession): Promise<void> {
  const app = session.app;
  const storage = session.storage;
  session.app = undefined;
  session.storage = undefined;
  session.zcodeSessionId = undefined;
  session.lastSeq = 0;
  await app?.shutdown().catch(() => {});
  if (!storage) return;
  try {
    rmSync(storage, { recursive: true, force: true });
  } catch {
    // A held temp directory must not mask the recycle.
  }
}

/** Arms the idle recycle for a session whose turn just ended: with no new prompt for `idleMs`, the
 * app server is shut down. A prompt inside the window cancels the timer and keeps the process;
 * the turn's end re-arms the timer from then. */
export function scheduleZcodeAppServerRecycle(session: ZcodeRecyclableSession, idleMs: number): void {
  cancelZcodeAppServerRecycle(session);
  if (session.closed || !session.app) return;
  session.recycleTimer = setTimeout(() => {
    session.recycleTimer = undefined;
    if (session.busy || session.closed || !session.app) return;
    void recycleZcodeAppServer(session);
  }, Math.max(1, idleMs));
}

function startBridge(): void {
  const launchCli = argValue("--cli") ?? "zcode";
  const launchMode = argValue("--mode") ?? "yolo";
  const idleTimeoutSec = Math.max(1, Number(argValue("--timeout") ?? DEFAULT_IDLE_TIMEOUT_SEC) || DEFAULT_IDLE_TIMEOUT_SEC);
  const cli = resolveZcodeCli(process.env, launchCli);
  const sessions = new Map<string, BridgeSession>();

  const send = (message: unknown): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const reply = (id: unknown, result: unknown): void => {
    send({ jsonrpc: "2.0", id, result });
  };
  const fail = (id: unknown, code: number, message: string): void => {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  };
  const update = (sessionId: string, value: Record<string, unknown>): void => {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
  };
  const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
  const pollTimeoutMs = eventPollTimeoutMs(process.env);
  const recycleIdle = zcodeRecycleIdleMs(process.env);

  const ensureApp = async (session: BridgeSession): Promise<ZcodeAppServer> => {
    if (session.app?.alive) return session.app;
    if (session.app) {
      await session.app.shutdown().catch(() => {});
      session.app = undefined;
      session.zcodeSessionId = undefined;
      session.lastSeq = 0;
      if (session.storage) {
        try {
          rmSync(session.storage, { recursive: true, force: true });
        } catch {
          // A held temp directory must not mask the respawn.
        }
        session.storage = undefined;
      }
    }
    session.storage = mkdtempSync(join(tmpdir(), "omb-zcode-session-"));
    session.app = new ZcodeAppServer({ cli, cwd: session.cwd, storage: session.storage, env: process.env });
    await session.app.pushAccountProviders();
    return session.app;
  };

  const ensureCatalog = async (session: BridgeSession): Promise<ZcodeModel[]> => {
    if (session.catalog) return session.catalog;
    const app = await ensureApp(session);
    const probe = await app.request("session/create", {
      workspace: { workspacePath: session.cwd, workspaceKey: `omb-catalog-${randomUUID()}` },
      persistence: "deferred",
      mode: "plan",
      mcpServers: [],
      toolDenylist: [],
    }, STARTUP_TIMEOUT_MS);
    const probeId = typeof probe?.session?.sessionId === "string" ? probe.session.sessionId : undefined;
    try {
      const { models, defaultId } = catalogFromSnapshot(probe);
      if (!models.length) throw new ZcodeRpcError("MODEL_CATALOG_UNAVAILABLE");
      session.catalog = models;
      session.defaultModelId = defaultId;
      return models;
    } finally {
      if (probeId) await app.request("session/close", { sessionId: probeId, expectedPersistence: "deferred" }, 5_000).catch(() => {});
    }
  };

  const sessionModel = (session: BridgeSession): ZcodeModel | undefined => {
    const catalog = session.catalog ?? [];
    return findModel(catalog, session.model)
      ?? findModel(catalog, preferredZcodeModelId(catalog))
      ?? findModel(catalog, session.defaultModelId);
  };

  const ensureZcodeSession = async (session: BridgeSession): Promise<string> => {
    if (session.zcodeSessionId) {
      // The native session was created for one model; after a session/set_model it would keep
      // serving the old provider until the app server restarts (E57), so close it and open a new
      // native session on the model the session now carries.
      const current = sessionModel(session);
      if (!current || session.zcodeSessionModel === current.pickerId) return session.zcodeSessionId;
      await session.app?.request("session/close", { sessionId: session.zcodeSessionId }, 5_000).catch(() => {});
      session.zcodeSessionId = undefined;
      session.lastSeq = 0;
    }
    const app = await ensureApp(session);
    await ensureCatalog(session);
    const model = sessionModel(session);
    if (!model) throw new ZcodeRpcError("MODEL_UNAVAILABLE");
    const level = session.thoughtLevel && model.levels.includes(session.thoughtLevel)
      ? session.thoughtLevel
      : model.defaultLevel && model.levels.includes(model.defaultLevel) ? model.defaultLevel
        : model.levels[0] ?? (isZcodePlanModel(model.pickerId) ? "max" : undefined);
    const snapshot = await app.request("session/create", {
      workspace: { workspacePath: session.cwd, workspaceKey: `omb-${randomUUID()}` },
      persistence: "deferred",
      mode: session.mode,
      mcpServers: zcodeMcpServers(session.mcpServers),
      model: { providerId: model.providerId, modelId: model.modelId, ...(level ? { options: { reasoningLevel: level } } : {}) },
      ...(level ? { thoughtLevel: level } : {}),
    }, STARTUP_TIMEOUT_MS);
    const sessionId = snapshot?.session?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) throw new ZcodeRpcError("CREATE_SESSION_INVALID");
    const subscription = await app.request("session/subscribe", {
      sessionId,
      deliveryKind: "desktop-continuous",
      afterSeq: 0,
      includeSnapshot: false,
    }, STARTUP_TIMEOUT_MS);
    let seq = Number.isInteger(subscription?.eventSeq) ? subscription.eventSeq : 0;
    for (const event of subscription?.events ?? []) {
      if (Number.isInteger(event?.seq)) seq = Math.max(seq, event.seq);
    }
    session.zcodeSessionId = sessionId;
    session.zcodeSessionModel = model.pickerId;
    session.lastSeq = seq;
    return sessionId;
  };

  type NativeToolStatus = "pending" | "in_progress" | "completed" | "failed";
  const nativeToolStatus = (status: unknown): NativeToolStatus =>
    status === "completed" ? "completed" : status === "error" ? "failed" : status === "running" ? "in_progress" : "pending";

  const runTurn = async (session: BridgeSession, text: string): Promise<TurnTerminal> => {
    let app = await ensureApp(session);
    let sessionId = await ensureZcodeSession(session);
    // The output cap in force for this turn's model: the bridge's own limit on a deployed-key
    // provider, unknown for the plan models the builtin config sizes.
    const byokProviderIds = new Set(byokProvidersFromEnv(process.env).map((provider) => provider.id));
    const turnModel = sessionModel(session);
    const outputLimit = turnModel && byokProviderIds.has(turnModel.providerId) ? byokMaxOutputTokens(process.env) : undefined;
    const inputId = randomUUID();
    // The send waits for acceptance on the turn's silence window, not a fixed limit: the app
    // server can answer `session/send` long after the events of the turn it already runs (a
    // loaded CLI answers late), so every event restarts the wait and only total silence rejects.
    // The rejection leaves any running native turn alone — the retry follows it (E18).
    const send = () => app.request("session/send", { sessionId, content: text, inputId }, idleTimeoutSec * 1_000, { renewOnEvent: true });
    let sent: any;
    // Set when the session already runs an earlier prompt: this turn follows that one to its end
    // instead of failing (E18), so its events are taken whatever input id they carry.
    let adoptActive = false;
    try {
      sent = await send();
    } catch (error) {
      if (isActivePromptError(error)) {
        adoptActive = true;
      } else {
        if (!isStaleZcodeSessionError(error)) throw error;
        // The app server dropped this deferred session; keep the process and open a new native one.
        session.zcodeSessionId = undefined;
        session.lastSeq = 0;
        app = await ensureApp(session);
        sessionId = await ensureZcodeSession(session);
        sent = await send();
      }
    }
    if (!adoptActive && sent?.accepted !== true) throw new ZcodeRpcError("SEND_NOT_CONFIRMED");
    session.busy = true;
    session.cancelled = false;
    // Any event from the app server renews the window, so a long turn that keeps producing tools
    // or thinking is not stuck; only total silence ends it.
    let quietUntil = Date.now() + idleTimeoutSec * 1_000;
    const renew = (): void => { quietUntil = Date.now() + idleTimeoutSec * 1_000; };
    // A poll that times out is not a dead turn: the app server may be busy and answer the next
    // one. The streak of consecutive transient failures must not outlast the silence window, so a
    // genuinely unreachable app server still ends the turn instead of retrying forever.
    let transientPollStreakStart: number | undefined;
    const sinceSeq = session.lastSeq;
    let heartbeatAt = Date.now() + HEARTBEAT_MS;
    let terminal: TurnTerminal | undefined;
    let terminalError: ZcodeRpcError | undefined;
    const parts = new Map<string, string>();
    const toolTitles = new Map<string, string>();
    const startedTools = new Set<string>();
    let streamed = "";
    const chunk = (sessionUpdate: "agent_message_chunk" | "agent_thought_chunk", delta: string): void => {
      update(session.id, { sessionUpdate, content: { type: "text", text: delta } });
    };
    const emitTool = (toolCallId: string, title: string, status: NativeToolStatus, input?: unknown, output?: unknown): void => {
      const value = output === undefined ? {} : { rawOutput: output };
      if (startedTools.has(toolCallId)) {
        update(session.id, { sessionUpdate: "tool_call_update", toolCallId, status, ...value });
        return;
      }
      startedTools.add(toolCallId);
      update(session.id, {
        sessionUpdate: "tool_call",
        toolCallId,
        title: title.slice(0, 120),
        status,
        ...(input === undefined ? {} : { rawInput: input }),
        ...value,
      });
    };
    const consumeToolPart = (part: any): void => {
      const state = part?.state ?? {};
      const toolCallId = typeof part?.callId === "string" && part.callId ? part.callId
        : typeof part?.partId === "string" ? part.partId : "";
      if (!toolCallId) return;
      const title = (typeof state.title === "string" && state.title)
        || (typeof part.tool === "string" && part.tool) || toolTitles.get(toolCallId) || "tool";
      toolTitles.set(toolCallId, title);
      emitTool(toolCallId, title, nativeToolStatus(state.status), state.input, state.output ?? state.error);
    };
    const consumeToolUpdate = (payload: any): void => {
      const toolCallId = typeof payload?.toolCallId === "string" ? payload.toolCallId : "";
      if (!toolCallId) return;
      const title = (typeof payload.toolName === "string" && payload.toolName) || toolTitles.get(toolCallId) || "tool";
      toolTitles.set(toolCallId, title);
      switch (payload.kind) {
        case "scheduled": emitTool(toolCallId, title, "pending", payload.input); break;
        case "started":
        case "progress": emitTool(toolCallId, title, "in_progress"); break;
        case "result": emitTool(toolCallId, title, "completed", undefined, payload.result); break;
        case "error": emitTool(toolCallId, title, "failed", undefined, payload.error); break;
      }
    };
    const consume = (event: any): void => {
      if (!event || event.sessionId !== sessionId) return;
      if (Number.isInteger(event.seq) && event.seq <= sinceSeq) return;
      if (Number.isInteger(event.seq)) session.lastSeq = Math.max(session.lastSeq, event.seq);
      const payload = event.payload ?? {};
      // An earlier prompt's terminal event must not settle this turn.
      if (!adoptActive && typeof payload.inputId === "string" && payload.inputId !== inputId) return;
      renew();
      switch (event.type) {
        case "part.started":
        case "part.upserted": {
          const part = payload.part;
          if (typeof part?.partId === "string" && typeof part?.type === "string") parts.set(part.partId, part.type);
          if (part?.type === "tool") consumeToolPart(part);
          break;
        }
        case "part.delta": {
          const delta = typeof payload.delta === "string" ? payload.delta : "";
          if (!delta) break;
          const kind = typeof payload.field === "string" ? payload.field : parts.get(payload.partId);
          if (kind === "reasoning") chunk("agent_thought_chunk", delta);
          else if (kind === "text") {
            streamed += delta;
            chunk("agent_message_chunk", delta);
          }
          break;
        }
        case "tool.updated": consumeToolUpdate(payload); break;
        case "turn.failed": {
          const vendor = (payload.error ?? null) as Record<string, unknown> | null;
          if (zcodeTurnHitOutputLimit(vendor)) {
            terminalError = new ZcodeRpcError("TURN_FAILED", { readableReason: zcodeOutputLimitReason(outputLimit) });
          } else {
            // The vendor error rides along so classifyZcodeRpcRejection can read the plan-quota
            // code buried inside it (E58); the message it carries is never echoed back. A
            // concurrency refusal before the turn showed anything may be resent in place (E64).
            const concurrencyRetryable = isZcodeConcurrencyRejection(vendor)
              && streamed.length === 0 && startedTools.size === 0;
            terminalError = new ZcodeRpcError(typeof payload.code === "string" ? payload.code : "TURN_FAILED", {
              error: vendor,
              ...(concurrencyRetryable ? { concurrencyRetryable: true } : {}),
            });
          }
          break;
        }
        case "turn.completed": {
          const resultType = typeof payload.resultType === "string" ? payload.resultType : "";
          if (resultType !== "success") {
            terminalError = new ZcodeRpcError(`TURN_${resultType || "FAILED"}`.toUpperCase());
            break;
          }
          if (typeof payload.response !== "string" || !payload.response.trim()) {
            terminalError = new ZcodeRpcError("EMPTY_RESPONSE");
            break;
          }
          const usage: Record<string, number> = {};
          for (const [source, target] of Object.entries({
            inputTokens: "input_tokens", outputTokens: "output_tokens", reasoningTokens: "reasoning_tokens",
            totalTokens: "total_tokens", cacheReadTokens: "cache_read_tokens", cacheWriteTokens: "cache_write_tokens",
          })) {
            const value = (payload.usage as Record<string, unknown> | undefined)?.[source];
            if (typeof value === "number" && Number.isFinite(value) && value >= 0) usage[target] = value;
          }
          // The streamed text is already on the wire; only a missing tail is sent here.
          const tail = streamed.length
            ? payload.response.startsWith(streamed) ? payload.response.slice(streamed.length) : ""
            : payload.response;
          terminal = { ok: true, text: tail, ...(Object.keys(usage).length ? { usage } : {}) };
          break;
        }
      }
    };
    try {
      while (Date.now() < quietUntil) {
        if (session.cancelled) throw new ZcodeRpcError("CANCELLED");
        // A dead app server can never answer again: fail now instead of waiting for the silence
        // window to run out.
        if (!app.alive) throw new ZcodeRpcError("APP_SERVER_EXITED");
        if (Date.now() >= heartbeatAt) {
          update(session.id, { sessionUpdate: "zcode_bridge_heartbeat" });
          heartbeatAt = Date.now() + HEARTBEAT_MS;
        }
        for (const event of app.notifications.splice(0)) consume(event);
        if (terminal) return terminal;
        if (terminalError) throw terminalError;
        let page: any;
        try {
          page = await app.request("session/events", { sessionId, afterSeq: session.lastSeq, limit: 100 }, pollTimeoutMs);
          transientPollStreakStart = undefined;
        } catch (error) {
          if (!isTransientPollError(error)) throw error;
          transientPollStreakStart ??= Date.now();
          if (Date.now() - transientPollStreakStart >= idleTimeoutSec * 1_000) break;
          await sleep(TURN_POLL_MS);
          continue;
        }
        for (const event of page?.events ?? []) consume(event);
        if (terminal) return terminal;
        if (terminalError) throw terminalError;
        await sleep(TURN_POLL_MS);
      }
      throw new ZcodeRpcError("TURN_TIMEOUT");
    } catch (error) {
      if (error instanceof ZcodeRpcError && error.code === "TURN_TIMEOUT") {
        // The native turn may still be running and the app server may drop the deferred session;
        // stop it here so the next prompt opens a fresh one instead of reusing a dead id.
        void app.request("session/stop", { sessionId }, 5_000).catch(() => {});
        session.zcodeSessionId = undefined;
        session.lastSeq = 0;
      } else if (isStaleZcodeSessionError(error)) {
        session.zcodeSessionId = undefined;
        session.lastSeq = 0;
      }
      throw error;
    }
  };

  /** Resends a turn the plan's concurrency cap refused before it showed anything (E64): the same
   * text in the same native session after a doubling backoff, at most
   * OMB_ZCODE_CONCURRENCY_RETRIES times; a cancel during the wait ends the turn at once, and a
   * turn that already streamed text or ran a tool keeps failing without a resend. */
  const runTurnWithConcurrencyBackoff = async (session: BridgeSession, text: string): Promise<TurnTerminal> => {
    const retries = zcodeConcurrencyRetries(process.env);
    let waitMs = zcodeConcurrencyRetryMs(process.env);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await runTurn(session, text);
      } catch (error) {
        if (attempt >= retries
          || (error as { detail?: { concurrencyRetryable?: unknown } }).detail?.concurrencyRetryable !== true) {
          throw error;
        }
        const deadline = Date.now() + waitMs;
        waitMs *= 2;
        while (Date.now() < deadline) {
          if (session.cancelled) throw new ZcodeRpcError("CANCELLED");
          await sleep(Math.min(TURN_POLL_MS, deadline - Date.now()));
        }
      }
    }
  };

  const handlePrompt = async (id: unknown, params: Record<string, unknown>): Promise<void> => {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const session = sessions.get(sessionId);
    if (!session) return fail(id, -32602, "ZCode bridge: unknown session.");
    if (session.busy) return fail(id, -32000, "ZCode is still running this session's previous task.");
    const text = promptText(params.prompt);
    if (!text.trim()) return fail(id, -32602, "ZCode bridge: the prompt carried no text.");
    cancelZcodeAppServerRecycle(session);
    try {
      const result = await runTurnWithConcurrencyBackoff(session, text);
      for (let offset = 0; offset < result.text.length; offset += REPLY_CHUNK) {
        update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: result.text.slice(offset, offset + REPLY_CHUNK) },
        });
      }
      reply(id, { stopReason: "end_turn" });
    } catch (error) {
      if (error instanceof ZcodeRpcError && error.code === "CANCELLED") {
        reply(id, { stopReason: "cancelled" });
        return;
      }
      const code = error instanceof ZcodeRpcError ? error.code : "TURN_FAILED";
      const reason = classifyZcodeRpcRejection(error);
      fail(id, -32000, `ZCode could not finish this task (${code}${reason ? `: ${reason}` : ""}). Send the message again to retry.`);
    } finally {
      session.busy = false;
      scheduleZcodeAppServerRecycle(session, recycleIdle);
    }
  };

  const cancel = (sessionId: string): void => {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.cancelled = true;
    if (session.app && session.zcodeSessionId) {
      void session.app.request("session/stop", { sessionId: session.zcodeSessionId }, 5_000).catch(() => {});
    }
  };

  const releaseSession = async (session: BridgeSession): Promise<void> => {
    session.closed = true;
    cancelZcodeAppServerRecycle(session);
    if (session.app && session.zcodeSessionId) {
      await session.app.request("session/close", { sessionId: session.zcodeSessionId }, 5_000).catch(() => {});
    }
    await session.app?.shutdown().catch(() => {});
    if (session.storage) {
      try {
        rmSync(session.storage, { recursive: true, force: true });
      } catch {
        // A held temp directory must not mask the ACP close.
      }
    }
  };

  const handle = (message: Record<string, unknown>): void => {
    const method = typeof message.method === "string" ? message.method : "";
    const id = message.id;
    const params = (message.params ?? {}) as Record<string, unknown>;
    const isRequest = id !== undefined && id !== null;
    switch (method) {
      case "initialize":
        return reply(id, {
          protocolVersion: 1,
          agentCapabilities: { promptCapabilities: { image: false } },
          authMethods: [],
        });
      case "session/new": {
        const sessionId = `zcode-${randomUUID()}`;
        const cwd = typeof params.cwd === "string" && params.cwd ? params.cwd : process.cwd();
        const session: BridgeSession = {
          id: sessionId,
          cwd,
          mode: launchMode,
          mcpServers: Array.isArray(params.mcpServers) ? params.mcpServers : [],
          lastSeq: 0,
          busy: false,
          cancelled: false,
          closed: false,
        };
        sessions.set(sessionId, session);
        void (async () => {
          try {
            const catalog = await ensureCatalog(session);
            const current = preferredZcodeModelId(catalog) ?? session.defaultModelId ?? catalog[0]?.pickerId;
            reply(id, {
              sessionId,
              models: modelsResult(catalog, current),
              configOptions: thoughtConfig(findModel(catalog, current), undefined),
            });
          } catch (error) {
            sessions.delete(sessionId);
            void releaseSession(session);
            const code = error instanceof ZcodeRpcError ? error.code : "CATALOG_FAILED";
            fail(id, -32000, `ZCode could not read its model list (${code}). Check the ZCode CLI and its provider configuration, then try again.`);
          }
        })();
        return;
      }
      case "session/prompt":
        void handlePrompt(id, params);
        return;
      case "session/cancel":
        if (typeof params.sessionId === "string") cancel(params.sessionId);
        return;
      case "session/close": {
        const session = typeof params.sessionId === "string" ? sessions.get(params.sessionId) : undefined;
        if (session) {
          sessions.delete(session.id);
          void releaseSession(session);
        }
        return reply(id, {});
      }
      case "session/set_model": {
        const session = typeof params.sessionId === "string" ? sessions.get(params.sessionId) : undefined;
        if (session && typeof params.modelId === "string" && params.modelId) {
          session.model = params.modelId;
          const model = findModel(session.catalog ?? [], params.modelId);
          if (session.thoughtLevel && model && !model.levels.includes(session.thoughtLevel)) session.thoughtLevel = undefined;
          return reply(id, {
            models: modelsResult(session.catalog ?? [], params.modelId),
            configOptions: thoughtConfig(model, session.thoughtLevel),
          });
        }
        return reply(id, {});
      }
      case "session/set_config_option": {
        const session = typeof params.sessionId === "string" ? sessions.get(params.sessionId) : undefined;
        if (session && params.configId === "thought_level" && typeof params.value === "string") {
          session.thoughtLevel = params.value;
          const catalog = session.catalog ?? [];
          const model = findModel(catalog, session.model) ?? findModel(catalog, preferredZcodeModelId(catalog)) ?? findModel(catalog, session.defaultModelId);
          return reply(id, { configOptions: thoughtConfig(model, session.thoughtLevel) });
        }
        return reply(id, {});
      }
      case "authenticate":
        return reply(id, {});
      default:
        // session/load is unsupported: the driver falls back to session/new, which is the only
        // way this transport can start a native ZCode session.
        if (isRequest) fail(id, -32601, `ZCode bridge: ${method || "unknown method"} is not supported.`);
    }
  };

  const shutdown = (): void => {
    for (const session of sessions.values()) {
      session.cancelled = true;
      cancelZcodeAppServerRecycle(session);
      void session.app?.shutdown().catch(() => {});
      if (session.storage) {
        try {
          rmSync(session.storage, { recursive: true, force: true });
        } catch {
          // Best effort on process exit.
        }
      }
    }
    sessions.clear();
  };
  process.once("SIGTERM", () => { shutdown(); process.exit(0); });
  process.once("SIGINT", () => { shutdown(); process.exit(0); });
  process.once("exit", shutdown);
  process.stdin.once("end", () => { shutdown(); process.exit(0); });

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (message && typeof message === "object" && !Array.isArray(message)) handle(message as Record<string, unknown>);
  });
}

const entry = process.argv[1];
if (entry && resolve(entry) === fileURLToPath(import.meta.url)) startBridge();
