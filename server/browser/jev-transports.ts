// Browser transports for Jev automation: builtin CDP engine (dom-fast) and computer/remote adapter (passthrough/guarded).
import { randomUUID } from "node:crypto";
import type { BrowserExpectation } from "../../shared/browser-automation.ts";
import { readJevObservation, resolveJevTarget, validateJevObservation } from "./cdp/jev-observation.ts";
import type { CdpPage } from "./cdp/page.ts";
import type {
  BrowserChoice,
  BrowserExecution,
  BrowserObservation,
  BrowserPrimitive,
  BrowserScope,
  BrowserTransport,
  BrowserTransportCapabilities,
  PreparedBrowserAction,
} from "./jev-types.ts";

export interface BuiltinTransportDeps {
  getPage(scope: BrowserScope): Promise<CdpPage>;
  rawDispatch(scope: BrowserScope, call: BrowserPrimitive): Promise<unknown>;
}

export interface ComputerTransportDeps {
  catalog?: readonly string[];
  rawDispatch(scope: BrowserScope, call: BrowserPrimitive): Promise<unknown>;
  capabilities?: Partial<BrowserTransportCapabilities>;
}

export function createBuiltinBrowserTransport(deps: BuiltinTransportDeps): BrowserTransport {
  const issuedTickets = new Map<string, { scope: BrowserScope; call: BrowserPrimitive }>();

  const capabilities: BrowserTransportCapabilities = {
    mode: "dom-fast",
    operations: ["CLICK", "TYPE_TEXT", "SELECT", "SCROLL_UP", "SCROLL_DOWN", "WAIT", "DONE", "BLOCKED"],
    semanticGuard: true,
    atomicObservation: true,
  };

  return {
    capabilities,

    async rawCall(scope: BrowserScope, call: BrowserPrimitive): Promise<unknown> {
      return deps.rawDispatch(scope, call);
    },

    async observe(scope: BrowserScope): Promise<BrowserObservation> {
      const page = await deps.getPage(scope);
      return readJevObservation(page, scope);
    },

    async verify(scope: BrowserScope, expectations: readonly BrowserExpectation[]): Promise<boolean> {
      const page = await deps.getPage(scope);
      const obs = await readJevObservation(page, scope);
      // CdpPage.url() is the live document URL; an empty one (page not yet committed) falls back to the observed origin.
      const currentUrl = page.url() || obs.origin;

      for (const exp of expectations) {
        if (exp.kind === "visible-text") {
          if (!obs.stateText.toLowerCase().includes(exp.text.toLowerCase())) {
            return false;
          }
        } else if (exp.kind === "url-path") {
          try {
            const parsed = new URL(currentUrl);
            if (parsed.origin !== exp.origin || parsed.pathname !== exp.pathname) {
              return false;
            }
          } catch {
            return false;
          }
        } else if (exp.kind === "field-state") {
          const matching = obs.candidates.filter(
            (c) => c.role.toLowerCase() === exp.role.toLowerCase() && c.label.toLowerCase() === exp.label.toLowerCase(),
          );
          if (matching.length !== 1) return false;
          const candidate = matching[0]!;
          if (exp.value !== undefined && candidate.value !== exp.value) return false;
          if (exp.checked !== undefined && candidate.checked !== exp.checked) return false;
          if (exp.selected !== undefined && candidate.selected !== exp.selected) return false;
        }
      }
      return true;
    },

    async prepare(
      scope: BrowserScope,
      observation: BrowserObservation,
      choice: BrowserChoice,
      text?: string,
    ): Promise<PreparedBrowserAction> {
      const page = await deps.getPage(scope);

      let call: BrowserPrimitive;

      if (choice.kind === "control") {
        if (choice.operation === "SCROLL_DOWN") {
          call = { name: "agent_browser_scroll", arguments: { direction: "down", amount: 560 } };
        } else if (choice.operation === "SCROLL_UP") {
          call = { name: "agent_browser_scroll", arguments: { direction: "up", amount: 560 } };
        } else if (choice.operation === "WAIT") {
          call = { name: "agent_browser_wait", arguments: { ms: 100 } };
        } else {
          throw new Error(`Unsupported control operation: ${choice.operation}`);
        }
      } else if (choice.kind === "target") {
        const candidate = observation.candidates.find((c) => c.id === choice.candidateId);
        if (!candidate) {
          throw new Error(`Candidate ${choice.candidateId} not found in observation`);
        }

        const valid = await validateJevObservation(page, observation.guardId, candidate.elementId);
        if (!valid) {
          throw new Error("Semantic guard failed: DOM state changed");
        }

        const { ref } = await resolveJevTarget(page, observation.id, candidate.elementId);

        if (choice.operation === "CLICK") {
          call = { name: "agent_browser_click", arguments: { ref: `@${ref}` } };
        } else if (choice.operation === "TYPE_TEXT") {
          call = { name: "agent_browser_fill", arguments: { ref: `@${ref}`, text: text ?? "" } };
        } else if (choice.operation === "SELECT") {
          call = { name: "agent_browser_select", arguments: { ref: `@${ref}`, values: [candidate.optionId || candidate.value || ""] } };
        } else {
          throw new Error(`Unsupported target operation: ${choice.operation}`);
        }
      } else {
        throw new Error(`Cannot prepare action for stop choice: ${choice.operation}`);
      }

      const ticket = "tk_" + randomUUID().replace(/-/g, "").slice(0, 16);
      issuedTickets.set(ticket, { scope, call });

      return { ticket, call };
    },

    async execute(scope: BrowserScope, action: PreparedBrowserAction): Promise<BrowserExecution> {
      const issued = issuedTickets.get(action.ticket);
      if (!issued) {
        return { state: "not-dispatched", reason: "invalid-ticket" };
      }
      issuedTickets.delete(action.ticket);

      if (issued.scope.turnGeneration !== scope.turnGeneration) {
        return { state: "not-dispatched", reason: "stale-generation" };
      }

      try {
        const result = await deps.rawDispatch(scope, action.call);
        return { state: "completed", result, postObservation: "ok" };
      } catch (error) {
        return { state: "unknown", result: error };
      }
    },
  };
}

export function createComputerBrowserTransport(deps: ComputerTransportDeps): BrowserTransport {
  const capabilities: BrowserTransportCapabilities = {
    mode: "passthrough",
    operations: [],
    semanticGuard: false,
    atomicObservation: false,
    ...deps.capabilities,
  };

  return {
    capabilities,

    async rawCall(scope: BrowserScope, call: BrowserPrimitive): Promise<unknown> {
      return deps.rawDispatch(scope, call);
    },

    async observe(): Promise<BrowserObservation> {
      throw new Error("Computer browser does not support fast DOM observation; use standard computer tools");
    },

    async verify(): Promise<boolean> {
      return false;
    },

    async prepare(): Promise<PreparedBrowserAction> {
      throw new Error("Computer browser does not support run preparation");
    },

    async execute(): Promise<BrowserExecution> {
      throw new Error("Computer browser does not support run execution");
    },
  };
}
