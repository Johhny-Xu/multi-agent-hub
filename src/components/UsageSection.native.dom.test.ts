// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, t } from "@/lib/i18n";

const mocks = vi.hoisted(() => ({ fetchTraces: vi.fn() }));
vi.mock("@/state/store", () => ({
  api: vi.fn(async () => ({ groupBy: "bot", groups: [], budget: null })),
  useStore: () => ({ state: { instances: [], bots: [] }, dispatch: vi.fn() }),
}));
vi.mock("@/lib/live-events", () => ({ listenLiveFrames: () => () => {} }));
vi.mock("@/lib/usage-trace", async (original) => ({
  ...await original<typeof import("@/lib/usage-trace")>(),
  fetchTraces: mocks.fetchTraces,
}));
vi.mock("./usage/TraceWaterfall", () => ({
  StatStrip: () => null,
  LiveBadge: () => null,
  modelName: (name: string) => name,
  totalsStats: () => [],
}));
vi.mock("./usage/TraceView", () => ({ TraceView: () => null }));
vi.mock("./PlanUsage", () => ({ PlanUsage: () => null }));
vi.mock("./UsageBudget", () => ({ UsageBudgetCards: () => null }));
import { UsageSection } from "./UsageSection";

const traceList = {
  from: "2026-11-01",
  to: "2026-11-10",
  totals: { durationMs: 1_000, costUsd: 0, tokens: 0, input: 0, cachedInput: 0, output: 0, steps: 0, tools: 0, errors: 0 },
  roots: [{
    id: "r1", title: "Morning routine", source: "routine", startedAt: 1, endedAt: 2,
    running: false, timed: true, bots: [{ id: "b1", name: "Bee" }], usageStatus: "complete",
    durationMs: 1_000, costUsd: 0, tokens: 0, input: 0, cachedInput: 0, output: 0, steps: 0, tools: 0, errors: 0,
  }],
} as unknown as import("../../shared/usage-trace").TraceList;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  mocks.fetchTraces.mockReset();
  mocks.fetchTraces.mockResolvedValue(traceList);
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
  await act(async () => { root.render(createElement(UsageSection)); });
  await settle();
};

describe("the usage page's native frames", () => {
  it("frames the totals strip in the native simple card, keeping its data-testid", async () => {
    await show();
    const totals = document.querySelector<HTMLElement>('[data-testid="usage-totals"]');
    expect(totals).toBeTruthy();
    expect(totals?.classList.contains("rounded-[12px]")).toBe(true);
    expect(totals?.classList.contains("bg-menu")).toBe(true);
  });

  it("leads 'Where it went' and 'Runs' with the native Card title and subtitle", async () => {
    await show();
    const cards = [...document.querySelectorAll("div")].filter(
      (el) => el.classList.contains("rounded-xl") && el.classList.contains("bg-card") && el.classList.contains("p-4"));
    expect(cards.length).toBe(2);
    const titles = cards.map((card) => card.firstElementChild?.textContent);
    expect(titles).toContain(t("usage.page.where"));
    expect(titles).toContain(t("usage.page.runs"));
  });

  it("keeps the export affordance on a standard button and the run rows listed inside", async () => {
    await show();
    const exportLink = document.querySelector<HTMLAnchorElement>("a.ui-button");
    expect(exportLink?.textContent).toContain(t("usage.history.export"));
    expect(document.querySelectorAll('[data-testid="usage-run"]').length).toBe(1);
    expect(document.querySelector('[data-testid="usage-page"]')).toBeTruthy();
  });
});
