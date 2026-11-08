// @vitest-environment node
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs, instanceConfigs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import { PerchAgentDriver, perchByolmModelId, perchSignedIn, resolvePerchCli } from "./perch.ts";
import { parsePerchOptions, perchBundlePath, perchModelOptions, perchPrivateSettingsDir, perchSelectedModel, selectPerchModel } from "./perch-models.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");

const SIGNED_OUT_STATUS = "Perch CLI 2.4.125 · Not signed in. Run `perch login`.\nMemory: unavailable; sign in or run from a .perch project";
const SIGNED_IN_STATUS = "Perch CLI 2.4.125 · Signed in as tester@example.com";

// The shape perchai-cli 2.4.125 ships: option-id constants, the Starter/Pro/Ultra groups, the
// trial list and the label map, all before the picker table `hx` that ties them together.
const BUNDLE_FIXTURE = [
  'var ow="openrouter-deepseek-deepseek-v4-1-flash-crusoe",x2="openrouter-z-ai-glm-5-3-flash-crusoe",',
  '_j=Uo("openrouter","stealth/crouton-alpha"),HG=Uo("openrouter","reflection/beam-1.0"),',
  'cre=Uo("gemini","gemini-4-argon"),FG=Uo("openrouter","qwen/qwen3-8-max-0902"),',
  'mre=Uo("anthropic","claude-opus-5-5"),jG=Uo("azure_foundry","gpt-6.1-sol"),',
  '$G=Uo("azure_foundry","gpt-6-sol"),yre=Uo("openrouter","moonshotai/kimi-k3.1-pro"),',
  'KG=Uo("azure_foundry","grok-4.7"),E2=Uo("openrouter","z-ai/glm-5.3"),',
  'vre=Uo("openrouter","anthropic/claude-fable-5.1");',
  'zre={"deepseek-flash-starter":ow,"glm-5.3-flash-starter":x2,"crouton-alpha":_j,...Ave()?{"beam-1.0-starter":HG}:{}};',
  '$re={"gemini-4-argon":cre,"claude-opus-5.5":mre,"gpt-6.1-sol":jG,"gpt-6-sol":$G,',
  '"kimi-3.1-pro":yre,"grok-4.7":KG,"glm-5.3":E2,"qwen-3.8-max":FG};',
  'qre={"claude-fable-5.1":vre};',
  'j5r=[{optionId:HG,isLive:Ave}];',
  "hx={...zre,...$re,...qre};",
  'k8e={"deepseek-flash-starter":"DeepSeek V4.1 Flash 1017 (Starter)","glm-5.3-flash-starter":"GLM 5.3 Flash (Starter)",',
  '"crouton-alpha":"Crouton Alpha (Stealth)","beam-1.0-starter":"Beam 1.0 (Starter)","gemini-4-argon":"Gemini 4 Argon",',
  '"claude-opus-5.5":"Claude Opus 5.5","gpt-6.1-sol":"GPT-6.1 Sol","gpt-6-sol":"GPT-6 Sol",',
  '"kimi-3.1-pro":"Kimi K3.1 Pro","grok-4.7":"Grok 4.7","glm-5.3":"GLM 5.3",',
  '"qwen-3.8-max":"Qwen 3.8 Max","claude-fable-5.1":"Claude Fable 5.1"};',
].join("\n");

const STARTER_IDS = [
  "openrouter-deepseek-deepseek-v4-1-flash-crusoe",
  "openrouter-z-ai-glm-5-3-flash-crusoe",
  "openrouter-stealth-crouton-alpha",
];
const PRO_IDS = [
  "gemini-gemini-4-argon",
  "anthropic-claude-opus-5-5",
  "azure-foundry-gpt-6-1-sol",
  "azure-foundry-gpt-6-sol",
  "openrouter-moonshotai-kimi-k3-1-pro",
  "azure-foundry-grok-4-7",
  "openrouter-z-ai-glm-5-3",
  "openrouter-qwen-qwen3-8-max-0902",
];

describe("Perch ACP driver", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  beforeEach(() => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "omb-perch-contract-"));
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
    vi.unstubAllEnvs();
    await removeTempDir(scratch);
  });

  function writeStatusFixture(statusLine: string): string {
    const path = join(scratch, "bin", "perch");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "#!/bin/sh\nprintf '%s\\n' \"$FAKE_PERCH_STATUS\"\n");
    chmodSync(path, 0o755);
    vi.stubEnv("FAKE_PERCH_STATUS", statusLine);
    return path;
  }

  function writeAuthSession(expiresInS = 3600, refreshToken?: string): void {
    const dir = join(scratch, ".perch");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cli-auth-session.json"), JSON.stringify({
      accessToken: "fixture-token", appUrl: "https://perch.example", expiresAt: Math.floor(Date.now() / 1000) + expiresInS,
      ...(refreshToken === undefined ? {} : { refreshToken }),
    }));
  }

  function writeByolm(modelId: string): void {
    const dir = join(scratch, ".perch");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "byo-local.json"), JSON.stringify({
      version: 1,
      records: [{ providerId: "local", baseUrl: "http://127.0.0.1:9/v1", modelId, apiKeyCiphertext: "fixture-only" }],
    }));
  }

  /** The host's own settings file, the one OMB must never write. */
  function writeHostSettings(settings: Record<string, unknown>): string {
    const dir = join(scratch, ".perch");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "cli-settings.json");
    writeFileSync(path, JSON.stringify(settings, null, 2));
    return path;
  }

  it("is discoverable in fresh and existing product fleets", () => {
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "perchAgent")).toBe(true);
    expect(instanceConfigs({}).perch?.driver).toBe("perchAgent");
    expect(instanceConfigs({ instances: { claude: { driver: "claudeAgent" } } }).perch?.driver).toBe("perchAgent");
    expect(instanceConfigs({ instances: { fixture: { driver: "fake" } } }).perch).toBeUndefined();
    expect(PerchAgentDriver.models.options.map((option) => option.id)).toEqual(["standard", "standard_max", "pro", "pro_max"]);
  });

  it("reads the saved auth session's shape without keeping the token", () => {
    expect(perchSignedIn({ HOME: scratch })).toBe(false);
    writeAuthSession();
    expect(perchSignedIn({ HOME: scratch })).toBe(true);
    writeAuthSession(-120);
    expect(perchSignedIn({ HOME: scratch })).toBe(false);
    const env = { HOME: scratch, PERCH_CLI_AUTH_DIR: join(scratch, "auth-elsewhere") };
    expect(perchSignedIn(env)).toBe(false);
    mkdirSync(join(scratch, "auth-elsewhere"), { recursive: true });
    writeFileSync(join(scratch, "auth-elsewhere", "cli-auth-session.json"), JSON.stringify({ accessToken: "t", appUrl: "https://perch.example" }));
    expect(perchSignedIn(env)).toBe(true);
  });

  it("picks up the BYOLM model id and resolves the CLI fallback", () => {
    expect(perchByolmModelId({ HOME: scratch })).toBeNull();
    writeByolm("stai/step-5-preview");
    expect(perchByolmModelId({ HOME: scratch })).toBe("stai/step-5-preview");
    expect(resolvePerchCli({}, "perch")).toBe("perch");
    expect(resolvePerchCli({ HOME: scratch }, "perch")).toBe("perch");
    const bin = join(scratch, ".npm-global", "bin", "perch");
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    expect(resolvePerchCli({ HOME: scratch }, "perch")).toBe(bin);
    expect(resolvePerchCli({ HOME: scratch, OMB_PERCH_CLI: join(scratch, "over", "perch") }, "perch")).toBe(join(scratch, "over", "perch"));
  });

  it("never offers a host BYOLM model and marks plan models while signed out", async () => {
    writeByolm("stai/step-5-preview");
    instance = await PerchAgentDriver.create({
      instanceId: "perch-models", displayName: "Perch", enabled: true,
      environment: { HOME: scratch },
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    expect(instance.models.default).toBe("standard");
    expect(instance.models.options).toEqual([
      { id: "standard", label: "Standard (needs perch login)" },
      { id: "standard_max", label: "Standard 1M (needs perch login)" },
      { id: "pro", label: "Pro (needs perch login)" },
      { id: "pro_max", label: "Pro 1M (needs perch login)" },
    ]);
  });

  it("reads the picker table, its labels and its groups out of the bundle", () => {
    const options = parsePerchOptions(BUNDLE_FIXTURE);
    expect(options?.filter((option) => option.group === "starter").map((option) => option.id)).toEqual(STARTER_IDS);
    expect(options?.filter((option) => option.group === "pro").map((option) => option.id)).toEqual(PRO_IDS);
    expect(options?.find((option) => option.id === STARTER_IDS[0])?.label).toBe("DeepSeek V4.1 Flash 1017 (Starter)");
    // The trial-gated starter entry and the Ultra group are never offered.
    expect(options?.some((option) => option.id === "openrouter-reflection-beam-1-0")).toBe(false);
    expect(options?.some((option) => option.id === "openrouter-anthropic-claude-fable-5-1")).toBe(false);
    expect(parsePerchOptions("busybox v1.36")).toBeNull();
    expect(parsePerchOptions(BUNDLE_FIXTURE.replace('"crouton-alpha":_j,', ""))).toBeNull();
  });

  it("lists tiers then the bundle's groups, and tiers alone when it cannot read", () => {
    const bin = join(scratch, "pkg", "bin", "perch");
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    const bundle = join(scratch, "pkg", "dist", "perch.mjs");
    mkdirSync(dirname(bundle), { recursive: true });
    writeFileSync(bundle, BUNDLE_FIXTURE);
    expect(perchBundlePath(bin)).toBe(bundle);
    const listed = perchModelOptions(bin);
    expect(listed.slice(0, 4).map((option) => option.id)).toEqual(["standard", "standard_max", "pro", "pro_max"]);
    expect(listed.map((option) => option.id)).toEqual(["standard", "standard_max", "pro", "pro_max", ...STARTER_IDS, ...PRO_IDS]);
    // A CLI update changes the file, so the cached parse is dropped.
    writeFileSync(bundle, BUNDLE_FIXTURE.replace('"Qwen 3.8 Max"', '"Qwen 3.8 Max 0902"'));
    expect(perchModelOptions(bin).find((option) => option.id === "openrouter-qwen-qwen3-8-max-0902")?.label).toBe("Qwen 3.8 Max 0902");
    expect(perchBundlePath(FAKE_CLI)).toBeNull();
    expect(perchModelOptions(FAKE_CLI).map((option) => option.id)).toEqual(["standard", "standard_max", "pro", "pro_max"]);
  });

  it("writes the picked model into cli-settings.json and keeps every other key", () => {
    const dir = join(scratch, "settings");
    const env = { HOME: scratch, PERCH_CLI_SETTINGS_DIR: dir };
    const path = join(dir, "cli-settings.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({
      version: 1, permissionMode: "auto_review", effort: { level: "high" }, theme: "dark",
      roostChoice: "standard", subagentModelOptionId: "azure-foundry-gpt-6-sol",
    }));

    expect(selectPerchModel(env, "pro_max")).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1, permissionMode: "auto_review", effort: { level: "high" }, theme: "dark",
      roostChoice: "pro_max", subagentModelOptionId: "azure-foundry-gpt-6-sol",
    });
    expect(perchSelectedModel(env)).toBe("\npro_max");

    expect(selectPerchModel(env, "openrouter-qwen-qwen3-8-max-0902")).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      roostChoice: "pro_max", manualModelOptionId: "openrouter-qwen-qwen3-8-max-0902", theme: "dark",
    });
    expect(perchSelectedModel(env)).toBe("openrouter-qwen-qwen3-8-max-0902\npro_max");

    // Back to a tier: the pin is dropped so the tier actually applies.
    expect(selectPerchModel(env, "standard")).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("manualModelOptionId");

    // An injected local model is not a Perch id, and a newer settings schema is left alone.
    expect(selectPerchModel(env, "ollama:llama3")).toBe(false);
    writeFileSync(path, JSON.stringify({ version: 2, roostChoice: "pro" }));
    expect(selectPerchModel(env, "pro_max")).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 2, roostChoice: "pro" });
  });

  it("creates the private settings folder for a first pick, not the host's own", () => {
    const env = { HOME: scratch, OMB_DATA_DIR: join(scratch, "omb-data") };
    expect(selectPerchModel(env, "pro")).toBe(true);
    expect(JSON.parse(readFileSync(join(perchPrivateSettingsDir(env, "default"), "cli-settings.json"), "utf8"))).toEqual({ version: 1, roostChoice: "pro" });
    expect(existsSync(join(scratch, ".perch"))).toBe(false);
    expect(existsSync(join(perchPrivateSettingsDir(env, "default"), "cli-settings.lock"))).toBe(false);
  });

  it("leaves the host's own cli-settings.json untouched and writes the pick privately", () => {
    const host = writeHostSettings({ version: 1, roostChoice: "standard", theme: "dark" });
    const before = readFileSync(host, "utf8");
    const mtime = statSync(host).mtimeMs;
    const env = { HOME: scratch, OMB_DATA_DIR: join(scratch, "omb-data") };

    expect(selectPerchModel(env, "openrouter-qwen-qwen3-8-max-0902")).toBe(true);

    const privateDir = perchPrivateSettingsDir(env, "default");
    expect(JSON.parse(readFileSync(join(privateDir, "cli-settings.json"), "utf8"))).toMatchObject({
      manualModelOptionId: "openrouter-qwen-qwen3-8-max-0902",
    });
    expect(readFileSync(host, "utf8")).toBe(before);
    expect(statSync(host).mtimeMs).toBe(mtime);
    expect(existsSync(join(scratch, ".perch", "cli-settings.lock"))).toBe(false);
    expect(statSync(privateDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(privateDir, "cli-settings.json")).mode & 0o777).toBe(0o600);
  });

  it("seeds the private folder from the host's cli-settings.json on first use", () => {
    writeHostSettings({
      version: 1, permissionMode: "auto_review", effort: { level: "high" }, theme: "dark", roostChoice: "standard",
    });
    const env = { HOME: scratch, OMB_DATA_DIR: join(scratch, "omb-data") };

    expect(selectPerchModel(env, "pro")).toBe(true);
    expect(JSON.parse(readFileSync(join(perchPrivateSettingsDir(env, "default"), "cli-settings.json"), "utf8"))).toEqual({
      version: 1, permissionMode: "auto_review", effort: { level: "high" }, theme: "dark", roostChoice: "pro",
    });
  });

  it("uses the settings folder the caller names itself", () => {
    const caller = join(scratch, "caller-settings");
    const env = { HOME: scratch, OMB_DATA_DIR: join(scratch, "omb-data"), PERCH_CLI_SETTINGS_DIR: caller };

    expect(selectPerchModel(env, "pro_max")).toBe(true);
    expect(JSON.parse(readFileSync(join(caller, "cli-settings.json"), "utf8"))).toEqual({ version: 1, roostChoice: "pro_max" });
    expect(existsSync(join(scratch, "omb-data", "perch-settings"))).toBe(false);
  });

  it("writes nothing when no model is picked", () => {
    const env = { HOME: scratch, OMB_DATA_DIR: join(scratch, "omb-data") };
    expect(selectPerchModel(env, undefined)).toBe(false);
    expect(selectPerchModel(env, "   ")).toBe(false);
    expect(existsSync(join(scratch, "omb-data", "perch-settings"))).toBe(false);
    expect(existsSync(join(scratch, ".perch"))).toBe(false);
  });

  it("changes the spawn fingerprint with the model and keeps it for the same one", () => {
    const env = { HOME: scratch, OMB_DATA_DIR: join(scratch, "omb-data") };
    expect(perchSelectedModel(env)).toBe("\n");

    expect(selectPerchModel(env, "pro")).toBe(true);
    const tier = perchSelectedModel(env);
    expect(tier).toBe("\npro");
    expect(selectPerchModel(env, "pro")).toBe(false);
    expect(perchSelectedModel(env)).toBe(tier);

    expect(selectPerchModel(env, "openrouter-qwen-qwen3-8-max-0902")).toBe(true);
    expect(perchSelectedModel(env)).toBe("openrouter-qwen-qwen3-8-max-0902\npro");
  });

  it("never copies the host's byo-local.json into the private folder", () => {
    writeByolm("stai/step-5-preview");
    writeHostSettings({ version: 1, roostChoice: "standard" });
    const env = { HOME: scratch, OMB_DATA_DIR: join(scratch, "omb-data") };

    expect(selectPerchModel(env, "pro")).toBe(true);
    const privateDir = perchPrivateSettingsDir(env, "default");
    expect(existsSync(join(privateDir, "byo-local.json"))).toBe(false);
    expect(readdirSync(privateDir).sort()).toEqual(["cli-settings.json"]);
  });

  it("gives the pick up when the settings lock stays taken", () => {
    const env = { HOME: scratch, OMB_DATA_DIR: join(scratch, "omb-data") };
    const dir = perchPrivateSettingsDir(env, "default");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cli-settings.lock"), "", { mode: 0o600 });

    const started = Date.now();
    expect(selectPerchModel(env, "pro")).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(existsSync(join(dir, "cli-settings.json"))).toBe(false);
  });

  it("writes the turn's model before spawn and respawns when it changes", async () => {
    writeAuthSession();
    const launches = join(scratch, "launches");
    const environment = { HOME: scratch, OMB_DATA_DIR: join(scratch, "omb-data"), FAKE_ACP_LAUNCH_COUNT_FILE: launches, FAKE_ACP_TEXT_REPLY: "OK fixture" };
    const settings = join(perchPrivateSettingsDir(environment, "perch-select"), "cli-settings.json");
    instance = await PerchAgentDriver.create({
      instanceId: "perch-select", displayName: "Perch", enabled: true,
      environment,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const first = await instance.adapter.sendTurn({
      threadId: "perch-select", text: "one", model: "pro_max", approvalMode: "full",
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === first.turnId);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ version: 1, roostChoice: "pro_max" });
    // The host's own folder stays as it was: OMB never writes the person's perch settings.
    expect(existsSync(join(scratch, ".perch", "cli-settings.json"))).toBe(false);

    const second = await instance.adapter.sendTurn({
      threadId: "perch-select", text: "two", model: "openrouter-qwen-qwen3-8-max-0902", approvalMode: "full",
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === second.turnId);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
      version: 1, roostChoice: "pro_max", manualModelOptionId: "openrouter-qwen-qwen3-8-max-0902",
    });
    expect(readFileSync(launches, "utf8").trim()).toBe("2");
  });

  it("runs a turn through native acp with no permission flag", async () => {
    writeAuthSession();
    instance = await PerchAgentDriver.create({
      instanceId: "perch-contract", displayName: "Perch", enabled: true,
      environment: { HOME: scratch, FAKE_ACP_DUMP: join(scratch, "launch.json"), FAKE_ACP_TEXT_REPLY: "OK fixture" },
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "perch-chat", text: "hello", model: "standard", approvalMode: "full",
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(recorder.events.some((event) => event.type === "content.delta")).toBe(true);
    expect(recorder.events.every((event) => event.provider === "perchAgent")).toBe(true);
    const launch = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8"));
    expect(launch.argv).toEqual(["acp"]);
  });

  it("refuses a turn before spawn while signed out, with the login reason", async () => {
    instance = await PerchAgentDriver.create({
      instanceId: "perch-locked", displayName: "Perch", enabled: true,
      environment: { HOME: scratch },
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "perch-locked", text: "hello" });
    const done = await recorder.until((event) => event.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    expect(recorder.events.some((event) => event.type === "runtime.error" && event.message?.includes("perch login"))).toBe(true);
    expect(recorder.events.some((event) => event.type === "content.delta")).toBe(false);
    expect(existsSync(join(scratch, "launch.json"))).toBe(false);
  });

  it("reads the sign-in state off the status banner", async () => {
    const cli = writeStatusFixture(SIGNED_IN_STATUS);
    instance = await PerchAgentDriver.create({
      instanceId: "perch-status", displayName: "Perch", enabled: true,
      environment: { HOME: scratch },
      config: { cli, fullAuto: false },
    });
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true, version: "2.4.125" });
  });

  it("reports a signed-out engine as unavailable with the login reason", async () => {
    const cli = writeStatusFixture(SIGNED_OUT_STATUS);
    instance = await PerchAgentDriver.create({
      instanceId: "perch-signed-out", displayName: "Perch", enabled: true,
      environment: { HOME: scratch },
      config: { cli, fullAuto: false },
    });
    const snapshot = await instance.snapshot();
    expect(snapshot).toMatchObject({ state: "unavailable", version: "2.4.125" });
    expect(snapshot.reason).toContain("perch login");
    expect(snapshot.authenticationUnavailableReason).toContain("perch login");
  });

  it("counts an expired access token with a refresh token as signed in (E16)", () => {
    writeAuthSession(-120, "");
    expect(perchSignedIn({ HOME: scratch })).toBe(false);
    writeAuthSession(-120, "fixture-refresh");
    expect(perchSignedIn({ HOME: scratch })).toBe(true);
  });

  it("stays available when status says signed out but the session can refresh (E16)", async () => {
    writeAuthSession(-120, "fixture-refresh");
    const cli = writeStatusFixture(SIGNED_OUT_STATUS);
    instance = await PerchAgentDriver.create({
      instanceId: "perch-refreshable", displayName: "Perch", enabled: true,
      environment: { HOME: scratch },
      config: { cli, fullAuto: false },
    });
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true, version: "2.4.125" });
  });

  it("reads the banner even when status exits non-zero (E16)", async () => {
    const path = join(scratch, "bin", "perch");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "#!/bin/sh\nprintf '%s\\n' \"$FAKE_PERCH_STATUS\"\nexit 1\n");
    chmodSync(path, 0o755);
    vi.stubEnv("FAKE_PERCH_STATUS", SIGNED_OUT_STATUS);
    writeAuthSession(-120, "fixture-refresh");
    instance = await PerchAgentDriver.create({
      instanceId: "perch-exit1", displayName: "Perch", enabled: true,
      environment: { HOME: scratch },
      config: { cli: path, fullAuto: false },
    });
    expect(await instance.snapshot()).toMatchObject({ state: "available", version: "2.4.125" });
  });

  it("reports a foreign executable and a missing CLI as unavailable", async () => {
    const foreign = writeStatusFixture("busybox v1.36");
    instance = await PerchAgentDriver.create({
      instanceId: "perch-foreign", displayName: "Perch", enabled: true,
      environment: { HOME: scratch },
      config: { cli: foreign, fullAuto: false },
    });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable", notEngineCli: true });
    await instance.dispose();
    recorder?.stop();
    recorder = undefined;
    instance = await PerchAgentDriver.create({
      instanceId: "perch-missing", displayName: "Perch", enabled: true,
      environment: {},
      config: { cli: join(scratch, "missing-perch"), fullAuto: false },
    });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
  });
});
