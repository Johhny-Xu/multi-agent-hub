// @vitest-environment node
import { describe, expect, it } from "vitest";
import { QODER_THINKING, splitQoderThinking } from "./qoder.ts";

describe("splitQoderThinking", () => {
  it("prefers the picked variant", () => {
    expect(splitQoderThinking("Sonus", "enabled")).toEqual({ model: "Sonus", thinking: "enabled" });
  });
  it("reads a -mode suffix on the model id", () => {
    expect(splitQoderThinking("Sonus-Disabled", undefined)).toEqual({ model: "Sonus", thinking: "disabled" });
  });
  it("leaves a bare id and the auto model alone", () => {
    expect(splitQoderThinking("dfmodel", undefined)).toEqual({ model: "dfmodel", thinking: undefined });
    expect(splitQoderThinking("auto", undefined)).toEqual({ model: "auto", thinking: undefined });
  });
  it("offers the four CLI modes", () => {
    expect(QODER_THINKING.map((t) => t.id)).toEqual(["auto", "adaptive", "enabled", "disabled"]);
  });
});
