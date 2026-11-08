// Trae Code — the `traecode` wrapper around ByteDance's Trae CN desktop IDE (`trae-cn`, a VSCode
// fork). The IDE speaks no protocol a server can drive: its CLI is a window manager (the `chat`
// subcommand opens the chat view in a desktop window; `--acp` is not a known option), and the
// binaries under its ai-agent module are the IDE's internal tool host and context helper, not a
// model-driven agent. The mah product these accounts migrated from only ever held sign-in
// snapshots for this engine — it never had a driver either (docs/tasks/reports/FIX-E27.md).
//
// So this driver registers the engine so its instance and its accounts are recognized, and it
// reports the truth instead of spawning the desktop app: the snapshot explains that turns cannot
// run here, and a turn attempt refuses with the same explanation. Nothing here spawns or reads
// the IDE beyond existence checks; the sign-in lives in the IDE's own JWT file, which only its
// presence is tested.
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type {
  DriverCreateInput, ModelCatalog, ProviderDriver, ProviderInstance, ProviderSnapshot,
  RequestOutcome, RuntimeEventListener,
} from "../contracts.ts";
import { userHome } from "../env-path.ts";

export interface TraecodeConfig {
  cli: string;
  fullAuto: boolean;
  workspace?: string;
}

const NO_MODELS: ModelCatalog = { default: "", options: [] };

const DESKTOP_NOTE =
  "Trae Code is the Trae CN desktop IDE: it has no headless agent interface (its chat subcommand opens a desktop window and it has no ACP mode), so this server cannot run turns with it. Its accounts, sign-in and check-in stay manageable here.";
const SIGN_IN_NOTE =
  "Trae is not signed in on this server — open the Trae desktop IDE once and sign in, then check again.";

/** The IDE's own JWT (`~/.trae-cn/trae-jwt-token`, legacy `~/.trae`); its presence is the sign-in,
 * and no token is read here. */
export function traecodeSignedIn(env: Record<string, string | undefined>): boolean {
  const home = userHome(env);
  return [join(home, ".trae-cn", "trae-jwt-token"), join(home, ".trae", "trae-jwt-token")]
    .some((path) => existsSync(path));
}

/** What the instance runs: an absolute `cli` (or OMB_TRAECODE_CLI) decides alone, else the IDE's
 * standard install paths. Existence checks only — the wrapper launches the desktop app, so
 * nothing here is spawned, not even for `--version`. */
export function resolveTraecodeCli(env: Record<string, string | undefined>, cli: string): string | null {
  const explicit = [cli, env.OMB_TRAECODE_CLI]
    .find((entry) => typeof entry === "string" && entry.length > 0 && (isAbsolute(entry) || entry.includes("/")));
  if (typeof explicit === "string") return existsSync(explicit) ? explicit : null;
  const home = userHome(env);
  return ["/usr/bin/trae-cn", "/usr/share/trae-cn/bin/trae-cn", join(home, ".local", "bin", "traecode"), join(home, ".local", "bin", "trae")]
    .find((path) => existsSync(path)) ?? null;
}

export function traecodeSnapshot(env: Record<string, string | undefined>, config: TraecodeConfig): ProviderSnapshot {
  if (!resolveTraecodeCli(env, config.cli)) {
    return {
      state: "unavailable",
      reason: "Trae Code (the Trae CN desktop IDE) isn't installed on this server. Install it from https://www.trae.cn, then check again.",
    };
  }
  const signedIn = traecodeSignedIn(env);
  return {
    state: "unavailable",
    reason: signedIn ? DESKTOP_NOTE : `${SIGN_IN_NOTE} ${DESKTOP_NOTE}`,
    ...(signedIn ? { authenticated: true } : {}),
  };
}

function decodeConfig(raw: unknown): TraecodeConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    cli: typeof o.cli === "string" ? o.cli : "traecode",
    fullAuto: o.fullAuto === true,
    workspace: typeof o.workspace === "string" ? o.workspace : undefined,
  };
}

export const TraecodeAgentDriver: ProviderDriver<TraecodeConfig> = {
  driverKind: "traecodeAgent",
  metadata: { displayName: "Trae Code", supportsMultipleInstances: true, access: "subscription" },
  install: { docsUrl: "https://www.trae.cn" },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),
  models: NO_MODELS,
  async create(input: DriverCreateInput<TraecodeConfig>): Promise<ProviderInstance> {
    const refuse = () => Promise.reject(new Error(DESKTOP_NOTE));
    const adapter = {
      provider: "traecodeAgent" as const,
      capabilities: { sessionModelSwitch: "unsupported" as const },
      sendTurn: refuse,
      interruptTurn: () => Promise.resolve(),
      respondToRequest: (): Promise<RequestOutcome> => Promise.resolve("unavailable"),
      hasSession: () => false,
      stopAll: () => Promise.resolve(),
      onEvent: (_listener: RuntimeEventListener) => () => {},
    };
    return {
      instanceId: input.instanceId,
      driverKind: "traecodeAgent",
      displayName: input.displayName,
      enabled: input.enabled,
      models: NO_MODELS,
      adapter,
      snapshot: () => Promise.resolve(traecodeSnapshot(input.environment, input.config)),
      dispose: () => Promise.resolve(),
    };
  },
};
