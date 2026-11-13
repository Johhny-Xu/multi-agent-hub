// @vitest-environment happy-dom
// FEAT-dumate: the 百度搭子 card on the Daily page. Its QR comes from the shared browser (Baidu serves it as a GIF), a
// signed-in card offers to add another account, and an account row can be removed with a second press.
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
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};
const show = async (platform: CheckinPlatform, onLoginChanged = vi.fn()) => {
  await act(async () => {
    root.render(createElement(PlatformCard, { platformKey: "dumate", name: "百度搭子 DuMate", platform, onLoginChanged, today: "2026-11-13" }));
  });
  await settle();
  return onLoginChanged;
};
const qrButton = () => container.querySelector<HTMLButtonElement>("[data-daily-qr-login] button");

describe("the DuMate check-in card", () => {
  it("shows Baidu's GIF QR with the Baidu-app hint", async () => {
    mocks.api.mockResolvedValue({ ok: true, loggedIn: false, qrPng: "R0lGODlhoACgAA" });
    await show({ available: false, status: "unconfigured", loginKind: "qr" });
    expect(qrButton()?.textContent).toBe("Scan to sign in");
    await act(async () => { qrButton()?.click(); });
    await settle();
    expect(mocks.api).toHaveBeenCalledWith("/hub/checkin/dumate/login", expect.objectContaining({ method: "POST" }));
    expect(container.querySelector("[data-daily-qr-login] img")?.getAttribute("src")).toBe("data:image/gif;base64,R0lGODlhoACgAA");
    expect(container.textContent).toContain("Scan with the Baidu app");
  });

  it("offers to add another account once signed in, and removes an account on the second press", async () => {
    mocks.api.mockResolvedValue({ ok: true });
    const reload = await show({
      available: true, status: "success", loginKind: "qr", lastDate: "2026-11-13",
      accounts: [{ name: "dm-1a2b3c4d", display: "花花", status: "success", message: "签到成功 +500 积分" }],
    });
    expect(qrButton()?.textContent).toBe("Scan to add or re-sign an account");
    const remove = () => container.querySelector<HTMLButtonElement>("[data-daily-remove-account]");
    expect(remove()?.textContent).toBe("Remove");
    await act(async () => { remove()?.click(); });
    expect(mocks.api).not.toHaveBeenCalled();
    expect(remove()?.textContent).toBe("Confirm remove");
    await act(async () => { remove()?.click(); });
    await settle();
    expect(mocks.api).toHaveBeenCalledWith("/hub/checkin/dumate/account/remove", { method: "POST", body: JSON.stringify({ id: "dm-1a2b3c4d" }) });
    expect(reload).toHaveBeenCalled();
  });
});
