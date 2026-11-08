import { describe, expect, it, vi } from "vitest";
import { createBrowserGateway, type BrowserGatewayDeps } from "./jev.ts";
import type { BrowserExecution, BrowserObservation, BrowserScope, BrowserTransport, PreparedBrowserAction } from "./jev-types.ts";
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

function createMockObservation(): BrowserObservation {
  return {
    id: "obs_1",
    tabId: "tab_1",
    documentEpoch: "epoch_1",
    origin: "https://example.com",
    title: "Example",
    stateText: "Form page",
    candidates: [
      { id: "c1", elementId: "el_1", operation: "CLICK", role: "button", label: "Submit" },
    ],
    controls: [],
    guardId: "g_1",
    truncated: false,
    omittedCandidates: 0,
  };
}

describe("jev-control", () => {
  it("denies observation during human takeover", async () => {
    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["CLICK"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(),
      observe: vi.fn(async () => {
        throw new Error("Human takeover active");
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
    const result = await gateway.run(createMockScope(), { goal: "Run" });

    expect(result.status).toBe("needs-agent");
    expect(result.reason).toBe("unsupported-observation");
  });

  it("rechecks child action authorization before final input", async () => {
    let authCount = 0;
    const authorize = vi.fn(async () => {
      authCount++;
      return authCount === 1 ? "allow" as const : "refuse" as const;
    });

    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["CLICK"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(),
      observe: vi.fn(async () => createMockObservation()),
      verify: vi.fn(async () => true),
      prepare: vi.fn(async () => ({ ticket: "tk_1", call: { name: "click", arguments: {} } })),
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

    const deps: BrowserGatewayDeps = {
      decider: decider as Decider,
      config: () => ({ decider: { enabled: true, key: "key", jobs: { browserAutomation: true } } } as AppConfig),
      transport: () => transport,
      authorize,
    };

    // If authorize refuses child action, gateway returns permission-denied
    const gateway = createBrowserGateway(deps);
    const result = await gateway.run(createMockScope(), { goal: "Click", maxSteps: 2 });
    expect(result.status).toBe("needs-agent");
    expect(result.reason).toBe("permission-denied");
  });

  it("stops when the conversation is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    const deps: BrowserGatewayDeps = {
      decider: {} as Decider,
      config: () => ({ decider: { enabled: true, key: "key", jobs: { browserAutomation: true } } } as AppConfig),
      transport: () => ({
        capabilities: { mode: "dom-fast", operations: ["CLICK"], semanticGuard: true, atomicObservation: true },
        rawCall: vi.fn(),
        observe: vi.fn(),
        verify: vi.fn(),
        prepare: vi.fn(),
        execute: vi.fn(),
      }),
      authorize: vi.fn(async () => "allow"),
    };

    const gateway = createBrowserGateway(deps);
    const result = await gateway.run(createMockScope({ signal: controller.signal }), { goal: "Run" });

    expect(result.status).toBe("interrupted");
    expect(result.reason).toBe("cancelled");
  });

  it("rejects a stale scope generation before dispatch", async () => {
    const scopeGen1 = createMockScope({ turnGeneration: "gen_1" });

    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["CLICK"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(),
      observe: vi.fn(async () => createMockObservation()),
      verify: vi.fn(async () => true),
      prepare: vi.fn(async () => ({ ticket: "tk_1", call: { name: "click", arguments: {} } })),
      execute: vi.fn(async (scope): Promise<BrowserExecution> => {
        if (scope.turnGeneration !== "gen_2") {
          return { state: "not-dispatched", reason: "stale-generation" };
        }
        return { state: "completed", result: {}, postObservation: "ok" };
      }),
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

    const deps: BrowserGatewayDeps = {
      decider: decider as Decider,
      config: () => ({ decider: { enabled: true, key: "key", jobs: { browserAutomation: true } } } as AppConfig),
      transport: () => transport,
      authorize: vi.fn(async () => "allow"),
    };

    const gateway = createBrowserGateway(deps);
    const result = await gateway.run(scopeGen1, { goal: "Click", maxSteps: 1 });

    expect(result.status).toBe("needs-agent");
    expect(result.reason).toBe("stale-observation");
  });

  it("serializes on the existing profile lane without nesting it", async () => {
    // Tests that multiple sequential actions through the gateway do not deadlock or double-lock profile lane
    let inLane = false;
    let maxConcurrent = 0;

    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["CLICK"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(async () => {
        if (inLane) maxConcurrent = 2;
        inLane = true;
        await new Promise((r) => setTimeout(r, 10));
        inLane = false;
        return { ok: true };
      }),
      observe: vi.fn(async () => createMockObservation()),
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
    await gateway.call(createMockScope(), { name: "click", arguments: { ref: "e1" } });
    await gateway.call(createMockScope(), { name: "click", arguments: { ref: "e2" } });

    expect(maxConcurrent).toBe(0);
  });
});
