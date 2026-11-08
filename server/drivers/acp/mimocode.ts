// MiMo Code (Xiaomi's @mimo-ai/cli), native `mimo acp` (Agent Client Protocol over stdio).
//
// Verified on 2026-11-08 against mimo 0.1.15 on this host: `initialize` answers protocolVersion 1
// with agentInfo {name: "OpenCode", version: "0.1.15"} (the CLI is an OpenCode fork), the
// `opencode-login` auth method and promptCapabilities.image; `session/new` answers a `model`
// config option (ids like "xiaomi/mimo-v2.6-pro") beside the legacy `models` state, and modes
// build/plan/compose. Permission decisions arrive as ACP requests the shared runtime answers, so
// no approval flag rides argv.
//
// The npm launcher picks its platform binary by /proc/cpuinfo's AVX2 flag and prefers a cached
// `.mimocode` copy of it; on hosts where that flag lies (this one included) the AVX2 binary dumps
// core with no output. The driver therefore probes its candidates with `--version` and keeps the
// first one that answers as the MiMo CLI, trying the launcher first and the baseline build before
// the AVX2 one.
//
// House rule: only the CLI's own bundled tiers run. Ids under `mimo/`/`xiaomi/` are the whitelist —
// the `9router/*` rows `mimo models` also prints come from the CLI's own BYOK providers in its
// config, so they are filtered out of the catalog and a turn without a whitelisted pick is pinned
// to `mimo/mimo-auto`. No key of the person's own is injected, and the CLI's own provider
// configuration is never read or written.
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { ModelCatalog, SendTurnInput } from "../../contracts.ts";
import { decodeInjectId } from "../local-inject.ts";
import { userHome } from "../../env-path.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

/** The turn's model when it pinned none or a non-whitelisted one: the CLI's own free tier. */
const MIMOCODE_FALLBACK_MODEL = "mimo/mimo-auto";

/** The CLI's bundled tiers; anything else its listing names (e.g. `9router/*`) is its own BYOK. */
const MIMOCODE_MODEL_PREFIXES: readonly string[] = ["mimo/", "xiaomi/"];

function isBundledModel(id: string): boolean {
  return MIMOCODE_MODEL_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** `mimo models` on 0.1.15, verified 2026-11-08, minus the CLI's `9router/*` BYOK rows; the context
 * windows are the CLI's own report. */
const MIMOCODE_MODELS: ModelCatalog = {
  default: MIMOCODE_FALLBACK_MODEL,
  options: [
    { id: "mimo/mimo-auto", label: "MiMo Auto (free)", contextWindow: 1_048_576 },
    { id: "xiaomi/mimo-v2.6-pro-ultraspeed", label: "MiMo-V2.6-Pro UltraSpeed", contextWindow: 1_101_005 },
    { id: "xiaomi/mimo-v2.6-pro", label: "MiMo-V2.6-Pro", contextWindow: 1_101_005 },
    { id: "xiaomi/mimo-v2.6-flash", label: "MiMo-V2.6-Flash", contextWindow: 1_101_005 },
  ],
};

export const LOGIN_NOTE =
  "MiMo Code is not signed in — run `mimo providers login` in a terminal, finish its sign-in, then try again.";

const MODEL_LINE = /^(\S+) — window ([\d.]+)([KM])?(?:,|$)/m;
/** `mimo --version` prints only "0.1.15"; a looser shape would take a foreign banner's numbers. */
const MIMO_VERSION = /^v?\d+\.\d+\.\d+(?:[-+.\w]+)?$/;

const MODEL_UNITS: Record<string, number> = { K: 1024, M: 1024 * 1024 };

/** The picker labels the CLI's own session names give these ids; unknown ids label as themselves. */
const MODEL_LABELS: ReadonlyMap<string, string> = new Map(
  MIMOCODE_MODELS.options.map((option) => [option.id, option.label]),
);

/** Candidate entries in probe order: what the instance or the environment names, then the npm
 * launcher and the platform binaries beside it (baseline before AVX2, see the header), then PATH. */
export function mimocodeCliCandidates(env: Record<string, string | undefined>, cli: string): string[] {
  const home = userHome(env);
  const explicit = [cli, env.OMB_MIMOCODE_CLI]
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  const launcherRoots = [join(home, ".npm-global", "bin", "mimo"), join(home, ".local", "bin", "mimo"), join(home, ".local", "bin", "mimocode")]
    .filter((entry) => existsSync(entry))
    .map((entry) => {
      try {
        // ~/.local/bin/mimo is a symlink into the npm tree; the platform binaries live beside it.
        return dirname(dirname(dirname(realpathSync(entry))));
      } catch {
        return null;
      }
    })
    .filter((root): root is string => typeof root === "string" && basename(root) === "@mimo-ai");
  const platform = launcherRoots.flatMap((root) => [
    join(root, "mimocode-linux-x64-baseline", "bin", "mimo"),
    join(root, "mimocode-linux-x64", "bin", "mimo"),
    join(root, "mimocode-linux-x64-baseline-musl", "bin", "mimo"),
    join(root, "mimocode-linux-x64-musl", "bin", "mimo"),
  ]).filter((entry) => existsSync(entry));
  return [...new Set([...explicit, ...platform, "mimo"])];
}

/** Whether any candidate names a real file (the PATH fallback name does not count). */
export function mimocodeCliInstalled(env: Record<string, string | undefined>, cli: string): boolean {
  return mimocodeCliCandidates(env, cli).some((entry) => entry.includes("/") && existsSync(entry));
}

/** The CLI's own sign-in (`mimo providers login` writes it into `<data>/mimocode/auth.json`);
 * no token is read here. */
export function mimocodeSignedIn(env: Record<string, string | undefined>): boolean {
  const home = userHome(env);
  const datas = [env.XDG_DATA_HOME, join(home, ".local", "share")].filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return datas.some((data) => existsSync(join(data, "mimocode", "auth.json")));
}

export interface MimocodeCli {
  path: string;
  version: string;
}

let verified: { key: string; cli: MimocodeCli | null } | null = null;

/** Forget the cached `--version` probe (tests). */
export function resetMimocodeCliCache(): void {
  verified = null;
}

function probeVersion(path: string, env: Record<string, string | undefined>): Promise<string | null> {
  return new Promise((settle) => {
    execFile(path, ["--version"], { timeout: 20_000, env }, (error, stdout) => {
      const version = error ? null : MIMO_VERSION.exec((stdout ?? "").trim())?.[0] ?? null;
      settle(version);
    });
  });
}

/** The first candidate that answers `--version` as a version number, or null. */
export async function verifyMimocodeCli(
  env: Record<string, string | undefined>,
  cli: string,
): Promise<MimocodeCli | null> {
  const candidates = mimocodeCliCandidates(env, cli);
  const key = candidates.join("\u0000");
  if (verified?.key === key) return verified.cli;
  let found: MimocodeCli | null = null;
  for (const candidate of candidates) {
    const version = await probeVersion(candidate, env);
    if (version) {
      found = { path: candidate, version };
      break;
    }
  }
  verified = { key, cli: found };
  return found;
}

/** `mimo models` (one `id — window 131K, compacts at …` line per model), or null when nothing
 * whitelisted remains (a BYOK-only listing keeps the static catalog). */
export function parseMimoModels(output: string): ModelCatalog | null {
  const options: ModelCatalog["options"] = [];
  for (const line of output.split("\n")) {
    const match = MODEL_LINE.exec(line.trim());
    if (!match) continue;
    const [, id, value, unit] = match;
    if (!isBundledModel(id)) continue;
    const contextWindow = Math.round(Number(value) * (unit ? MODEL_UNITS[unit] : 1));
    options.push({
      id,
      label: MODEL_LABELS.get(id) ?? id,
      ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    });
  }
  if (!options.length) return null;
  const fallback = options.find((option) => option.id === MIMOCODE_FALLBACK_MODEL) ?? options[0];
  return { default: fallback.id, options };
}

/** A turn runs a bundled model: an unpinned pick or one outside the whitelist (a saved `9router/*`
 * id among them) is replaced with the fallback; a locally injected id is the person's own and passes. */
function normalizeMimocodeTurn(turn: SendTurnInput): SendTurnInput {
  const { model } = turn;
  if (model && (decodeInjectId(model) || isBundledModel(model))) return turn;
  return { ...turn, model: MIMOCODE_FALLBACK_MODEL };
}

async function resolveModels(
  env: Record<string, string | undefined>,
  config: { cli: string },
): Promise<ModelCatalog> {
  const cli = await verifyMimocodeCli(env, config.cli);
  if (!cli) return MIMOCODE_MODELS;
  return new Promise<ModelCatalog>((settle) => {
    execFile(cli.path, ["models"], { timeout: 25_000, maxBuffer: 4 * 1024 * 1024, env }, (error, stdout) => {
      settle(!error && stdout ? parseMimoModels(stdout) ?? MIMOCODE_MODELS : MIMOCODE_MODELS);
    });
  });
}

const support: AcpSupport = {
  driverKind: "mimocodeAgent",
  displayName: "MiMo Code",
  models: MIMOCODE_MODELS,
  defaultCli: "mimo",
  nativeSource: "mimo.acp",
  images: true,
  loginNote: LOGIN_NOTE,

  // `mimo acp` starts the ACP agent on stdio; permission decisions arrive as ACP requests the
  // runtime answers, so no approval flag rides argv.
  spawnArgs: () => ["acp"],

  // The launcher may be the broken entry on this host, so the turn spawns the probed binary.
  resolveCommand: async (env, config) => ({ command: (await verifyMimocodeCli(env, config.cli))?.path ?? config.cli }),

  snapshot: async (env, config) => {
    const cli = await verifyMimocodeCli(env, config.cli);
    if (!cli) {
      if (!mimocodeCliInstalled(env, config.cli)) {
        return {
          state: "unavailable",
          reason: "`mimo` isn't installed, or isn't on this app's PATH. Install the MiMo Code CLI (`npm install -g @mimo-ai/cli`) or use Set CLI, then check again.",
        };
      }
      return {
        state: "unavailable",
        reason: "A MiMo Code entry is present but did not answer as `mimo --version`. Run it on the server to diagnose the installation, then check again.",
        notEngineCli: true,
      };
    }
    return { state: "available", version: cli.version, authenticated: mimocodeSignedIn(env), billing: "subscription" };
  },

  resolveModels: (env, config) => resolveModels(env, config),

  selectModel: { configId: "model" },

  // The CLI's own default is a BYOK id (`9router/trcc/glm-5.3-flashx`), so a turn never runs
  // unpinned: normalize pins the whitelist, and fallbackModel also covers a whitelisted id the
  // live session stopped offering.
  normalizeSessionSelection: (turn) => normalizeMimocodeTurn(turn),
  fallbackModel: () => MIMOCODE_FALLBACK_MODEL,

  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: (env) => mimocodeSignedIn(env),

  classifyError: (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/not (?:signed in|authenticated)|authentication (?:required|failed)|unauthorized\b/i.test(message)) {
      return "invalid_credentials";
    }
    return undefined;
  },
  describeAccountError: () => LOGIN_NOTE,
};

export const MimocodeAgentDriver = createAcpDriver(support);
