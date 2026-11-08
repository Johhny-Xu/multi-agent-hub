import { describe, expect, it } from "vitest";
import {
  buildBrowserActionSpace,
  buildBrowserQuestions,
  chooseBrowserAction,
  MIN_MARGIN,
  MIN_PTOP,
} from "./jev-policy.ts";
import type { BrowserCandidate, BrowserObservation } from "./jev-types.ts";

function createMockObservation(overrides: Partial<BrowserObservation> = {}): BrowserObservation {
  return {
    id: "obs_1",
    tabId: "tab_1",
    documentEpoch: "epoch_1",
    origin: "https://example.com",
    title: "Example",
    stateText: "Example page",
    candidates: [],
    controls: ["WAIT"],
    guardId: "guard_1",
    truncated: false,
    omittedCandidates: 0,
    ...overrides,
  };
}

describe("jev-policy", () => {
  it("batches operation and compatible target heads in one request", () => {
    const candidates: BrowserCandidate[] = [
      { id: "c1", elementId: "el1", operation: "CLICK", role: "button", label: "Search" },
      { id: "c2", elementId: "el2", operation: "CLICK", role: "link", label: "Help" },
      { id: "c3", elementId: "el3", operation: "TYPE_TEXT", role: "textbox", label: "Query", value: "" },
      { id: "c4", elementId: "el4", operation: "TYPE_TEXT", role: "searchbox", label: "Filter", value: "" },
    ];
    const obs = createMockObservation({ candidates });
    const space = buildBrowserActionSpace(obs);
    const batch = buildBrowserQuestions("Find flights", space);

    expect(batch.questions.operation).toBeDefined();
    expect(batch.questions.operation.type).toBe("choice");
    if (batch.questions.operation.type === "choice") {
      expect(batch.questions.operation.options.CLICK).toBeDefined();
      expect(batch.questions.operation.options.TYPE_TEXT).toBeDefined();
    }
    expect(batch.questions.click_target).toBeDefined();
    expect(batch.questions.type_text_target).toBeDefined();
    expect(batch.questions.select_target).toBeUndefined();
  });

  it("shares one element index across click and type heads", () => {
    const candidates: BrowserCandidate[] = [
      { id: "c1", elementId: "el1", operation: "CLICK", role: "combobox", label: "Destination" },
      { id: "c2", elementId: "el1", operation: "TYPE_TEXT", role: "combobox", label: "Destination", value: "NYC" },
      { id: "c3", elementId: "el2", operation: "CLICK", role: "button", label: "Submit" },
    ];
    const obs = createMockObservation({ candidates });
    const space = buildBrowserActionSpace(obs);

    expect(space.elements.length).toBe(2);
    expect(space.elements.find((e) => e.id === "el1")).toMatchObject({
      id: "el1",
      role: "combobox",
      label: "Destination",
      current_value: "NYC",
    });
    expect(space.candidatesByOp.get("CLICK")?.length).toBe(2);
    expect(space.candidatesByOp.get("TYPE_TEXT")?.length).toBe(1);
  });

  it("consumes only the selected operation target", () => {
    const candidates: BrowserCandidate[] = [
      { id: "c1", elementId: "el1", operation: "CLICK", role: "button", label: "First" },
      { id: "c2", elementId: "el2", operation: "CLICK", role: "button", label: "Second" },
      { id: "t1", elementId: "el3", operation: "TYPE_TEXT", role: "textbox", label: "Name" },
      { id: "t2", elementId: "el4", operation: "TYPE_TEXT", role: "textbox", label: "Email" },
    ];
    const obs = createMockObservation({ candidates });
    const space = buildBrowserActionSpace(obs);
    const batch = buildBrowserQuestions("Fill form", space);

    const result = {
      ok: true as const,
      provider: "jev" as const,
      answers: {
        operation: { type: "choice" as const, choice: "CLICK", pTop: 0.95, margin: 0.3 },
        click_target: { type: "choice" as const, choice: "c2", pTop: 0.92, margin: 0.25 },
        type_text_target: { type: "choice" as const, choice: "t1", pTop: 0.1, margin: 0.01 },
      },
    };

    const choice = chooseBrowserAction(result, batch);
    expect(choice).toEqual({
      kind: "target",
      operation: "CLICK",
      candidateId: "c2",
    });
  });

  it("omits empty heads and binds singleton targets locally", () => {
    const candidates: BrowserCandidate[] = [
      { id: "c1", elementId: "el1", operation: "CLICK", role: "button", label: "Only Button" },
    ];
    const obs = createMockObservation({ candidates });
    const space = buildBrowserActionSpace(obs);
    const batch = buildBrowserQuestions("Click button", space);

    expect(batch.singletonTargets.get("CLICK")).toBe("c1");
    expect(batch.questions.click_target).toBeUndefined();
    expect(batch.questions.type_text_target).toBeUndefined();
    expect(batch.questions.select_target).toBeUndefined();

    const result = {
      ok: true as const,
      provider: "jev" as const,
      answers: {
        operation: { type: "choice" as const, choice: "CLICK", pTop: 0.95, margin: 0.3 },
      },
    };

    const choice = chooseBrowserAction(result, batch);
    expect(choice).toEqual({
      kind: "target",
      operation: "CLICK",
      candidateId: "c1",
    });
  });

  it("does not mistake a checkbox for a text field", () => {
    const candidates: BrowserCandidate[] = [
      { id: "c1", elementId: "el1", operation: "CLICK", role: "checkbox", label: "Accept Terms", checked: false },
      { id: "c2", elementId: "el2", operation: "CLICK", role: "button", label: "Submit" },
    ];
    const obs = createMockObservation({ candidates });
    const space = buildBrowserActionSpace(obs);
    const batch = buildBrowserQuestions("Accept and submit", space);

    expect(space.candidatesByOp.get("TYPE_TEXT")?.length).toBe(0);
    expect(batch.questions.type_text_target).toBeUndefined();
  });

  it("binds select to an observed enabled option", () => {
    const candidates: BrowserCandidate[] = [
      { id: "s1", elementId: "sel1", operation: "SELECT", role: "combobox", label: "Country → USA", optionId: "opt_us" },
      { id: "s2", elementId: "sel1", operation: "SELECT", role: "combobox", label: "Country → Canada", optionId: "opt_ca" },
    ];
    const obs = createMockObservation({ candidates });
    const space = buildBrowserActionSpace(obs);
    const batch = buildBrowserQuestions("Pick country", space);

    expect(batch.questions.select_target).toBeDefined();

    const result = {
      ok: true as const,
      provider: "jev" as const,
      answers: {
        operation: { type: "choice" as const, choice: "SELECT", pTop: 0.94, margin: 0.28 },
        select_target: { type: "choice" as const, choice: "s2", pTop: 0.91, margin: 0.22 },
      },
    };

    const choice = chooseBrowserAction(result, batch);
    expect(choice).toEqual({
      kind: "target",
      operation: "SELECT",
      candidateId: "s2",
    });
  });

  it("requires complete probabilities and both confidence thresholds", () => {
    const candidates: BrowserCandidate[] = [
      { id: "c1", elementId: "el1", operation: "CLICK", role: "button", label: "A" },
      { id: "c2", elementId: "el2", operation: "CLICK", role: "button", label: "B" },
    ];
    const obs = createMockObservation({ candidates });
    const space = buildBrowserActionSpace(obs);
    const batch = buildBrowserQuestions("Goal", space);

    const lowPtop = {
      ok: true as const,
      provider: "jev" as const,
      answers: {
        operation: { type: "choice" as const, choice: "CLICK", pTop: 0.88, margin: 0.25 },
        click_target: { type: "choice" as const, choice: "c1", pTop: 0.95, margin: 0.3 },
      },
    };
    expect(chooseBrowserAction(lowPtop, batch)).toBeNull();

    const lowMargin = {
      ok: true as const,
      provider: "jev" as const,
      answers: {
        operation: { type: "choice" as const, choice: "CLICK", pTop: 0.92, margin: 0.15 },
        click_target: { type: "choice" as const, choice: "c1", pTop: 0.95, margin: 0.3 },
      },
    };
    expect(chooseBrowserAction(lowMargin, batch)).toBeNull();
  });

  it("offers wait only with observed loading evidence", () => {
    const withoutLoading = createMockObservation({ controls: [] });
    const spaceWithout = buildBrowserActionSpace(withoutLoading);
    const batchWithout = buildBrowserQuestions("Check", spaceWithout);

    if (batchWithout.questions.operation.type === "choice") {
      expect(batchWithout.questions.operation.options.WAIT).toBeUndefined();
    }

    const withLoading = createMockObservation({ controls: ["WAIT"] });
    const spaceWith = buildBrowserActionSpace(withLoading);
    const batchWith = buildBrowserQuestions("Check", spaceWith);

    if (batchWith.questions.operation.type === "choice") {
      expect(batchWith.questions.operation.options.WAIT).toBeDefined();
    }
  });

  it("rejects unoffered and truncated target ids", () => {
    const candidates: BrowserCandidate[] = [
      { id: "c1", elementId: "el1", operation: "CLICK", role: "button", label: "A" },
      { id: "c2", elementId: "el2", operation: "CLICK", role: "button", label: "B" },
    ];
    const obs = createMockObservation({ candidates });
    const space = buildBrowserActionSpace(obs);
    const batch = buildBrowserQuestions("Goal", space);

    const hallucinated = {
      ok: true as const,
      provider: "jev" as const,
      answers: {
        operation: { type: "choice" as const, choice: "CLICK", pTop: 0.95, margin: 0.3 },
        click_target: { type: "choice" as const, choice: "c999", pTop: 0.95, margin: 0.3 },
      },
    };
    expect(chooseBrowserAction(hallucinated, batch)).toBeNull();
  });
});
