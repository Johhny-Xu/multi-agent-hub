// Which backend model actually answered an Antigravity turn, read from the agy CLI's own conversation database.
//
// Adapted from two MIT-licensed projects (the decoding approach, field numbers and the recovery rules; no code is
// copied verbatim):
//   - token-monitor, Copyright (c) 2026 Javis, MIT — https://github.com/Javis603/token-monitor
//     (src/shared/providers/antigravity: model configs map a display label to `modelOrAlias.model`, an internal
//     MODEL_PLACEHOLDER_* enum; per-generation usage comes from tokscale, below)
//   - tokscale, Copyright (c) 2025 Junho Yeo, MIT — https://github.com/junhoyeo/tokscale
//     (crates/tokscale-core/src/sessions/antigravity_cli.rs: `gen_metadata` rows are `GeneratorMetadata` protobufs;
//     `#1` chatModel → `#19` responseModel, `#21` display label, `#4` usage → `#1` model enum, `#11` response id;
//     "gemini-default" is a routing label, never a model; a row without `#19` borrows the id its label has elsewhere
//     in the same conversation)
//
// Reading is local and read-only: no network, no token, no quota, and it never touches the account files, so it
// works the same for the keyring-free CLI, consumer sign-ins and any number of saved accounts.
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ModelCatalog } from "../contracts.ts";

export interface AntigravityGeneration {
  /** `gen_metadata.idx`: grows by one per generation within a conversation. */
  idx: number;
  /** `#1.#19`, e.g. `gemini-3.8-flash-n`: the id Google's backend answered with. */
  responseModel?: string;
  /** `#1.#21`, e.g. `Gemini 3.8 Flash (High)`: the label the app showed for it. */
  label?: string;
  /** `#1.#4.#1`, the MODEL_PLACEHOLDER_* enum number (1318 = M318). */
  modelEnum?: number;
}

// ---- protobuf wire format (only what the fields above need) ----

type Field = { no: number; wire: number; value: number | Uint8Array };

function varint(buf: Uint8Array, at: number): [number, number] {
  let result = 0;
  let scale = 1;
  for (let i = at; i < buf.length && i < at + 10; i++) {
    const byte = buf[i]!;
    result += (byte & 0x7f) * scale;
    if (byte < 0x80) return [result, i + 1];
    scale *= 128;
  }
  throw new Error("truncated varint");
}

/** Top-level fields of one message; throws on bytes that are not a protobuf message. */
export function protoFields(buf: Uint8Array): Field[] {
  const fields: Field[] = [];
  let at = 0;
  while (at < buf.length) {
    const [key, next] = varint(buf, at);
    at = next;
    const no = Math.floor(key / 8);
    const wire = key % 8;
    if (no < 1) throw new Error("bad field number");
    if (wire === 0) {
      const [value, after] = varint(buf, at);
      fields.push({ no, wire, value });
      at = after;
    } else if (wire === 2) {
      const [length, after] = varint(buf, at);
      if (after + length > buf.length) throw new Error("truncated field");
      fields.push({ no, wire, value: buf.subarray(after, after + length) });
      at = after + length;
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (at + size > buf.length) throw new Error("truncated field");
      fields.push({ no, wire, value: buf.subarray(at, at + size) });
      at += size;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return fields;
}

const bytesField = (fields: Field[], no: number) => {
  const field = fields.find((item) => item.no === no && item.wire === 2);
  return field ? (field.value as Uint8Array) : undefined;
};
const textField = (fields: Field[], no: number) => {
  const bytes = bytesField(fields, no);
  const text = bytes ? new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim() : "";
  // A model id or label is short printable text; anything else is a misread field.
  // oxlint-disable-next-line no-control-regex -- rejecting control characters is the point
  return text && text.length <= 200 && !/[\u0000-\u001f]/u.test(text) ? text : undefined;
};

/** One `gen_metadata.data` blob; null when it is not the GeneratorMetadata layout. */
export function decodeAntigravityGeneration(idx: number, blob: Uint8Array): AntigravityGeneration | null {
  try {
    const chat = bytesField(protoFields(blob), 1);
    if (!chat) return null;
    const fields = protoFields(chat);
    const usage = bytesField(fields, 4);
    const usageEnum = usage ? protoFields(usage).find((item) => item.no === 1 && item.wire === 0)?.value : undefined;
    const generation: AntigravityGeneration = { idx };
    const responseModel = textField(fields, 19);
    const label = textField(fields, 21);
    if (responseModel) generation.responseModel = responseModel;
    if (label) generation.label = label;
    if (typeof usageEnum === "number") generation.modelEnum = usageEnum;
    return generation;
  } catch {
    return null;
  }
}

/** Names the router that served the request, never the model that answered it. */
export function isAntigravityRoutingLabel(model: string): boolean {
  return model.trim().toLowerCase() === "gemini-default";
}

/**
 * The backend id behind each generation, following tokscale's rules: a row's own `#19` (unless it is the routing
 * label); otherwise the id its display label carries on another row of the same conversation, when every such row
 * agrees; otherwise, for an unlabelled row, the conversation's only model when every label in it was identified.
 * Anything else stays unknown rather than guessed.
 */
export function resolveGenerationModels(generations: readonly AntigravityGeneration[]): Array<string | undefined> {
  const byLabel = new Map<string, string | null>();
  const distinct = new Set<string>();
  const unresolvedLabels: string[] = [];
  for (const generation of generations) {
    const model = generation.responseModel;
    if (!model || isAntigravityRoutingLabel(model)) {
      if (generation.label) unresolvedLabels.push(generation.label);
      continue;
    }
    distinct.add(model);
    if (!generation.label) continue;
    const known = byLabel.get(generation.label);
    if (known === undefined) byLabel.set(generation.label, model);
    else if (known !== null && known !== model) byLabel.set(generation.label, null);
  }
  const everyLabelIdentified = unresolvedLabels.every((label) => typeof byLabel.get(label) === "string");
  const sole = distinct.size === 1 && everyLabelIdentified ? [...distinct][0] : undefined;
  return generations.map((generation) => {
    const own = generation.responseModel;
    if (own && !isAntigravityRoutingLabel(own)) return own;
    if (generation.label) return byLabel.get(generation.label) ?? undefined;
    return sole;
  });
}

/** Every generation the conversation database holds, oldest first; [] when it is missing or not readable yet. */
export function readAntigravityGenerations(dbPath: string): AntigravityGeneration[] {
  if (!existsSync(dbPath)) return [];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gen_metadata'").get();
    if (!table) return [];
    const rows = db.prepare("SELECT idx, data FROM gen_metadata ORDER BY idx").all() as Array<{ idx: unknown; data: unknown }>;
    const generations: AntigravityGeneration[] = [];
    for (const row of rows) {
      if (typeof row.idx !== "number" && typeof row.idx !== "bigint") continue;
      if (!(row.data instanceof Uint8Array)) continue;
      const generation = decodeAntigravityGeneration(Number(row.idx), row.data);
      if (generation) generations.push(generation);
    }
    return generations;
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

// ---- where the conversations are ----

const CONVERSATIONS = [".gemini", "antigravity-cli", "conversations"];

/** The conversation folders one Antigravity instance can write to: its agy process's $HOME/.gemini (an added account
 * runs with HOME inside its profile, the primary with the person's own), then GEMINI_HOME for the packaged runtime. */
export function antigravityConversationDirs(environment: Record<string, string | undefined> | undefined): string[] {
  const home = environment?.HOME?.trim() || homedir();
  const dirs = [join(home, ...CONVERSATIONS)];
  const geminiHome = environment?.GEMINI_HOME?.trim();
  if (geminiHome) dirs.push(join(geminiHome, "antigravity-cli", "conversations"), join(geminiHome, "conversations"));
  return [...new Set(dirs)];
}

/** Every Antigravity conversation folder on this computer: the person's own and each added account's profile. */
export function allAntigravityConversationDirs(dataDir: string, home = homedir()): string[] {
  const dirs = [join(home, ...CONVERSATIONS)];
  const profiles = join(dataDir, "providers", "antigravity");
  try {
    for (const entry of readdirSync(profiles)) dirs.push(join(profiles, entry, "home", ...CONVERSATIONS));
  } catch { /* no added accounts */ }
  return dirs.filter((dir) => existsSync(dir));
}

export function conversationDbPath(dirs: readonly string[], sessionId: string): string | undefined {
  if (!/^[\w-]{8,128}$/u.test(sessionId)) return undefined;
  return dirs.map((dir) => join(dir, `${sessionId}.db`)).find((path) => existsSync(path));
}

// ---- what each catalog model is served as ----

const THINKING_SUFFIX = /\s*\((?:extra[\s-]+)?(?:minimal|low|medium|high|max)\)\s*$/iu;
/** "Gemini 3.8 Flash (High)" → "gemini 3.8 flash": the catalog names the model without its thinking level. */
export const labelKey = (label: string) => label.replace(THINKING_SUFFIX, "").trim().toLowerCase();

/** The backend ids seen for each model, learned from finished generations (newest wins). */
export class AntigravityBackendBook {
  private readonly byOption = new Map<string, { model: string; at: number }>();
  private readonly byLabel = new Map<string, { model: string; at: number }>();
  version = 0;

  private put(map: Map<string, { model: string; at: number }>, key: string, model: string, at: number) {
    const known = map.get(key);
    if (known && known.at > at) return;
    if (known?.model !== model) this.version++;
    map.set(key, { model, at });
  }

  /** `label` is the generation's display label; `optionId` the catalog id the turn asked for, when known. */
  record(model: string, input: { label?: string; optionId?: string; at?: number }): void {
    if (!model || isAntigravityRoutingLabel(model)) return;
    const at = input.at ?? Date.now();
    if (input.label) {
      this.put(this.byLabel, input.label.trim().toLowerCase(), model, at);
      this.put(this.byLabel, labelKey(input.label), model, at);
    }
    if (input.optionId) this.put(this.byOption, input.optionId, model, at);
  }

  lookup(option: { id: string; label: string }): string | undefined {
    return this.byOption.get(option.id)?.model
      ?? this.byLabel.get(option.label.trim().toLowerCase())?.model
      ?? this.byLabel.get(labelKey(option.label))?.model;
  }

  /** Learns one conversation database's labelled generations. */
  learnFile(path: string, at: number): number {
    const generations = readAntigravityGenerations(path);
    const models = resolveGenerationModels(generations);
    let learned = 0;
    generations.forEach((generation, index) => {
      const model = models[index];
      if (!model || !generation.label) return;
      this.record(model, { label: generation.label, at });
      learned++;
    });
    return learned;
  }

  /** Learns from the newest conversation databases; read-only, a few milliseconds per file. `pause` runs between
   * files so a long scan never holds the event loop. */
  async scan(dirs: readonly string[], maxFiles = 60, pause: () => Promise<void> = () => new Promise((done) => setImmediate(done))): Promise<number> {
    let learned = 0;
    for (const file of newestConversationFiles(dirs, maxFiles)) {
      learned += this.learnFile(file.path, file.at);
      await pause();
    }
    return learned;
  }
}

export function newestConversationFiles(dirs: readonly string[], maxFiles: number): Array<{ path: string; at: number }> {
  const files: Array<{ path: string; at: number }> = [];
  for (const dir of dirs) {
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".db")) continue;
        const path = join(dir, name);
        try { files.push({ path, at: statSync(path).mtimeMs }); } catch { /* removed meanwhile */ }
      }
    } catch { /* folder gone */ }
  }
  return files.sort((a, b) => b.at - a.at).slice(0, maxFiles);
}

/** The catalog with each model's backend id beside it; the same object back while nothing new was learned. */
export function catalogWithBackendModels(): (catalog: ModelCatalog, book: AntigravityBackendBook) => ModelCatalog {
  let last: { catalog: ModelCatalog; version: number; result: ModelCatalog } | undefined;
  return (catalog, book) => {
    if (last && last.catalog === catalog && last.version === book.version) return last.result;
    let changed = false;
    const options = catalog.options.map((option) => {
      const backendModel = option.custom ? undefined : book.lookup(option);
      if (!backendModel || option.backendModel === backendModel) return option;
      changed = true;
      return { ...option, backendModel };
    });
    const result = changed ? { ...catalog, options } : catalog;
    last = { catalog, version: book.version, result };
    return result;
  };
}

/**
 * Whether a served backend id is the model that was asked for. Backend ids carry serving suffixes the catalog id
 * does not (`gemini-3.8-flash` → `gemini-3.8-flash-n`, `gemini-4-argon` → `gemini-4-argon-trial`), so a prefix at a
 * dash boundary, either way round, counts as the same model; a different family or version does not.
 */
export function sameAntigravityModel(requested: string | null | undefined, served: string, knownBackend?: string): boolean {
  if (!requested) return true;
  const want = requested.trim().toLowerCase().replace(/-(?:low|medium|high)$/u, "");
  const got = served.trim().toLowerCase();
  if (knownBackend && knownBackend.trim().toLowerCase() === got) return true;
  return got === want || got.startsWith(`${want}-`) || want.startsWith(`${got}-`);
}

// ---- per-turn report ----

export interface ServedModelReport {
  /** Distinct backend ids this turn's generations ran on, in order. */
  served: string[];
  /** The display label of the last identified generation, e.g. "Gemini 3.8 Flash (High)". */
  label?: string;
  requested?: string;
  mismatch: boolean;
}

/** What a turn's new generations (idx above `baseline`) ran on; null when the database holds none yet. */
export function servedModelReport(
  generations: readonly AntigravityGeneration[],
  baseline: number,
  requested: string | null | undefined,
  knownBackend?: string,
): ServedModelReport | null {
  const models = resolveGenerationModels(generations);
  const served: string[] = [];
  let label: string | undefined;
  generations.forEach((generation, index) => {
    if (generation.idx <= baseline) return;
    const model = models[index];
    if (!model) return;
    if (!served.includes(model)) served.push(model);
    if (generation.label) label = generation.label;
  });
  if (!served.length) return null;
  return {
    served,
    ...(label ? { label } : {}),
    ...(requested ? { requested } : {}),
    mismatch: served.some((model) => !sameAntigravityModel(requested, model, knownBackend)),
  };
}

export interface ServedModelTrackerDeps {
  dirs: () => string[];
  read?: (dbPath: string) => AntigravityGeneration[];
  book: AntigravityBackendBook;
  catalog: () => ModelCatalog;
}

type TurnWatch = { sessionId: string; requested?: string; baseline: number };

/**
 * Follows one instance's turns: at `session.started` it notes how many generations the conversation already had, and
 * at `turn.completed` reads the new ones. Pure bookkeeping around injected readers so it can be tested without agy.
 */
export class ServedModelTracker {
  private readonly turns = new Map<string, TurnWatch>();
  private readonly deps: ServedModelTrackerDeps;

  constructor(deps: ServedModelTrackerDeps) {
    this.deps = deps;
  }

  private read(sessionId: string): AntigravityGeneration[] {
    const path = conversationDbPath(this.deps.dirs(), sessionId);
    return path ? (this.deps.read ?? readAntigravityGenerations)(path) : [];
  }

  started(turnId: string, sessionId: string | null | undefined, requested: string | null | undefined): void {
    if (!sessionId) return;
    const generations = this.read(sessionId);
    const baseline = generations.reduce((max, generation) => Math.max(max, generation.idx), -1);
    this.turns.set(turnId, { sessionId, baseline, ...(requested ? { requested } : {}) });
    if (this.turns.size > 200) this.turns.delete(this.turns.keys().next().value!);
  }

  watching(turnId: string): boolean {
    return this.turns.has(turnId);
  }

  forget(turnId: string): void {
    this.turns.delete(turnId);
  }

  /** The turn's report, learning its ids into the book; null while the database has nothing new for it. */
  report(turnId: string): ServedModelReport | null {
    const watch = this.turns.get(turnId);
    if (!watch) return null;
    const option = watch.requested
      ? this.deps.catalog().options.find((candidate) => candidate.id === watch.requested)
      : undefined;
    const report = servedModelReport(this.read(watch.sessionId), watch.baseline, watch.requested,
      option ? this.deps.book.lookup(option) : undefined);
    if (!report) return null;
    this.turns.delete(turnId);
    const last = report.served[report.served.length - 1]!;
    // A turn that ran on another model teaches the label it ran under, never the model it asked for.
    this.deps.book.record(last, { label: report.label, ...(report.mismatch ? {} : { optionId: watch.requested }) });
    return report;
  }
}
