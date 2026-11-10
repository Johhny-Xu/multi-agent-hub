// The runtime router's agent_browser_run: what tools/list offers, the authorization chain a run goes through, and its
// answer as the bot reads it. All with a fake chrome engine and a fake gateway; no browser runs here.
import { describe, expect, it, vi } from "vitest";

import type { BrowserRunResult } from "../../shared/browser-automation.ts";
import type { BrowserRuntime } from "../browser-runtime.ts";
import { CHROME_ENGINE, RuntimeRouter, type ChromeEngine, type RuntimeRouterOptions } from "./engines.ts";
import type { BrowserScope } from "./jev-types.ts";

const AGENT_BROWSER = { command: "/opt/agent-browser", args: ["--session", "s"], env: { AGENT_BROWSER_SESSION: "s" } };
const CHROME = { command: CHROME_ENGINE, args: ["bot:a"], env: {} };
const BASE_TOOLS = [{ name: "agent_browser_open", description: "Open a page.", inputSchema: { type: "object" } }];
const COMPLETED: BrowserRunResult = { status: "completed", steps: [{ stepNumber: 1, action: "agent_browser_click", state: "completed" }] };
const CALL = { name: "agent_browser_run", arguments: { goal: "Search flights and submit the form" } };

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | null)?.content ?? [];
  return content.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("\n");
}

function jevEngines({
  ready = true,
  gateway = true,
  run = async () => COMPLETED,
  ...options
}: {
  ready?: boolean;
  gateway?: boolean;
  run?: (scope: BrowserScope, input: unknown) => Promise<BrowserRunResult>;
} & RuntimeRouterOptions = {}) {
  const old = {
    agentRpc: vi.fn(async () => "agent-browser"),
    previewFrame: vi.fn(async (_session: string, capture: () => Promise<unknown>) => capture()),
    withSecretInput: vi.fn(async (_session: string, fn: () => Promise<unknown>) => fn()),
    heldBy: vi.fn((): string | null => null),
    interrupted: vi.fn(() => false),
    interruptedCount: vi.fn(() => 0),
    closeIfIdle: vi.fn(async () => true),
    close: vi.fn(async () => undefined),
    closeAll: vi.fn(async () => undefined),
  };
  const chrome = {
    service: {
      agentRpc: vi.fn(async (_target: unknown, method: string) => method === "tools/list" ? { tools: BASE_TOOLS.map((tool) => ({ ...tool })) } : "chrome"),
      previewFrame: vi.fn(async () => ({ png: "frame", format: "jpeg" })),
      withSecretInput: vi.fn(async (_target: unknown, fn: () => Promise<unknown>) => fn()),
      heldBy: vi.fn((): string | null => null),
      interrupted: vi.fn(() => false),
      interruptedCount: vi.fn(() => 0),
      close: vi.fn(async () => undefined),
      closeAll: vi.fn(async () => undefined),
    },
    live: { open: vi.fn(async () => undefined), action: vi.fn(async () => "chrome"), has: vi.fn(() => false), handBack: vi.fn(), closeForSession: vi.fn(), closeForOwner: vi.fn(), closeForBot: vi.fn(), closeAll: vi.fn() },
    stream: { open: vi.fn(), closeForSession: vi.fn(), closeForOwner: vi.fn(), closeForBot: vi.fn(), closeAll: vi.fn(), recheck: vi.fn() },
    close: vi.fn(async () => undefined),
  };
  const fakeGateway = { call: vi.fn(async () => undefined), run: vi.fn(run) };
  const jev = {
    automationReady: vi.fn(() => ready),
    gateway: vi.fn(() => (gateway ? fakeGateway : null)),
    scope: vi.fn((session: string, _spec: { command: string }, ctx?: { botId?: string; threadId?: string; generation?: string }): BrowserScope => ({
      botId: ctx?.botId ?? "scout",
      conversationId: ctx?.threadId ?? "thread-1",
      sessionId: session,
      profileId: "bot:a",
      turnGeneration: ctx?.generation ?? "gen-1",
      tabId: null,
      place: { key: "builtin", provider: "builtin", revision: "1" },
      signal: new AbortController().signal,
    })),
  };
  const runtime = new RuntimeRouter(old as unknown as BrowserRuntime, chrome as unknown as ChromeEngine, { ...options, jev });
  return { old, chrome, runtime, jev, gateway: fakeGateway };
}

describe("the runtime router's agent_browser_run", () => {
  it("offers agent_browser_run in a new-engine session's tools/list while automation is ready", async () => {
    const { chrome, runtime } = jevEngines();
    const listing = (await runtime.agentRpc("s", CHROME, "tools/list", {})) as { tools: Array<{ name: string }> };
    expect(chrome.service.agentRpc).toHaveBeenCalledOnce();
    expect(listing.tools.map((tool) => tool.name)).toEqual(["agent_browser_open", "agent_browser_run"]);
  });

  it("offers no run tool when automation is off, the gateway is none, or the session runs on agent-browser", async () => {
    for (const broken of [{ ready: false }, { gateway: false }]) {
      const { runtime } = jevEngines(broken);
      const listing = (await runtime.agentRpc("s", CHROME, "tools/list", {})) as { tools: Array<{ name: string }> };
      expect(listing.tools.map((tool) => tool.name), JSON.stringify(broken)).toEqual(["agent_browser_open"]);
    }
    const { old, runtime } = jevEngines();
    await expect(runtime.agentRpc("s", AGENT_BROWSER, "tools/list", {})).resolves.toBe("agent-browser");
    expect(old.agentRpc).toHaveBeenCalledOnce();
  });

  it("answers a run from the gateway with the scope it asked for, after dispatch claimed the turn", async () => {
    const order: string[] = [];
    const { chrome, gateway, runtime } = jevEngines({ run: async (scope, input) => {
      order.push(`run ${scope.botId} ${scope.conversationId} ${scope.sessionId} ${scope.turnGeneration} ${(input as { goal: string }).goal}`);
      return COMPLETED;
    } });
    const ctx = { botId: "scout", botName: "Scout", threadId: "thread-9", generation: "gen-9", turnId: () => null, record: false };
    const result = await runtime.agentRpc("s", CHROME, "tools/call", CALL, () => order.push("dispatch"), ctx);
    expect(order).toEqual(["dispatch", "run scout thread-9 s gen-9 Search flights and submit the form"]);
    expect(chrome.service.agentRpc, "the run never reaches the engine's own tools/call").not.toHaveBeenCalled();
    expect(gateway.run).toHaveBeenCalledWith(expect.objectContaining({ botId: "scout", conversationId: "thread-9", sessionId: "s", profileId: "bot:a", turnGeneration: "gen-9" }),
      { goal: "Search flights and submit the form", maxSteps: 4 });
    expect(textOf(result)).toContain("completed");
    expect(textOf(result)).toContain("agent_browser_click");
    expect((result as { isError?: boolean }).isError).toBeUndefined();
  });

  it("answers a refused run from the refusal alone, without claiming or reaching the gateway", async () => {
    const { chrome, gateway, runtime } = jevEngines({ refusal: () => "Not this conversation." });
    await expect(runtime.agentRpc("s", CHROME, "tools/call", CALL)).resolves.toEqual({ isError: true, content: [{ type: "text", text: "Not this conversation." }] });
    expect(gateway.run).not.toHaveBeenCalled();
    expect(chrome.service.agentRpc).not.toHaveBeenCalled();
  });

  it("stops a run the afterClaim refuses, after the claim and before the gateway", async () => {
    const { gateway, runtime } = jevEngines({ afterClaim: () => "another thread is using this browser" });
    const dispatched: boolean[] = [];
    await expect(runtime.agentRpc("s", CHROME, "tools/call", CALL, () => dispatched.push(true)))
      .resolves.toEqual({ isError: true, content: [{ type: "text", text: "another thread is using this browser" }] });
    expect(dispatched).toEqual([true]);
    expect(gateway.run).not.toHaveBeenCalled();
  });

  it("tells a run whose gateway is none that the tool is not offered, and claims nothing", async () => {
    const { runtime } = jevEngines({ gateway: false });
    const dispatched: boolean[] = [];
    const result = await runtime.agentRpc("s", CHROME, "tools/call", CALL, () => dispatched.push(true));
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain("not offered");
    expect(dispatched).toEqual([]);
  });

  it("answers what is wrong with arguments it cannot use, without reaching the gateway", async () => {
    const { gateway, runtime } = jevEngines();
    for (const args of [{}, { goal: "" }, { goal: "g", extra: true }]) {
      const result = await runtime.agentRpc("s", CHROME, "tools/call", { name: "agent_browser_run", arguments: args });
      expect((result as { isError?: boolean }).isError, JSON.stringify(args)).toBe(true);
      expect(textOf(result)).toContain("agent_browser_run got arguments it cannot use");
    }
    expect(gateway.run).not.toHaveBeenCalled();
  });

  it("reads a run's outcome as text: a stopped reason, the field waiting for text, and an unknown outcome as an error", async () => {
    const stopped = jevEngines({ run: async () => ({ status: "needs-agent", reason: "budget", steps: [] }) });
    const stop = await stopped.runtime.agentRpc("s", CHROME, "tools/call", CALL);
    expect(textOf(stop)).toContain("step or time budget");
    expect((stop as { isError?: boolean }).isError).toBeUndefined();

    const field = jevEngines({ run: async () => ({
      status: "needs-input",
      steps: [],
      pendingField: {
        requestId: "req_abc",
        field: { label: "Email", role: "textbox" },
        context: { goal: "g", field: { label: "Email", role: "textbox" }, page: { title: "Sign in", origin: "https://example.com" }, recentActions: [] },
        instruction: 'Answer as strict JSON: {"text": "value"} or {"text": null}.',
      },
    }) });
    const asked = await field.runtime.agentRpc("s", CHROME, "tools/call", CALL);
    expect(textOf(asked)).toContain("req_abc");
    expect(textOf(asked)).toContain("textbox");
    expect(textOf(asked)).toContain("textReply");
    expect((asked as { isError?: boolean }).isError).toBeUndefined();

    const uncertain = jevEngines({ run: async () => ({ status: "uncertain", reason: "unknown-outcome", steps: [] }) });
    const unknown = await uncertain.runtime.agentRpc("s", CHROME, "tools/call", CALL);
    expect(textOf(unknown)).toContain("outcome unknown");
    expect((unknown as { isError?: boolean }).isError).toBe(true);
  });

  it("sends a run's answer through annotate and afterCall like every other tool call", async () => {
    const { runtime } = jevEngines({
      annotate: (_spec, result) => ({ annotated: result }),
      afterCall: (_session, _spec, result) => ({ after: result }),
    });
    const result = await runtime.agentRpc("s", CHROME, "tools/call", CALL);
    expect(result).toEqual({ after: { annotated: { content: [{ type: "text", text: expect.any(String) }] } } });
  });
});
