// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({ calls: [] as Array<{ path: string; body?: unknown }>, refresh: vi.fn() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { instances: [] }, refreshInstances: fixture.refresh }),
  api: async (path: string, init?: RequestInit) => {
    fixture.calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return { instances: [] };
  },
}));

const { ModelVisibility } = await import("./EnginesSettings");

const engine = {
  instanceId: "zcode", driverKind: "zcodeAgent", displayName: "ZCode",
  snapshot: { state: "available", authenticated: true },
  models: { default: "glm-5.3-flash", options: [
    { id: "glm-5.3-flash", label: "GLM-5.3-Flash" },
    { id: "glm-5.3", label: "GLM-5.3", hidden: true },
    { id: "stealth", label: "stealth" },
  ] },
} as InstanceInfo;

let root: Root;
let host: HTMLElement;
const settle = () => new Promise((done) => setTimeout(done, 0));
beforeEach(() => {
  fixture.calls = [];
  fixture.refresh.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

describe("models in the picker", () => {
  it("lists every official model with a checked box, unchecked for a hidden one", () => {
    flushSync(() => root.render(createElement(ModelVisibility, { instance: engine })));
    expect(host.querySelector("[data-model-visibility]")).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('[data-model-shown="zcode/glm-5.3-flash"]')!.checked).toBe(true);
    expect(host.querySelector<HTMLInputElement>('[data-model-shown="zcode/glm-5.3"]')!.checked).toBe(false);
  });

  it("unchecking adds the model to hiddenModels, checking removes it", async () => {
    flushSync(() => root.render(createElement(ModelVisibility, { instance: engine })));
    flushSync(() => host.querySelector<HTMLInputElement>('[data-model-shown="zcode/stealth"]')!.click());
    await settle();
    expect(fixture.calls).toContainEqual({ path: "/api/instances/zcode", body: { hiddenModels: ["glm-5.3", "stealth"] } });
    expect(fixture.refresh).toHaveBeenCalled();

    fixture.calls = [];
    flushSync(() => host.querySelector<HTMLInputElement>('[data-model-shown="zcode/glm-5.3"]')!.click());
    await settle();
    expect(fixture.calls).toContainEqual({ path: "/api/instances/zcode", body: { hiddenModels: [] } });
  });
});
