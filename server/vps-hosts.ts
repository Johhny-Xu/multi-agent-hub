// Which VPS instance a bot's computer lives on, resolved once per turn from the bot's own selection.
import { createHash } from "node:crypto";

import type { AppConfig } from "./config.ts";
import { isValidSshAlias } from "./config.ts";
import type { BotRecord } from "./store.ts";
import { vpsIdentityKey, vpsInstanceById, type VpsConfig, type VpsInstance } from "../shared/vps.ts";

export type VpsTarget = Readonly<{
  instance: Readonly<VpsInstance>;
  revision: string;
  physicalKey: string;
}>;

export type VpsResolution =
  | { ok: true; target: VpsTarget }
  | { ok: false; reason: "not-selected" | "missing-instance" | "missing-connection" | "disabled" | "denied" };

/** The whole list's change token, so two edits cannot each write from a stale read. */
export function vpsConfigRevision(cfg: Readonly<AppConfig>): string {
  return createHash("sha256").update(JSON.stringify(cfg.vps ?? null)).digest("hex").slice(0, 16);
}

/** A name change is not a different computer; identity and adapter changes are. */
export function vpsInstanceRevision(instance: VpsInstance): string {
  return createHash("sha256").update(vpsIdentityKey(instance)).digest("hex").slice(0, 24);
}

function targetOf(instance: VpsInstance): VpsTarget {
  return {
    instance,
    revision: vpsInstanceRevision(instance),
    physicalKey: vpsIdentityKey(instance),
  };
}

export function listVpsTargets(cfg: Readonly<AppConfig>): readonly VpsTarget[] {
  const vps = cfg.vps;
  if (!vps || vps.version !== 2 || !Array.isArray(vps.instances)) return [];
  return vps.instances.map(targetOf);
}

function instancesOf(cfg: Readonly<AppConfig>): VpsInstance[] {
  const vps: Partial<VpsConfig> | undefined = cfg.vps;
  return vps?.version === 2 && Array.isArray(vps.instances) ? vps.instances : [];
}

/** Only the bot's explicit instance is used: an absent, deleted or invalid one never falls back to a default or another bot's host. */
export function resolveVpsTarget(
  cfg: Readonly<AppConfig>,
  bot: Pick<BotRecord, "id" | "vpsInstanceId" | "vpsAlias">,
): VpsResolution {
  const configured = instancesOf(cfg);
  if (bot.vpsInstanceId) {
    const instance = vpsInstanceById({ instances: configured }, bot.vpsInstanceId);
    if (!instance) return { ok: false, reason: "missing-instance" };
    return { ok: true, target: targetOf(instance) };
  }
  // Before the one-time migration writes a list, the legacy alias is still the only target there is.
  if (cfg.vps?.version !== 2) {
    const alias = bot.vpsAlias ?? cfg.vps?.sshAlias;
    if (isValidSshAlias(alias)) {
      const instance = { id: `legacy-${alias}`, name: alias, kind: "ssh" as const, sshAlias: alias };
      return { ok: true, target: targetOf(instance) };
    }
  }
  return { ok: false, reason: "not-selected" };
}

/** A delayed result may only act while its exact target revision is still the bot's selection. */
export function vpsTargetCurrent(
  target: VpsTarget,
  cfg: Readonly<AppConfig>,
  bot: Pick<BotRecord, "id" | "vpsInstanceId">,
): boolean {
  const current = resolveVpsTarget(cfg, bot);
  return current.ok && current.target.revision === target.revision && current.target.instance.id === target.instance.id;
}

/** A fixed container name makes the key stable while the container is missing or being replaced. */
export function vpsResourceKey(target: VpsTarget, botId: string): string {
  return target.instance.kind === "ssh"
    ? `vps:${target.physicalKey}:${botId}`
    : `vps:${target.physicalKey}`;
}

/** The pre-migration helpers; only migration inputs still use them. */
export function vpsSshAliasForBot(cfg: AppConfig, bot: { vpsAlias?: string } | null | undefined): string | null {
  if (isValidSshAlias(bot?.vpsAlias)) return bot.vpsAlias;
  const alias = cfg.vps?.sshAlias;
  return isValidSshAlias(alias) ? alias : null;
}

export function vpsAliasesInPlay(cfg: AppConfig, bots: ReadonlyArray<{ vpsAlias?: string }>): string[] {
  const aliases = new Set<string>();
  const primary = cfg.vps?.sshAlias;
  if (isValidSshAlias(primary)) aliases.add(primary);
  for (const bot of bots) {
    if (isValidSshAlias(bot.vpsAlias)) aliases.add(bot.vpsAlias);
  }
  return [...aliases];
}
