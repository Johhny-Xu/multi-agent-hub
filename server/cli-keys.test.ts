import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_DIR, ensureDirs, loadConfig, saveConfig, type AppConfig } from "./config.ts";
import {
  applyCentralCliKeys,
  centralCliKeyEnv,
  DEFAULT_ZHIPU_BASE_URL,
  DEFAULT_ZHIPU_MODELS,
  zcodeCentralKeyEnv,
} from "./cli-keys.ts";

const config = (patch: AppConfig): AppConfig => patch;

describe("centralCliKeyEnv", () => {
  it("puts each deployed key under the names its CLIs read", () => {
    const env = centralCliKeyEnv(config({
      anthropic: { key: "sk-ant-x", url: "https://anthropic.example" },
      openai: { key: "sk-openai" },
      gemini: { key: "AIza-x" },
      zhipu: { key: "zhipu-x" },
    }));
    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: "sk-ant-x",
      ANTHROPIC_AUTH_TOKEN: "sk-ant-x",
      ANTHROPIC_BASE_URL: "https://anthropic.example",
      OPENAI_API_KEY: "sk-openai",
      GEMINI_API_KEY: "AIza-x",
      GOOGLE_API_KEY: "AIza-x",
      ZHIPU_API_KEY: "zhipu-x",
      BIGMODEL_API_KEY: "zhipu-x",
    });
  });

  it("lets an explicit OpenAI key beat the OpenAI-compatible one", () => {
    const env = centralCliKeyEnv(config({
      openai: { key: "sk-openai" },
      openaiCompat: { key: "sk-compat", url: "https://compat.example/v1" },
    }));
    expect(env.OPENAI_API_KEY).toBe("sk-openai");
    expect(env.OPENAI_BASE_URL).toBe("https://compat.example/v1");
  });

  it("falls back to the OpenAI-compatible key when no OpenAI key is saved", () => {
    const env = centralCliKeyEnv(config({ openaiCompat: { key: "sk-compat", url: "https://compat.example/v1" } }));
    expect(env.OPENAI_API_KEY).toBe("sk-compat");
  });

  it("says nothing for a whitespace-only or missing key", () => {
    expect(centralCliKeyEnv(config({ gemini: { key: "   " } }))).not.toHaveProperty("GEMINI_API_KEY");
    expect(centralCliKeyEnv({})).toEqual({});
  });
});

describe("applyCentralCliKeys", () => {
  it("adds a deployed key only where the engine declared it reads one", () => {
    const env: Record<string, string | undefined> = {};
    applyCentralCliKeys(env, config({ gemini: { key: "AIza-x" }, zhipu: { key: "zhipu-x" } }), new Set(["GEMINI_API_KEY"]));
    expect(env).toEqual({ GEMINI_API_KEY: "AIza-x" });
  });

  it("keeps a key the instance set for itself", () => {
    const env: Record<string, string | undefined> = { GEMINI_API_KEY: "own" };
    applyCentralCliKeys(env, config({ gemini: { key: "AIza-x" } }), new Set(["GEMINI_API_KEY"]), { GEMINI_API_KEY: "own" });
    expect(env.GEMINI_API_KEY).toBe("own");
  });

  it("replaces a stray server variable with the deployed key", () => {
    const env: Record<string, string | undefined> = { GOOGLE_API_KEY: "someone-elses" };
    applyCentralCliKeys(env, config({ gemini: { key: "AIza-x" } }), new Set(["GEMINI_API_KEY", "GOOGLE_API_KEY"]));
    expect(env.GOOGLE_API_KEY).toBe("AIza-x");
  });
});

describe("zcodeCentralKeyEnv", () => {
  it("hands the bridge a Zhipu key with its base URL and models", () => {
    expect(zcodeCentralKeyEnv(config({ zhipu: { key: "zhipu-x" } }))).toEqual({
      OMB_CLI_ZHIPU_KEY: "zhipu-x",
      OMB_CLI_ZHIPU_URL: DEFAULT_ZHIPU_BASE_URL,
      OMB_CLI_ZHIPU_MODELS: DEFAULT_ZHIPU_MODELS.join(","),
    });
  });

  it("takes the person's own model list and server", () => {
    const env = zcodeCentralKeyEnv(config({ zhipu: { key: "zhipu-x", url: "https://zhipu.example/v4", models: ["glm-9"] } }));
    expect(env).toMatchObject({ OMB_CLI_ZHIPU_URL: "https://zhipu.example/v4", OMB_CLI_ZHIPU_MODELS: "glm-9" });
  });

  it("only offers an OpenAI-compatible provider when its URL and model are known", () => {
    expect(zcodeCentralKeyEnv(config({ openaiCompat: { key: "sk-compat", url: "https://compat.example/v1" } }))).toEqual({});
    expect(zcodeCentralKeyEnv(config({ openaiCompat: { key: "sk-compat", url: "https://compat.example/v1", model: "m-1" } })))
      .toEqual({
        OMB_CLI_OPENAI_COMPAT_KEY: "sk-compat",
        OMB_CLI_OPENAI_COMPAT_URL: "https://compat.example/v1",
        OMB_CLI_OPENAI_COMPAT_MODELS: "m-1",
      });
  });
});

describe("deploying a key", () => {
  it("keeps it in the 0600 config the server reads back", () => {
    ensureDirs();
    saveConfig({ gemini: { key: "AIza-deployed" }, zhipu: { key: "zhipu-deployed", models: ["glm-9"] } });
    const file = join(DATA_DIR, "config.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const cfg = loadConfig();
    expect(cfg.gemini?.key).toBe("AIza-deployed");
    expect(cfg.zhipu).toEqual({ key: "zhipu-deployed", models: ["glm-9"] });
  });
});
