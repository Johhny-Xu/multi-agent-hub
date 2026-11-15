// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: mocks.api }));
import { HubSection } from "./HubSection";

const health = { console: { ok: true, url: "http://hub.local" }, scheduler: { ok: true, url: "http://hub.local" } };
const task = (ref: string) => ({
  ref, agent: "zcode-n2", status: "running", title: "Fix the hub bridge",
  progress: "step 2 of 4", startedAt: 1_000, updatedAt: 1_100, elapsedS: 100, exitCode: null, result: null,
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", undefined);
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: false, addEventListener: () => {}, removeEventListener: () => {},
  } as unknown as MediaQueryList);
  setLocale("en");
  mocks.api.mockReset();
  mocks.api.mockImplementation(async (path: string) => {
    if (path === "/hub/health") return health;
    if (path === "/api/hub/tasks") return { tasks: [] };
    return {};
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

const show = async () => {
  await act(async () => { root.render(createElement(HubSection)); });
  await settle();
};

// HUB-HIDE: the section is hidden, so it must mount nothing and start no request. These replace the old
// visibility tests on purpose: the requirement changed from "show both cards" to "show nothing".
describe("the hidden hub section", () => {
  it("renders nothing and asks the hub for nothing", async () => {
    await show();
    expect(container.innerHTML).toBe("");
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it("stays empty even when the hub would report a dispatched task", async () => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path === "/hub/health") return health;
      if (path === "/api/hub/tasks") return { tasks: [task("T-1")] };
      return {};
    });
    await show();
    expect(container.innerHTML).toBe("");
    expect(document.querySelector('[data-hub-task="T-1"]')).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    expect(mocks.api).not.toHaveBeenCalled();
  });
});
