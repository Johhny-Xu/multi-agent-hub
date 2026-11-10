import { describe, expect, it } from "vitest";

import { endTurn, type AcpTurn } from "./turn-state.ts";

const ERROR_BODY = '403 {"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization."}}';

/** A turn whose buffered text is `text`, flushed as core.ts does: a non-blank text becomes a reply. */
function turnWith(text: string, state: { stopped?: boolean; replied?: string } = {}) {
  const replies: string[] = [];
  const current = {
    state: { text: state.replied ?? "", stopped: false, producedItem: false, repliedText: false },
    flushAssistantText() {
      const said = current.state.text;
      current.state.text = "";
      if (!said.trim()) return;
      current.state.producedItem = true;
      current.state.repliedText = true;
      replies.push(said);
    },
  };
  if (state.replied) current.flushAssistantText();
  current.state.text = text;
  current.state.stopped = state.stopped ?? false;
  return { current: current as unknown as AcpTurn, replies };
}

describe("endTurn on a reply that is a provider's error body", () => {
  it("keeps an empty reply's existing notice key and provider", () => {
    const { current } = turnWith("");
    expect(endTurn(current, true, null, "Grok")).toEqual({
      ok: false, stopReason: "empty_turn", error: {
        message: "Grok finished without replying.",
        text: { key: "chat.notice.acpEmpty", params: { provider: "Grok" } },
      },
    });
  });

  it("keeps the semantic reset facts when a provider's error body ends the turn", () => {
    const { current, replies } = turnWith('429 {"error":{"message":"usage limit"}} retry-after-ms=300000');
    expect(endTurn(current, true, null, "Grok")).toMatchObject({
      ok: false, stopReason: "quota", error: {
        text: { key: "chat.notice.usageLimitResets", params: { provider: "Grok", resetsAt: expect.any(Number), timeZone: expect.any(String) } },
        limit: "engine", limitResetsAt: expect.any(Number),
      },
    });
    expect(replies).toEqual([]);
  });

  it("after the person's Stop, ends the turn as stopped and keeps what was said", () => {
    const { current, replies } = turnWith(ERROR_BODY, { stopped: true });
    expect(endTurn(current, true, null, "omp")).toEqual({ ok: true, stopReason: "cancelled" });
    expect(replies).toEqual([ERROR_BODY]);
  });

  it("keeps the body a reply when the turn already replied in words before it", () => {
    const { current, replies } = turnWith(ERROR_BODY, { replied: "Let me check the deploy." });
    expect(endTurn(current, true, null, "omp")).toEqual({ ok: true, stopReason: null });
    expect(replies).toEqual(["Let me check the deploy.", ERROR_BODY]);
  });
});

/** A turn that only thought (producedItem from reasoning chunks), with its last request's output tokens. */
function thinkingTurn(outputTokens: number | null, text = "", stopped = false) {
  const { current, replies } = turnWith(text, { stopped });
  current.state.producedItem = true;
  current.state.outputTokens = outputTokens;
  return { current, replies };
}

describe("endTurn when the model spent its output cap thinking (E54)", () => {
  it("fails the turn with a readable cap notice that suggests splitting the task", () => {
    const { current } = thinkingTurn(64_000);
    expect(endTurn(current, true, null, "OpenCode", 64_000)).toEqual({
      ok: false, stopReason: "max_tokens", error: {
        message: "OpenCode spent its whole output limit (64000 tokens) thinking and stopped before writing a reply or running a tool (stop: length). Split the task into smaller steps, or ask it to continue.",
        text: { key: "chat.notice.stop.thinkingCap", params: { provider: "OpenCode", limit: "64000" } },
      },
    });
  });

  it("still flags a cut-off last request after earlier words in the same turn, keeping those words", () => {
    const { current, replies } = turnWith("", { replied: "Writing index.html now." });
    current.state.outputTokens = 32_000;
    expect(endTurn(current, true, null, "MiMo Code", 32_000)).toMatchObject({ ok: false, stopReason: "max_tokens" });
    expect(replies).toEqual(["Writing index.html now."]);
  });

  it("leaves a turn alone when its last request stayed under the cap or wrote text", () => {
    expect(endTurn(thinkingTurn(63_999).current, true, null, "OpenCode", 64_000)).toEqual({ ok: true, stopReason: null });
    const { current, replies } = thinkingTurn(64_000, "Done: index.html");
    expect(endTurn(current, true, null, "OpenCode", 64_000)).toEqual({ ok: true, stopReason: null });
    expect(replies).toEqual(["Done: index.html"]);
  });

  it("does nothing without a cap or usage, and a Stop still ends as cancelled", () => {
    expect(endTurn(thinkingTurn(64_000).current, true, null, "Grok")).toEqual({ ok: true, stopReason: null });
    expect(endTurn(thinkingTurn(null).current, true, null, "OpenCode", 64_000)).toEqual({ ok: true, stopReason: null });
    expect(endTurn(thinkingTurn(64_000, "", true).current, true, null, "OpenCode", 64_000)).toEqual({ ok: true, stopReason: "cancelled" });
  });
});
