// ZCode, driven through its official `zcode app-server` protocol. The CLI speaks neither ACP nor a
// plain print mode with model selection, so `zcode-acp.ts` sits in front of it as an ACP server and
// this driver only describes that bridge to the shared runtime.
//
// The protocol follows agenthub's verified `drivers/zcode_rpc.mjs` adapter: a deferred session is
// created with an explicit model and thinking level, and the turn ends on `turn.completed`. The CLI
// keeps its own sign-in in `~/.zcode`; the bridge only reuses a coding-plan key the desktop app
// already stored, through a private provider file, so the plan's GLM models reach the picker.
// Model ids come from the live app-server catalog on startup, so a provider added in ZCode reaches
// the picker without an update.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { ModelCatalog, ProviderSnapshot } from "../../contracts.ts";
import { loadConfig } from "../../config.ts";
import { zcodeCentralKeyEnv } from "../../cli-keys.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import {
  discoverZcodeModels,
  normalizeZcodeSessionModel,
  resolveZcodeCli,
  resolveBuiltinProviderConfig,
  zcodeHasAccount,
  zcodeLaunchForVersion,
} from "../zcode-acp.ts";

/** What a ZCode install normally offers. The live catalog replaces this list on startup; the
 * static list keeps the picker usable when that read fails. */
const ZCODE_MODELS: ModelCatalog = {
  default: "GLM-5.3-Flash",
  options: [
    {
      id: "GLM-5.3-Flash",
      label: "GLM-5.3-Flash",
      variants: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "max", label: "Max" },
      ],
    },
    {
      id: "GLM-5.3",
      label: "GLM-5.3",
      variants: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "max", label: "Max" },
      ],
    },
    {
      id: "deepseek-v4.1-flash",
      label: "DeepSeek V4.1 Flash",
      variants: [
        { id: "disabled", label: "None" },
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
        { id: "max", label: "Max" },
      ],
    },
    { id: "step-5-preview", label: "Step 5 Preview" },
    { id: "LongCat-2.5-Preview", label: "LongCat 2.5 Preview" },
  ],
};

const LOGIN_NOTE =
  "ZCode is not signed in, or has no provider configured — open ZCode once (or run `zcode login`), add a model provider, then try again.";

const BRIDGE_SCRIPT = fileURLToPath(new URL("../zcode-acp.ts", import.meta.url));

/** The native permission mode for this turn. Full access is OpenMausBot's default and ZCode's most
 * permissive mode is yolo; nothing is escalated beyond what the person chose. */
function zcodeMode(turn: { approvalMode?: string }): string {
  switch (turn.approvalMode) {
    case "full":
    case "auto":
      return "yolo";
    case "edits":
      return "edit";
    case "ask":
      return "plan";
    default:
      return "build";
  }
}

/** The bridge prints `zcode 0.17.1`; any other answer means another program sits behind the path. */
function zcodeVersionProbe(env: Record<string, string | undefined>, cli: string): Promise<ProviderSnapshot> {
  const resolved = resolveZcodeCli(env, cli);
  const launch = zcodeLaunchForVersion(env, cli);
  const providerConfig = resolveBuiltinProviderConfig(env, resolved);
  return new Promise((settle) => {
    execFile(launch.command, launch.args, {
      timeout: 8_000,
      env: providerConfig ? { ...env, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: providerConfig } : env,
    }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        settle({
          state: "unavailable",
          reason: code === "ENOENT"
            ? "`zcode` isn't installed, or isn't on this app's PATH. Install the ZCode desktop app or use Set CLI, then check again."
            : "The ZCode CLI version check failed. Run it with --version on the server to diagnose the installation, then check again.",
        });
        return;
      }
      const banner = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
      const version = /(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/.exec(banner)?.[0] ?? null;
      if (!version) {
        settle({ state: "unavailable", reason: "The configured executable did not answer as the ZCode CLI. Check its path and try again." });
        return;
      }
      settle({ state: "available", version, authenticated: zcodeHasAccount(env) });
    });
  });
}

const support: AcpSupport = {
  driverKind: "zcodeAgent",
  displayName: "ZCode",
  models: ZCODE_MODELS,
  defaultCli: "zcode",
  nativeSource: "zcode.acp",
  images: false,
  loginNote: LOGIN_NOTE,
  modelVariants: true,
  selectModel: { configId: "model", allowLegacy: true },

  // The bridge is the ACP agent; the ZCode script stays the CLI the snapshot and the bridge resolve.
  resolveCommand: (env) => {
    const launchEnv = process.versions.electron ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env;
    return Promise.resolve({ command: process.execPath, args: ["--experimental-strip-types", BRIDGE_SCRIPT], env: launchEnv });
  },
  spawnArgs: (config, turn) => ["--cli", config.cli, "--mode", zcodeMode(turn)],
  // The bridge runs as this process and builds ZCode's provider store from the deployed keys.
  transformEnv: (env) => {
    Object.assign(env, zcodeCentralKeyEnv(loadConfig()));
  },
  resolveModels: async (env, config) => discoverZcodeModels(config.cli, env),
  // Older bots and the hub keep the bare `GLM-5.3-Flash`; the live catalog qualifies it once two providers offer it.
  normalizeSessionSelection: (turn, offered) => {
    const model = normalizeZcodeSessionModel(turn.model, offered);
    return model === turn.model ? turn : { ...turn, model };
  },
  snapshot: (env, config) => zcodeVersionProbe(env, config.cli),

  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: (env) => zcodeHasAccount(env),

  classifyError: (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/MODEL_UNAVAILABLE|MODEL_CATALOG_UNAVAILABLE|MODEL_NOT_FOUND|not signed in|no provider|401|403/i.test(message)) return "invalid_credentials";
    return undefined;
  },
  describeAccountError: () => LOGIN_NOTE,
};

export const ZcodeAgentDriver = createAcpDriver(support);
