// The browser automation seam between the host and Jev: which browsers are offered the run tool, and how a stopped
// turn's signal reaches the run loop and the dispatch underneath it.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import type { Decider } from "../decider/index.ts";
import type { Store } from "../store.ts";
import { createBrowserHost } from "./browser.ts";
import { createBrowserGateway, type BrowserGatewayDeps } from "../browser/jev.ts";
import type { BrowserExecution, BrowserObservation, BrowserScope, BrowserTransport } from "../browser/jev-types.ts";

type Host = ReturnType<typeof createBrowserHost>;
const hosts: Host[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.browserRuntime.closeAll()));
});

const turn = { threadId: "thread-1", generation: "gen-1" };

function host(decider: NonNullable<AppConfig["decider"]>) {
  const cfg = { features: { browser: true }, browserEngine: { engine: "chrome" }, decider } as unknown as AppConfig;
  const bot = { id: "scout", name: "scout", browser: true };
  const created = createBrowserHost({
    cfg,
    store: () => ({ bots: [bot], bot: () => bot, botByThread: () => bot }) as unknown as Pick<Store, "bots" | "bot" | "botByThread">,
    turnResources: { free: () => true, holder: () => undefined, onClaim: () => () => {} },
    activeInternalGenerationByThread: new Map([[turn.threadId, turn.generation]]),
    mintInternalCapability: () => "capability-token",
    DESKTOP_MANAGED: true,
    CLOUD_HOME: null,
    PORT: 4100,
    decider: {} as Decider,
  });
  hosts.push(created);
  return created;
}

const JEV = { enabled: true, key: "tsk_fixture", jobs: { browserAutomation: true } } as NonNullable<AppConfig["decider"]>;

async function toolNames(created: Host): Promise<string[]> {
  const browser = (await created.browserIntegration("scout", undefined, turn))!;
  const listing = await created.browserRuntime.agentRpc(browser.session, browser.spec as never, "tools/list", {}) as { tools: Array<{ name: string }> };
  return listing.tools.map((tool) => tool.name);
}

describe("which browsers are offered the automation run", () => {
  it("offers it where Jev's own key can answer the browser seam", async () => {
    expect(await toolNames(host(JEV))).toContain("agent_browser_run");
  });

  it("never offers it to a Gemini-only decision model, which the seam refuses", async () => {
    expect(await toolNames(host({ enabled: true, provider: "gemini", geminiKey: "gemini-fixture", jobs: { browserAutomation: true } } as NonNullable<AppConfig["decider"]>)))
      .not.toContain("agent_browser_run");
  });

  it("never offers it to a custom gateway, which the seam refuses", async () => {
    expect(await toolNames(host({ enabled: true, provider: "custom", customKey: "custom-fixture", customBaseUrl: "https://gw.example.com/v1", jobs: { browserAutomation: true } } as NonNullable<AppConfig["decider"]>)))
      .not.toContain("agent_browser_run");
  });

  it("is not offered with the job off or the decision model switched off", async () => {
    expect(await toolNames(host({ ...JEV, jobs: { browserAutomation: false } }))).not.toContain("agent_browser_run");
    expect(await toolNames(host({ ...JEV, enabled: false }))).not.toContain("agent_browser_run");
  });
});

function observation(): BrowserObservation {
  return {
    id: "obs_1",
    tabId: "tab_1",
    documentEpoch: "epoch_1",
    origin: "https://example.com",
    title: "Example",
    stateText: "Form page",
    candidates: [{ id: "c1", elementId: "el_1", operation: "CLICK", role: "button", label: "Submit" }],
    controls: [],
    guardId: "g_1",
    truncated: false,
    omittedCandidates: 0,
  };
}

function gatewayFixture(controller: AbortController, options: { abortAfterDecision?: boolean; abortAfterAction?: number }) {
  const seen: AbortSignal[] = [];
  let executes = 0;
  const transport: BrowserTransport = {
    capabilities: { mode: "dom-fast", operations: ["CLICK"], semanticGuard: true, atomicObservation: true },
    rawCall: vi.fn(async () => ({})),
    observe: vi.fn(async () => observation()),
    verify: vi.fn(async () => true),
    prepare: vi.fn(async () => ({ ticket: "tk_1", call: { name: "agent_browser_click", arguments: {} } })),
    execute: vi.fn(async (scope: BrowserScope): Promise<BrowserExecution> => {
      executes++;
      seen.push(scope.signal);
      if (executes === options.abortAfterAction) controller.abort();
      return { state: "completed", result: {}, postObservation: "ok" };
    }),
  };
  const ask = vi.fn(async () => {
    if (options.abortAfterDecision) controller.abort();
    return { ok: true, provider: "jev", answers: { operation: { type: "choice", choice: "CLICK", pTop: 0.95, margin: 0.3 } } };
  });
  const deps: BrowserGatewayDeps = {
    decider: { ask } as unknown as Decider,
    config: () => ({ decider: { enabled: true, key: "tsk_fixture", jobs: { browserAutomation: true } } } as AppConfig),
    transport: () => transport,
    authorize: async () => "allow",
  };
  const scope: BrowserScope = {
    botId: "scout", conversationId: "thread-1", sessionId: "sess_1", profileId: "prof_1",
    turnGeneration: "gen-1", tabId: null, place: { key: "builtin", provider: "builtin", revision: "1" },
    signal: controller.signal,
  };
  return { gateway: createBrowserGateway(deps), scope, seen, executes: () => executes };
}

describe("a stopped turn stops the run", () => {
  it("runs nothing when the turn's signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const created = host(JEV);
    const browser = (await created.browserIntegration("scout", undefined, turn))!;
    const result = await created.browserRuntime.agentRpc(
      browser.session, browser.spec as never, "tools/call",
      { name: "agent_browser_run", arguments: { goal: "Click login" } },
      undefined,
      { botId: "scout", botName: "scout", ...turn, turnId: () => null, record: false, signal: controller.signal },
    ) as { isError?: true; content: Array<{ type: "text"; text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("cancelled");
  });

  it("does not act when the signal is aborted while the decision model answers", async () => {
    const controller = new AbortController();
    const f = gatewayFixture(controller, { abortAfterDecision: true });

    const result = await f.gateway.run(f.scope, { goal: "Click", maxSteps: 4 });

    expect(result.status).toBe("interrupted");
    expect(result.reason).toBe("cancelled");
    expect(f.executes()).toBe(0);
  });

  it("stops between two actions, handing the transport the turn's own signal", async () => {
    const controller = new AbortController();
    const f = gatewayFixture(controller, { abortAfterAction: 1 });

    const result = await f.gateway.run(f.scope, { goal: "Click", maxSteps: 4 });

    expect(result.status).toBe("interrupted");
    expect(f.executes()).toBe(1);
    expect(f.seen[0]).toBe(controller.signal);
  });
});
