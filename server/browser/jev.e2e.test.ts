import { describe, expect, it, vi } from "vitest";
import { createBrowserGateway, type BrowserGatewayDeps } from "./jev.ts";
import type {
  BrowserExecution,
  BrowserObservation,
  BrowserScope,
  BrowserTransport,
  PreparedBrowserAction,
} from "./jev-types.ts";
import type { Decider } from "../decider/index.ts";
import type { AppConfig } from "../config.ts";

function createMockScope(overrides: Partial<BrowserScope> = {}): BrowserScope {
  return {
    botId: "bot_1",
    conversationId: "conv_1",
    sessionId: "sess_1",
    profileId: "prof_1",
    turnGeneration: "gen_1",
    tabId: "tab_1",
    place: { key: "builtin", provider: "builtin", revision: "1" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("jev e2e scenarios", () => {
  it("completes a bounded form task on an isolated browser", async () => {
    let stepCount = 0;
    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["CLICK", "DONE"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(),
      observe: vi.fn(async () => ({
        id: "obs_1",
        tabId: "tab_1",
        documentEpoch: "epoch_1",
        origin: "https://form.local",
        title: "Registration",
        stateText: stepCount === 0 ? "Form input" : "Registration Successful",
        candidates: [
          { id: "c1", elementId: "el_1", operation: "CLICK", role: "button", label: "Submit" },
        ],
        controls: [],
        guardId: "g_1",
        truncated: false,
        omittedCandidates: 0,
      })),
      verify: vi.fn(async () => true),
      prepare: vi.fn(async () => ({ ticket: "tk_1", call: { name: "click", arguments: { ref: "e1" } } })),
      execute: vi.fn(async (): Promise<BrowserExecution> => {
        stepCount++;
        return { state: "completed", result: { ok: true }, postObservation: "ok" };
      }),
    };

    const decider: Partial<Decider> = {
      ask: vi.fn(async () => {
        if (stepCount === 0) {
          return {
            ok: true,
            provider: "jev",
            answers: {
              operation: { type: "choice", choice: "CLICK", pTop: 0.95, margin: 0.3 },
            },
          };
        }
        return {
          ok: true,
          provider: "jev",
          answers: {
            operation: { type: "choice", choice: "DONE", pTop: 0.98, margin: 0.4 },
          },
        };
      }) as any,
    };

    const deps: BrowserGatewayDeps = {
      decider: decider as Decider,
      config: () => ({ decider: { enabled: true, key: "key", jobs: { browserAutomation: true } } } as AppConfig),
      transport: () => transport,
      authorize: vi.fn(async () => "allow"),
    };

    const gateway = createBrowserGateway(deps);
    const result = await gateway.run(createMockScope(), {
      goal: "Submit form",
      expect: { all: [{ kind: "visible-text", text: "Successful" }] },
    });

    expect(result.status).toBe("completed");
    expect(result.steps.length).toBe(1);
    expect(result.steps[0]?.state).toBe("completed");
  });

  it("returns input generation to the active bot", async () => {
    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["TYPE_TEXT"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(),
      observe: vi.fn(async () => ({
        id: "obs_1",
        tabId: "tab_1",
        documentEpoch: "epoch_1",
        origin: "https://form.local",
        title: "Search",
        stateText: "Enter query",
        candidates: [
          { id: "t1", elementId: "el_1", operation: "TYPE_TEXT", role: "textbox", label: "Query", value: "" },
        ],
        controls: [],
        guardId: "g_1",
        truncated: false,
        omittedCandidates: 0,
      })),
      verify: vi.fn(async () => true),
      prepare: vi.fn(),
      execute: vi.fn(),
    };

    const decider: Partial<Decider> = {
      ask: vi.fn(async () => ({
        ok: true,
        provider: "jev",
        answers: {
          operation: { type: "choice", choice: "TYPE_TEXT", pTop: 0.95, margin: 0.3 },
        },
      })) as any,
    };

    const deps: BrowserGatewayDeps = {
      decider: decider as Decider,
      config: () => ({ decider: { enabled: true, key: "key", jobs: { browserAutomation: true } } } as AppConfig),
      transport: () => transport,
      authorize: vi.fn(async () => "allow"),
    };

    const gateway = createBrowserGateway(deps);
    const result = await gateway.run(createMockScope(), { goal: "Search for shoes" });

    expect(result.status).toBe("needs-input");
    expect(result.pendingField?.requestId).toBeDefined();
    expect(result.pendingField?.field.label).toBe("Query");
  });

  it("stops before a human only sign in step", async () => {
    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["CLICK"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(),
      observe: vi.fn(async () => ({
        id: "obs_1",
        tabId: "tab_1",
        documentEpoch: "epoch_1",
        origin: "https://login.local",
        title: "Sign in with Google",
        stateText: "Sign in with Google Account",
        candidates: [
          { id: "c1", elementId: "el_1", operation: "CLICK", role: "button", label: "Sign in with Google" },
        ],
        controls: [],
        guardId: "g_1",
        truncated: false,
        omittedCandidates: 0,
      })),
      verify: vi.fn(async () => true),
      prepare: vi.fn(async () => ({ ticket: "tk_1", call: { name: "click", arguments: { ref: "e1" } } })),
      execute: vi.fn(async () => ({ state: "completed", result: {}, postObservation: "ok" })),
    };

    const decider: Partial<Decider> = {
      ask: vi.fn(async () => ({
        ok: true,
        provider: "jev",
        answers: {
          operation: { type: "choice", choice: "CLICK", pTop: 0.95, margin: 0.3 },
        },
      })) as any,
    };

    // Authorize hook returns pending for human-only sign in
    const deps: BrowserGatewayDeps = {
      decider: decider as Decider,
      config: () => ({ decider: { enabled: true, key: "key", jobs: { browserAutomation: true } } } as AppConfig),
      transport: () => transport,
      authorize: vi.fn(async () => "pending"),
    };

    const gateway = createBrowserGateway(deps);
    const result = await gateway.run(createMockScope(), { goal: "Sign in" });

    expect(result.status).toBe("needs-agent");
    expect(result.reason).toBe("permission-required");
  });

  it("preserves iframe and popup ownership", async () => {
    // When observation encounters child frames or popups, it falls back to needs-agent / AX path
    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: [], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(),
      observe: vi.fn(async () => {
        throw new Error("Page contains frames or iframes; fast DOM observer only supports main document.");
      }),
      verify: vi.fn(async () => true),
      prepare: vi.fn(),
      execute: vi.fn(),
    };

    const deps: BrowserGatewayDeps = {
      decider: {} as Decider,
      config: () => ({ decider: { enabled: true, key: "key", jobs: { browserAutomation: true } } } as AppConfig),
      transport: () => transport,
      authorize: vi.fn(async () => "allow"),
    };

    const gateway = createBrowserGateway(deps);
    const result = await gateway.run(createMockScope(), { goal: "Interact with iframe" });

    expect(result.status).toBe("needs-agent");
    expect(result.reason).toBe("unsupported-observation");
  });

  it("falls back after a Jev timeout without duplicate submission", async () => {
    let callAttempts = 0;
    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["CLICK"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(),
      observe: vi.fn(async () => ({
        id: "obs_1",
        tabId: "tab_1",
        documentEpoch: "epoch_1",
        origin: "https://pay.local",
        title: "Checkout",
        stateText: "Pay $10",
        candidates: [
          { id: "c1", elementId: "el_1", operation: "CLICK", role: "button", label: "Pay Now" },
        ],
        controls: [],
        guardId: "g_1",
        truncated: false,
        omittedCandidates: 0,
      })),
      verify: vi.fn(async () => true),
      prepare: vi.fn(),
      execute: vi.fn(async () => {
        callAttempts++;
        return { state: "completed", result: {}, postObservation: "ok" };
      }),
    };

    const decider: Partial<Decider> = {
      ask: vi.fn(async () => ({
        ok: false,
        reason: "timeout",
      })) as any,
    };

    const deps: BrowserGatewayDeps = {
      decider: decider as Decider,
      config: () => ({ decider: { enabled: true, key: "key", jobs: { browserAutomation: true } } } as AppConfig),
      transport: () => transport,
      authorize: vi.fn(async () => "allow"),
    };

    const gateway = createBrowserGateway(deps);
    const result = await gateway.run(createMockScope(), { goal: "Pay" });

    expect(result.status).toBe("needs-agent");
    expect(callAttempts).toBe(0); // Zero duplicate submissions!
  });

  it("verifies all requested filters independently of done", async () => {
    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["DONE"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(),
      observe: vi.fn(async () => ({
        id: "obs_1",
        tabId: "tab_1",
        documentEpoch: "epoch_1",
        origin: "https://shop.local",
        title: "Shop",
        stateText: "Results list",
        candidates: [],
        controls: [],
        guardId: "g_1",
        truncated: false,
        omittedCandidates: 0,
      })),
      verify: vi.fn(async (_scope, expectations) => {
        // Only return true if both filters pass
        return expectations.length === 2;
      }),
      prepare: vi.fn(),
      execute: vi.fn(),
    };

    const decider: Partial<Decider> = {
      ask: vi.fn(async () => ({
        ok: true,
        provider: "jev",
        answers: {
          operation: { type: "choice", choice: "DONE", pTop: 0.95, margin: 0.3 },
        },
      })) as any,
    };

    const deps: BrowserGatewayDeps = {
      decider: decider as Decider,
      config: () => ({ decider: { enabled: true, key: "key", jobs: { browserAutomation: true } } } as AppConfig),
      transport: () => transport,
      authorize: vi.fn(async () => "allow"),
    };

    const gateway = createBrowserGateway(deps);
    const result = await gateway.run(createMockScope(), {
      goal: "Filter by size and color",
      expect: {
        all: [
          { kind: "visible-text", text: "Size: M" },
          { kind: "visible-text", text: "Color: Blue" },
        ],
      },
    });

    expect(result.status).toBe("completed");
    expect(transport.verify).toHaveBeenCalledTimes(1);
  });

  it("does not accept a matching path on the wrong origin", async () => {
    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["DONE"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(),
      observe: vi.fn(async () => ({
        id: "obs_1",
        tabId: "tab_1",
        documentEpoch: "epoch_1",
        origin: "https://phishing.local", // Wrong origin!
        title: "Success",
        stateText: "Done",
        candidates: [],
        controls: [],
        guardId: "g_1",
        truncated: false,
        omittedCandidates: 0,
      })),
      verify: vi.fn(async (_scope, expectations) => {
        for (const exp of expectations) {
          if (exp.kind === "url-path") {
            if ("https://phishing.local" !== exp.origin) return false;
          }
        }
        return true;
      }),
      prepare: vi.fn(),
      execute: vi.fn(),
    };

    const decider: Partial<Decider> = {
      ask: vi.fn(async () => ({
        ok: true,
        provider: "jev",
        answers: {
          operation: { type: "choice", choice: "DONE", pTop: 0.95, margin: 0.3 },
        },
      })) as any,
    };

    const deps: BrowserGatewayDeps = {
      decider: decider as Decider,
      config: () => ({ decider: { enabled: true, key: "key", jobs: { browserAutomation: true } } } as AppConfig),
      transport: () => transport,
      authorize: vi.fn(async () => "allow"),
    };

    const gateway = createBrowserGateway(deps);
    const result = await gateway.run(createMockScope(), {
      goal: "Navigate",
      expect: {
        all: [{ kind: "url-path", origin: "https://official.local", pathname: "/dashboard" }],
      },
    });

    expect(result.status).toBe("needs-agent");
    expect(result.reason).toBe("expectation-unmet");
  });

  it("keeps selecting autocomplete results without redundant model waits", async () => {
    let selectCalled = false;
    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["SELECT", "DONE"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(),
      observe: vi.fn(async () => ({
        id: "obs_1",
        tabId: "tab_1",
        documentEpoch: "epoch_1",
        origin: "https://search.local",
        title: "Flights",
        stateText: "Pick destination",
        candidates: [
          { id: "s1", elementId: "sel_1", operation: "SELECT", role: "combobox", label: "City → Tokyo", optionId: "NRT" },
        ],
        controls: [],
        guardId: "g_1",
        truncated: false,
        omittedCandidates: 0,
      })),
      verify: vi.fn(async () => true),
      prepare: vi.fn(async () => ({ ticket: "tk_1", call: { name: "select", arguments: { ref: "e1", values: ["NRT"] } } })),
      execute: vi.fn(async (): Promise<BrowserExecution> => {
        selectCalled = true;
        return { state: "completed", result: { ok: true }, postObservation: "ok" };
      }),
    };

    const decider: Partial<Decider> = {
      ask: vi.fn(async () => ({
        ok: true,
        provider: "jev",
        answers: {
          operation: { type: "choice", choice: "SELECT", pTop: 0.96, margin: 0.35 },
        },
      })) as any,
    };

    const deps: BrowserGatewayDeps = {
      decider: decider as Decider,
      config: () => ({ decider: { enabled: true, key: "key", jobs: { browserAutomation: true } } } as AppConfig),
      transport: () => transport,
      authorize: vi.fn(async () => "allow"),
    };

    const gateway = createBrowserGateway(deps);
    await gateway.run(createMockScope(), { goal: "Pick Tokyo", maxSteps: 1 });

    expect(selectCalled).toBe(true);
  });
});
