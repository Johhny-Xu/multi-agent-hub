// Host adapter for fast DOM observation, target resolution, and guard validation in CdpPage.
import type { BrowserChoice, BrowserObservation, BrowserOperation, BrowserScope } from "../jev-types.ts";
import type { CdpPage } from "./page.ts";
import type { NodeHandle } from "./refs.ts";
import { DriverError } from "./errors.ts";
import {
  DomObservationResult,
  JEV_DOM_SCRIPT,
  JEV_RESOLVE_TARGET_SCRIPT,
  JEV_VALIDATE_GUARD_SCRIPT,
} from "./jev-dom.ts";

export interface JevObservationOptions {
  allowFrames?: boolean;
}

export async function readJevObservation(
  page: CdpPage,
  scope: BrowserScope,
  options: JevObservationOptions = {},
): Promise<BrowserObservation> {
  const mainFrameId = page.frames.mainFrameId;

  // If there are other frames and options.allowFrames is not set, report unsupported frames.
  const hasSubframes = Array.from(page.frames["_frames"]?.values() ?? []).some((f: { parentId: string | null }) => f.parentId !== null);
  if (hasSubframes && !options.allowFrames) {
    throw new DriverError("unsupported-observation", "Page contains frames or iframes; fast DOM observer only supports main document.");
  }

  const raw = await page.frames.inWorld(mainFrameId, async (session, contextId) => {
    const evalResult = await session.send<{
      result: { value: DomObservationResult | null };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression: JEV_DOM_SCRIPT,
      contextId,
      returnByValue: true,
      awaitPromise: true,
    });
    if (evalResult.exceptionDetails) {
      throw new DriverError("execution", evalResult.exceptionDetails.text || "Failed to execute JEV_DOM_SCRIPT");
    }
    return evalResult.result.value;
  });

  if (!raw) {
    throw new DriverError("execution", "DOM snapshot returned null");
  }

  return {
    ...raw,
    tabId: scope.tabId ?? page.targetId,
  };
}

export async function resolveJevTarget(
  page: CdpPage,
  observationId: string,
  elementId: string,
): Promise<{ handle: NodeHandle; ref: string }> {
  const mainFrameId = page.frames.mainFrameId;
  const frame = page.frames.get(mainFrameId);
  if (!frame) throw new DriverError("not-found", "Main frame not found");

  const session = frame.session;

  const result = await page.frames.inWorld(mainFrameId, async (worldSession, contextId) => {
    const evaluated = await worldSession.send<{
      result: { objectId?: string; type?: string };
      exceptionDetails?: { text?: string };
    }>("Runtime.evaluate", {
      expression: JEV_RESOLVE_TARGET_SCRIPT(elementId),
      contextId,
      returnByValue: false,
    });

    if (evaluated.exceptionDetails || !evaluated.result.objectId) {
      throw new DriverError("not-found", `Target element ${elementId} could not be resolved in DOM`);
    }

    const objectId = evaluated.result.objectId;
    try {
      const { node } = await worldSession.send<{ node: { backendNodeId: number } }>("DOM.describeNode", {
        objectId,
      });
      return node.backendNodeId;
    } finally {
      void worldSession.send("Runtime.releaseObject", { objectId }).catch(() => {});
    }
  });

  const handle: NodeHandle = {
    frameId: mainFrameId,
    session,
    backendNodeId: result,
  };

  const ref = page.refs.refFor(handle);
  return { handle, ref };
}

export async function validateJevObservation(
  page: CdpPage,
  guardId: string,
  elementId: string,
): Promise<boolean> {
  const mainFrameId = page.frames.mainFrameId;
  try {
    return await page.frames.inWorld(mainFrameId, async (session, contextId) => {
      const evalResult = await session.send<{
        result: { value: boolean };
      }>("Runtime.evaluate", {
        expression: JEV_VALIDATE_GUARD_SCRIPT(guardId, elementId),
        contextId,
        returnByValue: true,
      });
      return evalResult.result.value === true;
    });
  } catch {
    return false;
  }
}

export async function waitForJevState(
  page: CdpPage,
  previous: BrowserOperation,
  target: NodeHandle | null,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;

  if (previous === "WAIT") {
    // Bounds explicit wait by 100ms
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 100);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    return;
  }

  if (previous === "TYPE_TEXT") {
    // Wait for combobox or inputs up to 200ms
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 50);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    return;
  }

  // Ordinary settling by two frames or 50ms
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 50);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
