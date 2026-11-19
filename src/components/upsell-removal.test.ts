import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { CloudUsage } from "../../electron/cloud-home.mjs";
import type { RoomCardView } from "@/lib/room-card";
import { setLocale } from "@/lib/i18n";
import { CloudUsageCardView, CloudUsageSettingsView } from "./CloudUsageMeter";
import { CloudRoomCardView } from "./CloudRoomCard";

const source = (path: string) => readFileSync(path, "utf8");
const RESETS = Date.UTC(2026, 10, 1);
const usage = (extra: Partial<CloudUsage> = {}): CloudUsage => ({ tier: "pro", resetsAt: RESETS,
  meters: [{ kind: "computerHours", used: 285, max: 300 }, { kind: "storage", used: 41.2, max: 100 }],
  upgrades: [{ tier: "max", amount: 9900 }], ...extra });
const markup = (element: ReactElement) => renderToStaticMarkup(element);
const NO_SELLING = [/Upgrade/i, /Other plans/i, /See plans/i, /\$\d/, /openCloudAdd/];

beforeEach(() => setLocale("en"));

describe("usage meters keep the facts and sell nothing", () => {
  it("the sidebar card shows the allowance with its bar and the hide and see-all actions", () => {
    const html = markup(createElement(CloudUsageCardView, { usage: usage(), meters: [usage().meters[0]!], band: "near", onHide: () => {}, onSeeAll: () => {} }));
    expect(html).toContain("Cloud desktop hours"); expect(html).toContain("285 of 300 hours"); expect(html).toContain("Resets on Nov 1.");
    expect(html).toContain("See all usage");
    for (const pattern of NO_SELLING) expect(html, String(pattern)).not.toMatch(pattern);
  });

  it("the Settings section lists every allowance, and the top plan says so", () => {
    const html = markup(createElement(CloudUsageSettingsView, { usage: usage({ tier: "max", upgrades: [] }) }));
    expect(html).toContain("285 of 300 hours"); expect(html).toContain("41.2 of 100 GB"); expect(html).toContain("You&#x27;re on the top plan.");
    for (const pattern of NO_SELLING) expect(html, String(pattern)).not.toMatch(pattern);
  });
});

describe("the room card keeps the room's state and sells nothing", () => {
  it("says what ran short and how it is put away, with no plan, price or upgrade", () => {
    const view: RoomCardView = { id: "room-1", kind: "disk", title: "This Cloud is running out of room", cause: "Its disk is 9.4 of 10 GB full.",
      offer: { tier: "max", text: "Max gives it more disk.", price: "$99/month" }, tip: null };
    const html = markup(createElement(CloudRoomCardView, { view, onNotNow: () => {} }));
    expect(html).toContain("This Cloud is running out of room"); expect(html).toContain("Its disk is 9.4 of 10 GB full.");
    expect(html).toContain("Got it");
    for (const pattern of NO_SELLING) expect(html, String(pattern)).not.toMatch(pattern);
  });
});

describe("the components that only carry a hook now sell nothing", () => {
  it("ProIntroduction keeps the plan view and no buy card or compare link", () => {
    const text = source("src/components/ProIntroduction.tsx");
    for (const gone of ["UpgradeButton", "ProCompareRow", "ProSettingsCard", "openCloudAdd", "cloudIntro.start"]) expect(text, gone).not.toContain(gone);
    expect(text).toContain("useCloudPlan");
  });

  it("RoutineScheduleNote keeps where a routine runs, with no Add a Cloud offer", () => {
    const text = source("src/components/RoutineScheduleNote.tsx");
    for (const gone of ["add-cloud", "addCloud", "openCloudAdd", "buyOfferAllowed"]) expect(text, gone).not.toContain(gone);
    for (const kept of ["routines.scheduleNote.cloud", "routines.scheduleNote.server", "routines.scheduleNote.local"]) expect(text, kept).toContain(kept);
  });

  it("BotLimitPopup keeps the limit's reason and wakes bots, with no upgrade or preview call", () => {
    const text = source("src/components/BotLimitPopup.tsx");
    for (const gone of ["UpgradeButton", "useUpgrade", "upgradePreview", "roomCard.upgrade"]) expect(text, gone).not.toContain(gone);
    for (const kept of ["botLimit.title", "AwakeBotsPicker", "botLimit.openPlan"]) expect(text, kept).toContain(kept);
  });

  it("PublishedPageCard and PageTools keep publish, copy, open and unpublish, and offer no more pages", () => {
    for (const path of ["src/components/PublishedPageCard.tsx", "src/components/app/PageTools.tsx"]) {
      const text = source(path);
      for (const gone of ["morePages", "openCloudAdd", "ASK_PRIMARY_BUTTON"]) expect(text, `${path}: ${gone}`).not.toContain(gone);
    }
    for (const kept of ["chat.page.copyLink", "chat.page.unpublish"]) expect(source("src/components/PublishedPageCard.tsx"), kept).toContain(kept);
  });
});
