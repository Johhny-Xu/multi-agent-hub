// One deployment of a provider key, read by every engine that can use it. The keys live in
// config.json (written 0600); a CLI child receives only the variables its driver already declared in
// AcpSupport.credentialEnv, so a key never moves an engine off a login it never opted out of.
import type { AppConfig } from "./config.ts";

/** Zhipu's OpenAI-compatible endpoint; the CLI's provider rule names this base URL directly. */
export const DEFAULT_ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";

/** Open Platform chat models, used until the person lists their own in `zhipu.models`. */
export const DEFAULT_ZHIPU_MODELS = ["glm-4.7", "glm-4.6", "glm-4.5", "glm-4.5-air"];

/**
 * Every deployed provider key under the env name a CLI reads it from. The first source to claim a
 * name wins: an explicit OpenAI key beats the OpenAI-compatible one, never the reverse.
 */
export function centralCliKeyEnv(cfg: AppConfig): Record<string, string> {
  const env: Record<string, string> = {};
  const put = (name: string, value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && !env[name]) env[name] = trimmed;
  };
  put("ANTHROPIC_API_KEY", cfg.anthropic?.key);
  put("ANTHROPIC_AUTH_TOKEN", cfg.anthropic?.key);
  put("ANTHROPIC_BASE_URL", cfg.anthropic?.url);
  put("OPENAI_API_KEY", cfg.openai?.key);
  put("OPENAI_API_KEY", cfg.openaiCompat?.key);
  put("OPENAI_BASE_URL", cfg.openaiCompat?.url);
  put("GEMINI_API_KEY", cfg.gemini?.key);
  put("GOOGLE_API_KEY", cfg.gemini?.key);
  put("ZHIPU_API_KEY", cfg.zhipu?.key);
  put("BIGMODEL_API_KEY", cfg.zhipu?.key);
  put("DEEPSEEK_API_KEY", cfg.deepseek?.key);
  put("XAI_API_KEY", cfg.xai?.key);
  put("MISTRAL_API_KEY", cfg.mistral?.key);
  put("CEREBRAS_API_KEY", cfg.cerebras?.key);
  put("GROQ_API_KEY", cfg.groq?.key);
  put("GREENFERENCE_API_KEY", cfg.greenference?.key);
  put("META_API_KEY", cfg.meta?.key);
  return env;
}

/**
 * Adds the deployed key for each variable this engine's driver declared. A value the instance set
 * itself (`instanceEnvironment`) is that instance's own routing and stays.
 */
export function applyCentralCliKeys(
  env: Record<string, string | undefined>,
  cfg: AppConfig,
  allowed: ReadonlySet<string>,
  instanceEnvironment: Readonly<Record<string, string>> = {},
): void {
  for (const [name, value] of Object.entries(centralCliKeyEnv(cfg))) {
    if (!allowed.has(name)) continue;
    if ((instanceEnvironment[name] ?? "").trim()) continue;
    env[name] = value;
  }
}

/**
 * The deployed keys ZCode's bridge turns into its own provider rules, so the CLI never reads a
 * BYOK key saved inside ZCode. Model ids ride along because a ZCode provider lists its models.
 */
export function zcodeCentralKeyEnv(cfg: AppConfig): Record<string, string> {
  const env: Record<string, string> = {};
  const zhipu = cfg.zhipu?.key?.trim();
  if (zhipu) {
    env.OMB_CLI_ZHIPU_KEY = zhipu;
    env.OMB_CLI_ZHIPU_URL = cfg.zhipu?.url?.trim() || DEFAULT_ZHIPU_BASE_URL;
    const models = cfg.zhipu?.models?.filter((model) => model.trim()).map((model) => model.trim()) ?? [];
    env.OMB_CLI_ZHIPU_MODELS = (models.length ? models : DEFAULT_ZHIPU_MODELS).join(",");
  }
  const compat = cfg.openaiCompat?.key?.trim();
  const compatUrl = cfg.openaiCompat?.url?.trim();
  const compatModel = cfg.openaiCompat?.model?.trim();
  if (compat && compatUrl && compatModel) {
    env.OMB_CLI_OPENAI_COMPAT_KEY = compat;
    env.OMB_CLI_OPENAI_COMPAT_URL = compatUrl;
    env.OMB_CLI_OPENAI_COMPAT_MODELS = compatModel;
  }
  return env;
}
