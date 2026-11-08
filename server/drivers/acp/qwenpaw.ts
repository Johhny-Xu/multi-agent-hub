// QwenPaw (agentscope-ai/QwenPaw), native `qwenpaw acp` (Agent Client Protocol over stdio).
//
// Verified on 2026-11-08 against qwenpaw 2.2.2.post1 on this host: `initialize` answers
// protocolVersion 1 with agentInfo {name: qwenpaw, title: "QwenPaw", version: 2.2.2.post1},
// loadSession, and session capabilities (close/list/resume); `session/new` answers with the
// session id, config options and the model state. The CLI is Python (pip/uv install), so its
// `--version` prints "QwenPaw, version 2.2.2.post1" on stdout and its import-time warnings go to
// stderr. `qwenpaw acp` takes flags (--agent, --workspace, --agent-mode, --runtime-provider),
// but its permission decisions arrive as ACP requests the shared runtime answers, so no
// permission flag rides argv.
//
// House rule (2026-11-08): no CLI's own BYOK. The CLI's own free tier is offered as it ships, and
// the person's own provider keys reach the CLI through OpenMausBot's BYOK injection — never through
// a key saved inside QwenPaw's own settings, which this driver neither reads nor writes.
//
// The injection follows QwenPaw's own headless mode: `qwenpaw acp --runtime-provider openai-env`
// builds one process-scoped provider from OPENAI_BASE_URL, OPENAI_API_KEY and OPENAI_MODEL
// (QwenPaw 2.2.2.post1: cli/acp_cmd.py's --runtime-provider choice, agents/acp/runtime_provider.py's
// OpenAIRuntimeProviderConfig.from_env). The provider is registered in memory and dropped when the
// process ends, so no credential is ever written to a file and QwenPaw's own user-level provider
// configuration stays untouched. That mode names its one model `runtime-openai:<model>`, which is
// why a BYOK pick is a different process (its env differs, so its spawn contract differs) and why
// the picker id is rewritten to that native id before the session selects a model.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import { DEFAULT_ZHIPU_BASE_URL, DEFAULT_ZHIPU_MODELS } from "../../cli-keys.ts";
import type { AppConfig } from "../../config.ts";
import { loadConfig } from "../../config.ts";
import type { ModelCatalog, ProviderSnapshot } from "../../contracts.ts";
import { augmentedPath, userHome } from "../../env-path.ts";
import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";
import { FREE_MODEL_PREFERENCE } from "../openrouter-free.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

/**
 * The CLI's own free tier: the Kilo free router QwenPaw points its default LLM slot at, the
 * other free models behind that router, and the QwenPaw-Flash models its local runtime can run
 * with no key at all. A person's own provider keys are deliberately not listed (house rule).
 */
const QWENPAW_MODELS: ModelCatalog = {
  default: "kilo:kilo-auto/free",
  options: [
    { id: "kilo:kilo-auto/free", label: "Kilo Auto (free router)", provider: "kilo" },
    { id: "kilo:openrouter/free", label: "OpenRouter (free router)", provider: "kilo" },
    { id: "kilo:nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra 550B (free)", provider: "kilo" },
    { id: "kilo:nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron 3 Super 120B (free)", provider: "kilo" },
    { id: "kilo:poolside/laguna-s-2.1:free", label: "Poolside Laguna S 2.1 (free)", provider: "kilo" },
    { id: "kilo:poolside/laguna-xs-2.1:free", label: "Poolside Laguna XS 2.1 (free)", provider: "kilo" },
    { id: "kilo:stepfun/step-3.7-flash:free", label: "Step 3.7 Flash (free)", provider: "kilo" },
    { id: "qwenpaw-local:agentscope-ai/QwenPaw-Flash-9B-Q4_K_M", label: "QwenPaw-Flash 9B Q4 (local)", provider: "qwenpaw-local" },
    { id: "qwenpaw-local:agentscope-ai/QwenPaw-Flash-4B-Q4_K_M", label: "QwenPaw-Flash 4B Q4 (local)", provider: "qwenpaw-local" },
  ],
};

/** QwenPaw's own model id for the injected provider (agents/acp/server.py's runtime model slot). */
const RUNTIME_MODEL_PREFIX = "runtime-openai:";

const SETUP_NOTE =
  "QwenPaw needs a model slot before it can answer — set the free tier in QwenPaw itself (for example `qwenpaw models set-llm`), then check again.";

/** A provider the person saved in OpenMausBot, offered to QwenPaw as a BYOK model. */
export interface QwenpawByokProvider {
  /** The picker id's provider part; the source the model is labelled with. */
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  /** The upstream model ids this provider serves. */
  models: string[];
  /** The wire protocol QwenPaw speaks to this provider. */
  protocol: "chat" | "responses" | "anthropic";
}

/** The BYOK connection one picked model runs on. */
export interface QwenpawRuntimeTarget {
  /** Where the key came from, for the badge and for diagnostics. */
  provider: string;
  baseUrl: string;
  apiKey: string;
  /** The upstream model id QwenPaw sends (not the picker id). */
  model: string;
  protocol: "chat" | "responses" | "anthropic";
}

const trimmed = (value: string | undefined): string => value?.trim() ?? "";

/**
 * One saved OpenMausBot provider that QwenPaw can call, and how. `url` is the OpenAI-compatible
 * base (the drivers' own default), `protocol` is the wire protocol QwenPaw's runtime provider
 * speaks: `chat` for OpenAI-compatible endpoints, `anthropic` for Anthropic's own messages API.
 */
interface ByokSpec {
  /** The picker id's provider part. */
  id: string;
  label: string;
  /** The OpenMausBot config field the key lives in. */
  key: (cfg: AppConfig) => string | undefined;
  /** The base url; a config override wins over the default. */
  baseUrl: (cfg: AppConfig) => string;
  models: readonly string[];
  protocol?: "chat" | "anthropic";
}

const OPENAI_MODELS = ["gpt-5", "gpt-5-mini"] as const;
const CLAUDE_MODELS = ["claude-sonnet-5", "claude-opus-5", "claude-haiku-5-5"] as const;
const GEMINI_MODELS = ["gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro"] as const;
const GROK_MODELS = ["grok-4.7", "grok-4", "grok-4-fast"] as const;
const MISTRAL_MODELS = ["mistral-large-latest", "mistral-small-latest"] as const;
const CEREBRAS_MODELS = ["gpt-oss-120b", "qwen-3.8-27b"] as const;
const GROQ_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"] as const;
const GREENFERENCE_MODELS = ["greenference/glm-5.3-flash", "greenference/qwen3.6-27b", "greenference/gemma-4-31b-it"] as const;
const META_MODELS = ["muse-wonder-1.0", "muse-spark-1.3"] as const;

/** Every provider OpenMausBot saves a key for that QwenPaw can reach over a documented protocol. */
const BYOK_SPECS: readonly ByokSpec[] = [
  {
    id: "openai", label: "OpenAI",
    key: (cfg) => cfg.openai?.key,
    baseUrl: () => "https://api.openai.com/v1",
    models: OPENAI_MODELS,
  },
  {
    id: "anthropic", label: "Anthropic",
    key: (cfg) => cfg.anthropic?.key,
    baseUrl: (cfg) => trimmed(cfg.anthropic?.url) || "https://api.anthropic.com",
    models: CLAUDE_MODELS,
    protocol: "anthropic",
  },
  {
    id: "gemini", label: "Gemini",
    key: (cfg) => cfg.gemini?.key,
    baseUrl: (cfg) => trimmed(cfg.gemini?.url) || "https://generativelanguage.googleapis.com/v1beta/openai",
    models: GEMINI_MODELS,
  },
  {
    id: "xai", label: "xAI",
    key: (cfg) => cfg.xai?.key,
    baseUrl: (cfg) => trimmed(cfg.xai?.url) || "https://api.x.ai/v1",
    models: GROK_MODELS,
  },
  {
    id: "mistral", label: "Mistral",
    key: (cfg) => cfg.mistral?.key,
    baseUrl: () => "https://api.mistral.ai/v1",
    models: MISTRAL_MODELS,
  },
  {
    id: "cerebras", label: "Cerebras",
    key: (cfg) => cfg.cerebras?.key,
    baseUrl: () => "https://api.cerebras.ai/v1",
    models: CEREBRAS_MODELS,
  },
  {
    id: "groq", label: "Groq",
    key: (cfg) => cfg.groq?.key,
    baseUrl: (cfg) => trimmed(cfg.groq?.url) || "https://api.groq.com/openai/v1",
    models: GROQ_MODELS,
  },
  {
    id: "greenference", label: "Greenference",
    key: (cfg) => cfg.greenference?.key,
    baseUrl: () => "https://llm.eu.greenference.com/v1",
    models: GREENFERENCE_MODELS,
  },
  {
    id: "meta", label: "Meta",
    key: (cfg) => cfg.meta?.key,
    baseUrl: (cfg) => trimmed(cfg.meta?.url) || "https://api.meta.ai/v1",
    models: META_MODELS,
  },
];

/**
 * The providers OpenMausBot holds a key for, each with the models it can serve. A provider with no
 * key is not offered at all: an offered model that cannot be called is worse than no model.
 */
export function qwenpawByokProviders(cfg: AppConfig): QwenpawByokProvider[] {
  const providers: QwenpawByokProvider[] = [];
  const compat = cfg.openaiCompat;
  const compatModels = trimmed(compat?.model).split(",").map((model) => model.trim()).filter(Boolean);
  if (trimmed(compat?.key) && trimmed(compat?.url) && compatModels.length) {
    providers.push({
      id: "openai-compat",
      label: "OpenAI-compatible",
      baseUrl: trimmed(compat?.url).replace(/\/+$/, ""),
      apiKey: trimmed(compat?.key),
      models: compatModels,
      protocol: "chat",
    });
  }
  for (const spec of BYOK_SPECS) {
    const apiKey = trimmed(spec.key(cfg));
    if (!apiKey) continue;
    providers.push({
      id: spec.id,
      label: spec.label,
      baseUrl: spec.baseUrl(cfg).replace(/\/+$/, ""),
      apiKey,
      models: [...spec.models],
      protocol: spec.protocol ?? "chat",
    });
  }
  const openrouter = trimmed(cfg.openrouter?.key);
  if (openrouter) {
    providers.push({
      id: "openrouter",
      label: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: openrouter,
      models: [...FREE_MODEL_PREFERENCE],
      protocol: "chat",
    });
  }
  const deepseek = trimmed(cfg.deepseek?.key);
  if (deepseek) {
    providers.push({
      id: "deepseek",
      label: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      apiKey: deepseek,
      models: ["deepseek-chat", "deepseek-reasoner"],
      protocol: "chat",
    });
  }
  const zhipu = trimmed(cfg.zhipu?.key);
  if (zhipu) {
    providers.push({
      id: "zhipu",
      label: "Zhipu",
      baseUrl: (trimmed(cfg.zhipu?.url) || DEFAULT_ZHIPU_BASE_URL).replace(/\/+$/, ""),
      apiKey: zhipu,
      models: cfg.zhipu?.models?.map((model) => model.trim()).filter(Boolean).length
        ? cfg.zhipu.models!.map((model) => model.trim()).filter(Boolean)
        : [...DEFAULT_ZHIPU_MODELS],
      protocol: "chat",
    });
  }
  providers.push(...qwenpawCompatInstanceProviders(cfg));
  return providers;
}

/** The fleet's own `openai-compat` instances; their keys are the workspace keys offered above. */
const BUILTIN_COMPAT_INSTANCES = new Set(["openaiCompat", "openai", "openrouter"]);

/** openai-compat's own default key variable (server/drivers/openai-compat.ts's DEFAULT_KEY_ENV). */
const QWENPAW_COMPAT_KEY_ENV = "OPENAI_COMPAT_API_KEY";

/**
 * The added OpenAI-compatible servers ("更多服务器") each with their own url, key and models. One
 * provider per instance, so a pick runs on that instance's own key and never on another's.
 */
function qwenpawCompatInstanceProviders(cfg: AppConfig): QwenpawByokProvider[] {
  const providers: QwenpawByokProvider[] = [];
  for (const [instanceId, entry] of Object.entries(cfg.instances ?? {})) {
    if (entry?.driver !== "openai-compat") continue;
    // The built-in fleet instances carry the workspace keys, which are offered above.
    if (BUILTIN_COMPAT_INSTANCES.has(instanceId)) continue;
    const config = (entry.config ?? {}) as { key?: string; url?: string; model?: string; managedModels?: string[]; apiKeyEnv?: string };
    // The openai-compat driver's key rule (server/drivers/openai-compat.ts): an instance key first,
    // else the variable its apiKeyEnv names (its own default when unset). BYOK reads process.env only
    // and skips the instance when that names nothing readable.
    const keyEnv = typeof config.apiKeyEnv === "string" && config.apiKeyEnv.trim()
      ? config.apiKeyEnv.trim()
      : QWENPAW_COMPAT_KEY_ENV;
    const envKey = process.env[keyEnv];
    const apiKey = trimmed(config.key) || (envKey ? envKey.trim() : "");
    const baseUrl = trimmed(config.url);
    const models = (config.managedModels ?? (config.model ? [config.model] : [])).map((model) => model.trim()).filter(Boolean);
    if (!apiKey || !baseUrl || !models.length) continue;
    providers.push({
      id: instanceId,
      label: trimmed(entry.displayName) || "OpenAI-compatible",
      baseUrl: baseUrl.replace(/\/+$/, ""),
      apiKey,
      models,
      protocol: "chat",
    });
  }
  return providers;
}

/** The CLI's own tier plus every BYOK provider, each model labelled with the source it came from. */
export function qwenpawCatalog(cfg: AppConfig): ModelCatalog {
  const options = QWENPAW_MODELS.options.map((option) => ({ ...option }));
  for (const provider of qwenpawByokProviders(cfg)) {
    for (const model of provider.models) {
      options.push({
        id: `${provider.id}:${model}`,
        label: `${model} (${provider.label})`,
        provider: provider.id,
        custom: true,
      });
    }
  }
  return { default: QWENPAW_MODELS.default, options };
}

/**
 * The BYOK connection a picked model runs on, or null for the CLI's own tier (which brings its own
 * connection). A local host (LOCAL_HOSTS) is one of those connections too.
 */
export function qwenpawRuntimeTarget(
  modelId: string | null | undefined,
  cfg: AppConfig,
  env: Record<string, string | undefined> = process.env,
): QwenpawRuntimeTarget | null {
  if (!modelId) return null;
  const inject = decodeInjectId(modelId);
  if (inject) {
    const host = localHost(inject.host);
    if (!host) return null;
    return {
      provider: `local:${host.id}`,
      baseUrl: host.baseUrl,
      apiKey: hostApiKey(host, env),
      model: inject.model,
      protocol: "chat",
    };
  }
  const separator = modelId.indexOf(":");
  if (separator <= 0) return null;
  const providerId = modelId.slice(0, separator);
  const model = modelId.slice(separator + 1);
  const provider = qwenpawByokProviders(cfg).find((entry) => entry.id === providerId);
  if (!provider || !provider.models.includes(model)) return null;
  return {
    provider: provider.id,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
    protocol: provider.protocol,
  };
}

/**
 * The variables QwenPaw's runtime provider reads (agents/acp/runtime_provider.py). The key rides the
 * child env only: it is never logged, and the spawn contract hashes the env instead of naming it.
 */
export function applyQwenpawByokEnv(
  env: Record<string, string | undefined>,
  target: QwenpawRuntimeTarget,
): void {
  env.OPENAI_BASE_URL = target.baseUrl;
  env.OPENAI_API_KEY = target.apiKey;
  env.OPENAI_MODEL = target.model;
  env.QWENPAW_MODEL_INFO_JSON = JSON.stringify({ protocol: target.protocol });
  // A BYOK router may deliver a long tool call in one burst after a long silence (E50: 9router +
  // step-5-preview went 32 s quiet), which QwenPaw's 30 s stream-idle default turns into a failed turn.
  if (!env.QWENPAW_LLM_STREAM_IDLE_TIMEOUT?.trim()) env.QWENPAW_LLM_STREAM_IDLE_TIMEOUT = String(QWENPAW_BYOK_STREAM_IDLE_TIMEOUT_S);
}

/** Stream-idle window for BYOK runs, seconds (QwenPaw reads it as a float). */
export const QWENPAW_BYOK_STREAM_IDLE_TIMEOUT_S = 300;

/** Where QwenPaw keeps its working dir (its own default: $QWENPAW_WORKING_DIR, else ~/.qwenpaw). */
export function qwenpawHome(env: Record<string, string | undefined>): string {
  const configured = env.QWENPAW_WORKING_DIR?.trim();
  return configured || join(userHome(env), ".qwenpaw");
}

/**
 * The instance's CLI when it names a path, else the bin a user-level Python install puts it in
 * (~/.local/bin, where `uv tool install` and `pipx` link it).
 */
export function resolveQwenpawCli(env: Record<string, string | undefined>, cli: string): string {
  if (cli && (isAbsolute(cli) || cli.includes("/") || cli.includes("\\") || existsSync(cli))) return cli;
  if (env.OMB_QWENPAW_CLI) return env.OMB_QWENPAW_CLI;
  const path = join(userHome(env), ".local", "bin", "qwenpaw");
  if (existsSync(path)) return path;
  return cli || "qwenpaw";
}

const support: AcpSupport = {
  driverKind: "qwenpawAgent",
  displayName: "QwenPaw",
  models: QWENPAW_MODELS,
  defaultCli: "qwenpaw",
  nativeSource: "qwenpaw.acp",
  images: true,
  loginNote: SETUP_NOTE,

  // `qwenpaw acp` starts the ACP agent on stdio; permission decisions arrive as ACP requests
  // the runtime answers, so no permission flag rides argv. A BYOK pick adds the CLI's own
  // ephemeral provider, which reads the injected variables from the child env.
  spawnArgs: (_config, turn) => turn.model?.startsWith(RUNTIME_MODEL_PREFIX)
    ? ["acp", "--runtime-provider", "openai-env"]
    : ["acp"],

  resolveModels: async (env) => mergeLocalInject(qwenpawCatalog(loadConfig()), env),

  // A BYOK pick becomes the CLI's own id for the injected provider, which is the only model that
  // mode offers; the CLI's own tier keeps its native ids.
  resolveTurnModel: (model, env) => {
    if (!model) return model;
    const target = qwenpawRuntimeTarget(model, loadConfig(), env);
    return target ? `${RUNTIME_MODEL_PREFIX}${target.model}` : model;
  },

  // QwenPaw answers session/new with the legacy `models` state (availableModels carrying
  // "provider:model" ids) and no "model" config option; it switches a model with
  // session/set_model, so the legacy path is the one that works here (verified 2026-11-08).
  selectModel: { configId: "model", allowLegacy: true },

  // The injected variables belong to the picked model, so they are set per turn and the server's
  // own environment never carries a provider key into a child.
  transformEnv: (env) => {
    delete env.OPENAI_BASE_URL;
    delete env.OPENAI_MODEL;
    delete env.OPENAI_API_KEY;
    delete env.QWENPAW_MODEL_INFO_JSON;
  },

  applyTurnEnv: (env, ctx) => {
    const target = qwenpawRuntimeTarget(ctx.requestedModel ?? ctx.model, loadConfig(), env);
    if (!target) return;
    applyQwenpawByokEnv(env, target);
  },

  snapshot: (env, config) => new Promise<ProviderSnapshot>((settle) => {
    const cli = resolveQwenpawCli(env, config.cli);
    const home = userHome(env);
    const probeEnv = {
      ...env,
      PATH: [join(home, ".local", "bin"), join(home, ".npm-global", "bin"), augmentedPath()].join(delimiter),
      HOME: home,
    };
    execFile(cli, ["--version"], { timeout: 25_000, env: probeEnv }, (error, stdout, stderr) => {
      const code = error ? (error as NodeJS.ErrnoException).code : undefined;
      const banner = `${stdout ?? ""}\n${stderr ?? ""}`;
      if (error && code === "ENOENT") {
        settle({
          state: "unavailable",
          reason: "`qwenpaw` isn't installed, or isn't on this app's PATH. Install the QwenPaw CLI or use Set CLI, then check again.",
        });
        return;
      }
      const version = /QwenPaw, version (\d+\.\d+\.\d+(?:[.\w-]*)?)/.exec(banner)?.[1] ?? null;
      if (!version) {
        settle({
          state: "unavailable",
          reason: error
            ? "`qwenpaw --version` failed. Run it on the server to diagnose the installation, then check again."
            : "The configured executable did not answer as the QwenPaw CLI. Check its path and try again.",
          notEngineCli: true,
        });
        return;
      }
      settle({ state: "available", version, authenticated: true });
    });
  }),

  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
  requireAuthenticationBeforeSpawn: false,

  classifyError: (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/no active model configured|no model configured/i.test(message)) return "invalid_credentials";
    return undefined;
  },
  describeAccountError: () => SETUP_NOTE,

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const QwenPawAgentDriver = createAcpDriver(support);
