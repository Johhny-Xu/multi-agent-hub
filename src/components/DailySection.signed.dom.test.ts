// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, t } from "@/lib/i18n";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: mocks.api,
  useStore: () => ({ state: { instances: [] }, dispatch: vi.fn() }),
}));
import { DailySection, PlatformCard, signedTodayLabel, statusLabel } from "./DailySection";

type PlatformProps = Parameters<typeof PlatformCard>[0];
type CheckinPlatform = PlatformProps["platform"];

const TODAY = "2026-11-10";

const platform = (over: Partial<CheckinPlatform>): CheckinPlatform => ({
  available: true,
  status: "pending",
  lastDate: "",
  message: "",
  ...over,
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  mocks.api.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

const showCard = async (one: CheckinPlatform, onRun?: (key: string) => void) => {
  await act(async () => {
    root.render(createElement(PlatformCard, {
      platformKey: "codebuddy",
      name: "CodeBuddy",
      platform: one,
      onRun,
      today: TODAY,
    }));
  });
  await settle();
};

const showDaily = async (platforms: Record<string, CheckinPlatform>) => {
  mocks.api.mockImplementation(async (path: string) =>
    path.startsWith("/hub/quota")
      ? { updatedAt: `${TODAY}T00:00:00Z`, workers: {} }
      : { ok: true, today: TODAY, autoCheckin: true, autoCheckinTime: "08:30", platforms });
  await act(async () => { root.render(createElement(DailySection)); });
  await settle();
};

const cardRunButton = () => document.querySelector<HTMLButtonElement>("[data-daily-platform] button.ui-button");
const runAllButton = () => document.querySelector<HTMLButtonElement>("button.ui-button-primary");
const click = async (button: HTMLButtonElement | null | undefined) => {
  expect(button).toBeTruthy();
  await act(async () => { button?.click(); });
  await settle();
};

describe("a platform card's check-in button", () => {
  it("stands down once the platform already signed today, and says so in its tooltip", async () => {
    const onRun = vi.fn();
    await showCard(platform({ status: "already", lastDate: TODAY }), onRun);
    expect(cardRunButton()?.disabled).toBe(true);
    expect(cardRunButton()?.getAttribute("title")).toBe(statusLabel("already"));
    expect(cardRunButton()?.textContent).toBe(signedTodayLabel());
  });

  it("stands down after a successful run today, with the success label as its tooltip", async () => {
    await showCard(platform({ status: "success", lastDate: TODAY }), vi.fn());
    expect(cardRunButton()?.disabled).toBe(true);
    expect(cardRunButton()?.getAttribute("title")).toBe(statusLabel("success"));
  });

  it("stays clickable while the platform has not signed, even on a success dated before today", async () => {
    const onRun = vi.fn();
    await showCard(platform({ status: "pending", lastDate: "" }), onRun);
    expect(cardRunButton()?.disabled).toBe(false);
    await click(cardRunButton());
    expect(onRun).toHaveBeenCalledWith("codebuddy");
    await act(async () => root.unmount());
    root = createRoot(container);
    await showCard(platform({ status: "success", lastDate: "2026-11-09" }), onRun);
    expect(cardRunButton()?.disabled).toBe(false);
  });

  it("stays clickable on a partial day, since some accounts still wait", async () => {
    const onRun = vi.fn();
    await showCard(platform({ status: "partial", lastDate: TODAY }), onRun);
    expect(cardRunButton()?.disabled).toBe(false);
    await click(cardRunButton());
    expect(onRun).toHaveBeenCalledWith("codebuddy");
  });
});

describe("the run-all button", () => {
  it("stands down once every configured platform signed today, unconfigured ones not counting", async () => {
    await showDaily({
      codebuddy: platform({ status: "success", lastDate: TODAY }),
      qoder: platform({ status: "already", lastDate: TODAY }),
      traecode: platform({ status: "unconfigured", available: false }),
    });
    expect(runAllButton()?.disabled).toBe(true);
    expect(runAllButton()?.getAttribute("title")).toBe(t("settings.daily.accountsSigned", { signed: 2, count: 2 }));
  });

  it("stays up while any configured platform still waits", async () => {
    await showDaily({
      codebuddy: platform({ status: "success", lastDate: TODAY }),
      qoder: platform({ status: "pending", lastDate: "" }),
    });
    expect(runAllButton()?.disabled).toBe(false);
    expect(runAllButton()?.getAttribute("title")).toBe(null);
    expect(runAllButton()?.textContent).toBe(t("settings.daily.run"));
  });
});

describe("the native settings rows", () => {
  it("hands the auto-checkin row a native Switch inside a SettingRow", async () => {
    await showDaily({ codebuddy: platform({ status: "pending" }) });
    const row = document.querySelector("[data-daily-auto]");
    expect(row).toBeTruthy();
    const sw = row?.querySelector<HTMLButtonElement>("[role='switch']");
    expect(sw?.getAttribute("aria-checked")).toBe("true");
    const group = sw?.closest("[role='group']");
    expect(group).toBeTruthy();
    const labelId = group?.getAttribute("aria-labelledby");
    expect(document.getElementById(labelId ?? "")?.textContent).toBe(t("settings.daily.autoCheckin"));
  });

  it("lays each platform's header on a SettingRow of its own", async () => {
    await showDaily({ codebuddy: platform({ status: "pending" }) });
    const card = document.querySelector("[data-daily-platform]");
    expect(card).toBeTruthy();
    const group = card?.querySelector("[role='group']");
    expect(group).toBeTruthy();
    const labelId = group?.getAttribute("aria-labelledby");
    expect(document.getElementById(labelId ?? "")?.textContent).toBe("CodeBuddy");
  });

  it("says signed today on a signed platform's stand-down button", async () => {
    const onRun = vi.fn();
    await showCard(platform({ status: "already", lastDate: TODAY }), onRun);
    expect(cardRunButton()?.disabled).toBe(true);
    expect(cardRunButton()?.textContent).toBe(signedTodayLabel());
  });

  it("says signed today on the run-all button once every configured platform signed", async () => {
    await showDaily({
      codebuddy: platform({ status: "success", lastDate: TODAY }),
      qoder: platform({ status: "already", lastDate: TODAY }),
    });
    expect(runAllButton()?.disabled).toBe(true);
    expect(runAllButton()?.textContent).toBe(signedTodayLabel());
  });
});
