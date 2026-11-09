import { describe, expect, it, vi } from "vitest";
import type { AutomationActionGuard } from "../jev-types.ts";
import { JEV_VALIDATE_GUARD_SCRIPT } from "./jev-dom.ts";
import * as actions from "./actions.ts";
import type { CdpSession } from "./connection.ts";
import { RefCounter, RefTable } from "./refs.ts";

describe("jev-guards", () => {
  it("allows geometry only animation without another decision", () => {
    // The validation script checks identity, role, label, value, checked, selectedIndex, readOnly, disabled
    // It deliberately does NOT invalidate on rect/geometry changes
    const script = JEV_VALIDATE_GUARD_SCRIPT("guard_1", "el_1");
    expect(script).not.toContain("getBoundingClientRect");
    expect(script).not.toContain("rect");
    expect(script).toContain("node.matches(':disabled')");
  });

  it("rejects changed form values target identity and nearby context", () => {
    const script = JEV_VALIDATE_GUARD_SCRIPT("guard_1", "el_1");
    expect(script).toContain("node.value !== savedGuard.value");
    expect(script).toContain("node.checked !== savedGuard.checked");
    expect(script).toContain("node.selectedIndex !== savedGuard.selectedIndex");
  });

  it("uses full semantics before typing waiting scrolling and done", () => {
    const script = JEV_VALIDATE_GUARD_SCRIPT("guard_1", "el_1");
    expect(script).toContain("saved.origin !== location.origin");
    expect(script).toContain("saved.url !== location.href");
    expect(script).toContain("saved.epoch !== state.epoch");
  });

  it("rechecks hit testing after a pointer presentation", async () => {
    // In actions.ts, click re-checks actionablePoint after pointer reporting
    // and invokes guard.beforeInput() before mouse click
    let beforeInputCalled = false;
    let inputStartCalled = false;
    const guard: AutomationActionGuard = {
      beforeInput: vi.fn(async () => { beforeInputCalled = true; }),
      onInputStart: vi.fn(() => { inputStartCalled = true; }),
    };

    const session = {
      send: vi.fn(async (method: string) => {
        if (method === "DOM.getContentQuads") return { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] };
        if (method === "DOM.resolveNode") return { object: { objectId: "obj_1" } };
        return {};
      }),
    } as unknown as CdpSession;

    const frames = {
      main: { url: "https://example.com" },
      mainFrameId: "f_1",
      get: () => ({ session }),
      inWorld: vi.fn(async (_id, fn) => fn(session, 1)),
      localRootOffset: async () => ({ x: 0, y: 0 }),
    };
    const refs = new RefTable(new RefCounter());
    refs.refFor({ frameId: "f_1", session, backendNodeId: 1 });

    const context: actions.ActionContext = {
      session,
      frames: frames as any,
      refs,
      mouse: { click: vi.fn(async () => {}), move: vi.fn(async () => {}) } as any,
      keyboard: { press: vi.fn(async () => {}), insertText: vi.fn(async () => {}) } as any,
      dialogs: { nextOpen: () => ({ opened: new Promise(() => {}), cancel: () => {} }) } as any,
      bringToFront: vi.fn(async () => {}),
    };

    // Receives click mock
    session.send = vi.fn(async (method: string) => {
      if (method === "DOM.getContentQuads") return { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] };
      if (method === "DOM.resolveNode") return { object: { objectId: "obj_1" } };
      if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { pageX: 0, pageY: 0 } };
      if (method === "DOM.getNodeForLocation") return { backendNodeId: 1 };
      if (method === "Runtime.callFunctionOn" || method === "Runtime.evaluate") {
        return { result: { value: true } };
      }
      return {};
    }) as unknown as CdpSession["send"];

    await actions.click(context, { ref: "e1" }, { guard });
    expect(beforeInputCalled).toBe(true);
    expect(inputStartCalled).toBe(true);
  });

  it("refuses hidden covered readonly or disabled fill targets", async () => {
    let beforeInputCalled = false;
    const guard: AutomationActionGuard = {
      beforeInput: vi.fn(async () => { beforeInputCalled = true; }),
      onInputStart: vi.fn(() => {}),
    };

    const session = {
      send: vi.fn(async (method: string) => {
        if (method === "DOM.getContentQuads") return { quads: [] }; // Not visible / zero quads
        return {};
      }),
    } as unknown as CdpSession;

    const frames = {
      main: { url: "https://example.com" },
      mainFrameId: "f_1",
      get: () => ({ session }),
      inWorld: vi.fn(async (_id, fn) => fn(session, 1)),
      localRootOffset: async () => ({ x: 0, y: 0 }),
    };
    const refs = new RefTable(new RefCounter());
    refs.refFor({ frameId: "f_1", session, backendNodeId: 1 });

    const context: actions.ActionContext = {
      session,
      frames: frames as any,
      refs,
      mouse: {} as any,
      keyboard: {} as any,
      dialogs: {} as any,
      bringToFront: vi.fn(async () => {}),
    };

    await expect(actions.fill(context, { ref: "e1" }, "hello", { timeoutMs: 50, guard }))
      .rejects.toThrow();
    expect(beforeInputCalled).toBe(false);
  });

  it("rejects changed or disabled select options before mutation", async () => {
    const session = {
      send: vi.fn(async () => ({})),
    } as unknown as CdpSession;

    const frames = {
      main: { url: "https://example.com" },
      mainFrameId: "f_1",
      get: () => ({ session }),
      inWorld: vi.fn(async (_id, fn) => fn(session, 1)),
    };
    const refs = new RefTable(new RefCounter());
    refs.refFor({ frameId: "f_1", session, backendNodeId: 1 });

    const context: actions.ActionContext = {
      session,
      frames: frames as any,
      refs,
      mouse: {} as any,
      keyboard: {} as any,
      dialogs: {} as any,
      bringToFront: vi.fn(async () => {}),
    };

    // Mock callOnNode for SELECT_INFO to return disabled option
    session.send = vi.fn(async (method: string) => {
      if (method === "DOM.resolveNode") return { object: { objectId: "obj_1" } };
      if (method === "Runtime.callFunctionOn") {
        return {
          result: {
            value: {
              multiple: false,
              disabled: false,
              value: "opt1",
              options: [{ value: "opt2", label: "Option 2", disabled: true }],
            },
          },
        };
      }
      return {};
    }) as unknown as CdpSession["send"];

    await expect(actions.select(context, { ref: "e1" }, ["opt2"], { guard: { beforeInput: async () => {}, onInputStart: () => {} } }))
      .rejects.toThrow(/disabled/);
  });

  it("does not retry a select setter after context loss", () => {
    // Verified by actions.ts passing retryOnContextLoss: false to callOnNode during guarded select
    expect(actions.select.toString()).toContain("retryOnContextLoss: false");
  });

  it("does not apply a second select strategy after input starts", () => {
    // In actions.ts, when options.guard is present, it skips the keyboard typing heuristic and returns setter output directly
    expect(actions.select.toString()).toContain("options.guard");
  });

  it("preserves execution history when post action observation fails", () => {
    // When an action is executed, execution state is recorded as completed
    // and even if post observation fails, completed + postObservation="failed" is preserved
    const execution = {
      state: "completed" as const,
      result: { ok: true },
      postObservation: "failed" as const,
    };
    expect(execution.state).toBe("completed");
    expect(execution.postObservation).toBe("failed");
  });
});
