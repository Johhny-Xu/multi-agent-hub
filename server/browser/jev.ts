// Jev Browser Gateway: single dispatch seam for exact tools and bounded autonomous run loop.
import type { AppConfig } from "../config.ts";
import type { Decider } from "../decider/index.ts";
import { deciderBrowserTextModelOn, deciderJobOn, deciderReady } from "../decider/index.ts";
import type {
  BrowserExpectation,
  BrowserFailureReason,
  BrowserRunInput,
  BrowserRunResult,
  BrowserStepSummary,
} from "../../shared/browser-automation.ts";
import {
  buildBrowserActionSpace,
  buildBrowserQuestions,
  chooseBrowserAction,
} from "./jev-policy.ts";
import {
  acceptBrowserText,
  browserTextContext,
  clearBrowserText,
  getCachedText,
  getPendingTextMeta,
  request9RouterText,
  requestBrowserText,
} from "./jev-text.ts";
import type {
  BrowserHistoryEntry,
  BrowserObservation,
  BrowserPrimitive,
  BrowserScope,
  BrowserTransport,
  PreparedBrowserAction,
} from "./jev-types.ts";

export const DEFAULT_ACTIVE_BUDGET_MS = 12_000;
export const MAX_JEV_TIMEOUT_MS = 750;

export interface BrowserGatewayDeps {
  decider: Decider;
  config(): AppConfig;
  transport(scope: BrowserScope): BrowserTransport;
  authorize(scope: BrowserScope, primitive: BrowserPrimitive): Promise<"allow" | "refuse" | "pending">;
  recordStep?(handle: unknown, facts: unknown): void;
  now?(): number;
  fetch?: typeof fetch;
}

export interface BrowserGateway {
  call(scope: BrowserScope, call: BrowserPrimitive): Promise<unknown>;
  run(scope: BrowserScope, input: BrowserRunInput): Promise<BrowserRunResult>;
}

export async function verifyBrowserExpectations(
  scope: BrowserScope,
  expectations: readonly BrowserExpectation[],
  transport: BrowserTransport,
): Promise<boolean> {
  return transport.verify(scope, expectations);
}

export function createBrowserGateway(deps: BrowserGatewayDeps): BrowserGateway {
  const now = deps.now ?? Date.now;

  return {
    async call(scope: BrowserScope, call: BrowserPrimitive): Promise<unknown> {
      // Exact tools bypass Jev classification and observation completely.
      const auth = await deps.authorize(scope, call);
      if (auth !== "allow") {
        throw new Error(`Action not authorized: ${auth}`);
      }
      const transport = deps.transport(scope);
      return transport.rawCall(scope, call);
    },

    async run(scope: BrowserScope, input: BrowserRunInput): Promise<BrowserRunResult> {
      const cfg = deps.config();
      if (!deciderJobOn(cfg, "browserAutomation")) {
        return { status: "needs-agent", reason: "disabled", steps: [] };
      }
      if (!deciderReady(cfg, "browserAutomation")) {
        return { status: "needs-agent", reason: "not-ready", steps: [] };
      }

      if (scope.signal.aborted) {
        return { status: "interrupted", reason: "cancelled", steps: [] };
      }

      const transport = deps.transport(scope);
      if (transport.capabilities.mode === "passthrough") {
        return { status: "needs-agent", reason: "unsupported-observation", steps: [] };
      }

      const startTime = now();
      const meta = input.textReply ? getPendingTextMeta(scope, input.textReply.requestId) : null;
      let remainingSteps = meta?.remainingSteps ?? input.maxSteps ?? 4;
      let remainingBudgetMs = meta?.remainingBudgetMs ?? DEFAULT_ACTIVE_BUDGET_MS;
      const history: BrowserHistoryEntry[] = meta?.history ? [...meta.history] : [];
      const steps: BrowserStepSummary[] = [];

      while (remainingSteps > 0 && remainingBudgetMs > 0) {
        if (scope.signal.aborted) {
          return { status: "interrupted", reason: "cancelled", steps };
        }

        let observation: BrowserObservation;
        try {
          observation = await transport.observe(scope);
        } catch {
          return { status: "needs-agent", reason: "unsupported-observation", steps };
        }

        const space = buildBrowserActionSpace(observation);
        const batch = buildBrowserQuestions(input.goal, space, history.map((h) => h.action));

        const jevTimeout = Math.min(MAX_JEV_TIMEOUT_MS, remainingBudgetMs);
        const askResult = await deps.decider.ask(
          "browserAutomation",
          {
            goal: input.goal.slice(0, 2000),
            elements: space.elements.slice(0, 64),
            recentActions: history.slice(-6).map((h) => h.action),
          },
          batch.questions,
          { signal: scope.signal, timeoutMs: jevTimeout },
        );

        if (scope.signal.aborted) {
          return { status: "interrupted", reason: "cancelled", steps };
        }

        if (!askResult.ok) {
          return { status: "needs-agent", reason: "low-confidence", steps };
        }

        const choice = chooseBrowserAction(askResult, batch);
        if (!choice) {
          return { status: "needs-agent", reason: "low-confidence", steps };
        }

        if (choice.kind === "stop") {
          if (choice.operation === "BLOCKED") {
            return { status: "needs-agent", reason: "blocked", steps };
          }
          if (choice.operation === "DONE") {
            if (input.expect && input.expect.all.length > 0) {
              const verified = await transport.verify(scope, input.expect.all);
              if (verified) {
                return { status: "completed", steps };
              }
              return { status: "needs-agent", reason: "expectation-unmet", steps };
            }
            // Without explicit expect, DONE returns needs-agent with reason done-unverified
            return { status: "needs-agent", reason: "done-unverified", steps };
          }
        }

        let textToType: string | undefined;
        let chosenCandidate = undefined;

        if (choice.kind === "target") {
          chosenCandidate = batch.targetsByOp.get(choice.operation)?.get(choice.candidateId);
          if (!chosenCandidate) {
            return { status: "needs-agent", reason: "invalid-decision", steps };
          }

          if (choice.operation === "TYPE_TEXT") {
            const textCtx = browserTextContext(input.goal, chosenCandidate, observation, history);
            if (input.textReply) {
              const accepted = acceptBrowserText(scope, input.textReply, textCtx, chosenCandidate);
              if (accepted !== null) {
                textToType = accepted;
              }
            } else {
              const cached = getCachedText(scope, textCtx, chosenCandidate);
              if (cached !== null) {
                textToType = cached;
              }
            }

            let textModelFailureReason: BrowserFailureReason | undefined;
            if (textToType === undefined && deciderBrowserTextModelOn(cfg)) {
              const fetchImpl = deps.fetch ?? globalThis.fetch;
              const res = await request9RouterText(cfg, textCtx, {
                signal: scope.signal,
                timeoutMs: Math.min(5000, remainingBudgetMs),
                fetch: fetchImpl,
              });
              if (res.ok) {
                textToType = res.text;
              } else {
                textModelFailureReason = "text-model-failed";
              }
            }

            if (textToType === undefined) {
              const elapsed = now() - startTime;
              const pendingField = requestBrowserText(scope, textCtx, chosenCandidate, {
                remainingSteps,
                remainingBudgetMs: Math.max(0, remainingBudgetMs - elapsed),
                history,
              });
              return {
                status: "needs-input",
                ...(textModelFailureReason ? { reason: textModelFailureReason } : {}),
                pendingField,
                steps,
                lastObservation: {
                  title: observation.title,
                  origin: observation.origin,
                  stateText: observation.stateText.slice(0, 500),
                  candidateCount: space.elements.length,
                },
              };
            }
          }
        }

        // Prepare action
        let prepared: PreparedBrowserAction;
        try {
          prepared = await transport.prepare(scope, observation, choice, textToType);
        } catch {
          return { status: "needs-agent", reason: "stale-observation", steps };
        }

        // Authorize sub-action
        const auth = await deps.authorize(scope, prepared.call);
        if (auth === "refuse") {
          return { status: "needs-agent", reason: "permission-denied", steps };
        }
        if (auth === "pending") {
          return { status: "needs-agent", reason: "permission-required", steps };
        }

        // Execute action
        const execution = await transport.execute(scope, prepared);

        if (execution.state === "not-dispatched") {
          return { status: "needs-agent", reason: "stale-observation", steps };
        }

        if (execution.state === "unknown") {
          steps.push({
            stepNumber: steps.length + 1,
            action: prepared.call.name,
            state: "unknown",
          });
          clearBrowserText(scope);
          return { status: "uncertain", reason: "unknown-outcome", steps };
        }

        // Completed
        steps.push({
          stepNumber: steps.length + 1,
          action: prepared.call.name,
          state: "completed",
        });

        history.push({
          action: prepared.call.name,
          kind: choice.operation,
          pageChanged: true,
          redactedText: textToType ? "[redacted]" : undefined,
        });

        if (textToType) {
          clearBrowserText(scope);
        }

        remainingSteps--;
        const elapsed = now() - startTime;
        remainingBudgetMs = Math.max(0, DEFAULT_ACTIVE_BUDGET_MS - elapsed);
      }

      if (remainingBudgetMs <= 0) {
        return { status: "needs-agent", reason: "budget", steps };
      }

      return { status: "needs-agent", reason: "no-progress", steps };
    },
  };
}
