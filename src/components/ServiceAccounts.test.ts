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
}));
vi.mock("@/state/store", () => ({
  useStore: () => ({ refreshInstances: fixture.refresh }),
  api: async (path: string, init?: RequestInit) => {
    fixture.calls.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return { accounts: fixture.view };
  },
}));

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
