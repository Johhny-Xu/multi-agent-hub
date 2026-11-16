// @vitest-environment node
import { describe, expect, it } from "vitest";

import { SseReader, applySseEvent, composeReplyBody, runResult, takeSseEvent, type RunProgress } from "./meoo-acp.ts";

const TEXT = "你好，Meoo 🚀 完成";

function event(name: string, payload: unknown, eol = "\n"): string {
  return `event: ${name}${eol}data: ${JSON.stringify(payload)}${eol}${eol}`;
}

function progress(): RunProgress {
  return { replyText: "", status: "running", note: "" };
}

function feed(chunks: Uint8Array[], state = progress()): RunProgress {
  const reader = new SseReader();
  const events = [...chunks.flatMap((chunk) => reader.push(chunk)), ...reader.flush()];
  for (const { event: name, data } of events) applySseEvent(state, name, data);
  return state;
}

describe("Meoo's event stream", () => {
  it("keeps text intact when a multi-byte character is split between chunks", () => {
    const bytes = Buffer.from(event("message.delta", { type: "message.delta", delta: TEXT }), "utf8");
    for (let cut = 0; cut <= bytes.length; cut++) {
      const state = feed([bytes.subarray(0, cut), bytes.subarray(cut)]);
      expect(state.replyText).toBe(TEXT);
    }
  });

  it("keeps text intact in one-byte chunks", () => {
    const bytes = Buffer.from(event("message.delta", { type: "message.delta", delta: TEXT }), "utf8");
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
    expect(feed(chunks).replyText).toBe(TEXT);
  });

  it("reads LF and CRLF streams the same way", () => {
    const lf = event("message.delta", { delta: "one" }) + event("run.completed", { type: "run.completed" });
    const crlf = event("message.delta", { delta: "one" }, "\r\n") + event("run.completed", { type: "run.completed" }, "\r\n");
    expect(feed([Buffer.from(lf)]).replyText).toBe("one");
    expect(feed([Buffer.from(crlf)]).replyText).toBe("one");
    expect(feed([Buffer.from(lf)]).status).toBe("completed");
    expect(feed([Buffer.from(crlf)]).status).toBe("completed");
  });

  it("frames consecutive CRLF events without leaving one in the buffer", () => {
    const reader = new SseReader();
    const stream = Buffer.from([
      event("message.delta", { delta: "a" }, "\r\n"),
      event("message.delta", { delta: "b" }, "\r\n"),
      event("run.completed", { type: "run.completed" }, "\r\n"),
    ].join(""));
    const names = reader.push(stream).map((entry) => entry.event);
    expect(names).toEqual(["message.delta", "message.delta", "run.completed"]);
  });

  it("removes the whole event terminator, CRLF included", () => {
    expect(takeSseEvent("data: x\r\n\r\ndata: y\r\n\r\n")).toEqual({ raw: "data: x", rest: "data: y\r\n\r\n" });
    expect(takeSseEvent("data: x\n\ndata: y\n\n")).toEqual({ raw: "data: x", rest: "data: y\n\n" });
    expect(takeSseEvent("data: x")).toBeNull();
  });

  it("ignores a half-written JSON payload instead of reporting an error", () => {
    const state = progress();
    expect(applySseEvent(state, "message.delta", '{"delta":"unfinished"')).toBe(true);
    expect(state).toEqual(progress());
    expect(runResult(state)).toEqual({
      kind: "error",
      message: "Meoo closed this run before it finished. Send the message again to retry.",
    });
  });
});

describe("a Meoo run that needs more input", () => {
  it("keeps the reply and the question", () => {
    const state = progress();
    applySseEvent(state, "message.delta", JSON.stringify({ type: "message.delta", delta: "第一段" }));
    applySseEvent(state, "run.input_required", JSON.stringify({ action: { prompt: "Which file should I edit?" } }));
    expect(runResult(state)).toEqual({ kind: "text", text: "第一段", note: "Which file should I edit?" });
  });

  it("shows the question when no reply text arrived at all", () => {
    const state = progress();
    applySseEvent(state, "run.input_required", JSON.stringify({ detail: "Need a file path" }));
    expect(runResult(state)).toEqual({ kind: "text", text: "", note: "Need a file path" });
  });

  it("still reports an empty reply when the question carries no text", () => {
    const state = progress();
    applySseEvent(state, "run.input_required", JSON.stringify({ type: "run.input_required" }));
    expect(runResult(state)).toEqual({ kind: "error", message: "Meoo finished without any reply text." });
  });

  it("does not start the body with blank lines", () => {
    expect(composeReplyBody("", "Which file?")).toBe(
      "(Meoo asked for more input, which this connection cannot send: Which file?)",
    );
    expect(composeReplyBody("done", "Which file?")).toBe(
      "done\n\n(Meoo asked for more input, which this connection cannot send: Which file?)",
    );
    expect(composeReplyBody("", "")).toBe("");
  });
});
