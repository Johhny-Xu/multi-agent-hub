export type PeerAction = "ask_bot" | "delegate_bot" | "post_to_room";

export function peerAllowKey(action: PeerAction, targetId: string): string {
  return `${action}:${targetId}`;
}
