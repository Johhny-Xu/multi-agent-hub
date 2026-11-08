// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderInstance } from "../contracts.ts";
import { DEFAULT_FLEET, PRODUCT_FLEET_ADDITIONS } from "../instance-fleets.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { BUILT_IN_DRIVERS } from "./builtIn.ts";
import {
  TraecodeAgentDriver,
  resolveTraecodeCli,
  traecodeSignedIn,
  traecodeSnapshot,
} from "./traecode.ts";

describe("Trae Code driver", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "omb-traecode-contract-"));
  });
  afterEach(async () => {
    await instance?.dispose();
    instance = undefined;
    await removeTempDir(scratch);
  });

  function writeJwt(home: string): void {
    const path = join(home, ".trae-cn", "trae-jwt-token");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not-a-real-token-fixture\n");
  }

  it("is registered for the migrated fleet kind", () => {
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "traecodeAgent")).toBe(true);
    expect(DEFAULT_FLEET.traecode?.driver).toBe("traecodeAgent");
    expect(PRODUCT_FLEET_ADDITIONS.traecode?.driver).toBe("traecodeAgent");
    expect(TraecodeAgentDriver.metadata.displayName).toBe("Trae Code");
  });

  it("decodes the instance config onto the trae CLI", () => {
    expect(TraecodeAgentDriver.decodeConfig({})).toEqual({ cli: "traecode", fullAuto: false, workspace: undefined });
    expect(TraecodeAgentDriver.decodeConfig({ cli: "/usr/bin/trae-cn", workspace: "/w" }))
      .toEqual({ cli: "/usr/bin/trae-cn", fullAuto: false, workspace: "/w" });
  });

  it("resolves the CLI from an explicit path, else the standard install paths", () => {
    expect(resolveTraecodeCli({ HOME: scratch }, join(scratch, "missing"))).toBeNull();
    const explicit = join(scratch, "trae-cn");
    writeFileSync(explicit, "");
    expect(resolveTraecodeCli({ HOME: scratch }, explicit)).toBe(explicit);
    expect(resolveTraecodeCli({ HOME: scratch, OMB_TRAECODE_CLI: explicit }, "traecode")).toBe(explicit);
    expect(resolveTraecodeCli({ HOME: scratch, OMB_TRAECODE_CLI: join(scratch, "missing") }, "traecode")).toBeNull();

    // The standard-path fallback answers with a path that exists, or nothing (a box without the IDE).
    const fallback = resolveTraecodeCli({ HOME: scratch }, "traecode");
    expect(fallback === null || existsSync(fallback)).toBe(true);
    const local = join(scratch, ".local", "bin", "traecode");
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, "");
    expect(existsSync(resolveTraecodeCli({ HOME: scratch }, "traecode") ?? "")).toBe(true);

    expect(traecodeSignedIn({ HOME: scratch })).toBe(false);
    writeJwt(scratch);
    expect(traecodeSignedIn({ HOME: scratch })).toBe(true);
  });

  it("reports a missing IDE as not installed", () => {
    const snapshot = traecodeSnapshot({ HOME: scratch }, { cli: join(scratch, "missing"), fullAuto: false });
    expect(snapshot.state).toBe("unavailable");
    expect(snapshot.reason).toContain("isn't installed");
  });

  it("reports the desktop-only truth once installed, with the sign-in step while unsigned", () => {
    const cli = join(scratch, "trae-cn");
    writeFileSync(cli, "");
    const unsigned = traecodeSnapshot({ HOME: scratch }, { cli, fullAuto: false });
    expect(unsigned.state).toBe("unavailable");
    expect(unsigned.reason).toContain("not signed in");
    expect(unsigned.reason).toContain("desktop IDE");
    expect(unsigned.authenticated).toBeUndefined();

    writeJwt(scratch);
    const signed = traecodeSnapshot({ HOME: scratch }, { cli, fullAuto: false });
    expect(signed.state).toBe("unavailable");
    expect(signed.reason).toContain("desktop IDE");
    expect(signed.reason).not.toContain("not signed in");
    expect(signed.authenticated).toBe(true);
  });

  it("offers no model: nothing here can run a turn", () => {
    expect(TraecodeAgentDriver.models).toEqual({ default: "", options: [] });
  });

  it("refuses turns with the desktop explanation and holds no sessions", async () => {
    const cli = join(scratch, "trae-cn");
    writeFileSync(cli, "");
    writeJwt(scratch);
    instance = await TraecodeAgentDriver.create({
      instanceId: "traecode-contract", displayName: "Trae Code", enabled: true,
      environment: { HOME: scratch },
      config: { cli, fullAuto: false },
    });
    const snapshot = await instance.snapshot();
    expect(snapshot.state).toBe("unavailable");
    expect(snapshot.authenticated).toBe(true);

    await expect(instance.adapter.sendTurn({ threadId: "trae-chat", text: "hello" })).rejects.toThrow(/desktop IDE/);
    expect(instance.adapter.hasSession("trae-chat")).toBe(false);
    await expect(instance.adapter.respondToRequest("trae-chat", "req-1", { behavior: "allow" })).resolves.toBe("unavailable");
    await expect(instance.adapter.interruptTurn("trae-chat")).resolves.toBeUndefined();
    await instance.adapter.stopAll();
    const unsubscribed = instance.adapter.onEvent(() => {});
    expect(typeof unsubscribed).toBe("function");
    unsubscribed();
  });
});
