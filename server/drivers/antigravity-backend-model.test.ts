import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { ModelCatalog, ProviderAdapter } from "../contracts.ts";
import type { RuntimeEvent, RuntimeEventListener } from "../../shared/runtime-events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import {
  AntigravityBackendBook,
  ServedModelTracker,
  allAntigravityConversationDirs,
  antigravityConversationDirs,
  catalogWithBackendModels,
  conversationDbPath,
  decodeAntigravityGeneration,
  labelKey,
  readAntigravityGenerations,
  resolveGenerationModels,
  sameAntigravityModel,
  servedModelReport,
  type AntigravityGeneration,
} from "./antigravity-backend-model.ts";
import { instanceConversationDirs, servedModelNotice, withServedModels } from "./antigravity.ts";

// ---- a tiny protobuf writer for GeneratorMetadata-shaped rows ----
const varint = (value: number) => {
  const out: number[] = [];
  while (value >= 0x80) { out.push((value % 128) | 0x80); value = Math.floor(value / 128); }
  out.push(value);
  return out;
};
const bytes = (no: number, payload: Uint8Array | number[]) => [...varint(no * 8 + 2), ...varint(payload.length), ...payload];
const text = (no: number, value: string) => bytes(no, [...new TextEncoder().encode(value)]);
const num = (no: number, value: number) => [...varint(no * 8), ...varint(value)];
function generationBlob(input: { model?: string; label?: string; modelEnum?: number; responseId?: string }): Uint8Array {
  const usage = [...num(1, input.modelEnum ?? 1318), ...num(2, 120), ...num(3, 40), ...text(11, input.responseId ?? "resp")];
  const chat = [
    ...bytes(4, usage),
    ...bytes(9, num(2, 7)),
    ...(input.model !== undefined ? text(19, input.model) : []),
    ...(input.label !== undefined ? text(21, input.label) : []),
  ];
  return Uint8Array.from([...bytes(1, chat), ...num(2, 3)]);
}

const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) removeTempDir(dir); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "omb-agy-backend-")); temps.push(dir); return dir; };

function writeConversation(dir: string, sessionId: string, rows: Array<Parameters<typeof generationBlob>[0] | Uint8Array>): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.db`);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)");
  const start = Number((db.prepare("SELECT COALESCE(MAX(idx), -1) AS m FROM gen_metadata").get() as { m: number }).m) + 1;
  const insert = db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");
  rows.forEach((row, index) => insert.run(start + index, row instanceof Uint8Array ? row : generationBlob(row)));
  db.close();
  return path;
}

const gen = (idx: number, fields: Omit<AntigravityGeneration, "idx"> = {}): AntigravityGeneration => ({ idx, ...fields });
const CATALOG: ModelCatalog = {
  default: "gemini-3.8-flash",
  options: [
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
    { id: "my-local", label: "Gemini 3.8 Flash", custom: true },
  ],
};

describe("decodeAntigravityGeneration", () => {
  it("reads responseModel #19, label #21 and the usage enum from a gen_metadata blob", () => {
    expect(decodeAntigravityGeneration(4, generationBlob({ model: "gemini-3.8-flash-n", label: "Gemini 3.8 Flash (High)", modelEnum: 1318 })))
      .toEqual({ idx: 4, responseModel: "gemini-3.8-flash-n", label: "Gemini 3.8 Flash (High)", modelEnum: 1318 });
  });

  it("keeps a row without #19 and returns null for bytes that are not a protobuf message", () => {
    expect(decodeAntigravityGeneration(0, generationBlob({ label: "Gemini 3.8 Flash (High)" }))).toEqual({ idx: 0, label: "Gemini 3.8 Flash (High)", modelEnum: 1318 });
    expect(decodeAntigravityGeneration(0, Uint8Array.from([0x0a, 0x50, 1, 2]))).toBeNull();
    expect(decodeAntigravityGeneration(0, Uint8Array.from([0x0f]))).toBeNull();
  });
});

describe("resolveGenerationModels (tokscale rules)", () => {
  it("prefers each row's own #19 and treats gemini-default as a routing label, not a model", () => {
    expect(resolveGenerationModels([
      gen(0, { responseModel: "gemini-3.8-flash-n", label: "Gemini 3.8 Flash (High)" }),
      gen(1, { responseModel: "gemini-default", label: "Gemini 3.8 Flash (High)" }),
    ])).toEqual(["gemini-3.8-flash-n", "gemini-3.8-flash-n"]);
  });

  it("borrows the id a label carries elsewhere, but not when the label is ambiguous or never identified", () => {
    expect(resolveGenerationModels([gen(0, { label: "A" }), gen(1, { responseModel: "a-1", label: "A" })])).toEqual(["a-1", "a-1"]);
    expect(resolveGenerationModels([
      gen(0, { responseModel: "a-1", label: "A" }), gen(1, { responseModel: "a-2", label: "A" }), gen(2, { label: "A" }),
    ])[2]).toBeUndefined();
    expect(resolveGenerationModels([gen(0, { responseModel: "a-1", label: "A" }), gen(1, { label: "B" })])[1]).toBeUndefined();
  });

  it("gives an unlabelled row the conversation's sole model only when every label was identified", () => {
    expect(resolveGenerationModels([gen(0, { responseModel: "a-1", label: "A" }), gen(1)])[1]).toBe("a-1");
    expect(resolveGenerationModels([gen(0, { responseModel: "a-1", label: "A" }), gen(1, { label: "B" }), gen(2)])[2]).toBeUndefined();
  });
});

describe("conversation database", () => {
  it("reads every generation from gen_metadata read-only, oldest first", () => {
    const dir = tempDir();
    const path = writeConversation(dir, "11111111-aaaa", [
      { model: "gemini-3.8-flash-n", label: "Gemini 3.8 Flash (High)" },
      Uint8Array.from([0xff, 0xff]),
      { model: "gemini-4-argon-trial", label: "Gemini 4 Argon (Medium)", modelEnum: 1418 },
    ]);
    expect(readAntigravityGenerations(path).map((row) => [row.idx, row.responseModel])).toEqual([[0, "gemini-3.8-flash-n"], [2, "gemini-4-argon-trial"]]);
  });

  it("returns [] for a missing file, a database without gen_metadata and a file that is not SQLite", () => {
    const dir = tempDir();
    expect(readAntigravityGenerations(join(dir, "none.db"))).toEqual([]);
    const empty = new DatabaseSync(join(dir, "empty.db"));
    empty.exec("CREATE TABLE steps (id INTEGER)");
    empty.close();
    expect(readAntigravityGenerations(join(dir, "empty.db"))).toEqual([]);
    writeFileSync(join(dir, "junk.db"), "not sqlite at all");
    expect(readAntigravityGenerations(join(dir, "junk.db"))).toEqual([]);
  });

  it("finds a session's database by id and refuses ids that are not plain names", () => {
    const dir = tempDir();
    writeConversation(join(dir, "b"), "abcdef12-3456", [{ model: "x-1", label: "X" }]);
    expect(conversationDbPath([join(dir, "a"), join(dir, "b")], "abcdef12-3456")).toBe(join(dir, "b", "abcdef12-3456.db"));
    expect(conversationDbPath([join(dir, "b")], "../b/abcdef12-3456")).toBeUndefined();
    expect(conversationDbPath([join(dir, "b")], "missing-session")).toBeUndefined();
  });

  it("lists the person's own folder and each added account's profile HOME", () => {
    const dir = tempDir();
    const home = join(dir, "home");
    mkdirSync(join(home, ".gemini", "antigravity-cli", "conversations"), { recursive: true });
    mkdirSync(join(dir, "data", "providers", "antigravity", "abc", "home", ".gemini", "antigravity-cli", "conversations"), { recursive: true });
    mkdirSync(join(dir, "data", "providers", "antigravity", "def"), { recursive: true });
    expect(allAntigravityConversationDirs(join(dir, "data"), home)).toEqual([
      join(home, ".gemini", "antigravity-cli", "conversations"),
      join(dir, "data", "providers", "antigravity", "abc", "home", ".gemini", "antigravity-cli", "conversations"),
    ]);
    expect(antigravityConversationDirs({ HOME: "/h", GEMINI_HOME: "/g" })).toEqual([
      join("/h", ".gemini", "antigravity-cli", "conversations"), join("/g", "antigravity-cli", "conversations"), join("/g", "conversations"),
    ]);
  });

  it("points the primary instance at the real HOME and an added account at its profile HOME", () => {
    const primary = instanceConversationDirs("antigravity", { HOME: "/home/p" }, "/data");
    expect(primary[0]).toBe(join("/home/p", ".gemini", "antigravity-cli", "conversations"));
    const added = instanceConversationDirs("antigravity-1234", { HOME: "/home/p" }, "/data");
    expect(added[0]).toMatch(/\/data\/providers\/antigravity\/[0-9a-f]{64}\/home\/\.gemini\/antigravity-cli\/conversations$/u);
    expect(added.some((dir) => dir.startsWith("/home/p"))).toBe(false);
  });
});

describe("AntigravityBackendBook and the catalog", () => {
  it("matches a catalog model by the label without its thinking level, and an asked-for id first", () => {
    expect(labelKey("Gemini 3.8 Flash (High)")).toBe("gemini 3.8 flash");
    expect(labelKey("Claude Sonnet 4.6 (Thinking)")).toBe("claude sonnet 4.6 (thinking)");
    const book = new AntigravityBackendBook();
    book.record("gemini-3.8-flash-n", { label: "Gemini 3.8 Flash (High)", at: 1 });
    book.record("claude-sonnet-4-6-thinking", { label: "Claude Sonnet 4.6 (Thinking)", at: 1 });
    expect(book.lookup(CATALOG.options[0]!)).toBe("gemini-3.8-flash-n");
    expect(book.lookup(CATALOG.options[1]!)).toBe("claude-sonnet-4-6-thinking");
    book.record("gemini-3.8-flash-x", { optionId: "gemini-3.8-flash", at: 2 });
    expect(book.lookup(CATALOG.options[0]!)).toBe("gemini-3.8-flash-x");
  });

  it("keeps the newest observation and ignores the routing label", () => {
    const book = new AntigravityBackendBook();
    book.record("new-id", { label: "M", at: 20 });
    book.record("old-id", { label: "M", at: 10 });
    book.record("gemini-default", { label: "N", at: 30 });
    expect(book.lookup({ id: "m", label: "M" })).toBe("new-id");
    expect(book.lookup({ id: "n", label: "N" })).toBeUndefined();
  });

  it("learns from the newest conversation files first and only up to the limit", async () => {
    const dir = tempDir();
    const older = writeConversation(dir, "older-0001", [{ model: "old-flash", label: "Gemini 3.8 Flash (High)" }]);
    writeConversation(dir, "newer-0002", [{ model: "gemini-3.8-flash-n", label: "Gemini 3.8 Flash (Low)" }, { label: "Gemini 3.8 Flash (Low)" }]);
    utimesSync(older, new Date(1_000_000), new Date(1_000_000));
    const book = new AntigravityBackendBook();
    expect(await book.scan([dir], 1, async () => {})).toBe(2);
    expect(book.lookup(CATALOG.options[0]!)).toBe("gemini-3.8-flash-n");
    const all = new AntigravityBackendBook();
    await all.scan([dir, join(dir, "gone")], 10, async () => {});
    expect(all.lookup(CATALOG.options[0]!)).toBe("gemini-3.8-flash-n");
  });

  it("adds backendModel to built-in models only, and returns the same catalog object until something new is learned", () => {
    const book = new AntigravityBackendBook();
    const enrich = catalogWithBackendModels();
    expect(enrich(CATALOG, book)).toBe(CATALOG);
    book.record("gemini-3.8-flash-n", { label: "Gemini 3.8 Flash (High)" });
    const first = enrich(CATALOG, book);
    expect(first.options.map((option) => option.backendModel)).toEqual(["gemini-3.8-flash-n", undefined, undefined]);
    expect(enrich(CATALOG, book)).toBe(first);
    expect(CATALOG.options[0]!.backendModel).toBeUndefined();
  });
});

describe("served model per turn", () => {
  it("treats a serving suffix as the same model and another family or version as a mismatch", () => {
    expect(sameAntigravityModel("gemini-3.8-flash", "gemini-3.8-flash-n")).toBe(true);
    expect(sameAntigravityModel("gemini-4-argon-medium", "gemini-4-argon-trial")).toBe(true);
    expect(sameAntigravityModel("gemini-3.8-flash", "gemini-3.5-flash-high")).toBe(false);
    expect(sameAntigravityModel("claude-opus-4-6-thinking", "claude-sonnet-4-6")).toBe(false);
    expect(sameAntigravityModel("gpt-oss-120b-medium", "openai-oss-120b", "openai-oss-120b")).toBe(true);
    expect(sameAntigravityModel(undefined, "anything")).toBe(true);
  });

  it("reports only generations after the turn's baseline", () => {
    const rows = [gen(0, { responseModel: "old-x", label: "X" }), gen(1, { responseModel: "gemini-3.8-flash-n", label: "Gemini 3.8 Flash (High)" })];
    expect(servedModelReport(rows, 0, "gemini-3.8-flash")).toEqual({
      served: ["gemini-3.8-flash-n"], label: "Gemini 3.8 Flash (High)", requested: "gemini-3.8-flash", mismatch: false,
    });
    expect(servedModelReport(rows, 1, "gemini-3.8-flash")).toBeNull();
    expect(servedModelReport(rows, -1, "gemini-3.8-flash")?.mismatch).toBe(true);
  });

  it("tracks a turn from session.started to turn.completed and teaches the book", () => {
    const dir = tempDir();
    writeConversation(dir, "sess-0001", [{ model: "earlier-model", label: "Earlier" }]);
    const book = new AntigravityBackendBook();
    const tracker = new ServedModelTracker({ dirs: () => [dir], book, catalog: () => CATALOG });
    tracker.started("t1", "sess-0001", "gemini-3.8-flash");
    expect(tracker.report("t1")).toBeNull();
    expect(tracker.watching("t1")).toBe(true);
    writeConversation(dir, "sess-0001", [{ model: "gemini-3.8-flash-n", label: "Gemini 3.8 Flash (Low)" }]);
    expect(tracker.report("t1")).toMatchObject({ served: ["gemini-3.8-flash-n"], mismatch: false });
    expect(tracker.watching("t1")).toBe(false);
    expect(book.lookup(CATALOG.options[0]!)).toBe("gemini-3.8-flash-n");
  });

  it("does not teach the asked-for model a backend that answered as another model", () => {
    const dir = tempDir();
    const book = new AntigravityBackendBook();
    const tracker = new ServedModelTracker({ dirs: () => [dir], book, catalog: () => CATALOG });
    tracker.started("t2", "sess-0002", "gemini-3.8-flash");
    writeConversation(dir, "sess-0002", [{ model: "gemini-3.5-flash-high", label: "Gemini 3.5 Flash (High)" }]);
    expect(tracker.report("t2")?.mismatch).toBe(true);
    expect(book.lookup(CATALOG.options[0]!)).toBeUndefined();
    expect(book.lookup({ id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" })).toBe("gemini-3.5-flash-high");
  });

  it("words the chat notice for a match and for a mismatch", () => {
    expect(servedModelNotice({ served: ["gemini-3.8-flash-n"], label: "Gemini 3.8 Flash (High)", requested: "gemini-3.8-flash", mismatch: false }))
      .toEqual({ message: "Antigravity backend model for this turn: gemini-3.8-flash-n (Gemini 3.8 Flash (High)).",
        text: { key: "chat.notice.antigravityServedModel", params: { served: "gemini-3.8-flash-n", label: "Gemini 3.8 Flash (High)" } } });
    const mismatch = servedModelNotice({ served: ["gemini-3.5-flash-high"], requested: "gemini-3.8-flash", mismatch: true });
    expect(mismatch.text.key).toBe("chat.notice.antigravityServedModelMismatch");
    expect(mismatch.message).toBe("This turn asked Antigravity for gemini-3.8-flash, but its backend answered with gemini-3.5-flash-high (gemini-3.5-flash-high).");
  });
});

describe("withServedModels", () => {
  function harness(dir: string) {
    const inner = new Set<RuntimeEventListener>();
    const baseAdapter = { provider: "antigravityAgent", onEvent: (listener: RuntimeEventListener) => { inner.add(listener); return () => inner.delete(listener); } } as unknown as ProviderAdapter;
    const timers: Array<() => void> = [];
    const tracker = new ServedModelTracker({ dirs: () => [dir], book: new AntigravityBackendBook(), catalog: () => CATALOG });
    const adapter = withServedModels({ adapter: baseAdapter, driverKind: "antigravityAgent", instanceId: "antigravity" }, tracker, (run) => { timers.push(run); });
    const seenA: RuntimeEvent[] = [];
    const seenB: RuntimeEvent[] = [];
    adapter.onEvent((event) => seenA.push(event));
    adapter.onEvent((event) => seenB.push(event));
    const fire = (fields: Record<string, unknown>) => {
      const event = { eventId: `ev-${Math.random()}`, provider: "antigravityAgent", providerInstanceId: "antigravity", threadId: "th", turnId: "tu", createdAt: "2026-11-11T00:00:00Z", ...fields } as RuntimeEvent;
      for (const listener of inner) listener(event);
    };
    return { fire, seenA, seenB, timers, inner, dir };
  }

  it("adds servedModel to turn.completed without a chat line when the backend matches, reading once for every listener", () => {
    const dir = tempDir();
    const h = harness(dir);
    h.fire({ type: "session.started", sessionId: "sess-1000", model: "gemini-3.8-flash" });
    writeConversation(dir, "sess-1000", [{ model: "gemini-3.8-flash-n", label: "Gemini 3.8 Flash (Low)" }]);
    h.fire({ type: "turn.completed", ok: true });
    for (const seen of [h.seenA, h.seenB]) {
      expect(seen.map((event) => event.type)).toEqual(["session.started", "turn.completed"]);
      expect(seen[1]).toMatchObject({ servedModel: "gemini-3.8-flash-n" });
    }
    expect(h.seenA[1]).toBe(h.seenB[1]);
    expect(h.timers).toEqual([]);
  });

  it("puts the mismatch notice before turn.completed when the backend served another model", () => {
    const dir = tempDir();
    const h = harness(dir);
    h.fire({ type: "session.started", sessionId: "sess-1100", model: "gemini-3.8-flash" });
    writeConversation(dir, "sess-1100", [{ model: "gemini-3.5-flash-high", label: "Gemini 3.5 Flash (High)" }]);
    h.fire({ type: "turn.completed", ok: true });
    for (const seen of [h.seenA, h.seenB]) {
      expect(seen.map((event) => event.type)).toEqual(["session.started", "runtime.notice", "turn.completed"]);
      expect(seen[1]).toMatchObject({ turnId: "tu", text: { key: "chat.notice.antigravityServedModelMismatch" } });
      expect(seen[2]).toMatchObject({ servedModel: "gemini-3.5-flash-high" });
    }
    expect(h.seenA[1]!.eventId).toBe(h.seenB[1]!.eventId);
  });

  it("reads again after the turn when agy had not written the generation yet (notice only on a mismatch), then gives up quietly", () => {
    const dir = tempDir();
    const h = harness(dir);
    h.fire({ type: "session.started", sessionId: "sess-2000", model: "gemini-3.8-flash" });
    h.fire({ type: "turn.completed", ok: true });
    expect(h.seenA.map((event) => event.type)).toEqual(["session.started", "turn.completed"]);
    expect(h.seenA[1]).not.toHaveProperty("servedModel");
    writeConversation(dir, "sess-2000", [{ model: "gemini-3.5-flash-high", label: "Gemini 3.5 Flash (High)" }]);
    h.timers.shift()!();
    expect(h.seenA.map((event) => event.type)).toEqual(["session.started", "turn.completed", "runtime.notice"]);
    expect(h.seenA[2]).toMatchObject({ text: { key: "chat.notice.antigravityServedModelMismatch" } });
    const late = harness(tempDir());
    late.fire({ type: "session.started", sessionId: "sess-2100", model: "gemini-3.8-flash" });
    late.fire({ type: "turn.completed", ok: true });
    writeConversation(late.dir, "sess-2100", [{ model: "gemini-3.8-flash-n", label: "Gemini 3.8 Flash (Low)" }]);
    late.timers.shift()!();
    expect(late.seenA.map((event) => event.type)).toEqual(["session.started", "turn.completed"]);
    expect(late.timers).toEqual([]);
    const quiet = harness(tempDir());
    quiet.fire({ type: "session.started", sessionId: "sess-3000", model: "gemini-3.8-flash" });
    quiet.fire({ type: "turn.completed", ok: true });
    while (quiet.timers.length) quiet.timers.shift()!();
    expect(quiet.seenA.map((event) => event.type)).toEqual(["session.started", "turn.completed"]);
  });

  it("passes every other event through untouched and never throws on a turn it did not see start", () => {
    const h = harness(tempDir());
    h.fire({ type: "content.delta", streamKind: "assistant_text", delta: "hi" });
    h.fire({ type: "turn.completed", ok: false, turnId: "unknown" });
    h.fire({ type: "session.started", sessionId: null });
    expect(h.seenA.map((event) => event.type)).toEqual(["content.delta", "turn.completed", "session.started"]);
    expect(h.timers).toEqual([]);
  });
});
