// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body?: unknown }>,
  refresh: vi.fn(),
  view: null as unknown,
  autoSwitch: null as unknown,
  failPut: false,
  holdPut: false,
  heldPut: null as { resolve: (value: unknown) => void } | null,
  holdSwitch: false,
  heldSwitch: null as { resolve: (value: unknown) => void } | null,
}));
vi.mock("@/state/store", () => ({
  useStore: () => ({ refreshInstances: fixture.refresh }),
  api: async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    fixture.calls.push({ path, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === "GET") return path.endsWith("/auto-switch") ? { autoSwitch: fixture.autoSwitch } : { accounts: fixture.view };
    if (path.endsWith("/auto-switch")) {
      if (fixture.holdPut) return new Promise((resolve) => { fixture.heldPut = { resolve }; });
      if (fixture.failPut) throw new Error("put refused");
      fixture.autoSwitch = { ...(fixture.autoSwitch as object), enabled: JSON.parse(String(init!.body)).enabled };
      return { autoSwitch: fixture.autoSwitch };
    }
    if (path.endsWith("/switch")) {
      if (fixture.holdSwitch) return new Promise((resolve) => { fixture.heldSwitch = { resolve }; });
      return { accounts: fixture.view };
    }
    return {};
  },
}));
// A key missing from the packs falls back to the key name (plus params), so a test can spot it; the U2 keys are merged (2026-11-10).
vi.mock("@/lib/i18n", async (original) => {
  const real = await original<typeof import("@/lib/i18n")>();
  const { en } = await import("@/locales");
  return {
    ...real,
    t: (key: Parameters<typeof real.t>[0], params?: Record<string, string | number>) =>
      Object.hasOwn(en, key) ? real.t(key, params)
        : params ? `${key} ${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(" ")}` : key,
  };
});

const { ServiceAccounts } = await import("./ServiceAccounts");

const engine = { instanceId: "codebuddy", driverKind: "codebuddyAgent", displayName: "CodeBuddy" } as InstanceInfo;
const accounts = [
  { id: "11111111-1111-1111-1111-111111111111", label: "Work", identity: "ada@example.test", createdAt: 1 },
  { id: "22222222-2222-2222-2222-222222222222", label: "Personal", identity: "bob@example.test", createdAt: 2 },
];
const view = (over: Record<string, unknown> = {}) => ({
  supported: true, accounts, activeId: accounts[0]!.id, drifted: false, liveIdentity: "ada@example.test", ...over,
});

let root: Root;
let host: HTMLElement;
const section = () => host.querySelector<HTMLDetailsElement>("[data-service-accounts]")!;
const row = (id: string) => host.querySelector(`[data-service-account="${id}"]`)!;
const rowSwitch = (id: string) => row(id).querySelector<HTMLButtonElement>("button")!;
const autoSwitchButton = () => host.querySelector<HTMLButtonElement>("[data-auto-switch]")!;
const button = (text: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text))!;
const drain = () => act(async () => { for (let tick = 0; tick < 12; tick++) await Promise.resolve(); });
const click = async (element: Element) => {
  await act(async () => { (element as HTMLElement).click(); });
  await drain();
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fixture.calls = [];
  fixture.refresh.mockReset();
  fixture.view = view();
  fixture.autoSwitch = null;
  fixture.failPut = false;
  fixture.holdPut = false;
  fixture.heldPut = null;
  fixture.holdSwitch = false;
  fixture.heldSwitch = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const renderIt = async () => { await act(async () => { root.render(createElement(ServiceAccounts, { instance: engine })); }); await drain(); };
const remount = async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
};

describe("auto-switch toggle", () => {
  it("shows the new state while the request is still in flight", async () => {
    fixture.autoSwitch = { enabled: false, limited: [] };
    fixture.holdPut = true;
    await renderIt();
    await click(autoSwitchButton());
    expect(fixture.calls).toContainEqual({ path: "/api/instances/codebuddy/service-accounts/auto-switch", method: "PUT", body: { enabled: true } });
    expect(autoSwitchButton().getAttribute("aria-checked")).toBe("true");
    fixture.heldPut!.resolve({ autoSwitch: { enabled: true, limited: [] } });
    await drain();
    expect(autoSwitchButton().getAttribute("aria-checked")).toBe("true");
  });

  it("rolls the toggle back and reports the failure when the request fails", async () => {
    fixture.autoSwitch = { enabled: false, limited: [] };
    fixture.failPut = true;
    await renderIt();
    await click(autoSwitchButton());
    expect(autoSwitchButton().getAttribute("aria-checked")).toBe("false");
    expect(host.querySelector('[data-auto-switch-row] [role="alert"]')?.textContent).toContain("put refused");
  });
});

describe("cool-down labels", () => {
  it("shows the remaining cool-down as a local clock time", async () => {
    fixture.autoSwitch = { enabled: true, limited: [{ accountId: accounts[1]!.id, until: Date.now() + 60_000 }] };
    await renderIt();
    const badge = row(accounts[1]!.id).querySelector("[data-cooling]");
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toMatch(/until \d{2}:\d{2}$/);
    expect(row(accounts[0]!.id).querySelector("[data-cooling]")).toBeNull();
  });

  it("hides an expired cool-down entry", async () => {
    fixture.autoSwitch = { enabled: true, limited: [{ accountId: accounts[1]!.id, until: Date.now() - 1 }] };
    await renderIt();
    expect(row(accounts[1]!.id).querySelector("[data-cooling]")).toBeNull();
    expect(rowSwitch(accounts[1]!.id).disabled).toBe(false);
    expect(rowSwitch(accounts[1]!.id).title).toBe("");
  });

  it("still switches a cooling account by hand and says so on the button", async () => {
    fixture.autoSwitch = { enabled: true, limited: [{ accountId: accounts[1]!.id, until: Date.now() + 60_000 }] };
    await renderIt();
    expect(rowSwitch(accounts[1]!.id).title).toMatch(/^Cooling down · until \d{2}:\d{2}$/);
    await click(rowSwitch(accounts[1]!.id));
    expect(fixture.calls).toContainEqual({
      path: `/api/instances/codebuddy/service-accounts/${accounts[1]!.id}/switch`,
      method: "POST",
      body: {},
    });
  });
});

describe("switching feedback", () => {
  it("clears the switched notice after four seconds", async () => {
    await renderIt();
    await click(rowSwitch(accounts[1]!.id));
    expect(host.textContent).toContain("New tasks now use Personal.");
    await act(async () => { await vi.advanceTimersByTimeAsync(3_999); });
    expect(host.textContent).toContain("New tasks now use Personal.");
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(host.textContent).not.toContain("New tasks now use Personal.");
  });

  it("only blocks conflicting actions while a switch is in flight", async () => {
    fixture.view = view({ drifted: true });
    fixture.holdSwitch = true;
    await renderIt();
    await click(rowSwitch(accounts[1]!.id));
    expect(rowSwitch(accounts[0]!.id).disabled).toBe(true);
    expect(rowSwitch(accounts[1]!.id).disabled).toBe(true);
    expect(row(accounts[1]!.id).querySelectorAll("button")[1]!.disabled).toBe(true);
    const add = button("Save current sign-in");
    expect(add.disabled).toBe(false);
    await click(add);
    const submit = host.querySelector<HTMLButtonElement>('form button[type="submit"]')!;
    expect(submit.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("form button:not([type=submit])")!.disabled).toBe(false);
    fixture.heldSwitch!.resolve({ accounts: view({ activeId: accounts[1]!.id }) });
    await drain();
    expect(rowSwitch(accounts[0]!.id).disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('form button[type="submit"]')!.disabled).toBe(false);
    expect(host.textContent).toContain("New tasks now use Personal.");
  });
});

describe("saving the drifted sign-in", () => {
  it("offers a prefilled save-as-new shortcut on the drifted warning", async () => {
    fixture.view = view({ drifted: true });
    await renderIt();
    const shortcut = host.querySelector<HTMLButtonElement>("[data-save-as-new]")!;
    expect(shortcut.textContent).toContain("Save as new account");
    await click(shortcut);
    const input = host.querySelector<HTMLInputElement>('input[maxlength="80"]')!;
    expect(input.value).toBe("ada@example.test");
    expect(fixture.calls).not.toContainEqual(expect.objectContaining({ method: "POST" }));
    await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await drain();
    expect(fixture.calls).toContainEqual({ path: "/api/instances/codebuddy/service-accounts", method: "POST", body: { label: "ada@example.test" } });
  });
});

describe("default expansion", () => {
  it("opens by default with two saved accounts", async () => {
    await renderIt();
    expect(section().open).toBe(true);
  });

  it("stays collapsed with one account, no drift and auto-switch off", async () => {
    fixture.view = view({ accounts: [accounts[0]!], activeId: accounts[0]!.id });
    await renderIt();
    expect(section().open).toBe(false);
  });

  it("opens by default when drifted or when auto-switch is on", async () => {
    fixture.view = view({ accounts: [accounts[0]!], activeId: accounts[0]!.id, drifted: true });
    await renderIt();
    expect(section().open).toBe(true);

    fixture.view = view({ accounts: [accounts[0]!], activeId: accounts[0]!.id, drifted: false });
    fixture.autoSwitch = { enabled: true, limited: [] };
    await remount();
    await renderIt();
    expect(section().open).toBe(true);
  });

  it("keeps the section collapsed after the person closes it once", async () => {
    await renderIt();
    await act(async () => {
      section().open = false;
      section().dispatchEvent(new Event("toggle"));
      await Promise.resolve();
    });
    expect(section().open).toBe(false);

    fixture.view = view({ activeId: accounts[1]!.id });
    await click(rowSwitch(accounts[1]!.id));
    expect(section().open).toBe(false);
    expect(row(accounts[1]!.id).getAttribute("data-active")).not.toBeNull();
  });
});
