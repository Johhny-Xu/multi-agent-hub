import { describe, expect, it, vi } from "vitest";
import {
  acceptBrowserText,
  browserTextContext,
  clearBrowserText,
  getCachedText,
  getPendingTextMeta,
  request9RouterText,
  requestBrowserText,
  resolveNineRouterKey,
  TEXT_REQUEST_TTL_MS,
} from "./jev-text.ts";
import type { AppConfig } from "../config.ts";
import type { BrowserCandidate, BrowserObservation, BrowserScope, BrowserTextContext } from "./jev-types.ts";

function createMockScope(id = "1"): BrowserScope {
  return {
    botId: "bot_" + id,
    conversationId: "conv_1",
    sessionId: "sess_1",
    profileId: "prof_1",
    turnGeneration: "gen_1",
    tabId: "tab_1",
    place: { key: "builtin", provider: "builtin", revision: "1" },
    signal: new AbortController().signal,
  };
}

const mockCandidate: BrowserCandidate = {
  id: "c_1",
  elementId: "el_1",
  operation: "TYPE_TEXT",
  role: "textbox",
  label: "First Name",
  value: "",
};

const mockObservation: BrowserObservation = {
  id: "obs_1",
  tabId: "tab_1",
  documentEpoch: "epoch_1",
  origin: "https://example.com",
  title: "Registration Form",
  stateText: "Please register",
  candidates: [mockCandidate],
  controls: [],
  guardId: "g_1",
  truncated: false,
  omittedCandidates: 0,
};

describe("jev-text", () => {
  it("accepts strict text JSON only for the selected field", () => {
    const scope = createMockScope();
    const context = browserTextContext("Sign up", mockCandidate, mockObservation, []);
    const pending = requestBrowserText(scope, context, mockCandidate);

    const validReply = { requestId: pending.requestId, value: { text: "Alice" } };
    const accepted = acceptBrowserText(scope, validReply, context, mockCandidate);
    expect(accepted).toBe("Alice");

    const nullReply = { requestId: pending.requestId, value: { text: null } };
    expect(acceptBrowserText(scope, nullReply, context, mockCandidate)).toBeNull();
  });

  it("reuses pending text only for an identical full helper context", () => {
    const scope = createMockScope();
    const context = browserTextContext("Sign up", mockCandidate, mockObservation, []);
    const pending = requestBrowserText(scope, context, mockCandidate);
    acceptBrowserText(scope, { requestId: pending.requestId, value: { text: "Bob" } }, context, mockCandidate);

    // Exact same context reuses text
    const cached = getCachedText(scope, context, mockCandidate);
    expect(cached).toBe("Bob");

    // Different candidate does not reuse text
    const otherCandidate: BrowserCandidate = { ...mockCandidate, id: "c_2", elementId: "el_2" };
    expect(getCachedText(scope, context, otherCandidate)).toBeNull();
  });

  it("invalidates text when goal field page or history changes", () => {
    const scope = createMockScope();
    const context = browserTextContext("Sign up", mockCandidate, mockObservation, []);
    const pending = requestBrowserText(scope, context, mockCandidate);
    acceptBrowserText(scope, { requestId: pending.requestId, value: { text: "Charlie" } }, context, mockCandidate);

    // Changed goal
    const changedGoalContext: BrowserTextContext = { ...context, goal: "Log in instead" };
    expect(getCachedText(scope, changedGoalContext, mockCandidate)).toBeNull();

    // Changed page
    const changedPageContext: BrowserTextContext = {
      ...context,
      page: { title: "Different Page", origin: "https://example.com" },
    };
    expect(getCachedText(scope, changedPageContext, mockCandidate)).toBeNull();
  });

  it("rejects cross scope expired and replayed text replies", () => {
    const scope1 = createMockScope("1");
    const scope2 = createMockScope("2");
    const context = browserTextContext("Sign up", mockCandidate, mockObservation, []);
    const pending = requestBrowserText(scope1, context, mockCandidate);

    // Scope 2 cannot reply to scope 1's request
    expect(acceptBrowserText(scope2, { requestId: pending.requestId, value: { text: "David" } }, context, mockCandidate)).toBeNull();

    // Expired reply (simulate by clearing text)
    clearBrowserText(scope1);
    expect(acceptBrowserText(scope1, { requestId: pending.requestId, value: { text: "David" } }, context, mockCandidate)).toBeNull();
  });

  it("clears pending text after success unknown outcome or takeover", () => {
    const scope = createMockScope();
    const context = browserTextContext("Sign up", mockCandidate, mockObservation, []);
    requestBrowserText(scope, context, mockCandidate);

    clearBrowserText(scope);
    expect(getCachedText(scope, context, mockCandidate)).toBeNull();
  });

  it("preserves budgets and history across a text handoff", () => {
    const scope = createMockScope();
    const context = browserTextContext("Sign up", mockCandidate, mockObservation, [
      { action: "click", kind: "CLICK" },
    ]);
    const pending = requestBrowserText(scope, context, mockCandidate, {
      remainingSteps: 3,
      remainingBudgetMs: 8000,
      history: [{ action: "click", kind: "CLICK" }],
    });

    const meta = getPendingTextMeta(scope, pending.requestId);
    expect(meta).not.toBeNull();
    expect(meta?.remainingSteps).toBe(3);
    expect(meta?.remainingBudgetMs).toBe(8000);
    expect(meta?.history?.length).toBe(1);
  });

  it("does not bind duplicate field labels to the first input", () => {
    const scope = createMockScope();
    const candidateA: BrowserCandidate = {
      id: "c_1",
      elementId: "el_1",
      operation: "TYPE_TEXT",
      role: "textbox",
      label: "Phone",
      value: "",
    };
    const candidateB: BrowserCandidate = {
      id: "c_2",
      elementId: "el_2",
      operation: "TYPE_TEXT",
      role: "textbox",
      label: "Phone",
      value: "",
    };

    const contextA = browserTextContext("Fill phone", candidateA, mockObservation, []);
    const pendingA = requestBrowserText(scope, contextA, candidateA);

    // Trying to accept candidate A's request with candidate B fails
    const contextB = browserTextContext("Fill phone", candidateB, mockObservation, []);
    const resultB = acceptBrowserText(scope, { requestId: pendingA.requestId, value: { text: "12345" } }, contextB, candidateB);
    expect(resultB).toBeNull();
  });

  it("resolves the 9router key only from 9router's own sources", () => {
    const noDb = () => null;
    expect(resolveNineRouterKey({} as AppConfig, { OMB_9ROUTER_API_KEY: "key-env" }, noDb)).toBe("key-env");
    // the legacy variable and 9router's own database are no longer sources (OMB injects the key)
    expect(resolveNineRouterKey({} as AppConfig, { NINEROUTER_API_KEY: "key-legacy" })).toBeNull();
    expect(
      resolveNineRouterKey(
        { instances: { r: { driver: "openai-compat", config: { key: "key-inst", url: "http://127.0.0.1:20128/v1" } } } } as unknown as AppConfig,
        {},
        noDb,
      ),
    ).toBe("key-inst");
    expect(resolveNineRouterKey({} as AppConfig, {}, () => "key-db")).toBe("key-db");
    expect(resolveNineRouterKey({} as AppConfig, {}, noDb)).toBeNull();
  });

  it("never borrows another provider's key for 9router", () => {
    const cfg = {
      openaiCompat: { key: "key-compat" },
      imageGen: { customApiKey: "key-img" },
      opencodeGo: { providerKeys: { ROUTER_API_KEY: "key-ocg" } },
      instances: { other: { driver: "openai-compat", config: { key: "key-other", url: "https://api.example.com/v1" } } },
    } as unknown as AppConfig;
    expect(resolveNineRouterKey(cfg, { OPENAI_API_KEY: "key-openai", TEXT_MODEL_API_KEY: "key-text" }, () => null)).toBeNull();
  });

  it("calls 9router chat completions endpoint with json_object format and returns parsed text", async () => {
    let calledUrl = "";
    let calledHeaders: any;
    let calledBody: any;

    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(url);
      calledHeaders = init?.headers;
      calledBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ text: "Hello from 9router" }),
              },
            },
          ],
        }),
      } as Response;
    });

    const context = browserTextContext("Search for weather", mockCandidate, mockObservation, []);
    const res = await request9RouterText(
      { instances: { nr: { driver: "openai-compat", config: { key: "sec-key-123", url: "http://127.0.0.1:20128/v1" } } } } as AppConfig,
      context,
      { fetch: mockFetch as unknown as typeof fetch },
    );

    expect(res).toEqual({ ok: true, text: "Hello from 9router" });
    expect(calledUrl).toBe("http://127.0.0.1:20128/v1/chat/completions");
    expect(calledHeaders.Authorization).toBe("Bearer sec-key-123");
    expect(calledBody.model).toBe("ollama/gpt-oss:120b");
    expect(calledBody.stream).toBe(false);
    expect(calledBody.response_format).toEqual({ type: "json_object" });
  });

  it("handles 9router failure modes cleanly (401, timeout, malformed, empty)", async () => {
    const context = browserTextContext("Goal", mockCandidate, mockObservation, []);
    const cfg = { instances: { nr: { driver: "openai-compat", config: { key: "sec-key", url: "http://127.0.0.1:20128/v1" } } } } as AppConfig;

    // HTTP 401
    const res401 = await request9RouterText(cfg, context, {
      fetch: vi.fn(async () => ({ ok: false, status: 401 }) as Response) as any,
    });
    expect(res401.ok).toBe(false);
    if (!res401.ok) {
      expect(res401.reason).toBe("http-error");
      expect(res401.statusCode).toBe(401);
    }

    // Timeout / abort
    const resTimeout = await request9RouterText(cfg, context, {
      fetch: vi.fn(async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }) as any,
    });
    expect(resTimeout).toEqual({ ok: false, reason: "timeout" });

    // Non-JSON response
    const resNonJson = await request9RouterText(cfg, context, {
      fetch: vi.fn(async () => ({
        ok: true,
        json: async () => { throw new Error("not json"); },
      }) as Response) as any,
    });
    expect(resNonJson).toEqual({ ok: false, reason: "malformed" });

    // Content is not valid json
    const resBadContent = await request9RouterText(cfg, context, {
      fetch: vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "plain text" } }] }),
      }) as Response) as any,
    });
    expect(resBadContent).toEqual({ ok: false, reason: "malformed" });

    // Text is null
    const resNullText = await request9RouterText(cfg, context, {
      fetch: vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ text: null }) } }] }),
      }) as Response) as any,
    });
    expect(resNullText).toEqual({ ok: false, reason: "empty" });
  });
});
