import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZcodeAgentDriver } from "./acp/zcode.ts";
import {
  byokMaxOutputTokens,
  byokProvidersFromEnv,
  cancelZcodeAppServerRecycle,
  catalogFromSnapshot,
  classifyZcodeRpcRejection,
  decryptZcodeCredentialValue,
  isTransientPollError,
  isZcodeStartPlanProvider,
  planProviderFromConfig,
  preferZcodePlanModels,
  preferZcodeStartPlanModels,
  preferredZcodeModelId,
  providerFile,
  readZcodeAccountCredentials,
  scheduleZcodeAppServerRecycle,
  withByokProvider,
  withPlanProvider,
  zcodePlanKeyFallbackEnabled,
  zcodeRecycleIdleMs,
  zcodeStartPlanAccountPush,
  normalizeZcodeSessionModel,
  type ZcodeRecyclableSession,
} from "./zcode-acp.ts";

const PROCESS_ENV_SNAPSHOT: Record<string, string | undefined> = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in PROCESS_ENV_SNAPSHOT)) delete process.env[key];
  }
  Object.assign(process.env, PROCESS_ENV_SNAPSHOT);
});

const snapshot = {
  settings: {
    model: {
      available: [
        { ref: { providerId: "9router", modelId: "deepseek-v4.1-flash" }, label: "DeepSeek V4.1 Flash" },
        {
          ref: { providerId: "account:bigmodel-start-plan", modelId: "GLM-5.3-Flash" },
          label: "GLM-5.3-Flash",
          reasoning: { levels: [{ value: "max" }, { value: "high" }], defaultLevel: "max" },
        },
        { ref: { providerId: "account:bigmodel-coding-plan", modelId: "GLM-5.3" }, label: "GLM-5.3" },
      ],
      current: { providerId: "9router", modelId: "deepseek-v4.1-flash" },
    },
  },
};

describe("ZcodeAgentDriver", () => {
  it("falls back to a catalog that opens on GLM-5.3-Flash and offers GLM-5.3", () => {
    expect(ZcodeAgentDriver.models.default).toBe("GLM-5.3-Flash");
    expect(ZcodeAgentDriver.models.options.map((option) => option.id)).toEqual(
      expect.arrayContaining(["GLM-5.3-Flash", "GLM-5.3"]),
    );
  });
});

describe("catalogFromSnapshot", () => {
  it("keeps the app-server's current model when the plan is also listed", () => {
    const { models, defaultId } = catalogFromSnapshot(snapshot);
    expect(models.map((model) => model.pickerId)).toEqual(["deepseek-v4.1-flash", "GLM-5.3-Flash", "GLM-5.3"]);
    expect(defaultId).toBe("deepseek-v4.1-flash");
    expect(models[1]?.levels).toEqual(["max", "high"]);
  });

  it("qualifies model ids that two providers offer", () => {
    const { models } = catalogFromSnapshot({
      settings: {
        model: {
          available: [
            { ref: { providerId: "zai", modelId: "GLM-5.3" }, label: "GLM-5.3" },
            { ref: { providerId: "bigmodel", modelId: "GLM-5.3" }, label: "GLM-5.3", providerLabel: "BigModel" },
          ],
        },
      },
    });
    expect(models.map((model) => model.pickerId)).toEqual(["zai/GLM-5.3", "bigmodel/GLM-5.3"]);
  });

  it("labels the Start Plan and the injected coding plan apart when both offer Flash", () => {
    const { models } = catalogFromSnapshot({
      settings: {
        model: {
          available: [
            { ref: { providerId: "9router", modelId: "deepseek-v4.1-flash" }, label: "DeepSeek V4.1 Flash" },
            { ref: { providerId: "account:bigmodel-start-plan", modelId: "GLM-5.3-Flash" }, label: "GLM-5.3-Flash", providerLabel: "Start Plan" },
            { ref: { providerId: "omb-zcode-plan", modelId: "GLM-5.3-Flash" }, label: "GLM-5.3-Flash", providerLabel: "BigModel - Coding Plan" },
          ],
        },
      },
    });
    expect(models.map((model) => model.pickerId)).toEqual([
      "deepseek-v4.1-flash",
      "account:bigmodel-start-plan/GLM-5.3-Flash",
      "omb-zcode-plan/GLM-5.3-Flash",
    ]);
    expect(models[1]?.label).toBe("GLM-5.3-Flash — Start Plan");
    expect(models[2]?.label).toBe("GLM-5.3-Flash — BigModel - Coding Plan");
    expect(models.map((model) => model.providerLabel)).toEqual([undefined, "Start Plan", "BigModel - Coding Plan"]);
  });
});

describe("preferZcodePlanModels", () => {
  it("offers the plan models first and opens on Flash", () => {
    const { models } = catalogFromSnapshot(snapshot);
    const options = models.map((model) => ({ id: model.pickerId, label: model.label }));
    const preferred = preferZcodePlanModels("deepseek-v4.1-flash", options);
    expect(preferred.options.map((option) => option.id)).toEqual(["GLM-5.3-Flash", "GLM-5.3", "deepseek-v4.1-flash"]);
    expect(preferred.default).toBe("GLM-5.3-Flash");
  });

  it("leaves an account without plan models on its own default", () => {
    const options = [{ id: "deepseek-v4.1-flash", label: "DeepSeek" }, { id: "step-5-preview", label: "Step 5" }];
    expect(preferZcodePlanModels("deepseek-v4.1-flash", options)).toEqual({ default: "deepseek-v4.1-flash", options });
  });
});

describe("preferredZcodeModelId", () => {
  it("finds a plan model behind a provider-qualified picker id", () => {
    const catalog = [{ pickerId: "deepseek-v4.1-flash" }, { pickerId: "zai/GLM-5.3-Flash" }];
    expect(preferredZcodeModelId(catalog)).toBe("zai/GLM-5.3-Flash");
  });

  it("answers undefined when the account has no plan models", () => {
    expect(preferredZcodeModelId([{ pickerId: "deepseek-v4.1-flash" }])).toBeUndefined();
  });

  it("points GLM at the Start Plan when the catalog offers it, whichever order the CLI lists", () => {
    const startPlan = { pickerId: "account:bigmodel-start-plan/GLM-5.3-Flash", providerId: "account:bigmodel-start-plan" };
    const injected = { pickerId: "omb-zcode-plan/GLM-5.3-Flash", providerId: "omb-zcode-plan" };
    expect(preferredZcodeModelId([injected, startPlan])).toBe("account:bigmodel-start-plan/GLM-5.3-Flash");
    expect(preferredZcodeModelId([startPlan, injected])).toBe("account:bigmodel-start-plan/GLM-5.3-Flash");
  });

  it("falls back to the injected coding plan when the Start Plan is not in the catalog", () => {
    const injected = { pickerId: "omb-zcode-plan/GLM-5.3-Flash", providerId: "omb-zcode-plan" };
    expect(preferredZcodeModelId([injected, { pickerId: "deepseek-v4.1-flash", providerId: "9router" }])).toBe("omb-zcode-plan/GLM-5.3-Flash");
  });

  it("keeps a Start Plan Flash ahead of the injected provider's Flash and 5.3", () => {
    const catalog = [
      { pickerId: "omb-zcode-plan/GLM-5.3-Flash", providerId: "omb-zcode-plan" },
      { pickerId: "omb-zcode-plan/GLM-5.3", providerId: "omb-zcode-plan" },
      { pickerId: "account:bigmodel-start-plan/GLM-5.3-Flash", providerId: "account:bigmodel-start-plan" },
    ];
    expect(preferredZcodeModelId(catalog)).toBe("account:bigmodel-start-plan/GLM-5.3-Flash");
  });
});

describe("isZcodeStartPlanProvider", () => {
  it("recognises the account Start Plan and its legacy builtin alias", () => {
    expect(isZcodeStartPlanProvider("account:bigmodel-start-plan")).toBe(true);
    expect(isZcodeStartPlanProvider("builtin:bigmodel-start-plan")).toBe(true);
    expect(isZcodeStartPlanProvider("omb-zcode-plan")).toBe(false);
    expect(isZcodeStartPlanProvider(undefined)).toBe(false);
  });
});

describe("preferZcodeStartPlanModels", () => {
  const startFlash = { modelId: "GLM-5.3-Flash", providerId: "account:bigmodel-start-plan" };
  const injectedFlash = { modelId: "GLM-5.3-Flash", providerId: "omb-zcode-plan" };
  const injected53 = { modelId: "GLM-5.3", providerId: "omb-zcode-plan" };
  const deepseek = { modelId: "deepseek-v4.1-flash", providerId: "9router" };

  it("puts the Start Plan entry first within its model group and keeps other groups in place", () => {
    expect(preferZcodeStartPlanModels([injectedFlash, injected53, deepseek, startFlash]))
      .toEqual([startFlash, injectedFlash, injected53, deepseek]);
  });

  it("keeps the catalog untouched when no Start Plan entry exists", () => {
    expect(preferZcodeStartPlanModels([injectedFlash, deepseek, injected53])).toEqual([injectedFlash, deepseek, injected53]);
  });
});

describe("planProviderFromConfig", () => {
  it("takes a coding-plan provider whose key can be signed, Flash first", () => {
    const plan = planProviderFromConfig({
      provider: {
        "builtin:bigmodel-coding-plan": {
          name: "BigModel - Coding Plan",
          options: { apiKey: "key-id.key-secret", baseURL: "https://open.bigmodel.cn/api/anthropic" },
          models: { "GLM-5.3": {}, "GLM-5.3-Flash": {} },
        },
      },
    });
    expect(plan).toEqual({
      name: "BigModel - Coding Plan",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKey: "key-id.key-secret",
      models: ["GLM-5.3-Flash", "GLM-5.3"],
    });
  });

  it("skips the desktop's OAuth-style JWT, which the CLI cannot sign with", () => {
    const plan = planProviderFromConfig({
      provider: {
        "builtin:bigmodel-start-plan": {
          options: { apiKey: "header.payload.signature", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
        },
      },
    });
    expect(plan).toBeUndefined();
  });
});

describe("withPlanProvider", () => {
  it("keeps the user's providers and appends the plan rule", () => {
    const merged = withPlanProvider(
      {
        schemaVersion: 1,
        config: {
          providerOrder: ["9router"],
          providerConfigRules: { providerRules: [{ providerId: "9router", providerName: "9router" }] },
        },
      },
      { name: "BigModel Coding Plan", baseUrl: "https://open.bigmodel.cn/api/anthropic", apiKey: "id.secret", models: ["GLM-5.3-Flash", "GLM-5.3"] },
    );
    const rules = merged.config.providerConfigRules.providerRules;
    expect(rules.map((rule: any) => rule.providerId)).toEqual(["9router", "omb-zcode-plan"]);
    expect(rules[1].config.personalModelIds).toEqual(["GLM-5.3-Flash", "GLM-5.3"]);
    expect(merged.config.providerOrder).toEqual(["9router", "omb-zcode-plan"]);
  });

  it("replaces its own rule instead of duplicating it", () => {
    const merged = withPlanProvider(
      { config: { providerConfigRules: { providerRules: [{ providerId: "omb-zcode-plan" }] }, providerOrder: ["omb-zcode-plan"] } },
      { name: "Plan", baseUrl: "https://example.com", apiKey: "a.b", models: ["GLM-5.3-Flash"] },
    );
    expect(merged.config.providerConfigRules.providerRules).toHaveLength(1);
    expect(merged.config.providerOrder).toEqual(["omb-zcode-plan"]);
  });
});

describe("byokProvidersFromEnv", () => {
  it("builds a provider from the deployed Zhipu key", () => {
    expect(byokProvidersFromEnv({
      OMB_CLI_ZHIPU_KEY: "zhipu-x",
      OMB_CLI_ZHIPU_URL: "https://open.bigmodel.cn/api/paas/v4",
      OMB_CLI_ZHIPU_MODELS: "glm-4.7,glm-4.6",
    })).toEqual([{
      id: "omb-zhipu",
      name: "Zhipu",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "zhipu-x",
      models: ["glm-4.7", "glm-4.6"],
    }]);
  });

  it("names an OpenAI-compatible provider after its host", () => {
    expect(byokProvidersFromEnv({
      OMB_CLI_OPENAI_COMPAT_KEY: "sk-x",
      OMB_CLI_OPENAI_COMPAT_URL: "https://gateway.example/v1",
      OMB_CLI_OPENAI_COMPAT_MODELS: "model-a",
    })).toEqual([{
      id: "omb-openai-compat",
      name: "OpenAI-compatible (gateway.example)",
      baseUrl: "https://gateway.example/v1",
      apiKey: "sk-x",
      models: ["model-a"],
    }]);
  });

  it("ignores a key without a server or a model", () => {
    expect(byokProvidersFromEnv({ OMB_CLI_ZHIPU_KEY: "zhipu-x" })).toEqual([]);
    expect(byokProvidersFromEnv({ OMB_CLI_OPENAI_COMPAT_KEY: "sk-x", OMB_CLI_OPENAI_COMPAT_URL: "https://gateway.example/v1" })).toEqual([]);
    expect(byokProvidersFromEnv({})).toEqual([]);
  });
});

describe("withByokProvider", () => {
  it("adds an api-key rule beside the plan rule", () => {
    const withPlan = withPlanProvider(
      { schemaVersion: 1, config: {} },
      { name: "Plan", baseUrl: "https://open.bigmodel.cn/api/anthropic", apiKey: "id.secret", models: ["GLM-5.3-Flash"] },
    );
    const merged = withByokProvider(withPlan, {
      id: "omb-zhipu", name: "Zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "zhipu-x", models: ["glm-4.7"],
    });
    const rules = merged.config.providerConfigRules.providerRules;
    expect(rules.map((rule: any) => rule.providerId)).toEqual(["omb-zcode-plan", "omb-zhipu"]);
    expect(rules[1]).toEqual({
      providerId: "omb-zhipu",
      providerName: "Zhipu",
      config: {
        group: "standard-personal",
        access: { type: "api-key", apiKey: "zhipu-x" },
        api: { type: "openai-chat-completions", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
        personalModelIds: ["glm-4.7"],
        modelOrder: ["glm-4.7"],
      },
    });
    expect(merged.config.providerOrder).toEqual(["omb-zcode-plan", "omb-zhipu"]);
  });

  it("replaces its own rule instead of duplicating it", () => {
    const once = withByokProvider({ config: {} }, { id: "omb-zhipu", name: "Zhipu", baseUrl: "u", apiKey: "a", models: ["m"] });
    const twice = withByokProvider(once, { id: "omb-zhipu", name: "Zhipu", baseUrl: "u", apiKey: "b", models: ["m"] });
    const rules = twice.config.providerConfigRules.providerRules;
    expect(rules).toHaveLength(1);
    expect(rules[0].config.access.apiKey).toBe("b");
  });
});

const TEST_SECRET = "omb-test-credential-secret";

function seal(value: string, secret = TEST_SECRET): string {
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
}

const testEnv = (dir: string): Record<string, string | undefined> => ({
  ZCODE_DATA_BASE_DIR: dir,
  ZCODE_CREDENTIAL_SECRET: TEST_SECRET,
});

function writeCredentials(dir: string, values: Record<string, string>): void {
  mkdirSync(join(dir, ".zcode", "v2"), { recursive: true });
  writeFileSync(join(dir, ".zcode", "v2", "credentials.json"), JSON.stringify(values), { mode: 0o600 });
}

describe("decryptZcodeCredentialValue", () => {
  it("round-trips a vendor-format ciphertext", () => {
    const env = testEnv("/unused");
    expect(decryptZcodeCredentialValue(seal("test-jwt-token"), env)).toBe("test-jwt-token");
  });

  it("passes plaintext through and refuses values from another secret", () => {
    const env = testEnv("/unused");
    expect(decryptZcodeCredentialValue("plain-value", env)).toBe("plain-value");
    expect(decryptZcodeCredentialValue(seal("secret", "another-secret"), env)).toBeUndefined();
    expect(decryptZcodeCredentialValue("enc:v1:not.a.valid", env)).toBeUndefined();
    expect(decryptZcodeCredentialValue(undefined, env)).toBeUndefined();
  });
});

describe("readZcodeAccountCredentials", () => {
  it("reads the account JWT and OAuth token from the CLI's own store", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-zcode-cred-"));
    try {
      writeCredentials(dir, {
        zcodejwttoken: seal("jwt-value"),
        "oauth:bigmodel:access_token": seal("token-value"),
      });
      expect(readZcodeAccountCredentials(testEnv(dir))).toEqual({ jwt: "jwt-value", accessToken: "token-value" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers undefined when the store is missing, unreadable, or half-logged-in", () => {
    expect(readZcodeAccountCredentials(testEnv("/nonexistent-zcode-home"))).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), "omb-zcode-cred-"));
    try {
      writeCredentials(dir, { zcodejwttoken: seal("jwt-value") });
      expect(readZcodeAccountCredentials(testEnv(dir))).toBeUndefined();
      writeFileSync(join(dir, ".zcode", "v2", "credentials.json"), "{not json");
      expect(readZcodeAccountCredentials(testEnv(dir))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("zcodeStartPlanAccountPush", () => {
  it("mirrors the desktop's entitlement push for the bigmodel Start Plan", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-zcode-push-"));
    try {
      const builtin = join(dir, "zcode-builtin.json");
      writeFileSync(builtin, JSON.stringify({ schemaVersion: 1, revision: "30", config: {} }));
      const push = zcodeStartPlanAccountPush(builtin, { jwt: "jwt-value", accessToken: "token-value" })!;
      expect(push.providers).toEqual({
        "account:bigmodel-start-plan": { access: { type: "zhipu-account", entitled: true } },
      });
      expect(push.states).toEqual({
        "account:bigmodel-start-plan": { availability: "available", entitled: true, current: true },
      });
      expect(String(push.revision)).toMatch(/^omb-bridge-/);
      expect(push.basedOnZCodeBuiltinRevision).toBe(
        `zcode-builtin:30:${createHash("sha256").update(builtin).digest("hex")}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers undefined without a login, a builtin path, or a readable revision", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-zcode-push-"));
    try {
      const credentials = { jwt: "jwt-value", accessToken: "token-value" };
      expect(zcodeStartPlanAccountPush(undefined, credentials)).toBeUndefined();
      expect(zcodeStartPlanAccountPush(join(dir, "missing.json"), credentials)).toBeUndefined();
      const builtin = join(dir, "zcode-builtin.json");
      writeFileSync(builtin, JSON.stringify({ revision: "" }));
      expect(zcodeStartPlanAccountPush(builtin, credentials)).toBeUndefined();
      writeFileSync(builtin, JSON.stringify({ revision: "30" }));
      expect(zcodeStartPlanAccountPush(builtin, undefined)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("classifyZcodeRpcRejection", () => {
  it("tells a dead session from a provider refusal without leaking vendor detail", () => {
    const stale = new Error("RPC_REJECTED");
    (stale as any).detail = { message: "session is not resident: sess-1 (proto.sessionNotResident)" };
    expect(classifyZcodeRpcRejection(stale)).toBe("the native session expired");
    const model = new Error("RPC_REJECTED");
    (model as any).detail = { message: "Provider Registry 中不存在 Model: account:bigmodel-start-plan/GLM-5.3-Flash" };
    expect(classifyZcodeRpcRejection(model)).toBe("the model or provider is unavailable");
    const quota = new Error("RPC_REJECTED");
    (quota as any).detail = { message: "request has been blocked due to unusual activity.", code: "3012" };
    expect(classifyZcodeRpcRejection(quota)).toBe("the provider plan or quota refused the request");
    const plain = new Error("RPC_REJECTED");
    expect(classifyZcodeRpcRejection(plain)).toBe("rejected by the app server");
    expect(classifyZcodeRpcRejection(undefined)).toBe("");
  });

  it("never echoes the vendor error text back", () => {
    const error = new Error("RPC_REJECTED");
    (error as any).detail = { message: "request has been blocked due to unusual activity. request=06f6950e" };
    const reason = classifyZcodeRpcRejection(error);
    expect(reason).not.toContain("06f6950e");
    expect(reason).not.toContain("unusual activity");
  });
});

describe("normalizeZcodeSessionModel (E13)", () => {
  const offered = ["account:bigmodel-start-plan/GLM-5.3-Flash", "omb-zcode-plan/GLM-5.3-Flash", "GLM-5.3", "GLM-5.2"];
  it("maps a bare plan id onto the Start Plan entry when two providers offer it", () => {
    expect(normalizeZcodeSessionModel("GLM-5.3-Flash", offered)).toBe("account:bigmodel-start-plan/GLM-5.3-Flash");
  });
  it("falls back to the other provider only when OMB_ZCODE_PLAN_KEY_FALLBACK=1", () => {
    process.env.OMB_ZCODE_PLAN_KEY_FALLBACK = "1";
    expect(normalizeZcodeSessionModel("GLM-5.3-Flash", ["omb-zcode-plan/GLM-5.3-Flash", "GLM-5.2"])).toBe("omb-zcode-plan/GLM-5.3-Flash");
  });
  it("leaves offered, qualified, unknown and empty ids alone", () => {
    expect(normalizeZcodeSessionModel("GLM-5.3", offered)).toBe("GLM-5.3");
    expect(normalizeZcodeSessionModel("omb-zcode-plan/GLM-5.3-Flash", offered)).toBe("omb-zcode-plan/GLM-5.3-Flash");
    expect(normalizeZcodeSessionModel("nope", offered)).toBe("nope");
    expect(normalizeZcodeSessionModel(undefined, offered)).toBeUndefined();
    expect(normalizeZcodeSessionModel("GLM-5.3-Flash", [])).toBe("GLM-5.3-Flash");
  });
});

describe("zcode plan key fallback (ZCODE-planguard)", () => {
  it("reads the coding-plan fallback switch from OMB_ZCODE_PLAN_KEY_FALLBACK", () => {
    expect(zcodePlanKeyFallbackEnabled({})).toBe(false);
    expect(zcodePlanKeyFallbackEnabled({ OMB_ZCODE_PLAN_KEY_FALLBACK: "1" })).toBe(true);
    expect(zcodePlanKeyFallbackEnabled({ OMB_ZCODE_PLAN_KEY_FALLBACK: "0" })).toBe(false);
    expect(zcodePlanKeyFallbackEnabled()).toBe(false);
  });

  it("writes no coding-plan rule into the provider store unless the fallback is enabled", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-zcode-plan-home-"));
    const storage = mkdtempSync(join(tmpdir(), "omb-zcode-plan-store-"));
    try {
      mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
      writeFileSync(join(home, ".zcode", "v2", "config.json"), JSON.stringify({
        provider: {
          "builtin:bigmodel-coding-plan": {
            name: "BigModel - Coding Plan",
            enabled: true,
            options: { apiKey: "key-id.key-secret", baseURL: "https://open.bigmodel.cn/api/anthropic" },
            models: { "GLM-5.3-Flash": {}, "GLM-5.3": {} },
          },
        },
      }));
      writeFileSync(join(home, ".zcode", "v2", "provider_config.json"), JSON.stringify({ schemaVersion: 1, config: {} }));
      const env = { OMB_ZCODE_HOME: home, HOME: home };
      expect(providerFile(storage, env)).toBeUndefined();
      expect(existsSync(join(storage, "personal-providers.json"))).toBe(false);
      const written = providerFile(storage, { ...env, OMB_ZCODE_PLAN_KEY_FALLBACK: "1" });
      expect(written).toBeTruthy();
      const store = JSON.parse(readFileSync(written!, "utf8"));
      expect(store.config.providerConfigRules.providerRules.map((rule: any) => rule.providerId)).toEqual(["omb-zcode-plan"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(storage, { recursive: true, force: true });
    }
  });

  it("keeps deployed BYOK providers without the plan rule and merges the plan rule under the flag", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-zcode-plan-home-"));
    const storage = mkdtempSync(join(tmpdir(), "omb-zcode-plan-store-"));
    try {
      mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
      writeFileSync(join(home, ".zcode", "v2", "config.json"), JSON.stringify({
        provider: {
          "builtin:bigmodel-coding-plan": {
            enabled: true,
            options: { apiKey: "key-id.key-secret", baseURL: "https://open.bigmodel.cn/api/anthropic" },
            models: { "GLM-5.3-Flash": {} },
          },
        },
      }));
      const env = {
        OMB_ZCODE_HOME: home,
        HOME: home,
        OMB_CLI_ZHIPU_KEY: "zhipu-x",
        OMB_CLI_ZHIPU_URL: "https://open.bigmodel.cn/api/paas/v4",
        OMB_CLI_ZHIPU_MODELS: "glm-4.7",
      };
      const plain = JSON.parse(readFileSync(providerFile(storage, env)!, "utf8"));
      expect(plain.config.providerConfigRules.providerRules.map((rule: any) => rule.providerId)).toEqual(["omb-zhipu"]);
      const flagged = JSON.parse(readFileSync(providerFile(storage, { ...env, OMB_ZCODE_PLAN_KEY_FALLBACK: "1" })!, "utf8"));
      expect(flagged.config.providerConfigRules.providerRules.map((rule: any) => rule.providerId)).toEqual(["omb-zhipu", "omb-zcode-plan"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(storage, { recursive: true, force: true });
    }
  });

  it("skips a plan provider the desktop disabled or marked not entitled, taking the next usable one", () => {
    const codingPlan = {
      options: { apiKey: "key-id.key-secret", baseURL: "https://open.bigmodel.cn/api/anthropic" },
      models: { "GLM-5.3-Flash": {} },
    };
    const zaiPlan = {
      options: { apiKey: "zai-id.zai-secret", baseURL: "https://api.z.ai/api/anthropic" },
      models: { "GLM-5.3-Flash": {} },
    };
    expect(planProviderFromConfig({
      provider: {
        "builtin:bigmodel-coding-plan": { ...codingPlan, enabled: false, systemDisabledReason: "coding_plan_not_entitled" },
        "builtin:zai-coding-plan": { ...zaiPlan, enabled: false, systemDisabledReason: "oauth_provider_inactive" },
      },
    })).toBeUndefined();
    expect(planProviderFromConfig({
      provider: {
        "builtin:bigmodel-coding-plan": { ...codingPlan, enabled: false, systemDisabledReason: "coding_plan_not_entitled" },
        "builtin:zai-coding-plan": zaiPlan,
      },
    })?.apiKey).toBe("zai-id.zai-secret");
    expect(planProviderFromConfig({
      provider: { "builtin:bigmodel-coding-plan": { ...codingPlan, systemDisabledReason: "coding_plan_not_entitled" } },
    })).toBeUndefined();
  });

  it("maps a bare plan model onto the Start Plan entry whenever the catalog offers one", () => {
    expect(normalizeZcodeSessionModel("GLM-5.3-Flash", ["omb-zcode-plan/GLM-5.3-Flash", "account:bigmodel-start-plan/GLM-5.3-Flash"]))
      .toBe("account:bigmodel-start-plan/GLM-5.3-Flash");
    expect(normalizeZcodeSessionModel("GLM-5.3-Flash", ["account:bigmodel-start-plan/GLM-5.3-Flash"]))
      .toBe("account:bigmodel-start-plan/GLM-5.3-Flash");
  });

  it("fails a bare plan model instead of running another provider when the fallback is off", () => {
    expect(() => normalizeZcodeSessionModel("GLM-5.3-Flash", ["9router/GLM-5.3-Flash", "GLM-5.2"])).toThrow(/Start Plan/);
    expect(() => normalizeZcodeSessionModel("GLM-5.3", ["deepseek-v4.1-flash"])).toThrow(/Start Plan/);
  });

  it("accepts a saved qualified Start Plan id when the catalog shows that model bare", () => {
    expect(normalizeZcodeSessionModel("account:bigmodel-start-plan/GLM-5.3-Flash", ["GLM-5.3-Flash"])).toBe("GLM-5.3-Flash");
    expect(normalizeZcodeSessionModel("builtin:bigmodel-start-plan/GLM-5.3", ["GLM-5.3"])).toBe("GLM-5.3");
    expect(normalizeZcodeSessionModel("account:bigmodel-start-plan/GLM-5.3-Flash", ["9router/GLM-5.3-Flash"]))
      .toBe("account:bigmodel-start-plan/GLM-5.3-Flash");
  });
});

describe("zcode personal provider store (FIX-E44)", () => {
  it("writes the omb-openai-compat rule in the shape the CLI's personal-provider decoder accepts", () => {
    const storage = mkdtempSync(join(tmpdir(), "omb-zcode-fix-e44-"));
    try {
      const written = providerFile(storage, {
        OMB_CLI_OPENAI_COMPAT_KEY: "fixture-compat-key",
        OMB_CLI_OPENAI_COMPAT_URL: "http://127.0.0.1:20128/v1",
        OMB_CLI_OPENAI_COMPAT_MODELS: "stai/step-5-preview",
      });
      expect(written).toBe(join(storage, "personal-providers.json"));
      const store = JSON.parse(readFileSync(written!, "utf8"));
      expect(store.schemaVersion).toBe(1);
      expect(store.config.modelConfigRules).toEqual({
        providerModelRules: [{
          providerId: "omb-openai-compat",
          modelId: "stai/step-5-preview",
          config: { enabled: true, optionSpecs: { maxOutputTokens: { max: 64000 } } },
        }],
        manualProviderModelRules: [],
      });
      expect(store.config.providerOrder).toEqual(["omb-openai-compat"]);
      expect(store.config.providerConfigRules.providerRules).toEqual([{
        providerId: "omb-openai-compat",
        providerName: "OpenAI-compatible (127.0.0.1:20128)",
        config: {
          group: "standard-personal",
          access: { type: "api-key", apiKey: "fixture-compat-key" },
          api: { type: "openai-chat-completions", baseUrl: "http://127.0.0.1:20128/v1" },
          personalModelIds: ["stai/step-5-preview"],
          modelOrder: ["stai/step-5-preview"],
        },
      }]);
    } finally {
      rmSync(storage, { recursive: true, force: true });
    }
  });

  it("keeps a merged store's own modelConfigRules when the plan rule is added", () => {
    const modelConfigRules = {
      providerModelRules: [{ providerId: "p", modelId: "m", config: { enabled: true } }],
      manualProviderModelRules: [],
    };
    const merged = withPlanProvider(
      { schemaVersion: 1, config: { modelConfigRules } },
      { name: "Plan", baseUrl: "https://example.com", apiKey: "a.b", models: ["GLM-5.3-Flash"] },
    );
    expect(merged.config.modelConfigRules).toEqual(modelConfigRules);
    expect(merged.config.providerConfigRules.providerRules.map((rule: any) => rule.providerId)).toEqual(["omb-zcode-plan"]);
  });

  it("lists the injected compat model in the bridge's catalog", async () => {
    const bridge = startPollBridge("personal-store", 5, {
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "",
      OMB_CLI_OPENAI_COMPAT_KEY: "fixture-compat-key",
      OMB_CLI_OPENAI_COMPAT_URL: "http://127.0.0.1:20128/v1",
      OMB_CLI_OPENAI_COMPAT_MODELS: "stai/step-5-preview",
    });
    await bridge.request("initialize", { protocolVersion: 1, clientInfo: { name: "test", version: "0" } });
    const created = await bridge.request("session/new", { cwd: bridge.dir, mcpServers: [] });
    expect(created.models.availableModels).toEqual([{
      modelId: "stai/step-5-preview",
      name: "stai/step-5-preview",
      provider: "OpenAI-compatible (127.0.0.1:20128)",
    }]);
    expect(created.models.currentModelId).toBe("stai/step-5-preview");
  });

  it("writes no provider store when no BYOK provider is deployed", () => {
    const storage = mkdtempSync(join(tmpdir(), "omb-zcode-fix-e44-"));
    try {
      expect(providerFile(storage, { OMB_ZCODE_HOME: "/nonexistent-zcode-home", HOME: "/nonexistent-zcode-home" })).toBeUndefined();
      expect(existsSync(join(storage, "personal-providers.json"))).toBe(false);
    } finally {
      rmSync(storage, { recursive: true, force: true });
    }
  });
});

describe("zcode BYOK output limit (FIX-E54)", () => {
  it("gives every deployed provider's model a personal rule raising the output cap", () => {
    const storage = mkdtempSync(join(tmpdir(), "omb-zcode-fix-e54-"));
    try {
      const written = providerFile(storage, {
        OMB_CLI_ZHIPU_KEY: "fixture-zhipu-key",
        OMB_CLI_ZHIPU_URL: "https://open.bigmodel.cn/api/paas/v4",
        OMB_CLI_ZHIPU_MODELS: "glm-4.7,glm-4.6",
        OMB_CLI_OPENAI_COMPAT_KEY: "fixture-compat-key",
        OMB_CLI_OPENAI_COMPAT_URL: "http://127.0.0.1:20128/v1",
        OMB_CLI_OPENAI_COMPAT_MODELS: "stai/step-5-preview",
      });
      const store = JSON.parse(readFileSync(written!, "utf8"));
      expect(store.config.modelConfigRules).toEqual({
        providerModelRules: [
          { providerId: "omb-zhipu", modelId: "glm-4.7", config: { enabled: true, optionSpecs: { maxOutputTokens: { max: 64000 } } } },
          { providerId: "omb-zhipu", modelId: "glm-4.6", config: { enabled: true, optionSpecs: { maxOutputTokens: { max: 64000 } } } },
          { providerId: "omb-openai-compat", modelId: "stai/step-5-preview", config: { enabled: true, optionSpecs: { maxOutputTokens: { max: 64000 } } } },
        ],
        manualProviderModelRules: [],
      });
    } finally {
      rmSync(storage, { recursive: true, force: true });
    }
  });

  it("leaves the Start Plan and coding-plan providers without a model rule", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-zcode-fix-e54-home-"));
    const storage = mkdtempSync(join(tmpdir(), "omb-zcode-fix-e54-"));
    try {
      mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
      writeFileSync(join(home, ".zcode", "v2", "config.json"), JSON.stringify({
        provider: {
          "builtin:bigmodel-coding-plan": {
            name: "BigModel - Coding Plan",
            enabled: true,
            options: { apiKey: "key-id.key-secret", baseURL: "https://open.bigmodel.cn/api/anthropic" },
            models: { "GLM-5.3-Flash": {} },
          },
        },
      }));
      const store = JSON.parse(readFileSync(providerFile(storage, {
        OMB_ZCODE_HOME: home,
        HOME: home,
        OMB_ZCODE_PLAN_KEY_FALLBACK: "1",
        OMB_CLI_OPENAI_COMPAT_KEY: "fixture-compat-key",
        OMB_CLI_OPENAI_COMPAT_URL: "http://127.0.0.1:20128/v1",
        OMB_CLI_OPENAI_COMPAT_MODELS: "stai/step-5-preview",
      })!, "utf8"));
      expect(store.config.providerConfigRules.providerRules.map((rule: any) => rule.providerId))
        .toEqual(["omb-openai-compat", "omb-zcode-plan"]);
      expect(store.config.modelConfigRules.providerModelRules.map((rule: any) => rule.providerId))
        .toEqual(["omb-openai-compat"]);
      expect(store.config.modelConfigRules.manualProviderModelRules).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(storage, { recursive: true, force: true });
    }
  });

  it("reads OMB_BYOK_MAX_OUTPUT_TOKENS as a positive integer and defaults to 64000", () => {
    expect(byokMaxOutputTokens({})).toBe(64000);
    expect(byokMaxOutputTokens({ OMB_BYOK_MAX_OUTPUT_TOKENS: "96000" })).toBe(96000);
    for (const junk of ["0", "-5", "1.5", "junk", ""]) {
      expect(byokMaxOutputTokens({ OMB_BYOK_MAX_OUTPUT_TOKENS: junk })).toBe(64000);
    }
  });

  it("puts the store's own cap in force at session/create, following OMB_BYOK_MAX_OUTPUT_TOKENS", async () => {
    const bridge = startPollBridge("personal-store", 5, {
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "",
      OMB_CLI_OPENAI_COMPAT_KEY: "fixture-compat-key",
      OMB_CLI_OPENAI_COMPAT_URL: "http://127.0.0.1:20128/v1",
      OMB_CLI_OPENAI_COMPAT_MODELS: "stai/step-5-preview",
      OMB_BYOK_MAX_OUTPUT_TOKENS: "96000",
    });
    await bridge.request("initialize", { protocolVersion: 1, clientInfo: { name: "test", version: "0" } });
    await bridge.request("session/new", { cwd: bridge.dir, mcpServers: [] });
    expect(bridge.state().limits).toEqual({ "omb-openai-compat/stai/step-5-preview": 96000 });
  });

  it("reports an output-cap turn failure as a readable truncation naming the limit", async () => {
    const bridge = startPollBridge("personal-store", 5, {
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "",
      OMB_CLI_OPENAI_COMPAT_KEY: "fixture-compat-key",
      OMB_CLI_OPENAI_COMPAT_URL: "http://127.0.0.1:20128/v1",
      OMB_CLI_OPENAI_COMPAT_MODELS: "stai/step-5-preview",
      FAKE_ZCODE_TURN: "output-limit",
    });
    const sessionId = await newPollSession(bridge);
    await expect(pollPrompt(bridge, sessionId, "design a metro map"))
      .rejects.toThrow(/TURN_FAILED: 模型输出被截断:思考超过输出上限 64000 tokens\(stop: length\)/);
  });

  it("keeps every other turn failure on the plain TURN_FAILED wording", async () => {
    const bridge = startPollBridge("answer", 5, { FAKE_ZCODE_TURN: "vendor-error" });
    const sessionId = await newPollSession(bridge);
    await expect(pollPrompt(bridge, sessionId, "task"))
      .rejects.toThrow(/TURN_FAILED: rejected by the app server/);
  });
});

/* A fake `zcode app-server` for the poll tests: it answers the session handshake and then
 * misbehaves on `session/events` in the way the test asks for. Written to a temp directory at
 * run time so the fixture lives with the test that uses it. Modes (FAKE_ZCODE_POLL_MODE):
 *   personal-store    the catalog probe replays the vendor's personal-store decoding: the store
 *                     at ZCODE_PERSONAL_PROVIDER_CONFIG_FILE is listed only when it carries
 *                     config.modelConfigRules (CLI 0.16.9/0.17.1 discards the store whole otherwise)
 *   slow-accept       the acceptance reply lags behind a running turn's events; the events keep
 *                     the send's silence window open across several windows
 *   send-timeout-then-ok  the first send is never answered and nothing is emitted; later sends
 *                     answer and complete
 *   complete          accept and finish the turn at once with "OK complete"; the state file also
 *                     counts boots (app-server starts) and exits (the bridge ended its stdin)
 * FAKE_ZCODE_TURN turns a default-accept send into a terminal failure: "output-limit" replays the
 *           vendor's output-cap turn.failed payload, "vendor-error" an unrelated provider error.
 *           In personal-store mode the state file also records the effective output cap per
 *           provider/model the store's rules put in force (limits). */
const FAKE_POLL_APP_SERVER = `
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.FAKE_ZCODE_POLL_MODE ?? "answer";
const stateFile = process.env.FAKE_ZCODE_POLL_STATE;
const state = stateFile
  ? { polls: 0, stops: 0, sends: 0, creates: 0, boots: 0, exits: 0, limits: {}, ...JSON.parse(readFileSync(stateFile, "utf8")) }
  : { polls: 0, stops: 0, sends: 0, creates: 0, boots: 0, exits: 0, limits: {} };
const save = () => { if (stateFile) writeFileSync(stateFile, JSON.stringify(state)); };
state.boots += 1;
save();

// The vendor's decodeProviderConfigFile reads config.modelConfigRules unconditionally and drops
// the whole store when the key is missing; listed models come from the rules' personalModelIds.
// A personal provider-model rule must carry enabled:true and a positive-integer maxOutputTokens
// limit (the vendor's lenient rule schema), and the store stays dropped when a rule violates it
// or any manual rule is present (the strict manual shape always needs properties/optionSpecs).
// Effective caps start at the builtin catch-all's {max: 32000}; a personal rule's max overlays it
// because the vendor applies the personal store after the builtin rules (FIX-E54).
const personalStore = () => {
  try {
    const store = JSON.parse(readFileSync(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ?? "", "utf8"));
    const rules = store?.config && typeof store.config.modelConfigRules === "object" && store.config.modelConfigRules !== null
      && Array.isArray(store.config.providerConfigRules?.providerRules)
      ? store.config.providerConfigRules.providerRules : [];
    const modelRules = store?.config?.modelConfigRules;
    if (Array.isArray(modelRules?.manualProviderModelRules) && modelRules.manualProviderModelRules.length) return { models: [], limits: {} };
    const limits = {};
    for (const rule of Array.isArray(modelRules?.providerModelRules) ? modelRules.providerModelRules : []) {
      const max = rule?.config?.optionSpecs?.maxOutputTokens?.max;
      if (rule?.config?.enabled !== true || !Number.isInteger(max) || max <= 0) return { models: [], limits: {} };
      limits[String(rule.providerId) + "/" + String(rule.modelId)] = max;
    }
    return {
      models: rules.flatMap((rule) => (Array.isArray(rule?.config?.personalModelIds) ? rule.config.personalModelIds : [])
        .map((modelId) => ({
          ref: { providerId: String(rule.providerId), modelId: String(modelId) },
          label: String(modelId),
          ...(typeof rule.providerName === "string" ? { providerLabel: rule.providerName } : {}),
        }))),
      limits,
    };
  } catch { return { models: [], limits: {} }; }
};

let seq = 0;
let sessionId = "";
let inputId = "";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const fail = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\\n");
const notify = (type, payload) => {
  seq += 1;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/event", params: { sessionId, seq, type, payload } }) + "\\n");
};

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const id = message.id;
  const params = message.params ?? {};
  switch (message.method) {
    case "provider/updateAccountConfig":
      reply(id, { receivedRevision: params.revision, providerCount: 0, status: "received" });
      break;
    case "session/create": {
      const probe = String((params.workspace ?? {}).workspaceKey ?? "").startsWith("omb-catalog-");
      sessionId = probe ? "probe-1" : "sess-1";
      if (!probe) {
        state.creates += 1;
        save();
      }
      const store = mode === "personal-store" ? personalStore() : null;
      const available = store ? store.models
        : [{ ref: { providerId: "plan", modelId: "GLM-5.3-Flash" }, label: "GLM-5.3-Flash" }];
      if (store) {
        state.limits = store.limits;
        save();
      }
      reply(id, {
        session: { sessionId },
        settings: {
          model: {
            available,
            ...(available[0] ? { current: available[0].ref } : {}),
          },
        },
      });
      break;
    }
    case "session/subscribe":
      reply(id, { eventSeq: seq, events: [] });
      break;
    case "session/send":
      inputId = String(params.inputId ?? "");
      state.sends += 1;
      save();
      if (mode === "slow-accept") {
        // A loaded app server: the acceptance reply lands only after the running turn's events
        // have already crossed several silence windows.
        let ticks = 0;
        const trickle = setInterval(() => {
          ticks += 1;
          notify("turn.started", { turnNumber: 1 });
          if (ticks >= 10) {
            clearInterval(trickle);
            reply(id, { accepted: true });
            setTimeout(() => notify("turn.completed", {
              inputId, resultType: "success", response: "OK slow accept", usage: { inputTokens: 2, outputTokens: 2 },
            }), 30);
          }
        }, 250);
        break;
      }
      if (mode === "send-timeout-then-ok") {
        // The first send is answered by nothing at all: no reply, no event.
        if (state.sends === 1) break;
        reply(id, { accepted: true });
        setTimeout(() => notify("turn.completed", {
          inputId, resultType: "success", response: "OK after send timeout", usage: { inputTokens: 2, outputTokens: 2 },
        }), 20);
        break;
      }
      if (mode === "complete") {
        reply(id, { accepted: true });
        setTimeout(() => notify("turn.completed", {
          inputId, resultType: "success", response: "OK complete", usage: { inputTokens: 2, outputTokens: 2 },
        }), 20);
        break;
      }
      reply(id, { accepted: true });
      if (process.env.FAKE_ZCODE_TURN === "output-limit") {
        // The vendor's own wire shape for a turn that died on the output cap after its three
        // output continuations came back empty (CLI 0.16.9 turn teardown).
        setTimeout(() => notify("turn.failed", {
          inputId,
          turnPhase: "model",
          error: {
            type: "model_error",
            code: "MODEL_ERROR",
            message: "The model's response exceeded the output token maximum.",
            attribution: { source: "provider", reason: "model_output_limit_exceeded" },
          },
        }), 20);
        break;
      }
      if (process.env.FAKE_ZCODE_TURN === "vendor-error") {
        setTimeout(() => notify("turn.failed", {
          inputId,
          turnPhase: "model",
          error: { type: "provider_error", code: "PROVIDER_ERROR", message: "upstream unavailable" },
        }), 20);
        break;
      }
      if (mode === "timeout-with-events") {
        setInterval(() => notify("turn.started", { turnNumber: 1 }), 150);
      }
      break;
    case "session/events": {
      state.polls += 1;
      save();
      if (mode === "timeout" || mode === "timeout-with-events") return;
      if (mode === "timeout-once" && state.polls === 1) return;
      if (mode === "rejected") { fail(id, -32000, "the provider refused the request"); break; }
      if (mode === "timeout-once") {
        reply(id, {
          events: [{
            sessionId,
            seq: seq + 1,
            type: "turn.completed",
            payload: { inputId, resultType: "success", response: "OK after poll timeout", usage: { inputTokens: 2, outputTokens: 2 } },
          }],
        });
        break;
      }
      reply(id, { events: [] });
      break;
    }
    case "session/stop":
      state.stops += 1;
      save();
      reply(id, {});
      break;
    case "session/close":
      reply(id, {});
      break;
    default:
      reply(id, {});
  }
});
lines.on("close", () => {
  state.exits += 1;
  save();
  process.exit(0);
});
`;

interface PollBridge {
  readonly dir: string;
  request(method: string, params: unknown): Promise<any>;
  updates(): any[];
  state(): any;
  stop(): Promise<void>;
}

const pollBridges: PollBridge[] = [];

afterEach(async () => {
  await Promise.all(pollBridges.splice(0).map((bridge) => bridge.stop()));
});

/** The bridge under test, wired to the fake app server above. The poll window is shortened so a
 * timed-out poll costs 200ms instead of the vendor's 30s. */
function startPollBridge(mode: string, timeoutSec: number, extraEnv?: Record<string, string | undefined>): PollBridge {
  const dir = mkdtempSync(join(tmpdir(), "omb-zcode-poll-"));
  const stateFile = join(dir, "poll-state.json");
  const fakeCli = join(dir, "fake-poll-app-server.mjs");
  writeFileSync(stateFile, JSON.stringify({ polls: 0, stops: 0, sends: 0, creates: 0 }));
  writeFileSync(fakeCli, FAKE_POLL_APP_SERVER);
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [
    "--experimental-strip-types",
    fileURLToPath(new URL("./zcode-acp.ts", import.meta.url)),
    "--cli", fakeCli, "--mode", "yolo", "--timeout", String(timeoutSec),
  ], {
    env: {
      ...process.env,
      HOME: dir,
      OMB_ZCODE_HOME: dir,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(dir, "providers.json"),
      OMB_ZCODE_EVENT_POLL_TIMEOUT_MS: "200",
      FAKE_ZCODE_POLL_MODE: mode,
      FAKE_ZCODE_POLL_STATE: stateFile,
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const updates: any[] = [];
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let nextId = 1;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (message?.method === "session/update") {
      updates.push(message.params);
      return;
    }
    if (message?.id === undefined) return;
    const call = pending.get(Number(message.id));
    if (!call) return;
    pending.delete(Number(message.id));
    clearTimeout(call.timer);
    if (message.error) call.reject(new Error(`${message.error.code}: ${message.error.message}`));
    else call.resolve(message.result);
  });
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`bridge did not answer ${method}`));
    }, 10_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const bridge: PollBridge = {
    dir,
    request,
    updates: () => updates,
    state: () => JSON.parse(readFileSync(stateFile, "utf8")),
    stop: () => new Promise<void>((resolve) => {
      if (child.exitCode !== null) { resolve(); return; }
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("close", () => {
        clearTimeout(timer);
        lines.close();
        // The bridge exits without awaiting its app servers, so the fake's final state write can
        // land after the delete has begun.
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* leftover temp dir */ }
        resolve();
      });
      child.kill("SIGTERM");
    }),
  };
  pollBridges.push(bridge);
  return bridge;
}

async function newPollSession(bridge: PollBridge): Promise<string> {
  await bridge.request("initialize", { protocolVersion: 1, clientInfo: { name: "test", version: "0" } });
  const created = await bridge.request("session/new", { cwd: bridge.dir, mcpServers: [] });
  expect(created.sessionId).toMatch(/^zcode-/);
  return created.sessionId;
}

const pollPrompt = (bridge: PollBridge, sessionId: string, text: string) =>
  bridge.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });

const pollChunkText = (updates: any[]): string => updates
  .filter((entry) => entry.update?.sessionUpdate === "agent_message_chunk")
  .map((entry) => entry.update.content?.text ?? "")
  .join("");

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("isTransientPollError", () => {
  it("treats a poll timeout as transient", () => {
    expect(isTransientPollError({ code: "RPC_TIMEOUT" })).toBe(true);
    expect(isTransientPollError(new Error("RPC_TIMEOUT"))).toBe(true);
    const vendorTimeout = new Error("RPC_REJECTED");
    (vendorTimeout as any).detail = { message: "request timed out" };
    expect(isTransientPollError(vendorTimeout)).toBe(true);
  });

  it("leaves a final failure alone", () => {
    expect(isTransientPollError({ code: "APP_SERVER_EXITED" })).toBe(false);
    expect(isTransientPollError({ code: "CANCELLED" })).toBe(false);
    expect(isTransientPollError(new Error("CANCELLED"))).toBe(false);
    expect(isTransientPollError(new Error("RPC_REJECTED"))).toBe(false);
    const stale = new Error("RPC_REJECTED");
    (stale as any).detail = { message: "session is not resident: sess-1 (proto.sessionNotResident)" };
    expect(isTransientPollError(stale)).toBe(false);
    expect(isTransientPollError(undefined)).toBe(false);
  });
});

describe("zcode ACP bridge poll resilience", () => {
  it("keeps the turn alive after one poll times out and finishes with the next poll's answer", async () => {
    const bridge = startPollBridge("timeout-once", 5);
    const sessionId = await newPollSession(bridge);
    const result = await pollPrompt(bridge, sessionId, "long task");
    expect(result.stopReason).toBe("end_turn");
    expect(pollChunkText(bridge.updates())).toBe("OK after poll timeout");
    expect(bridge.state().polls).toBeGreaterThanOrEqual(2);
  });

  it("ends the turn with TURN_TIMEOUT and stops the native session when every poll times out", async () => {
    const bridge = startPollBridge("timeout", 1);
    const sessionId = await newPollSession(bridge);
    await expect(pollPrompt(bridge, sessionId, "stuck task")).rejects.toThrow(/TURN_TIMEOUT/);
    await waitFor(() => bridge.state().stops > 0);
    expect(bridge.state().stops).toBeGreaterThan(0);
    expect(bridge.state().polls).toBeGreaterThan(1);
  });

  it("gives up when the polls keep timing out even though events still arrive", async () => {
    const bridge = startPollBridge("timeout-with-events", 1);
    const sessionId = await newPollSession(bridge);
    await expect(pollPrompt(bridge, sessionId, "stuck task")).rejects.toThrow(/TURN_TIMEOUT/);
    await waitFor(() => bridge.state().stops > 0);
    expect(bridge.state().stops).toBeGreaterThan(0);
    // The arriving events keep the silence window open, so only the streak bound ends this turn.
    expect(bridge.state().polls).toBeGreaterThanOrEqual(3);
  });

  it("fails the turn at once when a poll fails for a reason that is not transient", async () => {
    const bridge = startPollBridge("rejected", 5);
    const sessionId = await newPollSession(bridge);
    await expect(pollPrompt(bridge, sessionId, "task")).rejects.toThrow(/RPC_REJECTED/);
    expect(bridge.state().polls).toBe(1);
  });
});

describe("zcode ACP bridge send wait", () => {
  it("keeps the send waiting across several silence windows while the app server streams events, and finishes the turn", async () => {
    const bridge = startPollBridge("slow-accept", 1);
    const sessionId = await newPollSession(bridge);
    const result = await pollPrompt(bridge, sessionId, "long task");
    expect(result.stopReason).toBe("end_turn");
    expect(pollChunkText(bridge.updates())).toBe("OK slow accept");
    // One send only: a late acceptance must never become a resend of an unknown-outcome task.
    expect(bridge.state().sends).toBe(1);
  });

  it("times out a fully silent send at the window with a clear error, leaves the native turn alone, and the retry reuses it", async () => {
    const bridge = startPollBridge("send-timeout-then-ok", 1);
    const sessionId = await newPollSession(bridge);
    await expect(pollPrompt(bridge, sessionId, "stuck task"))
      .rejects.toThrow(/RPC_TIMEOUT: rejected by the app server/);
    // No stop and no session reset: the send's outcome is unknown, so the retry must meet the
    // native session as it is (E18) instead of tearing it down.
    expect(bridge.state().stops).toBe(0);
    const retry = await pollPrompt(bridge, sessionId, "stuck task");
    expect(retry.stopReason).toBe("end_turn");
    expect(pollChunkText(bridge.updates())).toBe("OK after send timeout");
    expect(bridge.state().sends).toBe(2);
    expect(bridge.state().creates).toBe(1);
  });
});

describe("zcode app-server idle recycle (FIX-E52)", () => {
  it("shuts an idle app server down and clears the session once the quiet period passes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const storage = mkdtempSync(join(tmpdir(), "omb-zcode-recycle-"));
    try {
      const shutdown = vi.fn(() => Promise.resolve());
      const app = { shutdown };
      const session: ZcodeRecyclableSession = { busy: false, closed: false, lastSeq: 7, app, storage, zcodeSessionId: "sess-9" };
      scheduleZcodeAppServerRecycle(session, 120_000);
      vi.advanceTimersByTime(119_999);
      expect(shutdown).not.toHaveBeenCalled();
      expect(existsSync(storage)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(session.app).toBeUndefined();
      expect(session.zcodeSessionId).toBeUndefined();
      expect(session.lastSeq).toBe(0);
      expect(session.recycleTimer).toBeUndefined();
      await Promise.resolve();
      expect(session.storage).toBeUndefined();
      expect(existsSync(storage)).toBe(false);
    } finally {
      rmSync(storage, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("keeps the app server when the next prompt cancels the recycle inside the window", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const shutdown = vi.fn(() => Promise.resolve());
      const app = { shutdown };
      const session: ZcodeRecyclableSession = { busy: false, closed: false, lastSeq: 3, app, zcodeSessionId: "sess-1" };
      scheduleZcodeAppServerRecycle(session, 120_000);
      vi.advanceTimersByTime(90_000);
      cancelZcodeAppServerRecycle(session);
      vi.advanceTimersByTime(600_000);
      expect(shutdown).not.toHaveBeenCalled();
      expect(session.app).toBe(app);
      expect(session.zcodeSessionId).toBe("sess-1");
      expect(session.recycleTimer).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-arms the recycle at the follow-up turn's end and fires from there", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const shutdown = vi.fn(() => Promise.resolve());
      const session: ZcodeRecyclableSession = { busy: false, closed: false, lastSeq: 1, app: { shutdown } };
      scheduleZcodeAppServerRecycle(session, 120_000);
      vi.advanceTimersByTime(60_000);
      cancelZcodeAppServerRecycle(session);
      vi.advanceTimersByTime(600_000);
      expect(shutdown).not.toHaveBeenCalled();
      scheduleZcodeAppServerRecycle(session, 120_000);
      vi.advanceTimersByTime(119_999);
      expect(shutdown).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(shutdown).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults the quiet period to 120s and reads OMB_ZCODE_RECYCLE_IDLE_SEC, capped at a day", () => {
    expect(zcodeRecycleIdleMs({})).toBe(120_000);
    expect(zcodeRecycleIdleMs({ OMB_ZCODE_RECYCLE_IDLE_SEC: "5" })).toBe(5_000);
    expect(zcodeRecycleIdleMs({ OMB_ZCODE_RECYCLE_IDLE_SEC: "0" })).toBe(120_000);
    expect(zcodeRecycleIdleMs({ OMB_ZCODE_RECYCLE_IDLE_SEC: "-3" })).toBe(120_000);
    expect(zcodeRecycleIdleMs({ OMB_ZCODE_RECYCLE_IDLE_SEC: "junk" })).toBe(120_000);
    expect(zcodeRecycleIdleMs({ OMB_ZCODE_RECYCLE_IDLE_SEC: "1000000" })).toBe(86_400_000);
  });
});

describe("zcode ACP bridge idle recycle (FIX-E52)", () => {
  it("recycles the app server once the quiet period passes after a turn, and respawns for the next prompt", async () => {
    const bridge = startPollBridge("complete", 5, { OMB_ZCODE_RECYCLE_IDLE_SEC: "1" });
    const sessionId = await newPollSession(bridge);
    const result = await pollPrompt(bridge, sessionId, "first task");
    expect(result.stopReason).toBe("end_turn");
    expect(pollChunkText(bridge.updates())).toBe("OK complete");
    expect(bridge.state().boots).toBe(1);
    await waitFor(() => bridge.state().exits >= 1, 5_000);
    expect(bridge.state().exits).toBeGreaterThanOrEqual(1);
    const retry = await pollPrompt(bridge, sessionId, "second task");
    expect(retry.stopReason).toBe("end_turn");
    const state = bridge.state();
    expect(state.boots).toBe(2);
    expect(state.creates).toBe(2);
  }, 20_000);

  it("keeps the app server across prompts inside the quiet period and recycles only after the last one", async () => {
    const bridge = startPollBridge("complete", 5, { OMB_ZCODE_RECYCLE_IDLE_SEC: "3" });
    const sessionId = await newPollSession(bridge);
    const first = await pollPrompt(bridge, sessionId, "first task");
    expect(first.stopReason).toBe("end_turn");
    const second = await pollPrompt(bridge, sessionId, "second task");
    expect(second.stopReason).toBe("end_turn");
    const state = bridge.state();
    expect(state.boots).toBe(1);
    expect(state.creates).toBe(1);
    expect(state.exits).toBe(0);
    await waitFor(() => bridge.state().exits >= 1, 10_000);
    expect(bridge.state().exits).toBeGreaterThanOrEqual(1);
    expect(bridge.state().boots).toBe(1);
    expect(bridge.state().creates).toBe(1);
  }, 25_000);
});
