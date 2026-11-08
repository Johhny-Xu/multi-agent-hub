/** Bots created by an agent/hub integration rather than by the person. */
export interface DebugZoneBot {
  name?: string;
  debug?: unknown;
  source?: unknown;
}

export const DEBUG_ZONE_SECTION_ID = "builtin:debug";

const HUB_BOT_PREFIX = "hub·";

/** hub-compat keeps one bot per worker named `hub·<agent>`; `debug`/`source` are the explicit markers for anything
 * else that should stay out of the everyday lists. */
export function isDebugBot(bot: DebugZoneBot): boolean {
  return bot.debug === true || bot.source === "hub" || (bot.name ?? "").startsWith(HUB_BOT_PREFIX);
}

export function isDebugBotId(
  botId: string | undefined,
  bots: ReadonlyArray<DebugZoneBot & { id?: string }>,
): boolean {
  if (!botId) return false;
  const bot = bots.find((b) => b.id === botId);
  return bot ? isDebugBot(bot) : false;
}

export interface SearchHitLike {
  botId?: string;
  name?: string;
  from?: string;
}

export function isDebugSearchHit(
  hit: SearchHitLike,
  bots: ReadonlyArray<DebugZoneBot & { id?: string }> = [],
): boolean {
  if (hit.botId) {
    const bot = bots.find((b) => b.id === hit.botId);
    if (bot) return isDebugBot(bot);
  }
  if (hit.name && isDebugBot({ name: hit.name })) return true;
  if (hit.from && isDebugBot({ name: hit.from })) return true;
  return false;
}

export interface InboxRowLike {
  from?: { name?: string; botId?: string };
  via?: { name?: string; botId?: string };
  workingFor?: { name?: string; botId?: string };
  origin?: { botId?: string };
}

export function isDebugInboxRow(
  row: InboxRowLike,
  bots: ReadonlyArray<DebugZoneBot & { id?: string }> = [],
): boolean {
  const check = (id?: string, name?: string) => {
    if (id) {
      const bot = bots.find((b) => b.id === id);
      if (bot) return isDebugBot(bot);
    }
    if (name) return isDebugBot({ name });
    return false;
  };
  if (check(row.from?.botId, row.from?.name)) return true;
  if (check(row.origin?.botId)) return true;
  if (check(row.via?.botId, row.via?.name)) return true;
  if (check(row.workingFor?.botId, row.workingFor?.name)) return true;
  return false;
}
