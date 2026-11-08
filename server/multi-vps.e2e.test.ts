import { describe, expect, it } from "vitest";

import type { AppConfig } from "./config.ts";
import type { BotRecord } from "./store.ts";
import { resolveSurface } from "./surface.ts";
import { resolveVpsTarget, vpsResourceKey } from "./vps-hosts.ts";

const cfg: AppConfig = {
  vps: {
    version: 2,
    instances: [
      { id: "alpha", name: "Alpha", kind: "ssh", sshAlias: "alpha-vps" },
      { id: "beta", name: "Beta", kind: "ssh", sshAlias: "beta-vps" },
      { id: "boxed", name: "Boxed", kind: "mcp", adapter: "simular-box", mcpServer: "simular", boxId: "box-1" },
    ],
  },
} as AppConfig;

const bot = (id: string, vpsInstanceId: string) => ({ id, name: id, vpsInstanceId }) as BotRecord;

describe("multi-VPS routing", () => {
  it("keeps two SSH bots on separate computers", () => {
    const alpha = resolveVpsTarget(cfg, bot("a", "alpha"));
    const beta = resolveVpsTarget(cfg, bot("b", "beta"));
    if (!alpha.ok || !beta.ok) throw new Error("fixture did not resolve");
    expect(alpha.target.instance.kind === "ssh" && alpha.target.instance.sshAlias).toBe("alpha-vps");
    expect(beta.target.instance.kind === "ssh" && beta.target.instance.sshAlias).toBe("beta-vps");
    expect(vpsResourceKey(alpha.target, "a")).not.toBe(vpsResourceKey(beta.target, "b"));
  });

  it("mounts a simular computer only for its selected bot", () => {
    expect(resolveVpsTarget(cfg, bot("boxed-bot", "boxed")).ok).toBe(true);
    expect(resolveVpsTarget(cfg, bot("other", "alpha")).ok).toBe(true);
    expect(resolveVpsTarget(cfg, bot("unselected", "")).ok).toBe(false);
  });

  it("keeps off browser and vm turns free of the cloud source", () => {
    expect(resolveSurface({ destination: "off", browserOn: true })).toMatchObject({ computer: "off", browser: false });
    expect(resolveSurface({ destination: "browser", browserOn: true })).toMatchObject({ computer: "off", browser: true });
    expect(resolveSurface({ destination: "vm", browserOn: true }).computer).toBe("vm");
  });

  it("rejects an old capability after connection rotation", () => {
    const before = resolveVpsTarget(cfg, bot("boxed-bot", "boxed"));
    const rotated = {
      ...cfg,
      vps: {
        version: 2 as const,
        instances: [{ id: "boxed", name: "Boxed", kind: "mcp" as const, adapter: "simular-box" as const, mcpServer: "simular", boxId: "box-2" }],
      },
    } as AppConfig;
    const after = resolveVpsTarget(rotated, bot("boxed-bot", "boxed"));
    if (!before.ok || !after.ok) throw new Error("fixture did not resolve");
    expect(after.target.revision).not.toBe(before.target.revision);
  });

  it("keeps room and resumed selections on the original target", () => {
    const first = resolveVpsTarget(cfg, bot("a", "alpha"));
    const resumed = resolveVpsTarget(cfg, bot("a", "alpha"));
    if (!first.ok || !resumed.ok) throw new Error("fixture did not resolve");
    expect(vpsResourceKey(first.target, "a")).toBe(vpsResourceKey(resumed.target, "a"));
  });
});
