// @vitest-environment happy-dom
// FEAT-doubao-checkin: the QR sign-in on a check-in card. The hub's cloud browser screenshots the platform's
// login QR; the person scans it with the app. The card only shows the picture and polls for the scan.
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: mocks.api,
  useStore: () => ({ state: { instances: [] }, dispatch: vi.fn() }),
}));
import { PlatformCard } from "./DailySection";

type CheckinPlatform = Parameters<typeof PlatformCard>[0]["platform"];

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};

const show = async (platform: CheckinPlatform, onLoginChanged = vi.fn()) => {
  await act(async () => {
    root.render(createElement(PlatformCard, { platformKey: "doubao", name: "豆包 Doubao", platform, onLoginChanged, today: "2026-11-10" }));
  });
  await settle();
  return onLoginChanged;
};

const qrButton = () => container.querySelector<HTMLButtonElement>("[data-daily-qr-login] button");

describe("QR sign-in on a check-in card (Doubao)", () => {
  it("offers a scan-to-sign-in button on a platform that is not signed in yet", async () => {
    await show({ available: false, status: "unconfigured", loginKind: "qr" });
    expect(qrButton()?.textContent).toBe("Scan to sign in");
    expect(qrButton()?.className).toContain("ui-button");
  });

  it("shows no QR entry on platforms that sign in some other way", async () => {
    await show({ available: true, status: "pending" });
    expect(container.querySelector("[data-daily-qr-login]")).toBeNull();
  });

  it("shows the cloud browser's QR, polls for the scan, then reloads the card", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "Date"] });
    mocks.api.mockImplementation(async (path: string) =>
      path === "/hub/checkin/doubao/login" ? { ok: true, loggedIn: false, qrPng: "iVBORw0KGgo" } : { ok: true, loggedIn: true });
    const reload = await show({ available: false, status: "unconfigured", loginKind: "qr" });
    await act(async () => { qrButton()?.click(); });
    await settle();
    expect(mocks.api).toHaveBeenCalledWith("/hub/checkin/doubao/login", expect.objectContaining({ method: "POST" }));
    const img = container.querySelector<HTMLImageElement>("[data-daily-qr-login] img");
    expect(img?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo");
    expect(container.textContent).toContain("Waiting for the scan");
    await act(async () => { vi.advanceTimersByTime(3_000); });
    await settle();
    expect(mocks.api).toHaveBeenCalledWith("/hub/checkin/doubao/login/status", expect.anything());
    expect(container.textContent).toContain("Signed in — checking in now.");
    expect(reload).toHaveBeenCalled();
  });

  it("says plainly when the cloud browser could not produce a QR, and offers another try", async () => {
    mocks.api.mockResolvedValue({ ok: false, loggedIn: false, error: "国内出口隧道没连上" });
    await show({ available: false, status: "unconfigured", loginKind: "qr" });
    await act(async () => { qrButton()?.click(); });
    await settle();
    expect(container.textContent).toContain("国内出口隧道没连上");
    expect(qrButton()?.textContent).toBe("Get a new QR code");
  });

  it("keeps a quiet re-sign-in link once the platform is signed in", async () => {
    await show({ available: true, status: "success", lastDate: "2026-11-10", loginKind: "qr" });
    expect(qrButton()?.textContent).toBe("Sign in again with a QR code");
    expect(qrButton()?.className).not.toContain("ui-button");
  });
});
