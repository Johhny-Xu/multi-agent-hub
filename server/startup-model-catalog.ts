import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelCatalog } from "./contracts.ts";
import { buildStamp } from "./environment.ts";
import { afterFirstEngineRead } from "./first-engine-read.ts";
import { SERVER_ROOT } from "./proxy-paths.ts";

const SAFE_INSTANCE_ID = /^[\w.-]+$/;
/** A list this server's build read this recently is used as it is at start; an older one, or one an earlier build read,
 * is read again in the background. A sleeping Cloud wakes many times an hour, and each read can start the engine's CLI. */
export const STARTUP_MODEL_CACHE_FRESH_MS = 6 * 60 * 60_000;
/** Engines opened since this server started: opening one again means its key or settings just changed. */
const openedThisRun = new Set<string>();
const DRIVER_SOURCE = /\.(?:ts|js)$/;

let driverPrint: string | undefined;

/** A driver update that adds models does not change the release, so a saved list is tied to the driver code that listed it. */
export function driverFingerprint(): string {
  return (driverPrint ??= fingerprintDrivers());
}

function driverSourceFiles(root: string): string[] {
  try {
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && DRIVER_SOURCE.test(entry.name) && !/\.test\./.test(entry.name) && !entry.name.endsWith(".d.ts"))
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/** The release, plus the driver sources a checkout has beside this module; a bundle ships only its proxy entry points,
 * and its driver changes arrive with a new release. */
function fingerprintDrivers(): string {
  const hash = createHash("sha256").update(buildStamp());
  const root = join(SERVER_ROOT, "drivers");
  for (const file of driverSourceFiles(root)) {
    hash.update(file.slice(root.length));
    try {
      hash.update(readFileSync(file));
    } catch {
    }
  }
  return hash.digest("hex");
}

export function startupModelCachePath(instanceId: string): string | null {
  if (!SAFE_INSTANCE_ID.test(instanceId)) return null;
  return join(DATA_DIR, "providers", "engine-models", `${instanceId}.json`);
}

export function laterStartup(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")) as unknown;
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

function variantList(value: unknown): Array<{ id: string; label: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const variants = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const variant = entry as { id?: unknown; label?: unknown };
    return typeof variant.id === "string" && typeof variant.label === "string"
      ? [{ id: variant.id, label: variant.label }]
      : [];
  });
  return variants.length ? variants : undefined;
}

function catalogFrom(value: unknown): ModelCatalog | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { default?: unknown; options?: unknown };
  if (typeof raw.default !== "string" || !Array.isArray(raw.options) || raw.options.length === 0) return null;
  const options: ModelCatalog["options"] = [];
  for (const entry of raw.options) {
    if (!entry || typeof entry !== "object") return null;
    const option = entry as {
      id?: unknown;
      label?: unknown;
      custom?: unknown;
      loaded?: unknown;
      provider?: unknown;
      contextWindow?: unknown;
      variants?: unknown;
      orgBlocked?: unknown;
    };
    if (typeof option.id !== "string" || typeof option.label !== "string") return null;
    const variants = variantList(option.variants);
    options.push({
      id: option.id,
      label: option.label,
      ...(option.custom === true ? { custom: true } : {}),
      ...(option.loaded === true ? { loaded: true } : {}),
      ...(typeof option.provider === "string" ? { provider: option.provider } : {}),
      ...(typeof option.contextWindow === "number" && Number.isFinite(option.contextWindow)
        ? { contextWindow: option.contextWindow }
        : {}),
      ...(variants ? { variants } : {}),
      ...(option.orgBlocked === true ? { orgBlocked: true as const } : {}),
    });
  }
  return { default: raw.default, options };
}

const unconfirmed = new WeakSet<ModelCatalog>();

/** The engine did not give this list (its CLI timed out, or answered nothing): it is saved, but read again at the next start. */
export function unconfirmedModelCatalog(catalog: ModelCatalog): void {
  unconfirmed.add(catalog);
}

export interface StartupModelCacheEntry {
  catalog: ModelCatalog;
  checkedAt: number | null;
  build: string | null;
  /** The driver code that produced the list; a file saved before this existed has none and is read again. */
  fingerprint: string | null;
}

export function readStartupModelCacheEntry(instanceId: string): StartupModelCacheEntry | null {
  const path = startupModelCachePath(instanceId);
  if (!path) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { checkedAt?: unknown; build?: unknown; fingerprint?: unknown };
    const catalog = catalogFrom(raw);
    return catalog ? {
      catalog,
      checkedAt: typeof raw.checkedAt === "number" && Number.isFinite(raw.checkedAt) ? raw.checkedAt : null,
      build: typeof raw.build === "string" ? raw.build : null,
      fingerprint: typeof raw.fingerprint === "string" ? raw.fingerprint : null,
    } : null;
  } catch {
    return null;
  }
}

export function readStartupModelCache(instanceId: string): ModelCatalog | null {
  return readStartupModelCacheEntry(instanceId)?.catalog ?? null;
}

export function writeStartupModelCache(instanceId: string, catalog: ModelCatalog, read: { checkedAt?: number; build?: string; fingerprint?: string } = {}): void {
  if (!catalog.options.length) return;
  const path = startupModelCachePath(instanceId);
  if (!path) return;
  const stored = catalogFrom(catalog);
  if (!stored) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify({ ...stored, checkedAt: read.checkedAt ?? (unconfirmed.has(catalog) ? 0 : Date.now()), build: read.build ?? buildStamp(), fingerprint: read.fingerprint ?? driverFingerprint() }), { durable: false });
}

/** An object, not a promise: an async function cannot hand back a promise without `await` following it. */
export type DeferredStartupModelRefresh = { pending: Promise<void> };

export function openStartupModelCatalog(input: {
  instanceId: string;
  use: (catalog: ModelCatalog) => void;
  current: () => ModelCatalog;
  refresh: () => Promise<void>;
  now?: number;
  fingerprint?: string;
}): Promise<null> | DeferredStartupModelRefresh {
  const reopened = openedThisRun.has(input.instanceId);
  openedThisRun.add(input.instanceId);
  const fingerprint = input.fingerprint ?? driverFingerprint();
  const entry = readStartupModelCacheEntry(input.instanceId);
  const cached = entry?.catalog ?? null;
  if (cached) input.use(cached);
  const persist = () => {
    try {
      writeStartupModelCache(input.instanceId, input.current(), { fingerprint });
    } catch {
    }
  };
  if (!laterStartup()) {
    return input.refresh().then(() => {
      persist();
      return null;
    });
  }
  const age = (input.now ?? Date.now()) - (entry?.checkedAt ?? -Infinity);
  if (cached && !reopened && entry?.build === buildStamp() && entry.fingerprint === fingerprint && age >= 0 && age < STARTUP_MODEL_CACHE_FRESH_MS) return Promise.resolve(null);
  // A saved list stands in while the refresh waits; with none the engine would offer no model at all until it runs.
  const startAfter = cached ? afterFirstEngineRead() : Promise.resolve();
  return { pending: startAfter.then(() => input.refresh()).then(persist, () => undefined) };
}
