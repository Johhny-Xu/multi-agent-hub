import { describe, expect, it } from "vitest";
import { modelGroups } from "./EnginesSettings.tsx";

describe("modelGroups", () => {
  it("groups ids by provider prefix and skips bare ids", () => {
    expect(modelGroups(["openai/gpt-5", "opencode/big-pickle", "opencode/glm-5", "default"])).toEqual([
      { prefix: "openai", ids: ["openai/gpt-5"] },
      { prefix: "opencode", ids: ["opencode/big-pickle", "opencode/glm-5"] },
    ]);
  });
  it("keeps model ids that contain more slashes in their first segment's group", () => {
    expect(modelGroups(["openrouter/meta/llama"])).toEqual([{ prefix: "openrouter", ids: ["openrouter/meta/llama"] }]);
  });
});
