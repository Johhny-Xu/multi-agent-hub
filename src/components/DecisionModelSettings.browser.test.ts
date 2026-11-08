// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfigStatus } from "@/state/config-status";

const fixture = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; body?: unknown }>,
  config: null as ConfigStatus | null,
  failSave: false,
}));

vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({
    state: { config: fixture.config },
    dispatch: (action: any) => {
      if (action.type === "configStatus") fixture.config = action.config;
    },
  }),
  api: async (path: string, init?: RequestInit) => {
    fixture.calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (fixture.failSave) {
      throw new Error("Save rejected by server");
    }
    if (init?.method === "PUT" && init.body) {
      const parsed = JSON.parse(String(init.body));
      if (parsed.decider?.jobs) {
        fixture.config = {
          ...fixture.config!,
          decider: {
            ...fixture.config!.decider!,
            jobs: {
              ...fixture.config!.decider!.jobs,
              ...parsed.decider.jobs,
            },
          },
        };
      }
      return fixture.config;
    }
    return fixture.config;
  },
}));

const { DecisionModelSettings } = await import("./DecisionModelSettings");

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  fixture.calls = [];
  fixture.failSave = false;
  fixture.config = {
    decider: {
      provider: "jev",
      configured: true,
      enabled: true,
      jobs: { roomRouting: true, browserAutomation: false },
    },
  } as ConfigStatus;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  root.unmount();
  host.remove();
});

describe("DecisionModelSettings browser automation", () => {
  it("shows browser automation disabled by default", () => {
    flushSync(() => {
      root.render(createElement(DecisionModelSettings));
    });

    const toggle = host.querySelector('[data-testid="decider-job-browserAutomation"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
  });

  it("saves and reloads the browser job switch", async () => {
    flushSync(() => {
      root.render(createElement(DecisionModelSettings));
    });

    const toggle = host.querySelector('[data-testid="decider-job-browserAutomation"]') as HTMLElement;
    expect(toggle).not.toBeNull();

    flushSync(() => {
      toggle.click();
    });

    expect(fixture.calls.some((c) => c.path === "/api/config" && (c.body as any)?.decider?.jobs?.browserAutomation === true)).toBe(true);
  });

  it("explains missing Jev and unsupported places without exposing credentials", () => {
    fixture.config = {
      decider: {
        provider: "jev",
        configured: false,
        enabled: false,
        jobs: { roomRouting: true, browserAutomation: false },
      },
    } as ConfigStatus;

    flushSync(() => {
      root.render(createElement(DecisionModelSettings));
    });

    expect(host.textContent).toContain("TypeSafe Jev");
    expect(host.innerHTML).not.toContain("tsk_");
    expect(host.innerHTML).not.toContain("secret");
  });

  it("keeps the previous state when saving fails", () => {
    fixture.failSave = true;
    flushSync(() => {
      root.render(createElement(DecisionModelSettings));
    });

    const toggle = host.querySelector('[data-testid="decider-job-browserAutomation"]') as HTMLElement;
    flushSync(() => {
      toggle.click();
    });

    // Stays false on error
    expect(fixture.config?.decider?.jobs.browserAutomation).toBe(false);
  });

  it("shows 9router text model switch enabled by default and toggles it", () => {
    flushSync(() => {
      root.render(createElement(DecisionModelSettings));
    });

    const toggle = host.querySelector('[data-testid="decider-job-browserTextModel"]') as HTMLElement;
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-checked")).toBe("true");

    flushSync(() => {
      toggle.click();
    });

    expect(fixture.calls.some((c) => c.path === "/api/config" && (c.body as any)?.decider?.jobs?.browserTextModel === false)).toBe(true);
  });
});
