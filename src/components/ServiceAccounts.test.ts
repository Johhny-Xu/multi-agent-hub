// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body?: unknown }>,
  refresh: vi.fn(),
  view: null as unknown,
  autoSwitch: null as unknown,
  autoSwitchFail: false,
  autoSwitchPutFail: false,
}));
vi.mock("@/state/store", () => ({
  useStore: () => ({ refreshInstances: fixture.refresh }),
  api: async (path: string, init?: RequestInit) => {
    fixture.calls.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path.endsWith("/auto-switch")) {
      if (fixture.autoSwitchFail) throw new Error("route gone");
      if (init?.method === "PUT") {
        if (fixture.autoSwitchPutFail) throw new Error("put refused");
        fixture.autoSwitch = { ...(fixture.autoSwitch as object), enabled: JSON.parse(String(init.body)).enabled };
      }
      return { autoSwitch: fixture.autoSwitch };
    }
    return { accounts: fixture.view };
  },
}));
// Keys that Hark has not merged into the packs yet fall back to the key name (plus params), so tests can spot them.
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
const settle = () => new Promise((done) => setTimeout(done, 0));
const button = (text: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text))!;

beforeEach(() => {
  fixture.calls = [];
  fixture.refresh.mockReset();
  fixture.view = view();
  fixture.autoSwitch = null;
  fixture.autoSwitchFail = false;
  fixture.autoSwitchPutFail = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

describe("switching an engine's account", () => {
  it("shows the saved accounts and the one in use", async () => {
    flushSync(() => root.render(createElement(ServiceAccounts, { instance: engine })));
    await settle();
    expect(host.querySelector("[data-service-accounts]")?.textContent).toContain("Work");
    expect(host.querySelector("[data-service-account][data-active]")?.textContent).toContain("Work");
    expect(host.textContent).toContain("bob@example.test");
  });

  it("stays away for an engine that keeps no CLI sign-in", async () => {
    fixture.view = { supported: false, reason: "separate accounts", accounts: [], activeId: null, drifted: false };
    flushSync(() => root.render(createElement(ServiceAccounts, { instance: engine })));
    await settle();
    expect(host.querySelector("[data-service-accounts]")).toBeNull();
  });

  it("switches to another saved account and reports drift", async () => {
    fixture.view = view({ drifted: true });
    flushSync(() => root.render(createElement(ServiceAccounts, { instance: engine })));
    await settle();
    expect(host.querySelector("[data-accounts-drifted]")).not.toBeNull();

    fixture.view = view({ activeId: accounts[1]!.id, drifted: false });
    const targetRow = host.querySelector(`[data-service-account="${accounts[1]!.id}"]`)!;
    flushSync(() => targetRow.querySelector<HTMLButtonElement>("button")!.click());
    await settle();
    expect(fixture.calls).toContainEqual({ path: `/api/instances/codebuddy/service-accounts/${accounts[1]!.id}/switch`, method: "POST", body: {} });
    expect(fixture.refresh).toHaveBeenCalled();
    expect(host.querySelector("[data-service-account][data-active]")?.textContent).toContain("Personal");
  });

  it("offers a switch button on the active account when drifted to allow restoring", async () => {
    fixture.view = view({ drifted: true });
    flushSync(() => root.render(createElement(ServiceAccounts, { instance: engine })));
    await settle();
    const activeRow = host.querySelector("[data-service-account][data-active]")!;
    const restoreBtn = activeRow.querySelector("button");
    expect(restoreBtn).not.toBeNull();
    expect(restoreBtn?.textContent).toContain("Use");

    fixture.view = view({ drifted: false });
    flushSync(() => restoreBtn!.click());
    await settle();
    expect(fixture.calls).toContainEqual({
      path: `/api/instances/codebuddy/service-accounts/${accounts[0]!.id}/switch`,
      method: "POST",
      body: {},
    });
    expect(fixture.refresh).toHaveBeenCalled();
  });

  it("saves the current sign-in under the typed name", async () => {
    flushSync(() => root.render(createElement(ServiceAccounts, { instance: engine })));
    await settle();
    flushSync(() => button("Save current sign-in").click());
    const input = host.querySelector<HTMLInputElement>('input[maxlength="80"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Work laptop");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync(() => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(fixture.calls).toContainEqual({ path: "/api/instances/codebuddy/service-accounts", method: "POST", body: { label: "Work laptop" } });
  });
});

describe("auto-switching on quota", () => {
  const remount = () => {
    flushSync(() => root.unmount());
    host.remove();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  };
  const toggle = () => host.querySelector<HTMLButtonElement>("[data-auto-switch]")!;
  const toggleChecked = () => toggle().getAttribute("aria-checked");

  it("shows the toggle unchecked while off, with two accounts saved", async () => {
    fixture.autoSwitch = { enabled: false, limited: [] };
    flushSync(() => root.render(createElement(ServiceAccounts, { instance: engine })));
    await settle();
    expect(toggleChecked()).toBe("false");
    expect(toggle().disabled).toBe(false);
  });

  it("disables the toggle until a second account is saved", async () => {
    fixture.view = view({ accounts: [accounts[0]!], activeId: accounts[0]!.id });
    fixture.autoSwitch = { enabled: false, limited: [] };
    flushSync(() => root.render(createElement(ServiceAccounts, { instance: engine })));
    await settle();
    expect(toggle().disabled).toBe(true);
    expect(host.textContent).toContain("at least two accounts");
  });

  it("stays away when the route reports unavailable or fails", async () => {
    fixture.autoSwitch = { enabled: false, limited: [], available: false };
    flushSync(() => root.render(createElement(ServiceAccounts, { instance: engine })));
    await settle();
    expect(host.querySelector("[data-auto-switch]")).toBeNull();

    fixture.autoSwitch = { enabled: false, limited: [] };
    fixture.autoSwitchFail = true;
    remount();
    flushSync(() => root.render(createElement(ServiceAccounts, { instance: engine })));
    await settle();
    expect(host.querySelector("[data-auto-switch]")).toBeNull();
  });

  it("marks the accounts that are cooling down", async () => {
    fixture.autoSwitch = { enabled: true, limited: [{ accountId: accounts[1]!.id, until: Date.now() + 60_000 }] };
    flushSync(() => root.render(createElement(ServiceAccounts, { instance: engine })));
    await settle();
    expect(host.querySelector(`[data-service-account="${accounts[1]!.id}"] [data-cooling]`)).not.toBeNull();
    expect(host.querySelector(`[data-service-account="${accounts[0]!.id}"] [data-cooling]`)).toBeNull();
  });

  it("puts the new state when toggled on", async () => {
    fixture.autoSwitch = { enabled: false, limited: [] };
    flushSync(() => root.render(createElement(ServiceAccounts, { instance: engine })));
    await settle();
    flushSync(() => toggle().click());
    await settle();
    expect(fixture.calls).toContainEqual({
      path: "/api/instances/codebuddy/service-accounts/auto-switch",
      method: "PUT",
      body: { enabled: true },
    });
    expect(fixture.refresh).toHaveBeenCalled();
    expect(toggleChecked()).toBe("true");
  });
});
