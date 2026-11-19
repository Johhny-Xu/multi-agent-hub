// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudPlanBridge, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudRoom, CloudUsage } from "../../electron/cloud-home.mjs";
import { setLocale } from "@/lib/i18n";

const store = vi.hoisted(() => ({ bots: [] as Array<{ id: string; busy?: boolean }> }));
vi.mock("@/state/store", async original => ({ ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { bots: store.bots, config: { cloudHome: true } }, dispatch: vi.fn() }) }));
import { CloudRoomCard } from "./CloudRoomCard";

// The room card on the person's own Cloud, rendered as the sidebar renders it, against a bridge that answers as main does.
const usage: CloudUsage = { tier: "starter", resetsAt: Date.UTC(2026, 10, 1), meters: [{ kind: "storage", used: 2, max: 10 }], upgrades: [{ tier: "pro", amount: 4900 }, { tier: "max", amount: 9900 }] };
const memory: CloudRoom = { id: "offer-1", cause: { kind: "memory", waits: 3, waitMinutes: 6, stopped: 0 },
  plan: { tier: "pro", amount: 4900, memoryMb: 4096, fromMemoryMb: 2048, diskGb: 100, fromDiskGb: 10 } };
let container: HTMLDivElement, root: Root, snapshot: CloudPlanSnapshot;
function bridge(): CloudPlanBridge & Record<"roomNotNow", ReturnType<typeof vi.fn>> {
  return { state: vi.fn(async () => snapshot), manage: vi.fn(async () => {}), roomNotNow: vi.fn(async () => true) } as never;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  globalThis.localStorage?.clear();
  store.bots = [{ id: "chief" }];
  snapshot = { status: "paid", tier: "starter", usage, room: memory };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const show = async (plan: CloudPlanBridge) => { vi.stubGlobal("window", Object.assign(window, { ogb: { cloudPlan: plan } })); await act(async () => { root.render(createElement(CloudRoomCard)); }); await settle(); };
const card = () => document.querySelector<HTMLElement>("[data-cloud-room-card]");
const text = () => card()?.textContent ?? "";
const button = (label: string) => [...document.querySelectorAll("button")].find(item => item.textContent === label);
const click = async (target: Element | null | undefined) => { expect(target).toBeTruthy(); await act(async () => { (target as HTMLElement).click(); }); await settle(); };

describe("the room card", () => {
  it("says what ran short, in the person's own numbers, and Got it puts it away; it never sells a plan", async () => {
    const plan = bridge();
    await show(plan);
    expect(card()?.getAttribute("data-cloud-room-card")).toBe("tip");
    expect(text()).toBe("This Cloud is short on room3 tasks waited 6 minutes for memory today.Got it");
    expect(button("Upgrade")).toBeUndefined();
    expect(text()).not.toContain("$49"); expect(text()).not.toContain("Pro has twice the memory");
    await click(button("Got it"));
    expect(plan.roomNotNow).toHaveBeenCalledExactlyOnceWith("offer-1");
    expect(card()).toBeNull();
  });

  it("waits while any bot is working", async () => {
    store.bots = [{ id: "chief", busy: true }];
    await show(bridge());
    expect(card()).toBeNull();
    store.bots = [{ id: "chief" }];
    await act(async () => { root.render(createElement(CloudRoomCard)); });
    await settle();
    expect(card()).not.toBeNull();
  });

  it("shows the top plan's tip and no Upgrade, and nothing while the usage card is showing", async () => {
    const plan = bridge();
    snapshot = { status: "paid", tier: "max", usage: { ...usage, tier: "max", upgrades: [] }, room: { id: "tip-1", cause: { kind: "disk", usedGb: 87.5, capGb: 100 }, tip: true } };
    await show(plan);
    expect(text()).toBe("This Cloud is almost out of space87.5 GB of 100 GB used.You're on the biggest plan. To free up space, delete files and folders you no longer need.Got it");
    expect(button("Upgrade")).toBeUndefined();
    await act(async () => root.unmount()); root = createRoot(container);
    snapshot = { status: "paid", tier: "starter", usage: { ...usage, meters: [{ kind: "computerHours", used: 95, max: 100 }] }, room: { ...memory, id: "offer-2" } };
    await show(bridge());
    expect(card()).toBeNull();
  });
});
