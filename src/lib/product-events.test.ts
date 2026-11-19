import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/state/store";
import { keySaveFailure, keyTestResult, savedKeyResult } from "./product-events";

const ph = vi.hoisted(() => ({ loads: 0 }));
vi.mock("posthog-js", () => { ph.loads += 1; return { default: { capture: () => { throw new Error("no telemetry may leave"); } } }; });

describe("why a key save failed", () => {
  it("calls it rejected only when the provider refused the key", () => {
    expect(keySaveFailure(new ApiError("boat.dev rejected that key", 400, { error: "boat.dev rejected that key", code: "key_rejected" }))).toBe("rejected");
    expect(keySaveFailure(new Error("Error invoking remote method 'credential:set': KeyRejected: That doesn't look like a Boat API key"))).toBe("rejected");
  });

  it("calls every other failure an error", () => {
    for (const cause of [
      new ApiError("bad request", 400, { error: "bad request" }),
      new ApiError("hosted models", 403, { error: "This workspace uses hosted models" }),
      new ApiError("finish deleting first", 409, { error: "busy" }),
      new ApiError("unavailable", 503, {}),
      new ApiError("decider", 400, { code: "decider_rejected" }),
      new TypeError("Failed to fetch"),
      new Error("Error invoking remote method 'credential:set': Error: The embedded bot server is unavailable"),
      new Error("KeyRejected: not over IPC"),
      "key_rejected",
      null,
      undefined,
    ]) expect(keySaveFailure(cause)).toBe("error");
  });
});

describe("what a saved key's check said", () => {
  it("follows the key test when one runs", () => {
    expect(keyTestResult({ ok: true, check: "authentication" } as never)).toBe("ok");
    expect(keyTestResult({ ok: false, reason: "rejected" })).toBe("rejected");
    expect(keyTestResult({ ok: false, reason: "unreachable" })).toBe("unverified");
    expect(keyTestResult({ ok: false, reason: "unexpected", status: 500 } as never)).toBe("unverified");
    expect(keyTestResult(null)).toBe("unverified");
  });

  it("is ok for keys the server checks before saving, and unverified for the rest", () => {
    for (const provider of ["boat", "composio", "elevenlabs", "fish_audio"] as const) expect(savedKeyResult(provider)).toBe("ok");
    for (const provider of ["opencode_go", "openai_image", "custom_endpoint", "xai", "other"] as const) expect(savedKeyResult(provider)).toBe("unverified");
  });
});

describe("what reaches telemetry", () => {
  it("is nothing: the product events keep their shape and send no request", async () => {
    vi.resetModules();
    vi.doMock("posthog-js", () => { ph.loads += 1; return { default: { capture: () => { throw new Error("no telemetry may leave"); } } }; });
    const analytics = await import("./analytics");
    const events = await import("./product-events");
    await analytics.initAnalytics();
    events.keySaved("boat", "computer_panel", "rejected");
    events.keyRemoved("anthropic", "settings");
    events.botCreated("template", "research");
    events.connectorConnect("gmail", "connected");
    events.directMessageSent([], "unknown", false);
    events.roomMessageSent("chat", true);
    events.callStarted([], "unknown", "voice");
    events.engineSignedIn("claude", "code");
    expect(ph.loads).toBe(0);
  });
});
