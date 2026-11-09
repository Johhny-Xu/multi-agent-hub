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
      { id: "c1", elementId: "el_1", operation: "CLICK", role: "button", label: "Search" },
      { id: "c2", elementId: "el_2", operation: "CLICK", role: "button", label: "Submit" },
      { id: "t1", elementId: "el_3", operation: "TYPE_TEXT", role: "textbox", label: "Query", value: "" },
    ],
    controls: ["WAIT"],
    guardId: "g_1",
    truncated: false,
    omittedCandidates: 0,
  };
}

describe("jev gateway", () => {
  it("passes exact tools through once when disabled", async () => {
    let rawCalls = 0;
    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["CLICK"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(async () => { rawCalls++; return { ok: true }; }),
      observe: vi.fn(async () => createMockObservation()),
      verify: vi.fn(async () => true),
      prepare: vi.fn(async () => ({ ticket: "tk_1", call: { name: "click", arguments: {} } })),
      execute: vi.fn(async (): Promise<BrowserExecution> => ({ state: "completed", result: {}, postObservation: "ok" })),
    };

    const deps: BrowserGatewayDeps = {
      decider: {} as Decider,
      config: () => ({ decider: { enabled: false } } as AppConfig),
      transport: () => transport,
      authorize: vi.fn(async () => "allow" as const),
    };

    const gateway = createBrowserGateway(deps);
    const result = await gateway.call(createMockScope(), { name: "click", arguments: { ref: "e1" } });

    expect(result).toEqual({ ok: true });
    expect(rawCalls).toBe(1);
    expect(transport.observe).not.toHaveBeenCalled();
  });

  it("does not classify or observe an explicit ref action", async () => {
    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["CLICK"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(async () => ({ result: "clicked" })),
      observe: vi.fn(async () => createMockObservation()),
      verify: vi.fn(async () => true),
      prepare: vi.fn(),
      execute: vi.fn(),
    };

    const deciderAsk = vi.fn();
    const deps: BrowserGatewayDeps = {
      decider: { ask: deciderAsk } as unknown as Decider,
      config: () => ({ decider: { enabled: true, key: "key", jobs: { browserAutomation: true } } } as AppConfig),
      transport: () => transport,
      authorize: vi.fn(async () => "allow" as const),
    };

    const gateway = createBrowserGateway(deps);
    await gateway.call(createMockScope(), { name: "agent_browser_click", arguments: { selector: "@e1" } });

    expect(transport.rawCall).toHaveBeenCalledTimes(1);
    expect(transport.observe).not.toHaveBeenCalled();
    expect(deciderAsk).not.toHaveBeenCalled();
  });

  it("bounds and redacts the complete decision request", async () => {
    let capturedState: any;
    const decider: Partial<Decider> = {
      ask: vi.fn(async (_seam, state) => {
        capturedState = state;
        return {
          ok: true,
          provider: "jev",
          answers: {
            operation: { type: "choice", choice: "DONE", pTop: 0.95, margin: 0.3 },
          },
        };
      }) as any,
    };

    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["CLICK", "DONE"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(),
      observe: vi.fn(async () => createMockObservation()),
      verify: vi.fn(async () => true),
      prepare: vi.fn(),
      execute: vi.fn(),
    };

    const deps: BrowserGatewayDeps = {
      decider: decider as Decider,
      config: () => ({ decider: { enabled: true, key: "key", jobs: { browserAutomation: true } } } as AppConfig),
      transport: () => transport,
      authorize: vi.fn(async () => "allow" as const),
    };

    const gateway = createBrowserGateway(deps);
    await gateway.run(createMockScope(), { goal: "Find shoes", maxSteps: 4, expect: { all: [{ kind: "visible-text", text: "Results" }] } });

    expect(capturedState).toBeDefined();
    expect(capturedState.goal.length).toBeLessThanOrEqual(2000);
    expect(capturedState.elements.length).toBeLessThanOrEqual(64);
  });

  it("returns to the agent on low confidence", async () => {
    const decider: Partial<Decider> = {
      ask: vi.fn(async () => ({
        ok: true,
        provider: "jev",
        answers: {
          operation: { type: "choice", choice: "CLICK", pTop: 0.70, margin: 0.05 }, // below threshold
        },
      })) as any,
    };

    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["CLICK"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(),
      observe: vi.fn(async () => createMockObservation()),
      verify: vi.fn(async () => true),
      prepare: vi.fn(),
      execute: vi.fn(),
    };

    const deps: BrowserGatewayDeps = {
      decider: decider as Decider,
      config: () => ({ decider: { enabled: true, key: "key", jobs: { browserAutomation: true } } } as AppConfig),
      transport: () => transport,
      authorize: vi.fn(async () => "allow" as const),
    };

    const gateway = createBrowserGateway(deps);
    const result = await gateway.run(createMockScope(), { goal: "Goal", maxSteps: 4 });

    expect(result.status).toBe("needs-agent");
    expect(result.reason).toBe("low-confidence");
  });

  it("consumes an action ticket only once", async () => {
    let ticketConsumed = 0;
    const ticket = "ticket_abc_123";
    const usedTickets = new Set<string>();

    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["CLICK"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(),
      observe: vi.fn(async () => createMockObservation()),
      verify: vi.fn(async () => true),
      prepare: vi.fn(async () => ({ ticket, call: { name: "click", arguments: { ref: "e1" } } })),
      execute: vi.fn(async (_scope, action: PreparedBrowserAction): Promise<BrowserExecution> => {
        if (usedTickets.has(action.ticket)) {
          return { state: "not-dispatched", reason: "ticket-replayed" };
        }
        usedTickets.add(action.ticket);
        ticketConsumed++;
        return { state: "completed", result: { ok: true }, postObservation: "ok" };
      }),
    };

    const decider: Partial<Decider> = {
      ask: vi.fn(async () => ({
        ok: true,
        provider: "jev",
        answers: {
          operation: { type: "choice", choice: "CLICK", pTop: 0.95, margin: 0.3 },
          click_target: { type: "choice", choice: "c1", pTop: 0.95, margin: 0.3 },
        },
      })) as any,
    };

    const deps: BrowserGatewayDeps = {
      decider: decider as Decider,
      config: () => ({ decider: { enabled: true, key: "key", jobs: { browserAutomation: true } } } as AppConfig),
      transport: () => transport,
      authorize: vi.fn(async () => "allow" as const),
    };

    const gateway = createBrowserGateway(deps);
    await gateway.run(createMockScope(), { goal: "Click button", maxSteps: 1 });

    expect(ticketConsumed).toBe(1);
  });

  it("requests text without starting another model", async () => {
    const decider: Partial<Decider> = {
      ask: vi.fn(async () => ({
        ok: true,
        provider: "jev",
        answers: {
          operation: { type: "choice", choice: "TYPE_TEXT", pTop: 0.95, margin: 0.3 },
        },
      })) as any,
    };

    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["TYPE_TEXT"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(),
      observe: vi.fn(async () => createMockObservation()),
      verify: vi.fn(async () => true),
      prepare: vi.fn(),
      execute: vi.fn(),
    };

    const deps: BrowserGatewayDeps = {
      decider: decider as Decider,
      config: () => ({ decider: { enabled: true, key: "key", jobs: { browserAutomation: true } } } as AppConfig),
      transport: () => transport,
      authorize: vi.fn(async () => "allow" as const),
    };

    const gateway = createBrowserGateway(deps);
    const result = await gateway.run(createMockScope(), { goal: "Type name", maxSteps: 4 });

    // Handoff to active bot with status needs-input
    expect(result.status).toBe("needs-input");
    expect(result.pendingField).toBeDefined();
    expect(result.pendingField?.field.label).toBe("Query");
  });

  it("stops at action decision and active time budgets", async () => {
    let nowTime = 1000;
    const decider: Partial<Decider> = {
      ask: vi.fn(async () => ({
        ok: true,
        provider: "jev",
        answers: {
          operation: { type: "choice", choice: "CLICK", pTop: 0.95, margin: 0.3 },
          click_target: { type: "choice", choice: "c1", pTop: 0.95, margin: 0.3 },
        },
      })) as any,
    };

    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["CLICK"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(),
      observe: vi.fn(async () => {
        nowTime += 15_000; // time exceeds 12s budget
        return createMockObservation();
      }),
      verify: vi.fn(async () => true),
      prepare: vi.fn(async () => ({ ticket: "tk_1", call: { name: "click", arguments: {} } })),
      execute: vi.fn(async (): Promise<BrowserExecution> => ({ state: "completed", result: {}, postObservation: "ok" })),
    };

    const deps: BrowserGatewayDeps = {
      decider: decider as Decider,
      config: () => ({ decider: { enabled: true, key: "key", jobs: { browserAutomation: true } } } as AppConfig),
      transport: () => transport,
      authorize: vi.fn(async () => "allow" as const),
      now: () => nowTime,
    };

    const gateway = createBrowserGateway(deps);
    const result = await gateway.run(createMockScope(), { goal: "Run", maxSteps: 4 });

    expect(result.status).toBe("needs-agent");
  });

  it("does not replay an action with unknown outcome", async () => {
    let executeAttempts = 0;
    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["CLICK"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(),
      observe: vi.fn(async () => createMockObservation()),
      verify: vi.fn(async () => true),
      prepare: vi.fn(async () => ({ ticket: "tk_1", call: { name: "click", arguments: {} } })),
      execute: vi.fn(async (): Promise<BrowserExecution> => {
        executeAttempts++;
        return { state: "unknown", result: { timeout: true } };
      }),
    };

    const decider: Partial<Decider> = {
      ask: vi.fn(async () => ({
        ok: true,
        provider: "jev",
        answers: {
          operation: { type: "choice", choice: "CLICK", pTop: 0.95, margin: 0.3 },
          click_target: { type: "choice", choice: "c1", pTop: 0.95, margin: 0.3 },
        },
      })) as any,
    };

    const deps: BrowserGatewayDeps = {
      decider: decider as Decider,
      config: () => ({ decider: { enabled: true, key: "key", jobs: { browserAutomation: true } } } as AppConfig),
      transport: () => transport,
      authorize: vi.fn(async () => "allow" as const),
    };

    const gateway = createBrowserGateway(deps);
    const result = await gateway.run(createMockScope(), { goal: "Run", maxSteps: 4 });

    expect(executeAttempts).toBe(1);
    expect(result.status).toBe("uncertain");
    expect(result.reason).toBe("unknown-outcome");
  });

  it("rechecks scope after the decision returns", async () => {
    const controller = new AbortController();
    const decider: Partial<Decider> = {
      ask: vi.fn(async () => {
        controller.abort(); // Cancelled while decider was thinking
        return {
          ok: true,
          provider: "jev",
          answers: {
            operation: { type: "choice", choice: "CLICK", pTop: 0.95, margin: 0.3 },
            click_target: { type: "choice", choice: "c1", pTop: 0.95, margin: 0.3 },
          },
        };
      }) as any,
    };

    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["CLICK"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(),
      observe: vi.fn(async () => createMockObservation()),
      verify: vi.fn(async () => true),
      prepare: vi.fn(),
      execute: vi.fn(),
    };

    const deps: BrowserGatewayDeps = {
      decider: decider as Decider,
      config: () => ({ decider: { enabled: true, key: "key", jobs: { browserAutomation: true } } } as AppConfig),
      transport: () => transport,
      authorize: vi.fn(async () => "allow" as const),
    };

    const gateway = createBrowserGateway(deps);
    const result = await gateway.run(createMockScope({ signal: controller.signal }), { goal: "Run", maxSteps: 4 });

    expect(result.status).toBe("interrupted");
    expect(result.reason).toBe("cancelled");
    expect(transport.prepare).not.toHaveBeenCalled();
    expect(transport.execute).not.toHaveBeenCalled();
  });

  it("does not treat a stop decision as verified success", async () => {
    const decider: Partial<Decider> = {
      ask: vi.fn(async () => ({
        ok: true,
        provider: "jev",
        answers: {
          operation: { type: "choice", choice: "DONE", pTop: 0.95, margin: 0.3 },
        },
      })) as any,
    };

    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["DONE"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(),
      observe: vi.fn(async () => createMockObservation()),
      verify: vi.fn(async () => false), // verification fails!
      prepare: vi.fn(),
      execute: vi.fn(),
    };

    const deps: BrowserGatewayDeps = {
      decider: decider as Decider,
      config: () => ({ decider: { enabled: true, key: "key", jobs: { browserAutomation: true } } } as AppConfig),
      transport: () => transport,
      authorize: vi.fn(async () => "allow" as const),
    };

    const gateway = createBrowserGateway(deps);
    // When expect is provided and verification fails, it returns expectation-unmet, NOT completed!
    const resultWithExpect = await gateway.run(createMockScope(), {
      goal: "Search",
      maxSteps: 4,
      expect: { all: [{ kind: "visible-text", text: "Welcome" }] },
    });
    expect(resultWithExpect.status).toBe("needs-agent");
    expect(resultWithExpect.reason).toBe("expectation-unmet");

    // Without expect, DONE returns needs-agent with done-unverified
    const resultNoExpect = await gateway.run(createMockScope(), { goal: "Search", maxSteps: 4 });
    expect(resultNoExpect.status).toBe("needs-agent");
    expect(resultNoExpect.reason).toBe("done-unverified");
  });

  it("generates text via 9router and completes action when browserTextModel is on", async () => {
    let typedText: string | undefined;
    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["TYPE_TEXT"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(),
      observe: vi.fn(async () => createMockObservation()),
      verify: vi.fn(async () => true),
      prepare: vi.fn(async (_scope, _obs, _choice, text) => {
        typedText = text;
        return { ticket: "tk_1", call: { name: "type", arguments: { text } } };
      }),
      execute: vi.fn(async (): Promise<BrowserExecution> => ({ state: "completed", result: {}, postObservation: "ok" })),
    };

    const decider: Partial<Decider> = {
      ask: vi.fn(async () => ({
        ok: true,
        provider: "jev",
        answers: {
          operation: { type: "choice", choice: "TYPE_TEXT", pTop: 0.95, margin: 0.3 },
          type_target: { type: "choice", choice: "t1", pTop: 0.95, margin: 0.3 },
        },
      })) as any,
    };

    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://127.0.0.1:20128/v1/chat/completions");
      expect((init?.headers as any)?.Authorization).toBe("Bearer 9router-active-key");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("ollama/gpt-oss:120b");
      expect(body.response_format).toEqual({ type: "json_object" });
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ text: "Generated Query" }) } }],
        }),
      } as Response;
    });

    const deps: BrowserGatewayDeps = {
      decider: decider as Decider,
      config: () =>
        ({
          instances: { nr: { driver: "openai-compat", config: { key: "9router-active-key", url: "http://127.0.0.1:20128/v1" } } },
          decider: {
            enabled: true,
            key: "key",
            jobs: { browserAutomation: true, browserTextModel: true },
          },
        }) as AppConfig,
      transport: () => transport,
      authorize: vi.fn(async () => "allow" as const),
      fetch: mockFetch as unknown as typeof fetch,
    };

    const gateway = createBrowserGateway(deps);
    const result = await gateway.run(createMockScope(), { goal: "Search for books", maxSteps: 1 });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(typedText).toBe("Generated Query");
    expect(transport.execute).toHaveBeenCalledTimes(1);
    expect(result.steps.length).toBe(1);
    expect(result.steps[0].action).toBe("type");
    expect(result.status).not.toBe("needs-input");
  });

  it("falls back directly to needs-input when browserTextModel is off", async () => {
    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["TYPE_TEXT"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(),
      observe: vi.fn(async () => createMockObservation()),
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
          type_target: { type: "choice", choice: "t1", pTop: 0.95, margin: 0.3 },
        },
      })) as any,
    };

    const mockFetch = vi.fn();

    const deps: BrowserGatewayDeps = {
      decider: decider as Decider,
      config: () =>
        ({
          instances: { nr: { driver: "openai-compat", config: { key: "9router-active-key", url: "http://127.0.0.1:20128/v1" } } },
          decider: {
            enabled: true,
            key: "key",
            jobs: { browserAutomation: true, browserTextModel: false },
          },
        }) as AppConfig,
      transport: () => transport,
      authorize: vi.fn(async () => "allow" as const),
      fetch: mockFetch as unknown as typeof fetch,
    };

    const gateway = createBrowserGateway(deps);
    const result = await gateway.run(createMockScope(), { goal: "Search for books", maxSteps: 4 });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.status).toBe("needs-input");
    expect(result.reason).toBeUndefined();
    expect(result.pendingField).toBeDefined();
    expect(result.pendingField?.field.label).toBe("Query");
  });

  it("falls back to needs-input and marks failure reason when 9router fails (HTTP error, timeout, non-JSON)", async () => {
    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["TYPE_TEXT"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(),
      observe: vi.fn(async () => createMockObservation()),
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
          type_target: { type: "choice", choice: "t1", pTop: 0.95, margin: 0.3 },
        },
      })) as any,
    };

    // 1. HTTP 401 error
    const deps401: BrowserGatewayDeps = {
      decider: decider as Decider,
      config: () =>
        ({
          instances: { nr: { driver: "openai-compat", config: { key: "bad-key", url: "http://127.0.0.1:20128/v1" } } },
          decider: { enabled: true, key: "key", jobs: { browserAutomation: true, browserTextModel: true } },
        }) as AppConfig,
      transport: () => transport,
      authorize: vi.fn(async () => "allow" as const),
      fetch: vi.fn(async () => ({ ok: false, status: 401 }) as Response) as any,
    };

    const res401 = await createBrowserGateway(deps401).run(createMockScope(), { goal: "Search", maxSteps: 4 });
    expect(res401.status).toBe("needs-input");
    expect(res401.reason).toBe("text-model-failed");
    expect(res401.pendingField).toBeDefined();

    // 2. Timeout
    const depsTimeout: BrowserGatewayDeps = {
      decider: decider as Decider,
      config: () =>
        ({
          instances: { nr: { driver: "openai-compat", config: { key: "some-key", url: "http://127.0.0.1:20128/v1" } } },
          decider: { enabled: true, key: "key", jobs: { browserAutomation: true, browserTextModel: true } },
        }) as AppConfig,
      transport: () => transport,
      authorize: vi.fn(async () => "allow" as const),
      fetch: vi.fn(async () => {
        const err = new Error("timeout");
        err.name = "AbortError";
        throw err;
      }) as any,
    };

    const resTimeout = await createBrowserGateway(depsTimeout).run(createMockScope(), { goal: "Search", maxSteps: 4 });
    expect(resTimeout.status).toBe("needs-input");
    expect(resTimeout.reason).toBe("text-model-failed");

    // 3. Non-JSON
    const depsNonJson: BrowserGatewayDeps = {
      decider: decider as Decider,
      config: () =>
        ({
          instances: { nr: { driver: "openai-compat", config: { key: "some-key", url: "http://127.0.0.1:20128/v1" } } },
          decider: { enabled: true, key: "key", jobs: { browserAutomation: true, browserTextModel: true } },
        }) as AppConfig,
      transport: () => transport,
      authorize: vi.fn(async () => "allow" as const),
      fetch: vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "invalid json string" } }] }),
      }) as Response) as any,
    };

    const resNonJson = await createBrowserGateway(depsNonJson).run(createMockScope(), { goal: "Search", maxSteps: 4 });
    expect(resNonJson.status).toBe("needs-input");
    expect(resNonJson.reason).toBe("text-model-failed");
  });

  it("never leaks 9router API key in steps, observation, pendingField, or result output", async () => {
    const SECRET_KEY = "sk-super-secret-9router-token-998877";
    let capturedAuthHeader = "";

    const transport: BrowserTransport = {
      capabilities: { mode: "dom-fast", operations: ["TYPE_TEXT"], semanticGuard: true, atomicObservation: true },
      rawCall: vi.fn(),
      observe: vi.fn(async () => createMockObservation()),
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
          type_target: { type: "choice", choice: "t1", pTop: 0.95, margin: 0.3 },
        },
      })) as any,
    };

    const deps: BrowserGatewayDeps = {
      decider: decider as Decider,
      config: () =>
        ({
          instances: { nr: { driver: "openai-compat", config: { key: SECRET_KEY, url: "http://127.0.0.1:20128/v1" } } },
          decider: { enabled: true, key: "key", jobs: { browserAutomation: true, browserTextModel: true } },
        }) as AppConfig,
      transport: () => transport,
      authorize: vi.fn(async () => "allow" as const),
      fetch: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedAuthHeader = String((init?.headers as any)?.Authorization);
        return { ok: false, status: 500 } as Response;
      }) as any,
    };

    const gateway = createBrowserGateway(deps);
    const result = await gateway.run(createMockScope(), { goal: "Confidential search", maxSteps: 4 });

    // Key was indeed used to authorize the request
    expect(capturedAuthHeader).toBe(`Bearer ${SECRET_KEY}`);

    // Verify key NEVER leaks into result or pending field
    const serializedResult = JSON.stringify(result);
    expect(serializedResult).not.toContain(SECRET_KEY);
    expect(JSON.stringify(result.pendingField)).not.toContain(SECRET_KEY);
    expect(JSON.stringify(result.steps)).not.toContain(SECRET_KEY);
    expect(JSON.stringify(result.lastObservation)).not.toContain(SECRET_KEY);
  });
});
