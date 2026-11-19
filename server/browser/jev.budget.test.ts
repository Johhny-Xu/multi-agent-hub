// A continuation spends only the budget its saved meta holds: each stretch is charged the time it used, so a run that
// paused for text can never win back the default twelve seconds, and several actions in one stretch pay once each.
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import type { Decider } from "../decider/index.ts";
import { createBrowserGateway, DEFAULT_ACTIVE_BUDGET_MS, type BrowserGatewayDeps } from "./jev.ts";
import type { BrowserExecution, BrowserObservation, BrowserScope, BrowserTransport } from "./jev-types.ts";

const CONFIG = {
  decider: { enabled: true, key: "tsk_fixture", jobs: { browserAutomation: true, browserTextModel: false } },
} as unknown as AppConfig;

function scope(botId: string): BrowserScope {
  return {
    botId,
    conversationId: "conv_1",
    sessionId: "sess_1",
    profileId: "prof_1",
    turnGeneration: "gen_1",
    tabId: "tab_1",
    place: { key: "builtin", provider: "builtin", revision: "1" },
    signal: new AbortController().signal,
  };
}

function observation(): BrowserObservation {
  return {
    id: "obs_1",
    tabId: "tab_1",
    documentEpoch: "epoch_1",
    origin: "https://example.com",
    title: "Example",
    stateText: "Form page",
    candidates: [
      { id: "c1", elementId: "el_1", operation: "CLICK", role: "button", label: "Submit" },
      { id: "c2", elementId: "el_2", operation: "TYPE_TEXT", role: "textbox", label: "Name" },
    ],
    controls: [],
    guardId: "g_1",
    truncated: false,
    omittedCandidates: 0,
  };
}

function fixture(options: { decisionMs: number; actionMs: number; choices: Array<"CLICK" | "TYPE_TEXT"> }) {
  let clock = 1_000_000;
  let executes = 0;
  const script = [...options.choices];
  const ask = vi.fn(async (_job: unknown, _input: unknown, _questions: unknown, askOptions?: { timeoutMs?: number }) => {
    const timeout = askOptions?.timeoutMs ?? options.decisionMs;
    const waited = Math.min(options.decisionMs, timeout);
    clock += waited;
    if (waited < options.decisionMs) return { ok: false, reason: "timeout" };
    return {
      ok: true,
      provider: "jev",
      answers: { operation: { type: "choice", choice: script.shift() ?? "CLICK", pTop: 0.95, margin: 0.3 } },
    };
  });
  const transport: BrowserTransport = {
    capabilities: { mode: "dom-fast", operations: ["CLICK", "TYPE_TEXT"], semanticGuard: true, atomicObservation: true },
    rawCall: vi.fn(async () => ({})),
    observe: vi.fn(async () => observation()),
    verify: vi.fn(async () => true),
    prepare: vi.fn(async (_scope, _observation, choice) => ({
      ticket: "tk_1",
      call: { name: choice.operation === "TYPE_TEXT" ? "agent_browser_fill" : "agent_browser_click", arguments: {} },
    })),
    execute: vi.fn(async (): Promise<BrowserExecution> => {
      executes++;
      clock += options.actionMs;
      return { state: "completed", result: {}, postObservation: "ok" };
    }),
  };
  const deps: BrowserGatewayDeps = {
    decider: { ask } as unknown as Decider,
    config: () => CONFIG,
    transport: () => transport,
    authorize: async () => "allow",
    now: () => clock,
  };
  return {
    gateway: createBrowserGateway(deps),
    transport,
    executes: () => executes,
    setActionMs: (ms: number) => { options.actionMs = ms; },
    setChoices: (choices: Array<"CLICK" | "TYPE_TEXT">) => { script.splice(0, script.length, ...choices); },
  };
}

describe("the browser run's active time budget", () => {
  it("gives a new run twelve seconds and stops when they are spent, before another action", async () => {
    const f = fixture({ decisionMs: 100, actionMs: 2_900, choices: [] });

    const result = await f.gateway.run(scope("budget-default"), { goal: "Click", maxSteps: 8 });

    expect(result.status).toBe("needs-agent");
    expect(result.reason).toBe("budget");
    expect(f.executes()).toBe(4);
    expect(4 * (100 + 2_900)).toBe(DEFAULT_ACTIVE_BUDGET_MS);
  });

  it("continues from the saved budget instead of the default after a pause for text", async () => {
    const f = fixture({ decisionMs: 100, actionMs: 2_900, choices: ["CLICK", "CLICK", "CLICK", "TYPE_TEXT"] });
    const first = await f.gateway.run(scope("budget-continue"), { goal: "Fill", maxSteps: 8 });
    expect(first.status).toBe("needs-input");
    expect(first.pendingField?.requestId).toBeTruthy();

    f.setActionMs(1_000);
    f.setChoices(["TYPE_TEXT"]);
    const second = await f.gateway.run(scope("budget-continue"), {
      goal: "Fill", maxSteps: 8, textReply: { requestId: first.pendingField!.requestId, value: { text: "Ada" } },
    });

    // 2 900 ms were left: the fill and two clicks at 1 100 ms each spend it; a fourth action never starts.
    expect(second.status).toBe("needs-agent");
    expect(second.reason).toBe("budget");
    expect(f.executes()).toBe(6);
  });

  it("charges each action its own time, not the stretch's time again", async () => {
    const f = fixture({ decisionMs: 100, actionMs: 2_900, choices: ["CLICK", "CLICK", "TYPE_TEXT"] });
    const first = await f.gateway.run(scope("budget-each"), { goal: "Fill", maxSteps: 8 });
    expect(first.status).toBe("needs-input");

    f.setActionMs(1_000);
    f.setChoices(["TYPE_TEXT", "CLICK", "CLICK", "CLICK", "CLICK", "CLICK", "CLICK"]);
    const second = await f.gateway.run(scope("budget-each"), {
      goal: "Fill", maxSteps: 8, textReply: { requestId: first.pendingField!.requestId, value: { text: "Ada" } },
    });

    // 5 900 ms left at 1 100 ms an action: six actions, not three (which a cumulative deduction would allow).
    expect(second.reason).toBe("budget");
    expect(f.executes()).toBe(8);
  });

  it("carries the remainder into a second continuation, which stops as soon as it is spent", async () => {
    const f = fixture({ decisionMs: 100, actionMs: 2_900, choices: ["CLICK", "CLICK", "CLICK", "TYPE_TEXT"] });
    const first = await f.gateway.run(scope("budget-twice"), { goal: "Fill", maxSteps: 8 });
    expect(first.status).toBe("needs-input");

    f.setActionMs(1_000);
    f.setChoices(["TYPE_TEXT", "CLICK", "TYPE_TEXT"]);
    const second = await f.gateway.run(scope("budget-twice"), {
      goal: "Fill", maxSteps: 8, textReply: { requestId: first.pendingField!.requestId, value: { text: "Ada" } },
    });
    expect(second.status).toBe("needs-input");
    expect(second.pendingField?.requestId).toBeTruthy();

    const before = f.executes();
    f.setChoices(["TYPE_TEXT", "CLICK", "CLICK"]);
    const third = await f.gateway.run(scope("budget-twice"), {
      goal: "Fill", maxSteps: 8, textReply: { requestId: second.pendingField!.requestId, value: { text: "Grace" } },
    });

    // 600 ms were left: the fill spends them, and no click follows.
    expect(third.reason).toBe("budget");
    expect(f.executes() - before).toBe(1);
  });
});
