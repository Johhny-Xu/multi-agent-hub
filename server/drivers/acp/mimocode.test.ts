// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderInstance } from "../../contracts.ts";
import { DEFAULT_FLEET, PRODUCT_FLEET_ADDITIONS } from "../../instance-fleets.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import {
  LOGIN_NOTE,
  MimocodeAgentDriver,
  mimocodeCliCandidates,
  mimocodeCliInstalled,
  mimocodeSignedIn,
  parseMimoModels,
  resetMimocodeCliCache,
  verifyMimocodeCli,
} from "./mimocode.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");

const MIMO_MODELS_OUTPUT = [
  "9router/hw/deepseek-v4.1-flash — window 131K, compacts at 118K",
  "9router/hw/GLM-5.2 — window 131K, compacts at 118K",
  "9router/hw/glm-5.3 — window 131K, compacts at 118K",
  "9router/trae — window 131K, compacts at 118K",
  "9router/trcc/glm-5.3-flashx — window 131K, compacts at 118K",
  "mimo/mimo-auto — window 1M, compacts at 900K",
  "xiaomi/mimo-v2.6-flash — window 1.05M, compacts at 944K",
  "xiaomi/mimo-v2.6-pro — window 1.05M, compacts at 944K",
  "xiaomi/mimo-v2.6-pro-ultraspeed — window 1.05M, compacts at 944K",
  "",
].join("\n");

describe("MiMo Code ACP driver", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "omb-mimocode-contract-"));
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
    resetMimocodeCliCache();
    await removeTempDir(scratch);
  });

  function writeScript(relativePath: string, body: string): string {
    const path = join(scratch, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  function writeVersionFixture(banner: string): string {
    return writeScript(join("bin", "mimo-fixture"), `printf '%s\\n' "${banner}"`);
  }

  it("is registered for the migrated fleet kind", () => {
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "mimocodeAgent")).toBe(true);
    expect(DEFAULT_FLEET.mimocode?.driver).toBe("mimocodeAgent");
    expect(PRODUCT_FLEET_ADDITIONS.mimocode?.driver).toBe("mimocodeAgent");
  });

  it("decodes the instance config onto the mimo CLI", () => {
    expect(MimocodeAgentDriver.decodeConfig({})).toEqual({ cli: "mimo", fullAuto: false, workspace: undefined });
    expect(MimocodeAgentDriver.decodeConfig({ cli: "/opt/mimo", fullAuto: true, workspace: "/w" }))
      .toEqual({ cli: "/opt/mimo", fullAuto: true, workspace: "/w" });
    expect(MimocodeAgentDriver.defaultConfig()).toEqual({ cli: "mimo", fullAuto: false, workspace: undefined });
  });

  it("offers only the CLI's own bundled tiers", () => {
    const ids = MimocodeAgentDriver.models.options.map((option) => option.id);
    expect(MimocodeAgentDriver.models.default).toBe("mimo/mimo-auto");
    expect(ids.every((id) => id.startsWith("mimo/") || id.startsWith("xiaomi/"))).toBe(true);
    expect(ids).toContain("xiaomi/mimo-v2.6-pro");
    expect(ids).toHaveLength(4);
    expect(MimocodeAgentDriver.models.options.every((option) => option.custom !== true)).toBe(true);
  });

  it("parses the live `mimo models` listing over the static fallback", () => {
    const catalog = parseMimoModels(MIMO_MODELS_OUTPUT);
    expect(catalog?.default).toBe("mimo/mimo-auto");
    expect(catalog?.options).toHaveLength(4);
    expect(catalog?.options.every((option) => option.id.startsWith("mimo/") || option.id.startsWith("xiaomi/"))).toBe(true);
    expect(catalog?.options.find((option) => option.id === "mimo/mimo-auto")?.contextWindow).toBe(1_048_576);
    expect(catalog?.options.find((option) => option.id === "xiaomi/mimo-v2.6-pro")?.contextWindow).toBe(1_101_005);
    const unknown = parseMimoModels("xiaomi/brand-new-model — window 512K, compacts at 460K\n");
    expect(unknown?.options).toEqual([
      { id: "xiaomi/brand-new-model", label: "xiaomi/brand-new-model", contextWindow: 524_288 },
    ]);
    expect(parseMimoModels("")).toBeNull();
    // A listing of only the CLI's own BYOK providers keeps the static catalog.
    expect(parseMimoModels("9router/trcc/glm-5.3-flashx — window 131K, compacts at 118K\n")).toBeNull();
  });

  it("orders CLI candidates: explicit, environment, platform binaries, PATH", () => {
    expect(mimocodeCliCandidates({ HOME: scratch }, "/opt/mimo")).toEqual(["/opt/mimo", "mimo"]);
    expect(mimocodeCliCandidates({ HOME: scratch, OMB_MIMOCODE_CLI: "/opt/other" }, "mimo"))
      .toEqual(["mimo", "/opt/other"]);

    // A launcher symlink into an npm tree pulls its platform binaries in, baseline before AVX2.
    writeScript("fake-npm/lib/node_modules/@mimo-ai/cli/bin/mimo", "exit 0");
    const baseline = writeScript("fake-npm/lib/node_modules/@mimo-ai/mimocode-linux-x64-baseline/bin/mimo", "exit 0");
    const avx2 = writeScript("fake-npm/lib/node_modules/@mimo-ai/mimocode-linux-x64/bin/mimo", "exit 0");
    mkdirSync(join(scratch, ".npm-global", "bin"), { recursive: true });
    symlinkSync(
      join(scratch, "fake-npm/lib/node_modules/@mimo-ai/cli/bin/mimo"),
      join(scratch, ".npm-global", "bin", "mimo"),
    );
    expect(mimocodeCliCandidates({ HOME: scratch }, "mimo")).toEqual(["mimo", baseline, avx2]);
    expect(mimocodeCliInstalled({ HOME: scratch }, "mimo")).toBe(true);
    expect(mimocodeCliInstalled({ HOME: join(scratch, "no-home") }, join(scratch, "missing"))).toBe(false);
  });

  it("verifies candidates with --version and keeps the first one that answers as mimo", async () => {
    const emptyBin = join(scratch, "empty-bin");
    mkdirSync(emptyBin, { recursive: true });
    const env = { HOME: scratch, PATH: emptyBin };
    expect(await verifyMimocodeCli(env, "mimo")).toBeNull();

    const broken = writeScript("broken/mimo", "exit 0");
    const working = writeVersionFixture("0.1.15");
    const found = await verifyMimocodeCli({ ...env, OMB_MIMOCODE_CLI: working }, broken);
    expect(found).toEqual({ path: working, version: "0.1.15" });
  });

  it("reads the version and the sign-in file into the snapshot", async () => {
    const cli = writeVersionFixture("0.1.15");
    instance = await MimocodeAgentDriver.create({
      instanceId: "mimocode-version", displayName: "MiMo Code", enabled: true,
      environment: { HOME: scratch, PATH: join(scratch, "empty-bin") },
      config: { cli, fullAuto: false },
    });
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: false, version: "0.1.15" });

    const auth = join(scratch, ".local", "share", "mimocode", "auth.json");
    mkdirSync(dirname(auth), { recursive: true });
    writeFileSync(auth, "{}");
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true, version: "0.1.15" });
    // A second HOME with neither the xdg dir nor ~/.local/share sees no sign-in at all.
    const otherHome = join(scratch, "home2");
    expect(mimocodeSignedIn({ HOME: otherHome, XDG_DATA_HOME: join(scratch, "xdg-empty") })).toBe(false);
    const xdgAuth = join(scratch, "xdg", "mimocode", "auth.json");
    mkdirSync(dirname(xdgAuth), { recursive: true });
    writeFileSync(xdgAuth, "{}");
    expect(mimocodeSignedIn({ HOME: otherHome, XDG_DATA_HOME: join(scratch, "xdg") })).toBe(true);
  });

  it("reports a foreign executable and a missing CLI as unavailable", async () => {
    const foreign = writeVersionFixture("busybox v1.36");
    instance = await MimocodeAgentDriver.create({
      instanceId: "mimocode-foreign", displayName: "MiMo Code", enabled: true,
      environment: { HOME: scratch, PATH: join(scratch, "empty-bin") },
      config: { cli: foreign, fullAuto: false },
    });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable", notEngineCli: true });
    await instance.dispose();

    instance = await MimocodeAgentDriver.create({
      instanceId: "mimocode-missing", displayName: "MiMo Code", enabled: true,
      environment: { HOME: scratch, PATH: join(scratch, "empty-bin") },
      config: { cli: join(scratch, "missing-mimo"), fullAuto: false },
    });
    const missing = await instance.snapshot();
    expect(missing).toMatchObject({ state: "unavailable" });
    expect(missing.reason).toContain("isn't installed");
  });

  it("carries the sign-in note for a missing account", () => {
    expect(LOGIN_NOTE).toContain("mimo providers login");
  });

  it("runs a turn through native acp with no approval flag on argv", async () => {
    instance = await MimocodeAgentDriver.create({
      instanceId: "mimocode-contract", displayName: "MiMo Code", enabled: true,
      environment: {
        HOME: scratch, PATH: join(scratch, "empty-bin"), OMB_MIMOCODE_CLI: FAKE_CLI,
        FAKE_ACP_DUMP: join(scratch, "launch.json"), FAKE_ACP_TEXT_REPLY: "OK fixture",
        FAKE_ACP_VERSION: "0.1.15", FAKE_ACP_MODELS: "mimo/mimo-auto,xiaomi/mimo-v2.6-pro",
      },
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "mimocode-chat", text: "hello", model: "xiaomi/mimo-v2.6-pro", approvalMode: "full",
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const eventTypes = recorder.events.map((event) => `${event.type}:${(event as { streamKind?: string }).streamKind ?? ""}`).join(",");
    expect(eventTypes.includes("content.delta:assistant_text"), `events: ${eventTypes}`).toBe(true);
    expect(recorder.events.every((event) => event.provider === "mimocodeAgent")).toBe(true);
    const launch = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8"));
    expect(launch.argv).toEqual(["acp"]);
  });

  /** The CLI's own list carries its BYOK ids and its default model is one of them (`AGY_ACP_DEFAULT_MODEL`). */
  function byokDefaultEnvironment(): Record<string, string> {
    return {
      HOME: scratch, PATH: join(scratch, "empty-bin"), OMB_MIMOCODE_CLI: FAKE_CLI,
      FAKE_ACP_DUMP: join(scratch, "launch.json"), FAKE_ACP_TEXT_REPLY: "OK fixture",
      FAKE_ACP_VERSION: "0.1.15",
      FAKE_ACP_MODELS: "9router/trcc/glm-5.3-flashx,9router/trae,mimo/mimo-auto,xiaomi/mimo-v2.6-pro",
      AGY_ACP_DEFAULT_MODEL: "9router/trcc/glm-5.3-flashx",
    };
  }

  function configCalls(): Array<{ method: string; params: { configId?: string; value?: string } }> {
    return JSON.parse(readFileSync(join(scratch, "launch.json.config.json"), "utf8"));
  }

  it("pins a turn with no model to the bundled fallback, not the CLI's BYOK default", async () => {
    instance = await MimocodeAgentDriver.create({
      instanceId: "mimocode-unpinned", displayName: "MiMo Code", enabled: true,
      environment: byokDefaultEnvironment(),
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "mimocode-unpinned", text: "hello", approvalMode: "full" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(configCalls()).toEqual([
      { method: "session/set_config_option", params: expect.objectContaining({ configId: "model", value: "mimo/mimo-auto" }) },
    ]);
    const started = recorder.events.find((event) => event.type === "session.started") as { model?: string } | undefined;
    expect(started?.model).toBe("mimo/mimo-auto");
  });

  it("replaces a saved non-whitelisted pick with the bundled fallback", async () => {
    instance = await MimocodeAgentDriver.create({
      instanceId: "mimocode-byok-pick", displayName: "MiMo Code", enabled: true,
      environment: byokDefaultEnvironment(),
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "mimocode-byok", text: "hello", model: "9router/trae", approvalMode: "full",
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(configCalls().map((call) => [call.method, call.params.configId, call.params.value]))
      .toEqual([["session/set_config_option", "model", "mimo/mimo-auto"]]);
  });
});
