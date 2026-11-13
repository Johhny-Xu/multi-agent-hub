// Google's Decisions API (aistudio.google.com/docs/decisions-api, Oct 2026): one POST <root>/decisions with `input`
// where Jev takes `state`, answers in Jev's shape, and token counts under `usage.total_input_tokens`. It is not a chat
// model — no text, no tools, no structured output. Error bodies are read only to classify a failure, never into a
// message: they can echo the request.
import { isLoopback } from "../provider-key-check.ts";
import { parseJevResponse } from "./jev.ts";
import type { BackendRequest, BackendResult, DeciderAnswer, DeciderBackend, DeciderQuestion } from "./types.ts";

export const GEMINI_DECISIONS_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_DECISION_MODEL = "gemini-decision-1";

/** One call takes 1–1000 questions; each key is 1–64 of [A-Za-z0-9_-]. */
const MAX_QUESTIONS = 1000;
const QUESTION_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const MIN_CHOICES = 2;
const MAX_CHOICES = 255;
const MIN_LEVELS = 2;
const MAX_LEVELS = 255;
const MAX_OPTION_KEY = 128;
const CONTROL_CHARACTER = /\p{Cc}/u;

/** Null when the key must not be sent there: https anywhere, plain http only to this machine. */
export function geminiDecisionsEndpoint(baseUrl?: string | null): URL | null {
  const root = (baseUrl?.trim() || GEMINI_DECISIONS_DEFAULT_BASE_URL).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(`${root}/decisions`);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url;
  return url.protocol === "http:" && isLoopback(url.hostname) ? url : null;
}

/** Choice keys are 1–128 characters, with no outer whitespace and no control characters. */
function optionKeyFits(key: string): boolean {
  return key.length >= 1 && key.length <= MAX_OPTION_KEY && key === key.trim() && !CONTROL_CHARACTER.test(key);
}

function questionFits(question: DeciderQuestion): boolean {
  if (question.type === "choice") {
    const keys = Object.keys(question.options);
    return keys.length >= MIN_CHOICES && keys.length <= MAX_CHOICES && keys.every(optionKeyFits);
  }
  if (question.type === "score") {
    return question.levels.length >= MIN_LEVELS && question.levels.length <= MAX_LEVELS && question.levels.every((level) => Boolean(level.trim()));
  }
  return true;
}

/** Questions within the API's limits: 1–1000 of them, keys 1–64 of [A-Za-z0-9_-]. */
export function geminiQuestionsFit(questions: Record<string, DeciderQuestion>): boolean {
  const entries = Object.entries(questions);
  if (entries.length < 1 || entries.length > MAX_QUESTIONS) return false;
  return entries.every(([id, question]) => QUESTION_KEY.test(id) && questionFits(question));
}

/** The API's `input` is never empty: a string goes as it is, anything else as JSON. Null when neither is usable. */
export function geminiInput(state: unknown): string | null {
  if (typeof state === "string") return state.trim() ? state : null;
  try {
    return JSON.stringify(state) || null;
  } catch {
    return null;
  }
}

type WireQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string; criteria?: { true_description?: string; false_description?: string } };

export interface GeminiRequestBody {
  model: string;
  input: string;
  questions: Record<string, WireQuestion>;
}

/** Null when `state` has no usable input; the caller then fails before the request. */
export function geminiRequestBody(state: unknown, questions: Record<string, DeciderQuestion>): GeminiRequestBody | null {
  const input = geminiInput(state);
  if (input === null) return null;
  const wire: Record<string, WireQuestion> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === "choice") {
      wire[id] = { type: "choice", instructions: question.instructions, criteria: { ...question.options } };
    } else if (question.type === "score") {
      wire[id] = { type: "score", instructions: question.instructions, criteria: [...question.levels] };
    } else {
      const criteria = question.criteria?.yes || question.criteria?.no
        ? { ...(question.criteria.yes ? { true_description: question.criteria.yes } : {}), ...(question.criteria.no ? { false_description: question.criteria.no } : {}) }
        : undefined;
      wire[id] = { type: "noul", instructions: question.instructions, ...(criteria ? { criteria } : {}) };
    }
  }
  return { model: GEMINI_DECISION_MODEL, input, questions: wire };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Answers go through Jev's validator unchanged; only the token field differs, and the model is always this one. */
export function parseGeminiResponse(
  body: unknown,
  questions: Record<string, DeciderQuestion>,
): { ok: true; answers: Record<string, DeciderAnswer>; inputTokens?: number; model: string } | { ok: false } {
  const parsed = parseJevResponse(body, questions);
  if (!parsed.ok) return { ok: false };
  const usage = isRecord(body) && isRecord(body.usage) ? body.usage.total_input_tokens : undefined;
  const inputTokens = typeof usage === "number" && Number.isFinite(usage) && usage >= 0 ? usage : undefined;
  return { ok: true, answers: parsed.answers, ...(inputTokens !== undefined ? { inputTokens } : {}), model: GEMINI_DECISION_MODEL };
}

const SAFETY_CODES = new Set(["safety", "prohibited_content", "blocklist", "image_safety", "content_blocked"]);

/** The documented places a code can sit: error.code, error.status and details[].reason. */
function errorCodes(body: unknown): string[] {
  if (!isRecord(body)) return [];
  const error = isRecord(body.error) ? body.error : {};
  const codes: string[] = [];
  for (const value of [error.code, error.status]) if (typeof value === "string") codes.push(value.toLowerCase());
  if (Array.isArray(error.details)) {
    for (const detail of error.details) {
      if (isRecord(detail) && typeof detail.reason === "string") codes.push(detail.reason.toLowerCase());
    }
  }
  return codes;
}

/** A fixed reason per failure; the body is only inspected for its codes and never returned. */
export function geminiRefusal(status: number, errorBody: string): BackendResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(errorBody);
  } catch {
    parsed = undefined;
  }
  const codes = errorCodes(parsed);
  if (status === 400 && codes.some((code) => SAFETY_CODES.has(code))) return { ok: false, reason: "blocked", status };
  if (status === 400 && codes.includes("api_key_invalid")) return { ok: false, reason: "rejected", status };
  if (status === 401 || status === 403) return { ok: false, reason: "rejected", status };
  if (status === 429) return { ok: false, reason: "rate_limited", status };
  if (status === 503 || status === 529) return { ok: false, reason: "overloaded", status };
  if (status === 413) return { ok: false, reason: "too_large", status };
  return { ok: false, reason: "http_error", status };
}

const ERROR_BODY_MAX = 16 * 1024;

/** At most 16 KiB to read the codes, then the rest is cancelled; the text never leaves this function. */
async function readErrorBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < ERROR_BODY_MAX) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const take = value.byteLength > ERROR_BODY_MAX - size ? value.subarray(0, ERROR_BODY_MAX - size) : value;
      chunks.push(take);
      size += take.byteLength;
    }
  } catch {
    // A broken error body still has its status; an empty body classifies as http_error.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function decide(request: BackendRequest): Promise<BackendResult> {
  const endpoint = geminiDecisionsEndpoint(request.baseUrl);
  const body = geminiRequestBody(request.state, request.questions);
  if (!endpoint || !body || !geminiQuestionsFit(request.questions)) return { ok: false, reason: "misconfigured" };
  let response: Response;
  try {
    response = await request.fetch(endpoint, {
      method: "POST",
      headers: { "x-goog-api-key": request.key, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: request.signal,
      // Never replay the key to wherever a redirect points.
      redirect: "error",
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (!response.ok) return geminiRefusal(response.status, await readErrorBody(response));
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const result = parseGeminiResponse(parsed, request.questions);
  return result.ok ? result : { ok: false, reason: "malformed" };
}

export const geminiBackend: DeciderBackend = { id: "gemini", decide };
