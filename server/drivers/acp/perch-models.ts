// Perch's picker models, read out of the CLI's own bundle.
//
// perchai-cli 2.4.125 ships one compiled dist/perch.mjs. `perch acp` takes no model flag and its
// session/new answers no models or configOptions, so the only list of picker models is inside that
// bundle: `hx` maps a picker name to the option id it saves as manualModelOptionId, `zre`/`$re`/`qre`
// hold the Starter/Pro/Ultra groups, `k8e` holds their labels, `j5r` the trial-gated entries, and
// `Uo(providerId, modelId)` builds an option id. Names there are minifier output, so every read is
// best-effort: anything unrecognised leaves the caller on the tier list it started from.
import { createHash } from "node:crypto";
import { closeSync, chmodSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { dataHome } from "../../data-dir.ts";
import { userHome } from "../../env-path.ts";

/** The four Roost tiers, the ids perchai-cli 2.4.125 accepts as roostChoice. */
export const PERCH_TIERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "standard", label: "Standard" },
  { id: "standard_max", label: "Standard 1M" },
  { id: "pro", label: "Pro" },
  { id: "pro_max", label: "Pro 1M" },
];

export interface PerchModelOption {
  id: string;
  label: string;
  group: "starter" | "pro";
}

const OPTION_ID = /^[a-z0-9][a-z0-9-]{1,120}$/u;
const MIN_STARTER = 3;
const MIN_PRO = 8;
/** The lock wait is a ceiling, not a delay: a turn waits at most 275ms for the folder and then goes without the pick. */
const LOCK_ATTEMPTS = 11;
const LOCK_WAIT_MS = 25;
const LOCK_STALE_MS = 5_000;

/** The bundle Uo(providerId, modelId) turns into an option id. */
function optionId(providerId: string, modelId: string): string {
  return `${providerId.replace(/_/g, "-")}-${modelId.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase()}`;
}

/** Index of `name={` that starts a definition, not the tail of a longer identifier. */
function definitionAt(text: string, name: string, from: number, to: number): number {
  const needle = `${name}={`;
  let at = text.indexOf(needle, from);
  while (at >= 0 && at < to) {
    if (!/[A-Za-z0-9_$]/.test(at > 0 ? text[at - 1] : "")) return at;
    at = text.indexOf(needle, at + 1);
  }
  return -1;
}

/** The text between a definition's braces, or null when it never closes. */
function objectBody(text: string, name: string, from: number, to: number): string | null {
  const at = definitionAt(text, name, from, to);
  if (at < 0) return null;
  const open = at + name.length;
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return text.slice(open + 1, index);
  }
  return null;
}

/** `name: ref` pairs of an object literal; spreads and non-identifier values are skipped. */
function entries(body: string): Array<{ name: string; ref: string }> {
  const found: Array<{ name: string; ref: string }> = [];
  for (const match of body.matchAll(/(?:"([^"\\]{1,120})"|([A-Za-z_$][\w$]*))\s*:\s*([A-Za-z_$][\w$]*)/gu)) {
    found.push({ name: match[1] ?? match[2], ref: match[3] });
  }
  return found;
}

function labels(body: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of body.matchAll(/(?:"([^"\\]{1,120})"|([A-Za-z_$][\w$]*))\s*:\s*"([^"\\]{1,160})"/gu)) {
    found.set(match[1] ?? match[2], match[3]);
  }
  return found;
}

/** Minifier name → the string it was assigned, over the definitions before the picker table. */
function identifiers(text: string, until: number): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /([A-Za-z_$][\w$]*)=(?:"([^"\\\n]{1,160})"|Uo\("([^"]{1,80})","([^"]{1,120})"\))/gu;
  for (const match of text.slice(0, until).matchAll(pattern)) {
    found.set(match[1], match[3] === undefined ? match[2] : optionId(match[3], match[4]));
  }
  return found;
}

/**
 * The Starter and Pro picker entries of a perch.mjs bundle, or null when its tables do not read.
 * The Ultra group is left out: the CLI itself hides it unless the account is entitled to Ultra,
 * which no local file answers, and a trial-gated entry is not offered because its window is only
 * decidable by running the bundle.
 */
export function parsePerchOptions(text: string): PerchModelOption[] | null {
  const anchor = text.indexOf("hx={...zre");
  if (anchor < 0) return null;
  const window = 400_000;
  const starter = objectBody(text, "zre", Math.max(0, anchor - window), anchor);
  const pro = objectBody(text, "$re", Math.max(0, anchor - window), anchor);
  const labelBody = objectBody(text, "k8e", anchor, text.length);
  if (!starter || !pro || !labelBody) return null;

  const refs = identifiers(text, anchor);
  const names = labels(labelBody);
  const trials = new Set<string>();
  const trialAt = text.lastIndexOf("j5r=[", anchor);
  if (trialAt >= 0) {
    for (const match of text.slice(trialAt, trialAt + 400).matchAll(/optionId:([A-Za-z_$][\w$]*)/gu)) {
      const id = refs.get(match[1]);
      if (id) trials.add(id);
    }
  }

  const options: PerchModelOption[] = [];
  const seen = new Set<string>();
  let starterCount = 0;
  let proCount = 0;
  for (const [group, body] of [["starter", starter], ["pro", pro]] as const) {
    for (const entry of entries(body)) {
      const id = refs.get(entry.ref);
      if (!id || !OPTION_ID.test(id) || trials.has(id) || seen.has(id)) continue;
      seen.add(id);
      options.push({ id, label: names.get(entry.name) ?? entry.name, group });
      if (group === "starter") starterCount++;
      else proCount++;
    }
  }
  if (starterCount < MIN_STARTER || proCount < MIN_PRO) return null;
  return options;
}

/** `<prefix>/lib/node_modules/perchai-cli/dist/perch.mjs` for an installed `perch` binary. */
export function perchBundlePath(bin: string): string | null {
  if (!bin) return null;
  try {
    const bundle = join(dirname(dirname(realpathSync(bin))), "dist", "perch.mjs");
    return existsSync(bundle) ? bundle : null;
  } catch {
    return null;
  }
}

let cache: { key: string; options: PerchModelOption[] | null } | null = null;

/** The bundle's picker entries, re-read only when the installed file changes. */
export function perchBundleOptions(bundle: string): PerchModelOption[] | null {
  try {
    const stat = statSync(bundle);
    const key = `${bundle}:${stat.mtimeMs}:${stat.size}`;
    if (cache?.key === key) return cache.options;
    const options = parsePerchOptions(readFileSync(bundle, "utf8"));
    cache = { key, options };
    return options;
  } catch {
    return null;
  }
}

/** The tier list, then the bundle's Starter and Pro entries; tiers alone when the bundle does not read. */
export function perchModelOptions(cli: string): Array<{ id: string; label: string }> {
  const bundle = perchBundlePath(cli);
  const fine = bundle ? perchBundleOptions(bundle) : null;
  return [
    ...PERCH_TIERS.map((tier) => ({ id: tier.id, label: tier.label })),
    ...(fine ?? []).map((option) => ({ id: option.id, label: option.label })),
  ];
}

/**
 * Where OMB keeps its own state, the same folder config.ts uses; a per-instance env can point it
 * elsewhere so a test never touches the person's own data.
 */
function ombDataDir(env: Record<string, string | undefined>): string {
  return env.OMB_DATA_DIR?.trim() || join(dataHome(), ".openmausbot");
}

/**
 * OMB's private settings folder for one perch instance. The CLI reads cli-settings.json from
 * $PERCH_CLI_SETTINGS_DIR, so every OMB-spawned perch reads its pick here and the person's own
 * ~/.perch/cli-settings.json is never written.
 */
export function perchPrivateSettingsDir(env: Record<string, string | undefined>, instanceId = "default"): string {
  const key = instanceId.trim() || "default";
  const safe = /^[A-Za-z0-9._-]{1,64}$/u.test(key) && key !== "." && key !== ".."
    ? key
    : createHash("sha256").update(key).digest("hex").slice(0, 12);
  return join(ombDataDir(env), "perch-settings", safe);
}

/** The folder the CLI's settings live in: the caller's own when it names one, else OMB's private one. */
export function perchSettingsDir(env: Record<string, string | undefined>, instanceId = "default"): string {
  return env.PERCH_CLI_SETTINGS_DIR?.trim() || perchPrivateSettingsDir(env, instanceId);
}

/** The host's own settings file, the one OMB must never write. */
function hostSettingsPath(env: Record<string, string | undefined>): string {
  return join(userHome(env), ".perch", "cli-settings.json");
}

/**
 * The private folder starts as a copy of the host's cli-settings.json, so the CLI keeps the
 * permission mode, effort and theme the person chose; only the model pick changes afterwards.
 * Nothing else is copied: byo-local.json stays out (house rule, no CLI's own BYOLM), and the CLI
 * reads mcp.json from the host's ~/.perch, not from the settings folder, so a copy would be dead
 * weight.
 */
function seedPrivateSettings(dir: string, env: Record<string, string | undefined>): void {
  const target = join(dir, "cli-settings.json");
  if (existsSync(target)) return;
  const source = hostSettingsPath(env);
  if (source === target || !existsSync(source)) return;
  try {
    writeFileSync(target, readFileSync(source), { mode: 0o600 });
  } catch {
    // A seed that fails is not fatal: the write below creates the file.
  }
}

function readSettings(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Serialise the read-modify-write across the app's own processes; null when the lock stays taken. */
function withSettingsLock<T>(dir: string, body: () => T): T | null {
  const lock = join(dir, "cli-settings.lock");
  const fresh = !existsSync(dir);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fresh) chmodSync(dir, 0o700);
  } catch {
    return null;
  }
  let fd: number | null = null;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS && fd === null; attempt++) {
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        continue;
      }
      sleepSync(LOCK_WAIT_MS);
    }
  }
  if (fd === null) return null;
  try {
    return body();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The lock's own handle is already gone; the unlink below still clears it.
    }
    try {
      unlinkSync(lock);
    } catch {
      // Another process cleared a stale lock first.
    }
  }
}

/**
 * Point the CLI's saved pick at `model` before it spawns: a tier rewrites roostChoice and drops a
 * manual pin, an option id becomes manualModelOptionId, and every other key stays as it was. An id
 * the CLI does not know is written anyway — it ignores one that is not in its own table and falls
 * back to roostChoice — but an injected local model id is not a Perch id and is left alone.
 *
 * The write lands in OMB's private settings folder, never in the host's ~/.perch, so a model picked
 * here cannot overwrite the one the person set in their own perch CLI.
 */
export function selectPerchModel(env: Record<string, string | undefined>, model: string | undefined, instanceId = "default"): boolean {
  const wanted = model?.trim();
  if (!wanted) return false;
  const tier = PERCH_TIERS.some((entry) => entry.id === wanted);
  if (!tier && !OPTION_ID.test(wanted)) return false;
  const dir = perchSettingsDir(env, instanceId);
  const path = join(dir, "cli-settings.json");
  return withSettingsLock(dir, () => {
    seedPrivateSettings(dir, env);
    const current = readSettings(path);
    if (current && typeof current.version === "number" && current.version !== 1) return false;
    const next: Record<string, unknown> = Object.assign({}, current, { version: 1 });
    if (tier) {
      if (next.roostChoice === wanted && next.manualModelOptionId === undefined) return false;
      next.roostChoice = wanted;
      delete next.manualModelOptionId;
    } else {
      if (next.manualModelOptionId === wanted) return false;
      next.manualModelOptionId = wanted;
    }
    try {
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      renameSync(tmp, path);
    } catch {
      return false;
    }
    return true;
  }) ?? false;
}

/** The pick a running CLI read at startup, so a change respawns instead of reusing the old model. */
export function perchSelectedModel(env: Record<string, string | undefined>, instanceId = "default"): string {
  const settings = readSettings(join(perchSettingsDir(env, instanceId), "cli-settings.json"));
  const manual = typeof settings?.manualModelOptionId === "string" ? settings.manualModelOptionId : "";
  const roost = typeof settings?.roostChoice === "string" ? settings.roostChoice : "";
  return `${manual}\n${roost}`;
}
