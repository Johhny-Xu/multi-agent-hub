// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  state: { instances: [] as InstanceInfo[], bots: [] as Bot[], config: {} as Record<string, unknown> },
  calls: [] as Array<{ path: string; method: string }>,
}));

vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({
    state: fixture.state,
    dispatch: () => {},
    refreshInstances: async () => {},
    refreshModels: async () => {},
  }),
  api: async (path: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    fixture.calls.push({ path, method });
    if (path.endsWith("/muse-relay")) {
      return { config: { connections: [{ connectionId: "conn-1", lastSeenAt: null, online: false }], pendingTurns: 0, canManage: true } };
    }
    return {};
  },
}));

import { EnginesSettings } from "./EnginesSettings";

function museRelay(): InstanceInfo {
  return {
    instanceId: "muse-relay",
    driverKind: "museRelay",
    displayName: "Muse",
    snapshot: { state: "available" },
    models: { default: "muse-wonder", options: [] },
  } as InstanceInfo;
}

function codex(): InstanceInfo {
  return {
    instanceId: "codex",
    driverKind: "codex",
    displayName: "Codex",
    cli: "codex",
    snapshot: { state: "available", authenticated: true },
    models: { default: "gpt", options: [] },
  } as InstanceInfo;
}

let container: HTMLDivElement, root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  fixture.state = { instances: [museRelay(), codex()], bots: [], config: {} };
  fixture.calls = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = async () => {
  await act(async () => { root.render(createElement(EnginesSettings)); });
};

describe("Settings → AI → Muse", () => {
  it("shows the connection card on a Muse relay", async () => {
    await render();
    const card = container.querySelector('[data-muse-relay="muse-relay"]');
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain("Muse relay");
    expect(fixture.calls).toContainEqual({ path: "/api/instances/muse-relay/muse-relay", method: "GET" });
  });

  it("names the provider Meta", async () => {
    await render();
    const engine = container.querySelector('[data-engine-card="muse-relay"]')!;
    expect(engine.textContent).toContain("Meta");
  });

  it("leaves the other AIs without a connection card", async () => {
    await render();
    expect(container.querySelectorAll("[data-muse-relay]").length).toBe(1);
    expect(container.querySelector('[data-engine-card="codex"] [data-muse-relay]')).toBeNull();
  });

  it("lists a relay that has no program of its own to set up", async () => {
    fixture.state = { instances: [museRelay()], bots: [], config: {} };
    await render();
    expect(container.querySelector('[data-engine-card="muse-relay"]')).toBeTruthy();
    // A relay is set up by its connections, not by a command to run.
    expect(container.textContent).not.toContain("Set up");
  });
});
