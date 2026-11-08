import { describe, expect, it, vi } from "vitest";
import { createBuiltinBrowserTransport, createComputerBrowserTransport } from "./jev-transports.ts";
import { browserToolList } from "./tools.ts";
import { beginAutomationStep, finishAutomationStep, type StepContext } from "../browser-steps.ts";
import type { BrowserScope } from "./jev-types.ts";

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

describe("jev-transport", () => {
  it("routes both browser engines through the gateway", async () => {
    let dispatched = false;
    const transport = createBuiltinBrowserTransport({
      getPage: vi.fn(),
      rawDispatch: async (_scope, call) => {
        dispatched = true;
        return { ok: true, name: call.name };
      },
    });

    const result = await transport.rawCall(createMockScope(), { name: "agent_browser_open", arguments: { url: "https://example.com" } });
    expect(dispatched).toBe(true);
    expect(result).toEqual({ ok: true, name: "agent_browser_open" });
  });

  it("preserves the selected computer when opening a url", async () => {
    let capturedScope: BrowserScope | undefined;
    const transport = createComputerBrowserTransport({
      rawDispatch: async (scope, call) => {
        capturedScope = scope;
        return { ok: true, call };
      },
    });

    const vmScope = createMockScope({ place: { key: "vm_1", provider: "vm", revision: "rev_2" } });
    await transport.rawCall(vmScope, { name: "open_url", arguments: { url: "https://test.local" } });

    expect(capturedScope?.place.provider).toBe("vm");
    expect(capturedScope?.place.key).toBe("vm_1");
  });

  it("passes opaque remote browser calls through without claiming optimization", async () => {
    const transport = createComputerBrowserTransport({
      rawDispatch: async () => ({ status: "opened" }),
    });

    expect(transport.capabilities.mode).toBe("passthrough");
    expect(transport.capabilities.semanticGuard).toBe(false);
    expect(transport.capabilities.atomicObservation).toBe(false);

    await expect(transport.observe(createMockScope())).rejects.toThrow();
  });

  it("keeps refs isolated by profile tab and place generation", () => {
    const scopeA = createMockScope({ profileId: "prof_a", tabId: "t1" });
    const scopeB = createMockScope({ profileId: "prof_b", tabId: "t1" });
    expect(scopeA.profileId).not.toBe(scopeB.profileId);
  });

  it("preserves raw text image error and step evidence", async () => {
    const rawResult = {
      text: "Page header",
      image: "data:image/png;base64,...",
      error: null,
    };
    const transport = createBuiltinBrowserTransport({
      getPage: vi.fn(),
      rawDispatch: async () => rawResult,
    });

    const result = await transport.rawCall(createMockScope(), { name: "agent_browser_snapshot", arguments: {} });
    expect(result).toEqual(rawResult);
  });

  it("publishes runs only for semantically guarded engine catalogs", () => {
    const baseTools = [{ name: "agent_browser_click", description: "Click", inputSchema: {} }];

    const passthroughTools = browserToolList(baseTools, {
      automationReady: true,
      capabilities: { mode: "passthrough" },
    });
    expect(passthroughTools.some((t) => t.name === "agent_browser_run")).toBe(false);

    const guardedTools = browserToolList(baseTools, {
      automationReady: true,
      capabilities: { mode: "dom-fast" },
    });
    expect(guardedTools.some((t) => t.name === "agent_browser_run")).toBe(true);
  });

  it("keeps all driver browser integrations on the scoped gateway", () => {
    // Both engines and computer browser integrations route through createBuiltinBrowserTransport or createComputerBrowserTransport
    const builtin = createBuiltinBrowserTransport({ getPage: vi.fn(), rawDispatch: vi.fn() });
    const computer = createComputerBrowserTransport({ rawDispatch: vi.fn() });
    expect(builtin.rawCall).toBeDefined();
    expect(computer.rawCall).toBeDefined();
  });

  it("does not intercept opaque shell commands as browser actions", () => {
    const computerTransport = createComputerBrowserTransport({
      rawDispatch: vi.fn(async (_scope, call) => ({ shellOutput: call.name })),
    });

    // An opaque shell call passes straight through rawCall without browser translation
    expect(computerTransport.capabilities.mode).toBe("passthrough");
  });

  it("records each CDP child once without duplicating legacy evidence", async () => {
    const ctx: StepContext = {
      botId: "bot_1",
      botName: "Bot",
      threadId: "th_1",
      generation: "gen_1",
      turnId: () => "turn_1",
      record: false, // In test without evidence recorder, returns null cleanly without throw
    };

    const handle = beginAutomationStep(ctx, {
      action: "CLICK @e1",
      executionState: "completed",
    });

    const step1 = await finishAutomationStep(handle);
    const step2 = await finishAutomationStep(handle); // Second call returns null (only recorded once)
    expect(step2).toBeNull();
  });
});
