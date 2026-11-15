/** An undefined memberDefault means the engine runs off-host, so it never takes the room's host folder. */
export function groupTurnCwd(
  memberDefault: string | undefined,
  pinRoomCwd: () => string | null,
): string | undefined {
  if (memberDefault === undefined) return undefined;
  return pinRoomCwd() ?? memberDefault;
}

/** E108: a chat engine (no working folder of its own) gets the member's own folder for its in-process
 * workdir tools in a room too; workspace engines, confined guests and cloud-guest rooms get none. */
export function roomChatWorkdir(args: { worksInWorkspace: boolean; confined: boolean; botCwd: string | undefined }): string | undefined {
  if (args.worksInWorkspace || args.confined) return undefined;
  const cwd = args.botCwd?.trim();
  return cwd || undefined;
}
