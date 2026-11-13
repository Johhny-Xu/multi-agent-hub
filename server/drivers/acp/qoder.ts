// Qoder CLI, both builds: `qodercli --acp` and `qoderclicn --acp`.
//
// Verified on 2026-11-06 against qoder-cli-cn 1.1.74 on this host: `initialize` answers
// protocolVersion 1 with agentInfo {name: qoder-cli-cn, version: 1.1.74},
// promptCapabilities {image, embeddedContext}, mcpCapabilities {http, sse},
// loadSession, and sessionCapabilities {additionalDirectories, close, delete, fork, list, resume}.
// Sign-in is the CLI's own `qoderclicn login`; this driver stores no key.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { userHome } from "../../env-path.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

/**
 * `qodercli --thinking <mode>` (its --help, both builds: auto, adaptive, enabled, disabled). ACP has no session
 * option for it, so the mode travels on argv like CodeBuddy's effort: the picker's variant, or a `-enabled`
 * style suffix on the model id (what hub dispatch can send). No variant keeps the CLI's own default.
 */
export const QODER_THINKING = [
  { id: "auto", label: "Thinking: Auto" },
  { id: "adaptive", label: "Thinking: Adaptive" },
  { id: "enabled", label: "Thinking: On" },
  { id: "disabled", label: "Thinking: Off" },
];
const THINKING_SUFFIX = new RegExp(`^(.*)-(${QODER_THINKING.map((t) => t.id).join("|")})$`, "i");

export function splitQoderThinking(model: string | undefined, variant: string | undefined): { model: string | undefined; thinking: string | undefined } {
  if (variant) return { model, thinking: variant };
  const match = model && model !== "auto" ? THINKING_SUFFIX.exec(model) : null;
  if (!match) return { model, thinking: undefined };
  return { model: match[1], thinking: match[2]!.toLowerCase() };
}

/** qodercli 1.1.86 refuses a bare `--thinking enabled` ("requires --thinking-budget <tokens>"); a budget implies enabled. */
export const QODER_ENABLED_THINKING_BUDGET = "32000";
export function qoderThinkingArgs(thinking: string | undefined): string[] {
  if (!thinking) return [];
  return thinking === "enabled" ? ["--thinking-budget", QODER_ENABLED_THINKING_BUDGET] : ["--thinking", thinking];
}

const withThinking = <T extends { id: string }>(options: T[]) => options.map((option) => ({ ...option, variants: QODER_THINKING }));

/** Qoder's own model ids. Re-detect replaces this list with whatever the live session advertises. */
const QODER_MODELS = {
  default: "dfmodel",
  options: withThinking([
    // Live ACP model_selection of qodercli 1.1.86 on 2026-11-11 (the account's own BYOK "qoder-custom-*" entry left out on purpose).
    { id: "auto", label: "Auto" },
    { id: "ultimate", label: "Ultimate" },
    { id: "fast", label: "Fast" },
    { id: "efficient", label: "Efficient" },
    { id: "qmodel_latest", label: "Qwen4-Max-Preview" },
    { id: "qmodel_38max", label: "Qwen3.8-Max" },
    { id: "qfmodel", label: "Qwen3.8-Flash" },
    { id: "kmodel_latest", label: "Kimi-K3.1-Pro" },
    { id: "kmodel", label: "Kimi-K2.8-Preview" },
    { id: "gmodel", label: "GLM-5.3" },
    { id: "gfmodel", label: "GLM-5.3-Flash" },
    { id: "dmodel", label: "DeepSeek-V4-Pro" },
    { id: "dfmodel", label: "DeepSeek-Flash" },
    { id: "mmodel", label: "MiniMax-M3.1-Flash" },
    { id: "75513251-b620-4ae0-bae4-25d28cc6c7ec", label: "Mimo-V2.6-Flash" },
    { id: "cmodel", label: "Cantus" },
    // QoDuck is not in the ACP model_selection the CLI advertises (it is served from Qoder's remote catalog), so
    // it only shows up here. Its id is the display name, as Qoder's own free-tier model is addressed that way on the command line.
    { id: "QoDuck", label: "QoDuck (Free)" },
    // Qoder's own flagship (computer-use oriented, 8x credit multiplier); the live list calls it smodel, bots keep the name id.
    { id: "Sonus", label: "Sonus (8×)" },
  ]),
};

const QODER_CN_MODELS = {
  default: "dfmodel",
  options: withThinking([
    // Live ACP model_selection of qoderclicn 1.1.74 on 2026-11-12 (E89: Qwen4-Max-Preview now on the CN catalog; 1.1.86 fails models.list with 403).
    { id: "auto", label: "Auto" },
    { id: "fast", label: "Fast" },
    { id: "qmodel_latest", label: "Qwen4-Max-Preview" },
    { id: "qmodel_38max", label: "Qwen3.8-Max" },
    { id: "qfmodel", label: "Qwen3.8-Flash" },
    { id: "dmodel", label: "DeepSeek-V4-Pro" },
    { id: "dfmodel", label: "DeepSeek-Flash" },
    { id: "gmodel", label: "GLM-5.3" },
    { id: "gfmodel", label: "GLM-5.3-Flash" },
    { id: "kmodel_latest", label: "Kimi-K3.1-Pro" },
    { id: "kmodel", label: "Kimi-K2.8-Preview" },
    { id: "jmodel", label: "Step-5-Preview" },
    { id: "mmodel", label: "MiniMax-M3.1-Flash" },
  ]),
};

/** `qodercli login` writes into ~/.qoder (qoderclicn into ~/.qoder-cn); the presence of the state file is the signal. */
export function qoderSignedIn(homeDir: string) {
  return (env: Record<string, string | undefined>): boolean => {
    const home = join(userHome(env), homeDir);
    return existsSync(join(home, "state.json")) || existsSync(join(home, "settings.json"));
  };
}

const QODER_INSTALL = {
  command: { darwin: "curl -fsSL https://qoder.com/install.sh | bash", linux: "curl -fsSL https://qoder.com/install.sh | bash", win32: "irm https://qoder.com/install.ps1 | iex" },
  docsUrl: "https://qoder.com",
};

const intl: AcpSupport = {
  driverKind: "qoderAgent",
  displayName: "Qoder",
  models: QODER_MODELS,
  defaultCli: "qodercli",
  nativeSource: "qoder.acp",
  loginNote: "Qoder is not signed in — run `qodercli login` in a terminal first, then return here.",
  install: QODER_INSTALL,
  // --acp is the verified entry point; -m carries the model the bot picked, --thinking the picked thinking mode.
  spawnArgs: (_config, turn) => {
    const { model, thinking } = splitQoderThinking(turn.model, turn.variant);
    return ["--acp", ...(model ? ["-m", model] : []), ...qoderThinkingArgs(thinking)];
  },
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: qoderSignedIn(".qoder"),
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

const cn: AcpSupport = {
  ...intl,
  driverKind: "qoderCnAgent",
  displayName: "Qoder CN",
  models: QODER_CN_MODELS,
  defaultCli: "qoderclicn",
  nativeSource: "qoder-cn.acp",
  loginNote: "Qoder CN is not signed in — run `qoderclicn login` in a terminal first, then return here.",
  isAuthenticated: qoderSignedIn(".qoder-cn"),
};

export const QoderDriver = createAcpDriver(intl);
export const QoderCnDriver = createAcpDriver(cn);
