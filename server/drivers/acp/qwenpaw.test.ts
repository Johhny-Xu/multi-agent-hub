// @vitest-environment node
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs, instanceConfigs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import {
  applyQwenpawByokEnv,
  qwenpawByokProviders,
  qwenpawCatalog,
  qwenpawRuntimeTarget,
  QwenPawAgentDriver,
  qwenpawHome,
  resolveQwenpawCli,
} from "./qwenpaw.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");

/** A key that exists only in this test; it never names a real provider credential. */
const FIXTURE_KEY = "sk-qwenpaw-byok-fixture";

describe("QwenPaw ACP driver", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  beforeEach(() => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "omb-qwenpaw-contract-"));
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
    vi.unstubAllEnvs();
    await removeTempDir(scratch);
  });

  function writeVersionFixture(banner: string, exitCode = 0): string {
    const path = join(scratch, "bin", "qwenpaw");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "${banner}"\nexit ${exitCode}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it("is discoverable in fresh and existing product fleets", () => {
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "qwenpawAgent")).toBe(true);
    expect(instanceConfigs({}).qwenpaw?.driver).toBe("qwenpawAgent");
    expect(instanceConfigs({ instances: { claude: { driver: "claudeAgent" } } }).qwenpaw?.driver).toBe("qwenpawAgent");
    expect(instanceConfigs({ instances: { fixture: { driver: "fake" } } }).qwenpaw).toBeUndefined();
    expect(QwenPawAgentDriver.models.default).toBe("kilo:kilo-auto/free");
  });

  it("offers the CLI's own free tier and no personal provider key", async () => {
    instance = await QwenPawAgentDriver.create({
      instanceId: "qwenpaw-models", displayName: "QwenPaw", enabled: true,
      environment: { HOME: scratch },
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const ids = instance.models.options.map((option) => option.id);
    expect(ids).toContain("kilo:kilo-auto/free");
    expect(ids.some((id) => /sk-|api[-_]?key/i.test(id))).toBe(false);
    expect(ids.every((id) => id.endsWith(":free") || id.endsWith("/free") || id.includes("QwenPaw-Flash"))).toBe(true);
  });

  it("resolves the working dir and the CLI fallback", () => {
    expect(qwenpawHome({ HOME: scratch })).toBe(join(scratch, ".qwenpaw"));
    expect(qwenpawHome({ HOME: scratch, QWENPAW_WORKING_DIR: "/elsewhere" })).toBe("/elsewhere");
    expect(resolveQwenpawCli({}, "qwenpaw")).toBe("qwenpaw");
    expect(resolveQwenpawCli({ HOME: scratch }, "qwenpaw")).toBe("qwenpaw");
    const bin = join(scratch, ".local", "bin", "qwenpaw");
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    expect(resolveQwenpawCli({ HOME: scratch }, "qwenpaw")).toBe(bin);
    expect(resolveQwenpawCli({ HOME: scratch, OMB_QWENPAW_CLI: join(scratch, "over", "qwenpaw") }, "qwenpaw")).toBe(join(scratch, "over", "qwenpaw"));
  });

  it("runs a turn through native acp with no permission flag", async () => {
    instance = await QwenPawAgentDriver.create({
      instanceId: "qwenpaw-contract", displayName: "QwenPaw", enabled: true,
      environment: { HOME: scratch, FAKE_ACP_DUMP: join(scratch, "launch.json"), FAKE_ACP_TEXT_REPLY: "OK fixture", FAKE_ACP_MODELS: "kilo:kilo-auto/free" },
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "qwenpaw-chat", text: "hello", model: "kilo:kilo-auto/free", approvalMode: "full",
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(recorder.events.some((event) => event.type === "content.delta")).toBe(true);
    expect(recorder.events.every((event) => event.provider === "qwenpawAgent")).toBe(true);
    const launch = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8"));
    expect(launch.argv).toEqual(["acp"]);
  });

  it("reads the version off the CLI's own banner", async () => {
    const cli = writeVersionFixture("QwenPaw, version 2.2.2.post1");
    instance = await QwenPawAgentDriver.create({
      instanceId: "qwenpaw-version", displayName: "QwenPaw", enabled: true,
      environment: { HOME: scratch },
      config: { cli, fullAuto: false },
    });
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true, version: "2.2.2.post1" });
  });

  it("reports a foreign executable and a missing CLI as unavailable", async () => {
    const foreign = writeVersionFixture("busybox v1.36");
    instance = await QwenPawAgentDriver.create({
      instanceId: "qwenpaw-foreign", displayName: "QwenPaw", enabled: true,
      environment: { HOME: scratch },
      config: { cli: foreign, fullAuto: false },
    });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable", notEngineCli: true });
    await instance.dispose();
    recorder?.stop();
    recorder = undefined;
    instance = await QwenPawAgentDriver.create({
      instanceId: "qwenpaw-missing", displayName: "QwenPaw", enabled: true,
      environment: {},
      config: { cli: join(scratch, "missing-qwenpaw"), fullAuto: false },
    });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
  });

  it("keeps the banner when the version command exits non-zero", async () => {
    const cli = writeVersionFixture("QwenPaw, version 2.2.2.post1", 1);
    instance = await QwenPawAgentDriver.create({
      instanceId: "qwenpaw-exit1", displayName: "QwenPaw", enabled: true,
      environment: { HOME: scratch },
      config: { cli, fullAuto: false },
    });
    expect(await instance.snapshot()).toMatchObject({ state: "available", version: "2.2.2.post1" });
  });

  it("lists no BYOK model while no provider key is saved", () => {
    const catalog = qwenpawCatalog({});
    expect(catalog.options.some((option) => option.provider === "openrouter")).toBe(false);
    expect(catalog.options.every((option) => option.provider === "kilo" || option.provider === "qwenpaw-local")).toBe(true);
    expect(qwenpawByokProviders({})).toEqual([]);
  });

  it("merges the saved BYOK providers into the model list and labels their source", () => {
    const catalog = qwenpawCatalog({
      openrouter: { key: FIXTURE_KEY },
      openaiCompat: { key: FIXTURE_KEY, url: "https://compat.example/v1", model: "demo-model" },
    });
    const openrouter = catalog.options.find((option) => option.id.startsWith("openrouter:"));
    expect(openrouter?.provider).toBe("openrouter");
    expect(openrouter?.label).toContain("OpenRouter");
    const compat = catalog.options.find((option) => option.id === "openai-compat:demo-model");
    expect(compat?.provider).toBe("openai-compat");
    expect(catalog.options.some((option) => option.id === "kilo:kilo-auto/free")).toBe(true);
    // A key never rides along in an id or a label.
    expect(JSON.stringify(catalog)).not.toContain(FIXTURE_KEY);
  });

  it("offers every saved BYOK provider with its own key, and no model without one", () => {
    const providers = qwenpawByokProviders({
      openai: { key: FIXTURE_KEY },
      anthropic: { key: FIXTURE_KEY },
      gemini: { key: FIXTURE_KEY },
      xai: { key: FIXTURE_KEY },
      mistral: { key: FIXTURE_KEY },
      cerebras: { key: FIXTURE_KEY },
      groq: { key: FIXTURE_KEY },
      greenference: { key: FIXTURE_KEY },
      meta: { key: FIXTURE_KEY },
      deepseek: { key: FIXTURE_KEY },
      openrouter: { key: FIXTURE_KEY },
      zhipu: { key: FIXTURE_KEY },
    });
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    expect([...byId.keys()].sort()).toEqual([
      "anthropic", "cerebras", "deepseek", "gemini", "greenference", "groq", "meta", "mistral", "openai", "openrouter", "xai", "zhipu",
    ]);
    expect(byId.get("anthropic")).toMatchObject({ baseUrl: "https://api.anthropic.com", protocol: "anthropic" });
    expect(byId.get("gemini")?.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(byId.get("xai")?.baseUrl).toBe("https://api.x.ai/v1");
    expect(byId.get("mistral")?.baseUrl).toBe("https://api.mistral.ai/v1");
    expect(byId.get("cerebras")?.baseUrl).toBe("https://api.cerebras.ai/v1");
    expect(byId.get("groq")?.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(byId.get("greenference")?.baseUrl).toBe("https://llm.eu.greenference.com/v1");
    expect(byId.get("meta")?.baseUrl).toBe("https://api.meta.ai/v1");
    // Every provider's own key reaches its own models, and a key never rides along in a label.
    expect(JSON.stringify(qwenpawCatalog({
      openai: { key: FIXTURE_KEY },
      anthropic: { key: FIXTURE_KEY },
      instances: {
        "openai-compat-a": { driver: "openai-compat", displayName: "First", config: { key: "sk-first", url: "https://first.example/v1", managedModels: ["m1"] } },
        "openai-compat-b": { driver: "openai-compat", displayName: "Second", config: { key: "sk-second", url: "https://second.example/v1", managedModels: ["m2"] } },
      },
    }))).not.toContain(FIXTURE_KEY);
  });

  it("keeps each OpenAI-compatible server on its own key", () => {
    const cfg = {
      instances: {
        "openai-compat-a": { driver: "openai-compat" as const, displayName: "First", config: { key: "sk-first", url: "https://first.example/v1", managedModels: ["m1"] } },
        "openai-compat-b": { driver: "openai-compat" as const, displayName: "Second", config: { key: "sk-second", url: "https://second.example/v1", managedModels: ["m2"] } },
      },
    };
    const first = qwenpawRuntimeTarget("openai-compat-a:m1", cfg);
    const second = qwenpawRuntimeTarget("openai-compat-b:m2", cfg);
    expect(first).toMatchObject({ provider: "openai-compat-a", baseUrl: "https://first.example/v1", apiKey: "sk-first", model: "m1" });
    expect(second).toMatchObject({ provider: "openai-compat-b", baseUrl: "https://second.example/v1", apiKey: "sk-second", model: "m2" });
    // A model of one server is not offered on the other.
    expect(qwenpawRuntimeTarget("openai-compat-b:m1", cfg)).toBeNull();
  });

  it("resolves the provider connection of a picked BYOK model", () => {
    const target = qwenpawRuntimeTarget("openrouter:nvidia/nemotron-3-super-120b-a12b:free", { openrouter: { key: FIXTURE_KEY } });
    expect(target).toMatchObject({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: FIXTURE_KEY,
      model: "nvidia/nemotron-3-super-120b-a12b:free",
    });
    expect(qwenpawRuntimeTarget("kilo:kilo-auto/free", { openrouter: { key: FIXTURE_KEY } })).toBeNull();
    expect(qwenpawRuntimeTarget("openrouter:nvidia/nemotron-3-super-120b-a12b:free", {})).toBeNull();
  });

  it("injects the provider's base url, key and model into the child env", () => {
    const env: Record<string, string | undefined> = { HOME: scratch };
    applyQwenpawByokEnv(env, {
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: FIXTURE_KEY,
      model: "nvidia/nemotron-3-super-120b-a12b:free",
      protocol: "chat",
    });
    expect(env.OPENAI_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(env.OPENAI_API_KEY).toBe(FIXTURE_KEY);
    expect(env.OPENAI_MODEL).toBe("nvidia/nemotron-3-super-120b-a12b:free");
    expect(JSON.parse(env.QWENPAW_MODEL_INFO_JSON!)).toEqual({ protocol: "chat" });
  });

  it("starts the CLI in its ephemeral provider mode for a BYOK pick and keeps the key out of the log", async () => {
    vi.stubEnv("OPENAI_COMPAT_API_KEY", FIXTURE_KEY);
    vi.stubEnv("OPENAI_COMPAT_URL", "https://compat.example/v1");
    vi.stubEnv("OPENAI_COMPAT_MODEL", "demo-model");
    instance = await QwenPawAgentDriver.create({
      instanceId: "qwenpaw-byok", displayName: "QwenPaw", enabled: true,
      environment: {
        HOME: scratch,
        FAKE_ACP_DUMP: join(scratch, "launch.json"),
        FAKE_ACP_TEXT_REPLY: "OK fixture",
        FAKE_ACP_SESSION_MODELS: "runtime-openai:demo-model|Demo",
      },
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "qwenpaw-byok-chat", text: "hello", model: "openai-compat:demo-model", approvalMode: "full",
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const launch = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8"));
    expect(launch.argv).toEqual(["acp", "--runtime-provider", "openai-env"]);
    expect(launch.env.OPENAI_API_KEY).toBe(FIXTURE_KEY);
    // The key rides the child env only: it reaches neither the event log nor the model list.
    expect(JSON.stringify(recorder.events)).not.toContain(FIXTURE_KEY);
    expect(JSON.stringify(instance.models.options)).not.toContain(FIXTURE_KEY);
  });

  it("serves an apiKeyEnv instance by reading its environment variable", () => {
    vi.stubEnv("QBOX_QWENPAW_ENV_KEY", "sk-env-instance-fixture");
    const cfg = {
      instances: {
        "openai-compat-env": {
          driver: "openai-compat" as const,
          displayName: "Env First",
          config: { apiKeyEnv: "QBOX_QWENPAW_ENV_KEY", url: "https://env.example/v1", managedModels: ["env-model"] },
        },
      },
    };
    expect(qwenpawCatalog(cfg).options.map((option) => option.id)).toContain("openai-compat-env:env-model");
    const target = qwenpawRuntimeTarget("openai-compat-env:env-model", cfg);
    expect(target).toMatchObject({
      provider: "openai-compat-env",
      baseUrl: "https://env.example/v1",
      apiKey: "sk-env-instance-fixture",
      model: "env-model",
    });
    // applyTurnEnv writes the spawn env through applyQwenpawByokEnv: the env-resolved key rides it
    // exactly like a config key would.
    const env: Record<string, string | undefined> = { HOME: scratch };
    applyQwenpawByokEnv(env, target!);
    expect(env.OPENAI_API_KEY).toBe("sk-env-instance-fixture");
    expect(env.OPENAI_BASE_URL).toBe("https://env.example/v1");
    expect(env.OPENAI_MODEL).toBe("env-model");
  });

  it("skips an apiKeyEnv instance whose environment variable is missing", () => {
    const missing = "QBOX_QWENPAW_MISSING_KEY_ENV";
    const saved = process.env[missing];
    delete process.env[missing];
    const cfg = {
      instances: {
        "openai-compat-missing": {
          driver: "openai-compat" as const,
          displayName: "Missing Env",
          config: { apiKeyEnv: missing, url: "https://missing.example/v1", managedModels: ["missing-model"] },
        },
      },
    };
    try {
      expect(qwenpawByokProviders(cfg)).toEqual([]);
      expect(qwenpawCatalog(cfg).options.some((option) => option.id === "openai-compat-missing:missing-model")).toBe(false);
      // An empty variable is as good as a missing one.
      vi.stubEnv(missing, "");
      expect(qwenpawByokProviders(cfg)).toEqual([]);
    } finally {
      if (saved !== undefined) process.env[missing] = saved;
    }
  });

  it("reads openai-compat's default key variable when an instance names none", () => {
    vi.stubEnv("OPENAI_COMPAT_API_KEY", "sk-default-env-fixture");
    const cfg = {
      instances: {
        "openai-compat-default": {
          driver: "openai-compat" as const,
          displayName: "Default Env",
          config: { url: "https://default.example/v1", managedModels: ["default-model"] },
        },
      },
    };
    expect(qwenpawByokProviders(cfg)).toEqual([
      expect.objectContaining({ id: "openai-compat-default", apiKey: "sk-default-env-fixture", baseUrl: "https://default.example/v1" }),
    ]);
  });

  it("keeps an instance's key out of the catalog and every serializable output", () => {
    vi.stubEnv("QBOX_QWENPAW_SECRET_ENV", "sk-env-secret-fixture");
    const cfg = {
      instances: {
        "openai-compat-a": { driver: "openai-compat" as const, displayName: "Keyed", config: { key: "sk-config-secret-fixture", url: "https://first.example/v1", managedModels: ["m1"] } },
        "openai-compat-b": { driver: "openai-compat" as const, displayName: "Env Keyed", config: { apiKeyEnv: "QBOX_QWENPAW_SECRET_ENV", url: "https://second.example/v1", managedModels: ["m2"] } },
      },
    };
    const ids = qwenpawCatalog(cfg).options.map((option) => option.id);
    expect(ids).toEqual(expect.arrayContaining(["openai-compat-a:m1", "openai-compat-b:m2"]));
    expect(JSON.stringify(qwenpawCatalog(cfg))).not.toContain("sk-config-secret-fixture");
    expect(JSON.stringify(qwenpawCatalog(cfg))).not.toContain("sk-env-secret-fixture");
  });

  it("spawns an anthropic BYOK pick with the provider's key in its env", async () => {
    vi.stubEnv("OMB_ANTHROPIC_API_KEY", "sk-anthropic-fixture");
    vi.stubEnv("OMB_ANTHROPIC_API_URL", "");
    instance = await QwenPawAgentDriver.create({
      instanceId: "qwenpaw-anthropic", displayName: "QwenPaw", enabled: true,
      environment: {
        HOME: scratch,
        FAKE_ACP_DUMP: join(scratch, "launch-anthropic.json"),
        FAKE_ACP_TEXT_REPLY: "OK fixture",
        FAKE_ACP_SESSION_MODELS: "runtime-openai:claude-sonnet-5|Claude",
      },
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "qwenpaw-anthropic-chat", text: "hello", model: "anthropic:claude-sonnet-5", approvalMode: "full",
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const launch = JSON.parse(readFileSync(join(scratch, "launch-anthropic.json"), "utf8"));
    expect(launch.argv).toEqual(["acp", "--runtime-provider", "openai-env"]);
    expect(launch.env.OPENAI_API_KEY).toBe("sk-anthropic-fixture");
    // The key rides the child env only: it reaches neither the event log nor the model list.
    expect(JSON.stringify(recorder.events)).not.toContain("sk-anthropic-fixture");
    expect(JSON.stringify(instance.models.options)).not.toContain("sk-anthropic-fixture");
  });

  it("spawns a mistral BYOK pick with the provider's key in its env", async () => {
    vi.stubEnv("MISTRAL_API_KEY", "sk-mistral-fixture");
    instance = await QwenPawAgentDriver.create({
      instanceId: "qwenpaw-mistral", displayName: "QwenPaw", enabled: true,
      environment: {
        HOME: scratch,
        FAKE_ACP_DUMP: join(scratch, "launch-mistral.json"),
        FAKE_ACP_TEXT_REPLY: "OK fixture",
        FAKE_ACP_SESSION_MODELS: "runtime-openai:mistral-large-latest|Mistral",
      },
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "qwenpaw-mistral-chat", text: "hello", model: "mistral:mistral-large-latest", approvalMode: "full",
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const launch = JSON.parse(readFileSync(join(scratch, "launch-mistral.json"), "utf8"));
    expect(launch.argv).toEqual(["acp", "--runtime-provider", "openai-env"]);
    expect(launch.env.OPENAI_API_KEY).toBe("sk-mistral-fixture");
    expect(JSON.stringify(recorder.events)).not.toContain("sk-mistral-fixture");
    expect(JSON.stringify(instance.models.options)).not.toContain("sk-mistral-fixture");
  });
});

describe("QwenPaw BYOK stream-idle window (E50)", () => {
  const target = { provider: "openai-compat", baseUrl: "http://127.0.0.1:20128/v1", apiKey: "k", model: "stai/step-5-preview", protocol: "chat" as const };
  it("widens QwenPaw's 30 s stream-idle timeout for BYOK runs", () => {
    const env: Record<string, string | undefined> = {};
    applyQwenpawByokEnv(env, target);
    expect(env.QWENPAW_LLM_STREAM_IDLE_TIMEOUT).toBe("300");
  });
  it("keeps a stream-idle timeout the caller already set", () => {
    const env: Record<string, string | undefined> = { QWENPAW_LLM_STREAM_IDLE_TIMEOUT: "90" };
    applyQwenpawByokEnv(env, target);
    expect(env.QWENPAW_LLM_STREAM_IDLE_TIMEOUT).toBe("90");
  });
});
