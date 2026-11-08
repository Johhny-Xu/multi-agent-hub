// Perch (perchai-cli), native `perch acp` (Agent Client Protocol over stdio).
//
// Verified on 2026-11-08 against perchai-cli 2.4.125 on this host: `initialize` answers
// protocolVersion 1 with agentInfo {name: perch, title: "Perch Terminal", version: 2.4.125},
// promptCapabilities {image, embeddedContext}, loadSession, and authMethods [perch-browser-login,
// perch-terminal-login]; `session/new` then answers -32000 "Authentication required" while signed
// out — a configured BYOLM local model (`perch byolm set`, active at the time) does not cover the
// ACP endpoint, unlike `perch run`. `perch acp` takes no arguments ("Unknown domain: acp …"), so
// the task's permission modes (default|auto_review|take_the_wheel|plan) cannot ride argv; ACP
// permission requests are answered by the shared runtime instead. The CLI has no `--version`
// ("Unknown interactive flag"); `perch status` prints "Perch CLI 2.4.125 · Not signed in. …".
// Sign-in lives in `~/.perch/cli-auth-session.json` (or $PERCH_CLI_AUTH_DIR); only its shape is
// read here, never a token value. No login flow is driven from this driver.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import type { ModelCatalog, ProviderSnapshot } from "../../contracts.ts";
import { augmentedPath, userHome } from "../../env-path.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import { PERCH_TIERS, perchModelOptions, perchPrivateSettingsDir, perchSelectedModel, selectPerchModel } from "./perch-models.ts";

/**
 * What a signed-in account picks from before the bundle's picker entries are read; the live
 * catalog adds those, and the BYOLM model is never offered.
 */
const PERCH_MODELS: ModelCatalog = {
  default: "standard",
  options: PERCH_TIERS.map((tier) => ({ id: tier.id, label: tier.label })),
};

const LOGIN_NOTE =
  "Perch's ACP endpoint needs its own sign-in (a configured BYOLM local model does not apply there) — run `perch login` in a terminal, then return here.";

/** Where the CLI keeps its saved auth session (perchai-cli 2.4.125's own lookup). */
export function perchAuthDir(env: Record<string, string | undefined>): string {
  const configured = env.PERCH_CLI_AUTH_DIR?.trim();
  return configured || join(userHome(env), ".perch");
}

/**
 * The CLI's own session validity: a token and an app URL, unexpired with its 90-second slack, or
 * expired with a refresh token. E16: the access token lives one hour; `perch acp` and `perch run`
 * refresh it themselves (verified 2026-11-08 on 2.4.125), but `perch status` does not and prints
 * "Not signed in" until something refreshes it.
 */
export function perchSignedIn(env: Record<string, string | undefined>): boolean {
  try {
    const session = JSON.parse(readFileSync(join(perchAuthDir(env), "cli-auth-session.json"), "utf-8")) as {
      accessToken?: unknown; appUrl?: unknown; expiresAt?: unknown; refreshToken?: unknown;
    };
    const token = typeof session.accessToken === "string" ? session.accessToken.trim() : "";
    const appUrl = typeof session.appUrl === "string" ? session.appUrl.trim() : "";
    if (!token || !appUrl) return false;
    const expiresAt = typeof session.expiresAt === "number" ? session.expiresAt : null;
    if (expiresAt === null || expiresAt > Math.floor(Date.now() / 1000) + 90) return true;
    return typeof session.refreshToken === "string" && session.refreshToken.trim().length > 0;
  } catch {
    return false;
  }
}

/** The BYOLM model id from `~/.perch/byo-local.json`, when one is configured; key fields stay unread. */
export function perchByolmModelId(env: Record<string, string | undefined>): string | null {
  try {
    const saved = JSON.parse(readFileSync(join(userHome(env), ".perch", "byo-local.json"), "utf-8")) as {
      records?: unknown;
    };
    if (!Array.isArray(saved.records)) return null;
    for (const record of saved.records) {
      const modelId = (record as { modelId?: unknown } | null)?.modelId;
      if (typeof modelId === "string" && modelId.trim()) return modelId.trim();
    }
  } catch {
    // No BYOLM config: turns need the Perch login instead.
  }
  return null;
}

/** The instance's CLI when it names a path, else the npm prefix the CLI installs into (`~/.npm-global/bin`). */
export function resolvePerchCli(env: Record<string, string | undefined>, cli: string): string {
  if (cli && (isAbsolute(cli) || cli.includes("/") || cli.includes("\\") || existsSync(cli))) return cli;
  if (env.OMB_PERCH_CLI) return env.OMB_PERCH_CLI;
  const path = join(userHome(env), ".npm-global", "bin", "perch");
  if (existsSync(path)) return path;
  return cli || "perch";
}

const support: AcpSupport = {
  driverKind: "perchAgent",
  displayName: "Perch",
  models: PERCH_MODELS,
  defaultCli: "perch",
  nativeSource: "perch.acp",
  // promptCapabilities.image on 2.4.125; never exercised end to end (no login on this host).
  images: true,
  loginNote: LOGIN_NOTE,

  // `perch acp` takes no arguments, so no permission flag and no model flag: BYOLM routing is the
  // CLI's own, and session permissions arrive as ACP requests the runtime answers.
  spawnArgs: () => ["acp"],

  // `perch acp` reads its saved pick once, when the session opens, so the choice is written to
  // cli-settings.json just before spawn and its value joins the spawn contract: a different model
  // closes the pooled process instead of silently reusing the one it started with.
  //
  // The CLI takes that file from $PERCH_CLI_SETTINGS_DIR, so every OMB-spawned perch reads OMB's
  // own per-instance folder: the model picked here never overwrites the pick the person made in
  // their own perch CLI. A folder the instance environment names itself is left alone.
  transformEnv: (env, _config, instanceId) => {
    if (!env.PERCH_CLI_SETTINGS_DIR?.trim()) {
      env.PERCH_CLI_SETTINGS_DIR = perchPrivateSettingsDir(env, instanceId);
    }
  },
  applyTurnEnv: (env, context) => {
    if (!env.PERCH_CLI_SETTINGS_DIR?.trim()) env.PERCH_CLI_SETTINGS_DIR = perchPrivateSettingsDir(env);
    selectPerchModel(env, context.model ?? context.requestedModel);
  },
  spawnFingerprint: (env) => perchSelectedModel(env),

  // House rule (2026-11-08): no CLI's own BYOK/BYOLM; models come from the CLI's plan or from
  // OpenMausBot's own BYOK injection, so a `perch byolm set` left on the host is not offered.
  resolveModels: async (env, config) => {
    const planNote = perchSignedIn(env) ? "" : " (needs perch login)";
    return {
      default: "standard",
      options: perchModelOptions(resolvePerchCli(env, config.cli))
        .map((option) => ({ id: option.id, label: `${option.label}${planNote}` })),
    };
  },

  // No `--version` exists: the snapshot reads the version banner off `perch status` and lets the
  // CLI's own "Not signed in" line report the account, rather than parsing the session file twice.
  snapshot: (env, config) => new Promise<ProviderSnapshot>((settle) => {
    const cli = resolvePerchCli(env, config.cli);
    const home = userHome(env);
    const npmBin = join(home, ".npm-global", "bin");
    const probeEnv = {
      ...env,
      PATH: [npmBin, augmentedPath()].join(delimiter),
      HOME: home,
    };
    execFile(cli, ["status"], { timeout: 25_000, env: probeEnv }, (error, stdout, stderr) => {
      const code = error ? (error as NodeJS.ErrnoException).code : undefined;
      if (error && (code === "ENOENT" || !/Perch CLI \d/.test(`${stdout ?? ""}\n${stderr ?? ""}`))) {
        settle({
          state: "unavailable",
          reason: code === "ENOENT"
            ? "`perch` isn't installed, or isn't on this app's PATH. Install the Perch CLI or use Set CLI, then check again."
            : "`perch status` failed. Run it on the server to diagnose the installation, then check again.",
        });
        return;
      }
      const banner = `${stdout ?? ""}\n${stderr ?? ""}`;
      const version = /Perch CLI (\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/.exec(banner)?.[1] ?? null;
      if (!version) {
        settle({ state: "unavailable", reason: "The configured executable did not answer as the Perch CLI. Check its path and try again.", notEngineCli: true });
        return;
      }
      if (/Not signed in/.test(banner) && !perchSignedIn(probeEnv)) {
        settle({ state: "unavailable", reason: LOGIN_NOTE, authenticationUnavailableReason: LOGIN_NOTE, version });
        return;
      }
      settle({ state: "available", version, authenticated: true });
    });
  }),

  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: (env) => perchSignedIn(env),
  requireAuthenticationBeforeSpawn: true,

  classifyError: (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/Authentication required|Not signed in|perch login/i.test(message)) return "invalid_credentials";
    return undefined;
  },
  describeAccountError: () => LOGIN_NOTE,

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const PerchAgentDriver = createAcpDriver(support);
