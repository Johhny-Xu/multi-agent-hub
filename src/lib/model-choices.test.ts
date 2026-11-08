import { describe, expect, it, vi } from "vitest";

import type { InstanceInfo, ModelSelection } from "@/state/store";
import { choiceIsSelected, modelChoices, pickableModels, withTypedModels } from "./model-choices";
import { simpleModelMenu } from "./simple-model-menu";

vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});

const antigravity = {
  instanceId: "google",
  driverKind: "antigravityAgent",
  displayName: "Google Gemini (Antigravity)",
  snapshot: { state: "available", version: "1.4.3" },
  models: { default: "gemini-3.8-flash", options: [{
    id: "gemini-3.8-flash", label: "Gemini 3.8 Flash",
    variants: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }],
  }] },
} as InstanceInfo;

describe("Antigravity model choices", () => {
  it("presents each advertised thinking level as a selectable model row", () => {
    const choices = modelChoices(antigravity, antigravity.models.options);
    expect(choices.map((choice) => choice.label)).toEqual([
      "Gemini 3.8 Flash · Low", "Gemini 3.8 Flash · Medium", "Gemini 3.8 Flash · High",
    ]);
    expect(choiceIsSelected(choices[1]!, { instanceId: "google", model: "gemini-3.8-flash", variant: "medium" })).toBe(true);
  });
});

describe("models hidden from the pickers", () => {
  const engine = {
    instanceId: "zcode", driverKind: "zcodeAgent", displayName: "ZCode",
    snapshot: { state: "available", authenticated: true },
    models: { default: "glm-5.3-flash", options: [
      { id: "glm-5.3-flash", label: "GLM-5.3-Flash" },
      { id: "glm-5.3", label: "GLM-5.3", hidden: true },
      { id: "stealth", label: "stealth" },
    ] },
  } as InstanceInfo;

  it("leaves a hidden model out, unless it is already selected", () => {
    expect(pickableModels(engine).map((model) => model.id)).toEqual(["glm-5.3-flash", "stealth"]);
    expect(pickableModels(engine, ["glm-5.3"]).map((model) => model.id))
      .toEqual(["glm-5.3-flash", "glm-5.3", "stealth"]);
  });

  it("the simple menu keeps the current and the bot's model visible", () => {
    const selection: ModelSelection = { instanceId: "zcode", model: "glm-5.3" };
    const menu = simpleModelMenu({ instances: [engine], listed: [engine], selection,
      bot: { name: "Pepper", selection, follows: false }, query: "", expanded: new Set(), probing: new Set(), loading: false });
    expect(menu.groups[0]!.body.kind === "models" ? menu.groups[0]!.body.total : 0).toBe(3);

    const other = simpleModelMenu({ instances: [engine], listed: [engine], selection: { instanceId: "zcode", model: "stealth" },
      bot: { name: "Pepper", selection: { instanceId: "zcode", model: "stealth" }, follows: false }, query: "",
      expanded: new Set(["zcode"]), probing: new Set(), loading: false });
    const otherRows = other.groups[0]!.body.kind === "models" ? other.groups[0]!.body.rows.map((row) => row.option.id) : [];
    expect(otherRows).not.toContain("glm-5.3");
    expect(otherRows).toContain("glm-5.3-flash");
    expect(other.groups[0]!.body.kind === "models" ? other.groups[0]!.body.total : 0).toBe(2);
  });
});

describe("OpenCode models typed by hand", () => {
  const opencode = {
    instanceId: "opencode", driverKind: "opencodeGo", displayName: "OpenCode", access: "subscription",
    snapshot: { state: "available", version: "1.19.4", authenticated: true },
    models: { default: "opencode/big-pickle", options: [
      { id: "opencode/big-pickle", label: "Zen · Big Pickle" }, { id: "venice/deepseek-v4-flash", label: "Venice · DeepSeek V4 Flash" },
    ] },
  } as InstanceInfo;
  const typed = "venice/deepseek-v4-1-flash-uncensored";
  const onPickle: ModelSelection = { instanceId: "opencode", model: "opencode/big-pickle" };
  const added = (instances: InstanceInfo[]) => instances[0]!.models.options.slice(opencode.models.options.length);

  it("offers a provider/model id typed in the search box, saved as typed and labelled typed by hand", () => {
    expect(added(withTypedModels([opencode], onPickle, ` ${typed} `))).toEqual([{ id: `typed::${typed}`, label: `${typed} · typed by hand` }]);
    const menu = simpleModelMenu({ instances: [opencode], listed: withTypedModels([opencode], onPickle, typed), selection: onPickle,
      bot: { name: "Pepper", selection: onPickle }, query: typed, expanded: new Set(), probing: new Set(), loading: false });
    expect(menu.search).toBe(true);
    expect(menu.groups[0]!.body).toMatchObject({ kind: "models", rows: [{ option: { id: `typed::${typed}` }, label: `${typed} · typed by hand` }] });
  });

  it("keeps a typed selection listed and named, and adds nothing the catalog has or that is not an id", () => {
    expect(added(withTypedModels([opencode], { instanceId: "opencode", model: `typed::${typed}` }, ""))).toEqual([
      { id: `typed::${typed}`, label: `${typed} · typed by hand` },
    ]);
    for (const query of ["venice/deepseek-v4-flash", "deepseek", "venice/ x"]) {
      expect(withTypedModels([opencode], onPickle, query)[0]).toBe(opencode);
    }
    expect(withTypedModels([opencode], { instanceId: "opencode", model: "venice/retired" }, "")[0]).toBe(opencode);
    expect(withTypedModels([antigravity], { instanceId: "google", model: `typed::${typed}` }, typed)[0]).toBe(antigravity);
  });
});
