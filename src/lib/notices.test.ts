import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EMPTY_ONBOARDING, type OnboardingStatus } from "@/lib/onboarding";
import { DESKTOP_NOTICES } from "../../electron/desktop-prefs.mjs";
import { CLOUD_NOTICE, CLOUD_TRIAL_NOTICE, dismissNotice, dismissNotices, GROK_MOVE_NOTICE, launchNotice, markLaunchNotice, nextNotice, noticeSeen, NOTICES,
  PHONE_UPDATE_NOTICE, phoneUpdateHint, SIMPLE_MODE_NOTICE, TWO_PLACES_NOTICE, type NoticeFacts } from "./notices";

let storage: Map<string, string>, session: Map<string, string>;
beforeEach(() => {
  storage = new Map(); session = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => session.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());

const record = (hintsSeen: string[] = []): OnboardingStatus => ({ ...EMPTY_ONBOARDING, completedAt: "2026-09-01", version: 1, hintsSeen });
const facts = (grok: boolean | null, phone: boolean | null, simple: boolean | null, two: boolean | null, trial: boolean | null, cloud: boolean | null): NoticeFacts =>
  ({ [GROK_MOVE_NOTICE]: grok, [PHONE_UPDATE_NOTICE]: phone, [SIMPLE_MODE_NOTICE]: simple, [TWO_PLACES_NOTICE]: two,
    [CLOUD_TRIAL_NOTICE]: trial, [CLOUD_NOTICE]: cloud });
const none = () => false;

it("is one queue: the Move from Grok Bot popup, the phone update, the Simple mode popup, bots in two places, the trial's notice, the account's card", () => {
  expect(NOTICES).toEqual([GROK_MOVE_NOTICE, PHONE_UPDATE_NOTICE, SIMPLE_MODE_NOTICE, TWO_PLACES_NOTICE, CLOUD_TRIAL_NOTICE, CLOUD_NOTICE]);
  expect(nextNotice(facts(true, true, true, true, true, true), none)).toBe(GROK_MOVE_NOTICE);
  expect(nextNotice(facts(false, true, true, true, true, true), none)).toBe(PHONE_UPDATE_NOTICE);
  expect(nextNotice(facts(false, false, true, true, true, true), none)).toBe(SIMPLE_MODE_NOTICE);
  expect(nextNotice(facts(false, false, false, true, true, true), none)).toBe(TWO_PLACES_NOTICE);
  expect(nextNotice(facts(false, false, false, false, true, true), none)).toBe(CLOUD_TRIAL_NOTICE);
  expect(nextNotice(facts(false, false, false, false, false, true), none)).toBe(CLOUD_NOTICE);
  expect(nextNotice(facts(false, false, false, false, false, false), none)).toBeNull();
  expect(GROK_MOVE_NOTICE).toBe("grok-move-2026-11");
});

it("waits while an earlier notice's answer is unknown, so a later one never shows first", () => {
  expect(nextNotice(facts(null, false, false, false, false, true), none)).toBeNull();
  expect(nextNotice(facts(false, null, false, false, false, true), none)).toBeNull();
  expect(nextNotice(facts(null, false, false, false, false, true), id => id === GROK_MOVE_NOTICE)).toBe(CLOUD_NOTICE);
});

it("one notice a launch: a reload shows the one the launch took; once closed, nothing else in that launch", () => {
  const all = facts(true, true, true, true, true, true);
  expect(nextNotice(all, none)).toBe(GROK_MOVE_NOTICE);
  expect(nextNotice(all, none, GROK_MOVE_NOTICE), "a reload of the launch it took").toBe(GROK_MOVE_NOTICE);
  expect(nextNotice(all, id => id === GROK_MOVE_NOTICE), "the next launch").toBe(PHONE_UPDATE_NOTICE);
  expect(nextNotice(all, id => id === GROK_MOVE_NOTICE, GROK_MOVE_NOTICE), "another notice waits for a later launch").toBeNull();
  expect(nextNotice(all, none, GROK_MOVE_NOTICE, true), "closed: nothing else in this launch").toBeNull();
});

it("a launch keeps the notice it showed first for the window's session; storage that throws keeps it for the page", () => {
  expect(launchNotice()).toBeNull();
  markLaunchNotice(GROK_MOVE_NOTICE); markLaunchNotice(PHONE_UPDATE_NOTICE);
  expect(launchNotice()).toBe(GROK_MOVE_NOTICE);
  expect(session.get("omb.launch.notice")).toBe(GROK_MOVE_NOTICE);
  session.set("omb.launch.notice", "something-else");
  expect(launchNotice(), "only a notice of the list").toBeNull();
  vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  markLaunchNotice(SIMPLE_MODE_NOTICE);
  expect(launchNotice()).toBe(SIMPLE_MODE_NOTICE);
});

it("a dismissal holds on this device at once and in the workspace record for good", () => {
  const seen = record(["tour.done"]);
  expect(dismissNotice(seen, SIMPLE_MODE_NOTICE)).toEqual({ onboarding: { hintsSeen: ["tour.done", SIMPLE_MODE_NOTICE] } });
  expect(storage.get(SIMPLE_MODE_NOTICE)).toBe("1");
  expect(noticeSeen(record(), SIMPLE_MODE_NOTICE)).toBe(true);
  storage.clear();
  expect(noticeSeen(record(), SIMPLE_MODE_NOTICE)).toBe(false);
  expect(noticeSeen(record([SIMPLE_MODE_NOTICE]), SIMPLE_MODE_NOTICE)).toBe(true);
  expect(dismissNotice(record([SIMPLE_MODE_NOTICE]), SIMPLE_MODE_NOTICE)).toBeNull();
});

it("browser storage that throws still leaves the workspace record in charge", () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  expect(noticeSeen(record(), GROK_MOVE_NOTICE)).toBe(false);
  expect(noticeSeen(record([GROK_MOVE_NOTICE]), GROK_MOVE_NOTICE)).toBe(true);
  expect(dismissNotice(record(), GROK_MOVE_NOTICE)).toEqual({ onboarding: { hintsSeen: [GROK_MOVE_NOTICE] } });
});

it("the phone update dismissal is kept per phone, in short hints, all in one patch", () => {
  expect(phoneUpdateHint("0f8c2a41-1111-4222-8333-444455556666")).toBe("phone-app-update:0f8c2a41");
  expect(phoneUpdateHint("0f8c2a41-1111-4222-8333-444455556666").length).toBeLessThanOrEqual(60);
  const ids = [phoneUpdateHint("aaaaaaaa-1"), phoneUpdateHint("bbbbbbbb-2")];
  expect(dismissNotices(record(["star"]), ids)).toEqual({ onboarding: { hintsSeen: ["star", ...ids] } });
  for (const id of ids) expect(noticeSeen(undefined, id)).toBe(true);
  expect(dismissNotices(record(ids), ids), "nothing new").toBeNull();
  expect(dismissNotices(record([ids[0]!]), [...ids, ids[1]!])).toEqual({ onboarding: { hintsSeen: ids } });
});

it("the desktop keeps only the Grok move popup for its every page", () => {
  expect(DESKTOP_NOTICES).toEqual([GROK_MOVE_NOTICE]);
});
