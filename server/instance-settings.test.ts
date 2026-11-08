import { describe, expect, it } from "vitest";

import { instanceSettingsSchema } from "./claude-accounts.ts";
import { withInstanceConfig, type SelectableInstance } from "./default-model-selection.ts";

describe("instance settings for disabling and hiding models", () => {
  it("accepts the two new fields and keeps the old ones", () => {
    expect(instanceSettingsSchema.safeParse({ disabled: true }).success).toBe(true);
    expect(instanceSettingsSchema.safeParse({ disabled: false, hiddenModels: ["glm-5.3", "glm-5.2"] }).success).toBe(true);
    expect(instanceSettingsSchema.safeParse({ hidden: true, hiddenModels: [] }).success).toBe(true);
  });

  it("refuses empty model ids and unknown fields", () => {
    expect(instanceSettingsSchema.safeParse({ hiddenModels: [""] }).success).toBe(false);
    expect(instanceSettingsSchema.safeParse({ hiddenModels: ["x".repeat(257)] }).success).toBe(false);
    expect(instanceSettingsSchema.safeParse({ disabled: "yes" }).success).toBe(false);
    expect(instanceSettingsSchema.safeParse({ disable: true }).success).toBe(false);
  });

  it("a disabled engine is still described but is not selectable", () => {
    const instances = [
      { instanceId: "claude", snapshot: { state: "available" }, models: { default: "m", options: [{ id: "m" }] } },
      { instanceId: "zcode", snapshot: { state: "available" }, models: { default: "m", options: [{ id: "m" }] } },
    ] as unknown as SelectableInstance[];
    const listed = withInstanceConfig(instances, { zcode: { driver: "zcodeAgent", disabled: true } });
    expect(listed.map((instance) => instance.instanceId)).toEqual(["claude", "zcode"]);
    expect(listed[1]?.enabled).toBe(false);
  });
});
