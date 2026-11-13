import { describe, expect, it, vi } from "vitest";

import { GEMINI_DECISION_MODEL, geminiBackend, geminiDecisionsEndpoint, geminiQuestionsFit, geminiRequestBody, geminiRefusal } from "./gemini.ts";
import type { DeciderQuestion } from "./types.ts";

const KEY = "AIza-test-0000000000";
const STATE = { message: { from: "Milind", text: "PRIVATE-MESSAGE-TEXT the navbar overlaps on Safari" } };
const QUESTION: Record<string, DeciderQuestion> = { answer: { type: "yesno", instructions: "Is it?" } };

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function decide(fetchImpl: FetchMock, overrides: { state?: unknown; questions?: Record<string, DeciderQuestion>; baseUrl?: string } = {}) {
  return geminiBackend.decide({
    key: KEY,
    state: STATE,
    questions: QUESTION,
    signal: new AbortController().signal,
    fetch: fetchImpl as unknown as typeof fetch,
    ...overrides,
  });
}

describe("Gemini Decision 1's request", () => {
  it("maps all three question kinds and the fixed model into the documented body", async () => {
    const questions: Record<string, DeciderQuestion> = {
      need_reply: { type: "yesno", instructions: "Does this need a reply?", criteria: { yes: "Yes it does", no: "It does not" } },
      route: { type: "choice", instructions: "Who should answer?", options: { maya: "Maya, designer", theo: "Theo, engineer" } },
      urgency: { type: "score", instructions: "How urgent?", levels: ["low", "medium", "high"] },
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({
      answers: {
        need_reply: { type: "noul", noul: 0.2 },
        route: { type: "choice", choice: "theo", probabilities: { theo: 0.9, maya: 0.1 } },
        urgency: { type: "score", score: 1, probabilities: { 0: 0.1, 1: 0.8, 2: 0.1 } },
      },
    }));
    await expect(decide(fetchImpl, { questions })).resolves.toMatchObject({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/decisions");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: GEMINI_DECISION_MODEL,
      input: JSON.stringify(STATE),
      questions: {
        need_reply: { type: "noul", instructions: "Does this need a reply?", criteria: { true_description: "Yes it does", false_description: "It does not" } },
        route: { type: "choice", instructions: "Who should answer?", criteria: { maya: "Maya, designer", theo: "Theo, engineer" } },
        urgency: { type: "score", instructions: "How urgent?", criteria: ["low", "medium", "high"] },
      },
    });
  });

  it("omits noul criteria when neither side was given", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ answers: { answer: { noul: 0.5 } } }));
    await decide(fetchImpl);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)).questions).toEqual({ answer: { type: "noul", instructions: "Is it?" } });
  });

  it("sends a string input as it is and serializes anything else; an empty or circular state never calls", async () => {
    expect(geminiRequestBody("plain text", QUESTION)?.input).toBe("plain text");
    expect(geminiRequestBody({ a: 1 }, QUESTION)?.input).toBe('{"a":1}');
    expect(geminiRequestBody("   ", QUESTION)).toBeNull();
    expect(geminiRequestBody(undefined, QUESTION)).toBeNull();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(geminiRequestBody(circular, QUESTION)).toBeNull();

    const fetchImpl = vi.fn<typeof fetch>();
    for (const state of ["", "   ", undefined, circular]) {
      await expect(decide(fetchImpl, { state })).resolves.toEqual({ ok: false, reason: "misconfigured" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts https anywhere and plain http only on this machine", async () => {
    expect(String(geminiDecisionsEndpoint(undefined))).toBe("https://generativelanguage.googleapis.com/v1beta/decisions");
    expect(String(geminiDecisionsEndpoint("https://proxy.example.com/v1beta/"))).toBe("https://proxy.example.com/v1beta/decisions");
    expect(String(geminiDecisionsEndpoint("http://127.0.0.1:9911/v1beta"))).toBe("http://127.0.0.1:9911/v1beta/decisions");
    expect(geminiDecisionsEndpoint("http://gemini.example.com")).toBeNull();
    expect(geminiDecisionsEndpoint("https://user:pw@example.com/v1beta")).toBeNull();
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(decide(fetchImpl, { baseUrl: "http://gemini.example.com" })).resolves.toEqual({ ok: false, reason: "misconfigured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses every limit before the request", async () => {
    const many = (count: number): Record<string, DeciderQuestion> => Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`q${i}`, { type: "yesno" as const, instructions: "Is it?" }]),
    );
    const options = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`o${i}`, `option ${i}`]));
    const levels = (count: number) => Array.from({ length: count }, (_, i) => `level ${i}`);
    const cases: Array<[string, Record<string, DeciderQuestion>]> = [
      ["no questions", {}],
      ["1001 questions", many(1001)],
      ["a dotted question key", { "a.b": { type: "yesno", instructions: "?" } }],
      ["a 65-character question key", { ["a".repeat(65)]: { type: "yesno", instructions: "?" } }],
      ["a choice with one option", { answer: { type: "choice", instructions: "?", options: { only: "One" } } }],
      ["a choice with 256 options", { answer: { type: "choice", instructions: "?", options: options(256) } }],
      ["an empty option key", { answer: { type: "choice", instructions: "?", options: { "": "Empty" } } }],
      ["a padded option key", { answer: { type: "choice", instructions: "?", options: { " maya": "Maya" } } }],
      ["a 129-character option key", { answer: { type: "choice", instructions: "?", options: { ["a".repeat(129)]: "Long" } } }],
      ["a control character in an option key", { answer: { type: "choice", instructions: "?", options: { "a\u0001b": "Bad" } } }],
      ["a score with one level", { answer: { type: "score", instructions: "?", levels: ["only"] } }],
      ["a score with 256 levels", { answer: { type: "score", instructions: "?", levels: levels(256) } }],
      ["a blank score level", { answer: { type: "score", instructions: "?", levels: ["low", "  "] } }],
    ];
    for (const [name, questions] of cases) {
      expect(geminiQuestionsFit(questions), name).toBe(false);
      const fetchImpl = vi.fn<typeof fetch>();
      await expect(decide(fetchImpl, { questions }), name).resolves.toEqual({ ok: false, reason: "misconfigured" });
      expect(fetchImpl, name).not.toHaveBeenCalled();
    }
    expect(geminiQuestionsFit(many(1000))).toBe(true);
    expect(geminiQuestionsFit({ answer: { type: "choice", instructions: "?", options: options(255) } })).toBe(true);
    expect(geminiQuestionsFit({ answer: { type: "score", instructions: "?", levels: levels(255) } })).toBe(true);
  });

  it("authenticates with x-goog-api-key only, and never follows a redirect", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ answers: { answer: { noul: 0.5 } } }));
    await decide(fetchImpl);
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(init.headers).toEqual({ "x-goog-api-key": KEY, "content-type": "application/json", accept: "application/json" });
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(init.redirect).toBe("error");
  });
});

describe("Gemini Decision 1's answers", () => {
  const questions: Record<string, DeciderQuestion> = {
    need_reply: { type: "yesno", instructions: "Does this need a reply?" },
    route: { type: "choice", instructions: "Who?", options: { maya: "Maya", theo: "Theo" } },
    urgency: { type: "score", instructions: "How urgent?", levels: ["low", "medium", "high"] },
  };

  it("reads confidence and legend as extras, takes total_input_tokens, and always names this model", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({
      answers: {
        need_reply: { type: "noul", noul: 0.03, confidence: 0.97 },
        route: { type: "choice", choice: "theo", probabilities: { maya: 0.01, theo: 0.99 }, confidence: 0.99 },
        urgency: { type: "score", score: 1.12, legend: { 0: "low" }, probabilities: { 0: 0.03, 1: 0.83, 2: 0.14 }, confidence: 0.83 },
      },
      usage: { total_input_tokens: 100, total_output_tokens: 0, total_tokens: 100 },
      model: "gemini-decision-1-2026",
    }));
    const result = await decide(fetchImpl, { questions });
    expect(result).toMatchObject({ ok: true, inputTokens: 100, model: GEMINI_DECISION_MODEL });
    if (!result.ok) throw new Error("expected answers");
    expect(result.answers).toMatchObject({
      need_reply: { type: "yesno", p: 0.03 },
      route: { type: "choice", choice: "theo", pTop: 0.99 },
      urgency: { type: "score", score: 1.12, level: 1 },
    });
    expect(result.model).toBe("gemini-decision-1");
  });

  it("never reads Jev's usage.input_tokens field", async () => {
    const body = { answers: { answer: { noul: 0.5 } }, usage: { input_tokens: 612 } };
    const result = await decide(vi.fn<typeof fetch>().mockResolvedValue(json(body)));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected answers");
    expect(result.inputTokens).toBeUndefined();
  });

  it("a body that is not JSON, or answers Jev's validator refuses, is malformed", async () => {    const bad = [
      new Response("<html>gateway</html>", { status: 200 }),
      json({ answers: { answer: { type: "choice", choice: "quinn", probabilities: { quinn: 1 } } } }),
      json({ answers: {} }),
      json({}),
    ];
    for (const response of bad) {
      await expect(decide(vi.fn<typeof fetch>().mockResolvedValue(response))).resolves.toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("a network failure is unreachable and never names the key", async () => {
    const result = await decide(vi.fn<typeof fetch>().mockRejectedValue(new TypeError(`fetch failed for ${KEY}`)));
    expect(result).toEqual({ ok: false, reason: "unreachable" });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});

describe("Gemini Decision 1's failures", () => {
  const safety = (code: string) => JSON.stringify({ error: { code, status: "INVALID_ARGUMENT" } });
  const invalidKey = JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } });

  it.each([
    ["safety", 400, safety("safety"), "blocked"],
    ["prohibited_content", 400, safety("prohibited_content"), "blocked"],
    ["blocklist", 400, safety("blocklist"), "blocked"],
    ["image_safety", 400, safety("image_safety"), "blocked"],
    ["content_blocked", 400, safety("content_blocked"), "blocked"],
    ["API_KEY_INVALID", 400, invalidKey, "rejected"],
    ["401", 401, "{}", "rejected"],
    ["403", 403, "{}", "rejected"],
    ["429", 429, "{}", "rate_limited"],
    ["503", 503, "{}", "overloaded"],
    ["529", 529, "{}", "overloaded"],
    ["413", 413, "{}", "too_large"],
    ["an unknown 400", 400, "{}", "http_error"],
    ["500", 500, "{}", "http_error"],
  ] as Array<[string, number, string, string]>)("%s → %s, called once", async (_name, status, body, reason) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
    const result = await decide(fetchImpl);
    expect(result).toMatchObject({ ok: false, reason, status });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("reads at most 16 KiB of an error body and cancels the rest", async () => {
    const marker = "SENSITIVE-ERROR-ECHO";
    // Complete JSON that would classify as blocked, with the marker and the safety code only past the 16 KiB cap.
    const text = `{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"${"x".repeat(20_000)}${marker}","details":[{"reason":"safety"}]}}`;
    expect(text.indexOf(marker)).toBeGreaterThan(16 * 1024);
    expect(text.indexOf('"reason":"safety"')).toBeGreaterThan(16 * 1024);
    const bytes = new TextEncoder().encode(text);
    const chunkSize = 1024;
    const chunks = Array.from({ length: Math.ceil(bytes.length / chunkSize) }, (_, i) => bytes.subarray(i * chunkSize, (i + 1) * chunkSize));
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls < chunks.length) controller.enqueue(chunks[pulls++]!);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await decide(vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 400 })));
    // Truncated mid-JSON: the marker and the safety code after the cap were never read, so this is a plain 400.
    expect(result).toEqual({ ok: false, reason: "http_error", status: 400 });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(chunks.length);
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("classifies an unparseable error body by its status alone", () => {
    expect(geminiRefusal(400, "not json")).toEqual({ ok: false, reason: "http_error", status: 400 });
    expect(geminiRefusal(429, "")).toEqual({ ok: false, reason: "rate_limited", status: 429 });
  });
});
