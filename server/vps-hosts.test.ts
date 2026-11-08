import { describe, expect, it } from "vitest";

import { resolveVpsTarget, vpsAliasesInPlay, vpsInstanceRevision, vpsResourceKey, vpsSshAliasForBot } from "./vps-hosts.ts";

describe("which VPS host a bot uses", () => {
  it("lets a bot's own alias win, falls back to the default for an invalid or missing one, and invents nothing", () => {
    expect(vpsSshAliasForBot({ vps: { sshAlias: "production-vps" } }, { vpsAlias: "alpha-vps" })).toBe("alpha-vps");
    expect(vpsSshAliasForBot({}, { vpsAlias: "alpha-vps" })).toBe("alpha-vps");
    expect(vpsSshAliasForBot({ vps: { sshAlias: "production-vps" } }, { vpsAlias: "-bad" })).toBe("production-vps");
    expect(vpsSshAliasForBot({ vps: { sshAlias: "production-vps" } }, null)).toBe("production-vps");
    expect(vpsSshAliasForBot({}, {})).toBeNull();
  });

  it("puts every server in play in the inventory once, the default first", () => {
    expect(vpsAliasesInPlay(
      { vps: { sshAlias: "production-vps" } },
      [{}, { vpsAlias: "alpha-vps" }, { vpsAlias: "production-vps" }, { vpsAlias: "bad alias" }],
    )).toEqual(["production-vps", "alpha-vps"]);
    expect(vpsAliasesInPlay({}, [{ vpsAlias: "alpha-vps" }])).toEqual(["alpha-vps"]);
    expect(vpsAliasesInPlay({}, [{}])).toEqual([]);
  });
});


describe("VPS target resolution", () => {
  const cfg = {
    vps: {
      version: 2 as const,
      instances: [
        { id: "alpha", name: "Alpha", kind: "ssh" as const, sshAlias: "alpha-vps" },
        { id: "beta", name: "Beta", kind: "ssh" as const, sshAlias: "beta-vps" },
        { id: "boxed", name: "Boxed", kind: "mcp" as const, adapter: "simular-box" as const, mcpServer: "simular", boxId: "box-1" },
      ],
      defaultInstanceId: "alpha",
    },
  };

  it("resolves each bot to its selected instance", () => {
    const alpha = resolveVpsTarget(cfg, { id: "a", vpsInstanceId: "alpha" });
    const boxed = resolveVpsTarget(cfg, { id: "b", vpsInstanceId: "boxed" });
    expect(alpha.ok && alpha.target.instance.kind === "ssh" && alpha.target.instance.sshAlias).toBe("alpha-vps");
    expect(boxed.ok && boxed.target.instance.kind === "mcp" && boxed.target.instance.boxId).toBe("box-1");
    expect(vpsResourceKey((alpha as { ok: true; target: never }).target, "a")).toContain("a");
  });

  it("does not fall back from a missing explicit instance", () => {
    expect(resolveVpsTarget(cfg, { id: "a" })).toEqual({ ok: false, reason: "not-selected" });
    expect(resolveVpsTarget(cfg, { id: "a", vpsInstanceId: "gone" })).toEqual({ ok: false, reason: "missing-instance" });
  });

  it("keeps resource identity stable across display name changes", () => {
    const instance = cfg.vps.instances[0]!;
    const renamed = { ...instance, name: "Renamed" };
    expect(vpsInstanceRevision(instance)).toBe(vpsInstanceRevision(renamed));
    const before = resolveVpsTarget(cfg, { id: "a", vpsInstanceId: "alpha" });
    const after = resolveVpsTarget({ vps: { ...cfg.vps, instances: [renamed, ...cfg.vps.instances.slice(1)] } }, { id: "a", vpsInstanceId: "alpha" });
    expect(vpsResourceKey((before as { ok: true; target: never }).target, "a"))
      .toBe(vpsResourceKey((after as { ok: true; target: never }).target, "a"));
  });

  it("keeps the legacy alias working before the migration writes a list", () => {
    const legacy = { vps: { sshAlias: "production-vps" } };
    const resolved = resolveVpsTarget(legacy, { id: "a" });
    expect(resolved.ok && resolved.target.instance.kind === "ssh" && resolved.target.instance.sshAlias).toBe("production-vps");
    const own = resolveVpsTarget(legacy, { id: "a", vpsAlias: "alpha-vps" });
    expect(own.ok && own.target.instance.kind === "ssh" && own.target.instance.sshAlias).toBe("alpha-vps");
    expect(resolveVpsTarget(legacy, { id: "a", vpsAlias: "-bad" })).toEqual({ ok: false, reason: "not-selected" });
  });

  it("stops honoring a bare alias once the list exists; only instances resolve", () => {
    expect(resolveVpsTarget(cfg, { id: "a", vpsAlias: "alpha-vps" })).toEqual({ ok: false, reason: "not-selected" });
  });
});
