import { describe, expect, it } from "vitest";

import { groupTurnCwd, roomChatWorkdir } from "./room-cwd.ts";

describe("groupTurnCwd", () => {
  it("the room's pinned folder overrides the member's own default", () => {
    expect(groupTurnCwd("/workspaces/bot-a", () => "/tmp/room")).toBe("/tmp/room");
  });

  it("a room with no folder keeps each member's own default", () => {
    expect(groupTurnCwd("/workspaces/bot-a", () => null)).toBe("/workspaces/bot-a");
  });

  it("an off-host member gets no folder and cannot decide the room's pin", () => {
    let pinCalls = 0;
    expect(groupTurnCwd(undefined, () => {
      pinCalls += 1;
      return "/tmp/room";
    })).toBeUndefined();
    expect(pinCalls).toBe(0);
  });
});

describe("roomChatWorkdir (E108)", () => {
  it("gives a chat engine the member's own folder", () => {
    expect(roomChatWorkdir({ worksInWorkspace: false, confined: false, botCwd: "/home/u/proj" })).toBe("/home/u/proj");
  });
  it("gives a workspace engine none: it already works in its folder", () => {
    expect(roomChatWorkdir({ worksInWorkspace: true, confined: false, botCwd: "/home/u/proj" })).toBeUndefined();
  });
  it("gives a confined guest or cloud-guest room none", () => {
    expect(roomChatWorkdir({ worksInWorkspace: false, confined: true, botCwd: "/home/u/proj" })).toBeUndefined();
  });
  it("gives none when the member has no folder set", () => {
    expect(roomChatWorkdir({ worksInWorkspace: false, confined: false, botCwd: undefined })).toBeUndefined();
    expect(roomChatWorkdir({ worksInWorkspace: false, confined: false, botCwd: "  " })).toBeUndefined();
  });
});
