// Internal contracts and domain types for Jev browser integration in OpenMausBot.
import type { BrowserExpectation } from "../../shared/browser-automation.ts";
import type { DeciderQuestion } from "../decider/types.ts";

export type BrowserPlaceProvider = "builtin" | "local" | "vm" | "boat" | "vps-ssh" | "simular-box";

export interface BrowserPlace {
  readonly key: string;
  readonly provider: BrowserPlaceProvider;
  readonly revision: string;
}

export interface BrowserScope {
  readonly botId: string;
  readonly conversationId: string;
  readonly sessionId: string;
  readonly profileId: string;
  readonly turnGeneration: string;
  readonly tabId: string | null;
  readonly place: BrowserPlace;
  readonly signal: AbortSignal;
}

export type BrowserOperation =
  | "CLICK"
  | "TYPE_TEXT"
  | "SELECT"
  | "SCROLL_UP"
  | "SCROLL_DOWN"
  | "WAIT"
  | "DONE"
  | "BLOCKED";

export type TargetOperation = "CLICK" | "TYPE_TEXT" | "SELECT";

export interface BrowserPrimitive {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface BrowserCandidate {
  readonly id: string;
  readonly elementId: string;
  readonly operation: TargetOperation;
  readonly role: string;
  readonly label: string;
  readonly value?: string;
  readonly checked?: boolean | "mixed";
  readonly selected?: boolean;
  readonly expanded?: boolean;
  readonly optionId?: string;
}

export interface BrowserObservation {
  readonly id: string;
  readonly tabId: string;
  readonly documentEpoch: string;
  readonly origin: string;
  readonly title: string;
  readonly stateText: string;
  readonly candidates: readonly BrowserCandidate[];
  readonly controls: readonly BrowserOperation[];
  readonly guardId: string;
  readonly truncated: boolean;
  readonly omittedCandidates: number;
}

export type BrowserChoice =
  | { readonly kind: "target"; readonly operation: TargetOperation; readonly candidateId: string }
  | { readonly kind: "control"; readonly operation: "SCROLL_UP" | "SCROLL_DOWN" | "WAIT" }
  | { readonly kind: "stop"; readonly operation: "DONE" | "BLOCKED" };

export interface PreparedBrowserAction {
  readonly ticket: string;
  readonly call: BrowserPrimitive;
}

export type BrowserExecution =
  | { readonly state: "not-dispatched"; readonly reason: string }
  | { readonly state: "completed"; readonly result: unknown; readonly postObservation: "ok" | "failed" }
  | { readonly state: "unknown"; readonly result: unknown };

export interface BrowserTransportCapabilities {
  readonly mode: "dom-fast" | "guarded" | "passthrough";
  readonly operations: readonly BrowserOperation[];
  readonly semanticGuard: boolean;
  readonly atomicObservation: boolean;
}

export interface BrowserTransport {
  readonly capabilities: BrowserTransportCapabilities;
  rawCall(scope: BrowserScope, call: BrowserPrimitive): Promise<unknown>;
  observe(scope: BrowserScope): Promise<BrowserObservation>;
  verify(scope: BrowserScope, expect: readonly BrowserExpectation[]): Promise<boolean>;
  prepare(
    scope: BrowserScope,
    observation: BrowserObservation,
    choice: BrowserChoice,
    text?: string,
  ): Promise<PreparedBrowserAction>;
  execute(scope: BrowserScope, action: PreparedBrowserAction): Promise<BrowserExecution>;
}

export interface BrowserActionSpace {
  readonly observationId: string;
  readonly elements: readonly {
    readonly id: string;
    readonly role: string;
    readonly label: string;
    readonly current_value?: string;
    readonly checked?: boolean | "mixed";
    readonly selected?: boolean;
    readonly expanded?: boolean;
  }[];
  readonly candidatesByOp: ReadonlyMap<TargetOperation, readonly BrowserCandidate[]>;
  readonly controls: readonly BrowserOperation[];
  readonly omittedCandidates: number;
}

export interface BrowserQuestionBatch {
  readonly observationId: string;
  readonly questions: Record<string, DeciderQuestion>;
  readonly singletonTargets: ReadonlyMap<TargetOperation, string>;
  readonly targetsByOp: ReadonlyMap<TargetOperation, ReadonlyMap<string, BrowserCandidate>>;
}

export interface BrowserHistoryEntry {
  readonly action: string;
  readonly kind: string;
  readonly pageChanged?: boolean;
  readonly redactedText?: string;
}

export interface BrowserTextContext {
  readonly goal: string;
  readonly field: { readonly label: string; readonly role: string };
  readonly page: { readonly title: string; readonly origin: string };
  readonly recentActions: readonly string[];
}

export interface AutomationActionGuard {
  beforeInput(): Promise<void>;
  onInputStart(): void;
  readonly signal?: AbortSignal;
}
