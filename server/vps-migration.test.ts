import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "./config.ts";
import type { BotRecord } from "./store.ts";
import { applyVpsMigration, planVpsMigration } from "./vps-migration.ts";

const bot = (id: string, extra: Partial<BotRecord> = {}) => ({ id, name: id, ...extra }) as BotRecord;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("VPS migration", () => {
  it("puts the legacy global host first", () => {
    const plan = planVpsMigration({ vps: { sshAlias: "production-vps" } } as AppConfig, [
      bot("a", { vpsAlias: "alpha-vps" }),
      bot("b", { vpsAlias: "production-vps" }),
    ]);
    expect(plan.config.version).toBe(2);
    expect(plan.config.instances.map((instance) => instance.kind === "ssh" && instance.sshAlias)).toEqual([
      "production-vps",
      "alpha-vps",
    ]);
    expect(plan.config.defaultInstanceId).toBe(plan.config.instances[0]!.id);
  });

  it("pins bot specific aliases without changing targets", () => {
    const plan = planVpsMigration({ vps: { sshAlias: "production-vps" } } as AppConfig, [
      bot("a", { vpsAlias: "alpha-vps" }),
      bot("b"),
    ]);
    const byAlias = new Map(plan.config.instances.map((instance) => [instance.kind === "ssh" ? instance.sshAlias : "", instance.id]));
    expect(plan.botPatches).toEqual([
      { id: "a", vpsInstanceId: byAlias.get("alpha-vps") },
      { id: "b", vpsInstanceId: byAlias.get("production-vps") },
    ]);
    expect(plan.legacyAliases).toEqual({ a: "alpha-vps", b: "production-vps" });
  });

  it("keeps former VPS targets for Boat bots", () => {
    const plan = planVpsMigration({ vps: { sshAlias: "production-vps" } } as AppConfig, [
      bot("boat-bot", { cloudBackend: "box" }),
    ]);
    expect(plan.botPatches).toHaveLength(1);
    expect(plan.botPatches[0]!.vpsInstanceId).toBe(plan.config.defaultInstanceId);
  });

  it("resumes a partial migration without creating duplicate ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-vps-migration-"));
    dirs.push(dir);
    const first = planVpsMigration({ vps: { sshAlias: "production-vps" } } as AppConfig, [bot("a")]);
    const configPath = join(dir, "config.json");
    let config = first.config;
    writeFileSync(configPath, JSON.stringify(config));
    const deps = {
      dataDir: dir,
      writeConfig: (next: typeof config) => {
        config = next;
        writeFileSync(configPath, JSON.stringify(next));
      },
      writeBot: () => {
        throw new Error("the second step must not run before the test resumes");
      },
    };
    await expect(applyVpsMigration(first, deps)).rejects.toThrow("second step");
    expect(JSON.parse(readFileSync(configPath, "utf8")).instances).toHaveLength(1);

    const resumed = planVpsMigration({ vps: config } as AppConfig, [bot("a")]);
    expect(resumed.config.instances).toHaveLength(1);
    const patched: string[] = [];
    await applyVpsMigration(resumed, { dataDir: dir, writeConfig: () => {}, writeBot: (id, patch) => { patched.push(`${id}:${patch.vpsInstanceId}`); } });
    expect(patched).toEqual([`a:${resumed.config.instances[0]!.id}`]);
    expect(planVpsMigration({ vps: resumed.config } as AppConfig, [bot("a", { vpsInstanceId: resumed.config.instances[0]!.id })]).botPatches).toEqual([]);
  });

  it("does not start a provider while migrating", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-vps-migration-"));
    dirs.push(dir);
    const plan = planVpsMigration({ vps: { sshAlias: "production-vps" } } as AppConfig, [bot("a", { vpsAlias: "alpha-vps" })]);
    const calls: string[] = [];
    await applyVpsMigration(plan, {
      dataDir: dir,
      writeConfig: (next) => { calls.push(`config:${next.instances.length}`); },
      writeBot: (id) => { calls.push(`bot:${id}`); },
    });
    expect(calls.filter((call) => call.startsWith("config:"))).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith("bot:"))).toEqual(["bot:a"]);
    expect(JSON.parse(readFileSync(join(dir, "vps-migration-backup.json"), "utf8")).version).toBe(2);
  });
});
