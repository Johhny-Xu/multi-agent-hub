import { describe, expect, it, vi } from "vitest";
import {
  readJevObservation,
  resolveJevTarget,
} from "./jev-observation.ts";
import { JEV_DOM_SCRIPT } from "./jev-dom.ts";
import { RefCounter, RefTable } from "./refs.ts";
import type { CdpPage } from "./page.ts";
import type { BrowserScope } from "../jev-types.ts";

function createMockPage(overrides: {
  evaluateResult?: unknown;
  describeNodeResult?: { node: { backendNodeId: number } };
  hasFrames?: boolean;
} = {}): { page: CdpPage; sentMethods: string[] } {
  const sentMethods: string[] = [];
  const session = {
    id: "sess_1",
    send: vi.fn(async (method: string, _params: Record<string, unknown> = {}) => {
      sentMethods.push(method);
      if (method === "Runtime.evaluate") {
        return { result: { value: overrides.evaluateResult ?? null, objectId: "obj_123" } };
      }
      if (method === "DOM.describeNode") {
        return overrides.describeNodeResult ?? { node: { backendNodeId: 42 } };
      }
      if (method === "Runtime.releaseObject") {
        return {};
      }
      return {};
    }),
  };

  const framesMap = new Map();
  framesMap.set("main_frame", { id: "main_frame", parentId: null, session });
  if (overrides.hasFrames) {
    framesMap.set("sub_frame", { id: "sub_frame", parentId: "main_frame", session });
  }

  const frames = {
    mainFrameId: "main_frame",
    _frames: framesMap,
    get: (id: string) => framesMap.get(id),
    inWorld: vi.fn(async (frameId: string, work: (sess: any, ctx: number) => Promise<any>) => {
      return work(session, 1);
    }),
  };

  const refs = new RefTable(new RefCounter());

  const page = {
    targetId: "target_1",
    frames,
    refs,
  } as unknown as CdpPage;

  return { page, sentMethods };
}

const mockScope: BrowserScope = {
  botId: "bot_1",
  conversationId: "conv_1",
  sessionId: "sess_1",
  profileId: "prof_1",
  turnGeneration: "gen_1",
  tabId: "tab_1",
  place: { key: "builtin", provider: "builtin", revision: "1" },
  signal: new AbortController().signal,
};

describe("jev-observation", () => {
  it("reads controls form state and visible text in one evaluation", async () => {
    const mockObs = {
      id: "obs_1",
      documentEpoch: "epoch_1",
      origin: "https://example.com",
      title: "Title",
      stateText: "Visible text here",
      candidates: [
        { id: "c1", elementId: "el_1", operation: "CLICK", role: "button", label: "Submit" },
      ],
      controls: ["SCROLL_DOWN"],
      guardId: "g_1",
      truncated: false,
      omittedCandidates: 0,
    };

    const { page, sentMethods } = createMockPage({ evaluateResult: mockObs });
    const obs = await readJevObservation(page, mockScope);

    expect(obs.id).toBe("obs_1");
    expect(obs.title).toBe("Title");
    expect(obs.stateText).toBe("Visible text here");
    expect(obs.candidates.length).toBe(1);
    expect(sentMethods.filter((m) => m === "Runtime.evaluate").length).toBe(1);
  });

  it("does not resolve every candidate into a backend node", async () => {
    const mockObs = {
      id: "obs_1",
      documentEpoch: "epoch_1",
      origin: "https://example.com",
      title: "Title",
      stateText: "Text",
      candidates: [
        { id: "c1", elementId: "el_1", operation: "CLICK", role: "button", label: "A" },
        { id: "c2", elementId: "el_2", operation: "CLICK", role: "button", label: "B" },
        { id: "c3", elementId: "el_3", operation: "CLICK", role: "button", label: "C" },
      ],
      controls: [],
      guardId: "g_1",
      truncated: false,
      omittedCandidates: 0,
    };

    const { page, sentMethods } = createMockPage({ evaluateResult: mockObs });
    await readJevObservation(page, mockScope);

    // During observation, zero DOM.describeNode calls are made!
    expect(sentMethods.filter((m) => m === "DOM.describeNode").length).toBe(0);
  });

  it("materializes only the selected node into an existing ref", async () => {
    const { page, sentMethods } = createMockPage({
      describeNodeResult: { node: { backendNodeId: 101 } },
    });

    const { handle, ref } = await resolveJevTarget(page, "obs_1", "el_1");
    expect(handle.backendNodeId).toBe(101);
    expect(ref).toBe("e1");
    expect(sentMethods).toContain("DOM.describeNode");
    expect(sentMethods).toContain("Runtime.releaseObject");
  });

  it("changes identity when an identically named node is replaced", () => {
    expect(JEV_DOM_SCRIPT).toContain("state.ids.has(el)");
    expect(JEV_DOM_SCRIPT).toContain("state.nextId++");
    expect(JEV_DOM_SCRIPT).toContain("state.ids.set(el, state.nextId++)");
  });

  it("prunes detached nodes and clears document guards", () => {
    expect(JEV_DOM_SCRIPT).toContain("if (!node.isConnected)");
    expect(JEV_DOM_SCRIPT).toContain("state.nodes.delete(id)");
  });

  it("masks secrets using the existing sensitive field rules", () => {
    expect(JEV_DOM_SCRIPT).toContain("isSensitive(e.type");
    expect(JEV_DOM_SCRIPT).toContain("isSens ? undefined : (rawVal || '')");
  });

  it("does not send offscreen text or screenshots to Jev", () => {
    expect(JEV_DOM_SCRIPT).toContain("r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth");
    expect(JEV_DOM_SCRIPT).not.toContain("captureScreenshot");
    expect(JEV_DOM_SCRIPT).not.toContain("screenshot");
  });

  it("keeps fast observation state out of the page world", () => {
    expect(JEV_DOM_SCRIPT).not.toContain("window.__jevFast");
    expect(JEV_DOM_SCRIPT).toContain("globalThis.__ombJevState");
  });

  it("reports unsupported frames and preserves the AX tool path", async () => {
    const { page } = createMockPage({ hasFrames: true });
    await expect(readJevObservation(page, mockScope)).rejects.toThrow(/frames or iframes/);
  });

  it("enforces element option and byte limits with omission counts", () => {
    expect(JEV_DOM_SCRIPT).toContain("if (elementCount > 64) break;");
    expect(JEV_DOM_SCRIPT).toContain("if (candidates.length >= 128) break;");
    expect(JEV_DOM_SCRIPT).toContain("while ((node = walker.nextNode()) && textLen < 6000)");
    expect(JEV_DOM_SCRIPT).toContain("omittedCandidates: omitted");
  });
});
