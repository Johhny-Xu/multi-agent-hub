import { describe, expect, it } from "vitest";

import type { Bot } from "@/state/store";
import { duplicateBotProfile } from "./bot-duplicate";

describe("duplicating a bot on a VPS computer", () => {
  it("copies the instance reference without creating another box", () => {
    const source = {
      name: "Boxed",
      computer: "cloud",
      cloudBackend: "vps",
      vpsInstanceId: "boxed",
      autoStartVps: false,
    } as unknown as Bot;
    const copy = duplicateBotProfile(source);
    expect(copy.vpsInstanceId).toBe("boxed");
    expect(copy.cloudBackend).toBe("vps");
    expect(source.vpsInstanceId).toBe("boxed");
    expect(Object.keys(copy).filter((key) => /box|instance/i.test(key)).sort()).toEqual(["vpsInstanceId"]);
  });
});
