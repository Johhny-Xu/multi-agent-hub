import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountState, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudTrial } from "../../electron/cloud-home.mjs";
import { withTourFinished } from "@/lib/guided-tour";
import { setLocale } from "@/lib/i18n";
import { EMPTY_ONBOARDING, LOCAL_VIEWER, markWelcomeFinished, MET_CHIEF_HINT, type WelcomeViewer } from "@/lib/onboarding";
import { launchDialogShown } from "@/lib/launch-dialogs";

const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], state: {} as any, updater: null as any, dispatch: null as any, brand: "default" }));
vi.mock("./Layer", () => ({ Layer: ({ children }: { children: ReactNode }) => children, useIsTopLayer: () => () => true }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useId: () => "test-id",
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? initial() : initial;
    return [f.values[index], (next: unknown) => { f.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(f.values[index]) : next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: vi.fn().mockResolvedValue({}),
  CLOUD_LINK_SETTINGS: { type: "toggleAppSettings", open: true, section: "cloudAccount", cloudLink: true } }));
vi.mock("@/lib/analytics", () => ({ emailGateDone: () => false, track: vi.fn() }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => f.updater }));
vi.mock("./cloud-buy/NightCard", () => ({ NightCard: ({ children }: { children: unknown }) => children }));
vi.mock("@/lib/default-bot", async original => ({ ...await original<typeof import("@/lib/default-bot")>(), useViewerEmail: () => undefined }));
vi.mock("@/lib/brand", () => ({ brandStatus: () => ({ brand: { name: "OpenMausBot" }, source: f.brand, file: "" }), productName: () => "MausBot" }));
vi.mock("./Avatar", async original => ({ ...await original<typeof import("./Avatar")>(), MausAvatar: () => null }));
vi.mock("./lazy-screens", async original => ({ ...await original<typeof import("./lazy-screens")>(), GrokMoveDialog: () => "THE MOVE DIALOG" }));
vi.mock("@/components/EngineLibrary", () => ({ engineReady: () => true }));
import { AppNotices } from "./AppNotices";
import { CLOUD_TRIAL_NOTICE, GROK_MOVE_NOTICE, launchNotice, TWO_PLACES_NOTICE } from "@/lib/notices";
import { track } from "@/lib/analytics";
import { ADVANCED_MODE_KEY, setAdvancedMode } from "@/lib/interface-mode";
import { SIMPLE_MODE_PROMPT_KEY } from "@/lib/simple-mode-prompt";
import { api } from "@/state/store";

const DAY = 86_400_000, NOW = new Date(2026, 9, 9, 12).getTime();
const signedOut: CloudAccountState = { status: "signed-out" };
const paid = (extra: Partial<CloudAccountState> = {}): CloudAccountState => ({ status: "connected", account: { id: "a", email: "person@example.test" },
  entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: NOW + 30 * DAY, version: 2 }, ...extra });
const trial = (state: CloudTrial["state"], extra: Partial<CloudTrial> = {}): CloudTrial =>
  ({ state, tier: "pro", endsAt: NOW + DAY, amount: 4900, chargeAt: NOW + DAY, holdUntil: null, deleteAt: null, keep: "none", ...extra });

let storage: Map<string, string>;
let account: CloudAccountState;
let snapshot: CloudPlanSnapshot | Error;
let viewer: WelcomeViewer | null;
let bridges: { cloud: Record<string, ReturnType<typeof vi.fn>>; plan: Record<string, ReturnType<typeof vi.fn>> };
let desktopSeen: string[];
let now: number;
let session: Map<string, string>;

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const render = () => { f.index = 0; f.effects = []; return renderToStaticMarkup(createElement(AppNotices, { viewer, now: () => now })); };
async function settle(rounds = 4) { for (let i = 0; i < rounds; i++) { render(); f.effects.forEach(effect => effect()); await flush(); } return render(); }
const launch = () => { f.values = []; return settle(); };
const relaunch = () => { session.clear(); return launch(); };
type Node = ReactElement<Record<string, any>>;
const nodes = (value: ReactNode): Node[] => {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  if (typeof node.type === "function") return nodes((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
};
const tree = () => { f.index = 0; f.effects = []; return nodes(AppNotices({ viewer, now: () => now })); };
const press = (label: string) => {
  const button = tree().find(node => node.type === "button" && (renderToStaticMarkup(node).includes(`>${label}<`) || node.props["aria-label"] === label));
  expect(button, label).toBeTruthy(); button!.props.onClick();
};
const FIRST_REPLY = [{ tasks: [{ threadId: "first", usage: { turns: 1 } }] }];
const returning = () => { f.state.bots = [{ tasks: [{ threadId: "t", createdAt: 1, usage: { turns: 2 } }] }]; };
const hints = () => f.state.config.onboarding.hintsSeen as string[];

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  storage = new Map(); session = new Map(); f.values = []; f.index = 0; f.effects = []; f.updater = null; f.brand = "default"; f.dispatch = vi.fn(); now = NOW;
  setLocale("en"); viewer = LOCAL_VIEWER; account = signedOut; snapshot = { status: "none" }; desktopSeen = [];
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => session.set(key, value) });
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  // The two popups start seen: every test before their own is about the other notices.
  storage.set(GROK_MOVE_NOTICE, "1"); storage.set(SIMPLE_MODE_PROMPT_KEY, "1");
  f.state = { connected: true, hydrated: true, bots: structuredClone(FIRST_REPLY), groups: [], routines: [],
    instances: [{ instanceId: "claude", snapshot: { state: "available", authenticated: true } }],
    config: { onboarding: { ...EMPTY_ONBOARDING, completedAt: "2026-09-01", version: 1, hintsSeen: withTourFinished(undefined) } } };
  vi.mocked(api).mockImplementation(async (_path, init) => {
    const patch = JSON.parse(String((init as RequestInit).body));
    f.state.config.onboarding.hintsSeen = patch.onboarding.hintsSeen;
    return f.state.config;
  });
  bridges = {
    cloud: { state: vi.fn(async () => account), onState: vi.fn(() => () => {}), offer: vi.fn(async () => null),
      begin: vi.fn(async () => account), signInAgain: vi.fn(async () => account), connectHome: vi.fn(async () => account), openDashboard: vi.fn(async () => account) },
    plan: { state: vi.fn(async () => { if (snapshot instanceof Error) throw snapshot; return snapshot; }), manage: vi.fn(async () => {}), noticeSeen: vi.fn(async () => {}) },
  };
  vi.stubGlobal("window", {
    ogb: { remoteClient: { active: false }, cloudAccount: bridges.cloud, cloudPlan: bridges.plan,
      desktopNotices: { state: async () => ({ seen: desktopSeen, cloud: true }), seen: async (id: string) => { desktopSeen.push(id); }, shown: async () => false },
      twoPlaces: { state: async () => ({ suggest: null }), accept: async () => ({ suggest: null }), dismiss: async () => ({}), onChanged: () => () => {} } },
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", { activeElement: null, body: null, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); setLocale("en"); });

describe("the free trial's notice", () => {
  it("shows the notice main says is due, tells main once, and stays up until it is closed", async () => {
    const running = trial("active");
    account = paid({ trial: running }); snapshot = { status: "paid", tier: "pro", trial: running, notice: "active", credit: { grantedUsd: 5, remainingUsd: 3.2, state: "active" } };
    const html = await launch();
    expect(html).toContain("Your free trial ends on"); expect(html).toContain("Includes $5 of Claude credit: $3.20 left.");
    expect(bridges.plan.noticeSeen).toHaveBeenCalledOnce();
    snapshot = { ...snapshot, notice: undefined };
    expect(await settle()).toContain("Your free trial ends on");
    expect(bridges.plan.noticeSeen).toHaveBeenCalledOnce();
    press("Manage subscription"); await flush();
    expect(bridges.plan.manage).toHaveBeenCalledOnce();
    expect(render()).toBe("");
    expect(await relaunch()).not.toContain("Your free trial");
  });

  it("waits for a new install's first reply", async () => {
    const running = trial("active");
    account = paid({ trial: running }); snapshot = { status: "paid", tier: "pro", trial: running, notice: "active" };
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), MET_CHIEF_HINT];
    f.state.bots = [{ tasks: [{ threadId: "first", usage: { turns: 0 } }] }];
    expect(await launch()).toBe("");
    f.state.bots = structuredClone(FIRST_REPLY);
    expect(await launch()).toContain("Your free trial ends on");
  });
});

describe("This computer's Cloud sign-in card", () => {
  it("an ended sign-in on a paid plan asks to sign in again", async () => {
    account = { status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } }; returning();
    expect(await launch()).toContain("Sign in again to reach the Cloud");
    press("Sign in again"); await flush();
    expect(bridges.cloud.signInAgain).toHaveBeenCalledOnce();
  });
});

describe("the Move from Grok Bot popup", () => {
  const TITLE = "Move from Grok Bot";
  const events = () => vi.mocked(track).mock.calls.filter(([name]) => name === "grok_move_popup").map(([, props]) => (props as { action: string }).action);
  beforeEach(() => { storage.delete(GROK_MOVE_NOTICE); });

  it("goes first in the queue, is counted once, and Not now ends it for good everywhere", async () => {
    returning();
    const html = await launch();
    expect(html).toContain(TITLE);
    expect(events()).toEqual(["shown"]);
    expect(launchNotice()).toBe(GROK_MOVE_NOTICE);
    expect(launchDialogShown(), "MausBot's card waits for a later launch").toBe("notices");
    expect(await settle()).toContain(TITLE);
    expect(events(), "shown is counted once").toHaveLength(1);
    press("Not now"); await flush();
    expect(render()).toBe("");
    expect(storage.get(GROK_MOVE_NOTICE)).toBe("1"); expect(hints()).toContain(GROK_MOVE_NOTICE); expect(desktopSeen).toContain(GROK_MOVE_NOTICE);
    expect(await launch(), "a reload is the same launch").not.toContain(TITLE);
    expect(await relaunch(), "nor any later one").not.toContain(TITLE);
  });

  it("holds every other notice back in its launch", async () => {
    returning();
    setAdvancedMode(true);
    storage.delete(SIMPLE_MODE_PROMPT_KEY);
    const first = await launch();
    expect(first).toContain(TITLE); expect(first).not.toContain("data-simple-mode-prompt");
    press("Not now"); await flush();
    expect(render(), "nothing else after it in this launch").toBe("");
    const second = await relaunch();
    expect(second).toContain("data-simple-mode-prompt"); expect(second).not.toContain(TITLE);
  });
});

describe("the Simple mode popup", () => {
  const TITLE = "Try the new Simple mode";
  beforeEach(() => {
    setAdvancedMode(true);
    storage.delete(SIMPLE_MODE_PROMPT_KEY);
    storage.set(GROK_MOVE_NOTICE, "1");
    vi.stubGlobal("document", { activeElement: null, body: null, documentElement: { dataset: {} }, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] });
  });

  it("shows once in each browser, claims the launch, and never comes back once it is closed", async () => {
    const html = await launch();
    expect(html).toContain(TITLE);
    expect(launchDialogShown()).toBe("notices");
    press("Done"); await flush();
    expect(render(), "nothing else in this launch after it").toBe("");
    expect(storage.get(SIMPLE_MODE_PROMPT_KEY)).toBe("1");
    session.clear();
    expect(await launch()).not.toContain(TITLE);
  });

  it("changes the mode live from the popup, both ways, while its words stay", async () => {
    await launch();
    press("Simple mode"); await flush();
    expect(storage.get(ADVANCED_MODE_KEY)).toBe("0");
    expect(render()).toContain(TITLE);
    press("Simple mode"); await flush();
    expect(storage.get(ADVANCED_MODE_KEY)).toBe("1");
    expect(storage.has(SIMPLE_MODE_PROMPT_KEY), "flipping never closes it").toBe(false);
  });
});

describe("bots in two places", () => {
  const GARAGE = { key: "server:https://garage.example.test", name: "Garage server", kind: "server" as const };
  it("one plain card, and Not now hands main the place to remember", async () => {
    returning(); storage.set(GROK_MOVE_NOTICE, "1"); storage.set(SIMPLE_MODE_PROMPT_KEY, "1");
    const dismiss = vi.fn(async () => ({}));
    (window.ogb as any).twoPlaces = { state: async () => ({ suggest: GARAGE }), accept: async () => ({ suggest: null }), dismiss, onChanged: () => () => {} };
    const html = await launch();
    expect(html).toContain('data-notice="two-places"');
    expect(html).toContain("Bring your bots together");
    press("Not now"); await flush();
    expect(dismiss).toHaveBeenCalledWith(GARAGE.key);
    expect(vi.mocked(track)).toHaveBeenCalledWith("two_places_card", { action: "not_now", kind: "server" });
  });
});

describe("what an install sends", () => {
  it("asks for no announcements, and sends no analytics event beyond the notices' own", async () => {
    returning(); storage.set(GROK_MOVE_NOTICE, "1"); storage.set(SIMPLE_MODE_PROMPT_KEY, "1");
    await relaunch();
    expect(vi.mocked(api).mock.calls.map(([path]) => path).filter(path => path.startsWith("/api/announcements"))).toEqual([]);
    expect(vi.mocked(track).mock.calls.map(([event]) => event).sort()).toEqual([]);
  });

  it("shows the trial's notice after the Simple mode popup has gone, in a later launch", async () => {
    const running = trial("active");
    account = paid({ trial: running }); snapshot = { status: "paid", tier: "pro", trial: running, notice: "active" };
    storage.set(GROK_MOVE_NOTICE, "1"); storage.set(SIMPLE_MODE_PROMPT_KEY, "1");
    markWelcomeFinished();
    expect(await launch()).toContain("Your free trial ends on");
    expect(CLOUD_TRIAL_NOTICE).toBe("cloud-trial-notice");
    expect(TWO_PLACES_NOTICE).toBe("two-places");
  });
});
