import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudPlanBridge, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudTrial } from "../../electron/cloud-home.mjs";
import { cloudTrialView } from "@/lib/cloud-plan";
import { setLocale } from "@/lib/i18n";

const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? initial() : initial;
    return [f.values[index], (next: unknown) => { f.values[index] = next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
import { CLOUD_PLAN_REFRESH_MS, CloudTrialNoticeCard, useCloudPlanSnapshot } from "./CloudTrialNotice";

const ENDS = new Date(2026, 9, 15, 12).getTime(), DAY = 86_400_000;
const trial = (state: CloudTrial["state"], extra: Partial<CloudTrial> = {}): CloudTrial =>
  ({ state, tier: "pro", endsAt: ENDS, amount: 4900, chargeAt: state === "active" ? ENDS : null, holdUntil: null, deleteAt: null, keep: "none", ...extra });
type Node = ReactElement<Record<string, any>>;
const nodes = (value: ReactNode): Node[] => {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  if (typeof node.type === "function") return nodes((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
};
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => { vi.clearAllMocks(); f.values = []; f.index = 0; f.effects = []; setLocale("en"); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); setLocale("en"); });

describe("the trial's notice card", () => {
  const card = (view: ReturnType<typeof cloudTrialView>, failed = false) => {
    const onAction = vi.fn(), onClose = vi.fn();
    const element = createElement(CloudTrialNoticeCard, { view, failed, onAction, onClose });
    return { html: renderToStaticMarkup(element), tree: nodes(CloudTrialNoticeCard({ view, failed, onAction, onClose })), onAction, onClose };
  };
  it("says the trial's own facts and the way to manage it; nothing sells another plan", () => {
    const { html, tree, onAction, onClose } = card(cloudTrialView(trial("active", { switchTo: { tier: "starter", amount: 1500 } }), { grantedUsd: 5, remainingUsd: 3.2, state: "active" }));
    for (const text of ["Your free trial ends on Oct 15", "Then Pro is $49/month plus tax, charged on Oct 15.", "Includes $5 of Claude credit: $3.20 left.", "Manage subscription", "Not now"]) expect(html).toContain(text);
    expect(html, "no switch-plan offer").not.toContain("Prefer Starter");
    expect(html).not.toContain("Subscribe");
    expect(html).toContain('role="status"'); expect(html).not.toContain("autofocus"); expect(html).not.toContain('aria-modal="true"');
    expect(html).toContain('data-notice="cloud-trial-active"');
    tree.find(node => node.type === "button" && renderToStaticMarkup(node).includes("Manage subscription"))!.props.onClick();
    expect(onAction).toHaveBeenCalledOnce();
    for (const label of ["Not now"]) tree.find(node => node.type === "button" && renderToStaticMarkup(node).includes(label))!.props.onClick();
    tree.find(node => node.type === "button" && node.props["aria-label"] === "Close")!.props.onClick();
    const event = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
    tree.find(node => node.type === "aside")!.props.onKeyDown(event);
    expect(onClose).toHaveBeenCalledTimes(3); expect(event.preventDefault).toHaveBeenCalled();
  });
  it("a trial that ended, or a cancellation that keeps it until the end, offers no renewal, only OK", () => {
    const ended = card(cloudTrialView(trial("ended", { deleteAt: ENDS + 3 * DAY, keep: "checkout" })));
    expect(ended.html).toContain("Your free trial has ended");
    expect(ended.html).toContain(">OK<"); expect(ended.html).not.toContain("Not now"); expect(ended.html).not.toContain("Subscribe");
    const ending = card(cloudTrialView(trial("ending", { keep: "portal" })));
    expect(ending.html).toContain("Your free trial ends on Oct 15");
    expect(ending.html).toContain(">OK<"); expect(ending.html).not.toContain("Subscribe");
  });
  it("a payment problem keeps its way to check it, and a browser that did not open says so", () => {
    const late = card(cloudTrialView(trial("late", { deleteAt: ENDS + 3 * DAY })), true);
    expect(late.html).toContain("Your first payment is taking longer");
    expect(late.html).toContain("Check payment status");
    expect(late.tree.find(node => node.type === "button" && renderToStaticMarkup(node).includes("Check payment status"))).toBeTruthy();
    expect(late.html).toContain("Could not open your browser. Please try again.");
    const processing = card(cloudTrialView(trial("processing")));
    expect(processing.html).toContain("Your first payment is processing"); expect(processing.html).toContain(">OK<");
  });
});

describe("the plan main reports to this page", () => {
  let bridge: { state: ReturnType<typeof vi.fn> } & Partial<CloudPlanBridge>;
  let listeners: Record<string, () => void>;
  let unsubscribe: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    listeners = {}; unsubscribe = vi.fn();
    bridge = { state: vi.fn(async (): Promise<CloudPlanSnapshot> => ({ status: "paid", tier: "pro" })) };
    vi.stubGlobal("window", { ogb: { cloudAccount: { onState: (cb: () => void) => { listeners.account = cb; return unsubscribe; } } },
      addEventListener: (name: string, cb: () => void) => { listeners[name] = cb; }, removeEventListener: (name: string) => { delete listeners[name]; } });
  });
  const run = () => { f.index = 0; f.effects = []; return useCloudPlanSnapshot(bridge as CloudPlanBridge); };
  it("asks at once, on each verified check on this computer, when the window comes back, and every 5 minutes", async () => {
    expect(run()).toBeNull();
    const stop = f.effects[0]!() as () => void; await flush();
    expect(run()).toEqual({ status: "paid", tier: "pro" });
    listeners.account!(); listeners.focus!(); vi.advanceTimersByTime(CLOUD_PLAN_REFRESH_MS); await flush();
    expect(bridge.state).toHaveBeenCalledTimes(4);
    stop(); expect(unsubscribe).toHaveBeenCalled(); expect(listeners.focus).toBeUndefined();
  });
  it("where main refuses, there is no plan to show and nothing more is asked", async () => {
    bridge.state.mockRejectedValue(new Error("only available in this app's window"));
    run(); f.effects[0]!(); await flush();
    expect(run()).toEqual({ status: "none" });
    vi.advanceTimersByTime(CLOUD_PLAN_REFRESH_MS * 3); await flush();
    expect(bridge.state).toHaveBeenCalledOnce();
  });
  it("without the bridge (a browser, another server), nothing", () => {
    f.index = 0; f.effects = [];
    expect(useCloudPlanSnapshot(undefined)).toBeNull(); f.effects[0]!();
  });
});
