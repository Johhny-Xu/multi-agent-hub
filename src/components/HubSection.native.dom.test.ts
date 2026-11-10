// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, t } from "@/lib/i18n";

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

const nativeCardOf = (el: Element | null | undefined) => {
  let node = el?.parentElement;
  while (node) {
    if (node.classList.contains("rounded-[12px]")) return node;
    node = node.parentElement;
  }
  return undefined;
};

describe("the hub section's native rows", () => {
  it("lays each hub panel on a native SettingRow behind a standard open button", async () => {
    await show();
    const labels = [...document.querySelectorAll("[role='group']")].map(
      (group) => document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent);
    expect(labels).toContain(t("settings.hub.checkin"));
    expect(labels).toContain(t("settings.hub.webui"));
    const openButtons = [...document.querySelectorAll("button.ui-button")]
      .filter((button) => button.textContent === t("settings.hub.open"));
    expect(openButtons.length).toBe(2);
    for (const button of openButtons) {
      const card = nativeCardOf(button);
      expect(card?.classList.contains("bg-menu")).toBe(true);
    }
  });

  it("frames a dispatched task in the native simple card, keeping its data-hub-task", async () => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path === "/hub/health") return health;
      if (path === "/api/hub/tasks") return { tasks: [task("T-1")] };
      return {};
    });
    await show();
    const row = document.querySelector<HTMLElement>('[data-hub-task="T-1"]');
    expect(row).toBeTruthy();
    expect(row?.classList.contains("rounded-[12px]")).toBe(true);
    expect(row?.classList.contains("bg-menu")).toBe(true);
    expect(row?.textContent).toContain("zcode-n2");
    expect(row?.textContent).toContain("step 2 of 4");
  });
});
