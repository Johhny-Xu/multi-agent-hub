// @vitest-environment node
import { describe, expect, it } from "vitest";
import { sortEngines } from "./engine-sort";

describe("sortEngines", () => {
  it("orders used → signed-in → rest A→Z", () => {
    const out = sortEngines([
      { name: "Zeta" },
      { name: "Alpha" },
      { name: "SignedOld", signedIn: true, lastSignInAt: 1 },
      { name: "SignedNew", signedIn: true, lastSignInAt: 5 },
      { name: "SignedNoStamp", signedIn: true },
      { name: "UsedOld", ready: true, lastUsedAt: 10 },
      { name: "UsedNew", ready: true, lastUsedAt: 20 },
    ]).map((e) => e.name);
    expect(out).toEqual(["UsedNew", "UsedOld", "SignedNew", "SignedOld", "SignedNoStamp", "Alpha", "Zeta"]);
  });
  it("does not mutate input", () => {
    const input = [{ name: "b" }, { name: "a" }];
    sortEngines(input);
    expect(input[0].name).toBe("b");
  });
});
