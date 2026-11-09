import { describe, expect, it } from "vitest";

import { isDebugBot, isDebugBotId, isDebugInboxRow, isDebugSearchHit } from "./debug-zone";

describe("debug zone bots", () => {
  it("recognizes the bots hub-compat keeps for its workers", () => {
    expect(isDebugBot({ name: "hub·zcode" })).toBe(true);
    expect(isDebugBot({ name: "hub·codebuddy-cn" })).toBe(true);
  });

  it("recognizes bots marked debug or sourced from the hub", () => {
    expect(isDebugBot({ name: "Worker", debug: true })).toBe(true);
    expect(isDebugBot({ name: "Worker", source: "hub" })).toBe(true);
  });

  it("leaves the person's own bots in the everyday lists", () => {
    expect(isDebugBot({ name: "Atlas" })).toBe(false);
    expect(isDebugBot({ name: "hubris" })).toBe(false);
    expect(isDebugBot({ name: "Worker", debug: false, source: "app" })).toBe(false);
  });

  it("identifies debug bots by bot id", () => {
    const bots = [
      { id: "b1", name: "Atlas" },
      { id: "b2", name: "hub·minimaxcode" },
      { id: "b3", name: "Custom", source: "hub" },
    ];
    expect(isDebugBotId("b1", bots)).toBe(false);
    expect(isDebugBotId("b2", bots)).toBe(true);
    expect(isDebugBotId("b3", bots)).toBe(true);
    expect(isDebugBotId("unknown", bots)).toBe(false);
    expect(isDebugBotId(undefined, bots)).toBe(false);
  });

  it("filters search hits from debug bots", () => {
    const bots = [
      { id: "b1", name: "Atlas" },
      { id: "b2", name: "Worker", debug: true },
    ];
    expect(isDebugSearchHit({ botId: "b1", name: "Atlas" }, bots)).toBe(false);
    expect(isDebugSearchHit({ botId: "b2", name: "Worker" }, bots)).toBe(true);
    expect(isDebugSearchHit({ name: "hub·traecode" }, bots)).toBe(true);
    expect(isDebugSearchHit({ from: "hub·antigravity" }, bots)).toBe(true);
    expect(isDebugSearchHit({ name: "General Room" }, bots)).toBe(false);
  });

  it("filters inbox rows associated with debug bots", () => {
    const bots = [
      { id: "b1", name: "Atlas" },
      { id: "b2", name: "hub·zcode" },
    ];
    expect(isDebugInboxRow({ from: { botId: "b1", name: "Atlas" } }, bots)).toBe(false);
    expect(isDebugInboxRow({ from: { botId: "b2", name: "hub·zcode" } }, bots)).toBe(true);
    expect(isDebugInboxRow({ from: { name: "hub·qoder-cn" } }, bots)).toBe(true);
    expect(isDebugInboxRow({ origin: { botId: "b2" } }, bots)).toBe(true);
    expect(isDebugInboxRow({ via: { botId: "b2", name: "hub·zcode" } }, bots)).toBe(true);
    expect(isDebugInboxRow({ workingFor: { botId: "b2", name: "hub·zcode" } }, bots)).toBe(true);
  });
});

import { isAdvancedOnlySection } from "./debug-zone";

describe("isAdvancedOnlySection", () => {
  it("hides the 临时 department outside advanced mode only", () => {
    expect(isAdvancedOnlySection("临时")).toBe(true);
    expect(isAdvancedOnlySection("TEAM")).toBe(false);
    expect(isAdvancedOnlySection(undefined)).toBe(false);
  });
});
