import { describe, expect, it } from "vitest";

import type { AppConfig } from "./config.ts";
import { customMcpServers } from "./config.ts";
import type { BotRecord } from "./store.ts";
import { resolveVpsTarget, vpsTargetCurrent } from "./vps-hosts.ts";

const bot = { id: "selected", name: "Selected", vpsInstanceId: "boxed" } as BotRecord;
const cfg = (boxId = "box-1"): AppConfig => ({
  mcpServers: {
    simular: { type: "http", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer secret" }, enabled: true },
    notes: { command: "npx", args: ["notes"], enabled: true },
  },
  vps: {
    version: 2,
    instances: [{ id: "boxed", name: "Boxed", kind: "mcp", adapter: "simular-box", mcpServer: "simular", boxId }],
  },
}) as AppConfig;

describe("VPS computer mount boundaries", () => {
  it("blocks computer sources through MCP Apps and broker mounts", () => {
    const config = cfg();
    expect(customMcpServers(config, ["simular"], bot.id)).toEqual({});
    expect(customMcpServers(config, undefined, "someone-else").simular).toBeUndefined();
    // A saved connection that is not a computer source still mounts normally.
    expect(Object.keys(customMcpServers(config, ["notes"], bot.id))).toEqual(["notes"]);
    // Registering a missing source still reserves the name from ordinary mounts.
    expect(customMcpServers(config, ["absent"], bot.id).absent).toBeUndefined();
  });

  it("rejects a delayed selection result after its target changes", () => {
    const before = resolveVpsTarget(cfg("box-1"), bot);
    const after = resolveVpsTarget(cfg("box-2"), bot);
    if (!before.ok || !after.ok) throw new Error("fixture did not resolve");
    expect(vpsTargetCurrent(before.target, cfg("box-1"), bot)).toBe(true);
    expect(vpsTargetCurrent(before.target, cfg("box-2"), bot)).toBe(false);
    expect(vpsTargetCurrent(after.target, cfg("box-2"), bot)).toBe(true);
  });
});
