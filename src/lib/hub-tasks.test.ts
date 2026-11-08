import { describe, expect, it } from "vitest";

import {
  applyHubEvent,
  formatElapsed,
  isTerminalStatus,
  mergeTaskSnapshot,
  parseHubEvent,
  rowElapsedSeconds,
  type HubTaskView,
} from "./hub-tasks";

function task(patch: Partial<HubTaskView> = {}): HubTaskView {
  return {
    ref: "codebuddy-abcdef0123",
    agent: "codebuddy",
    status: "running",
    title: "改一个测试",
    progress: "起步",
    startedAt: 1_000,
    updatedAt: 1_010,
    elapsedS: 10,
    exitCode: null,
    result: null,
    ...patch,
  };
}

describe("hub task rows", () => {
  it("keeps terminal status and streamed text when a list refresh is older", () => {
    const started = mergeTaskSnapshot(undefined, task());
    const finished = applyHubEvent(started, {
      seq: 4, at: 1_020, ref: started.task.ref, agent: "codebuddy", kind: "done", text: "全部完成",
    });
    expect(finished.status).toBe("completed");
    expect(finished.result).toBe("全部完成");
    const refreshed = mergeTaskSnapshot(finished, task({ status: "running", progress: "旧的", result: null }));
    expect(refreshed.status).toBe("completed");
    expect(refreshed.result).toBe("全部完成");
  });

  it("maps each event kind to the row's status and text", () => {
    const base = mergeTaskSnapshot(undefined, task());
    const progress = applyHubEvent(base, { seq: 2, at: 1_005, ref: base.task.ref, agent: "codebuddy", kind: "progress", text: "工具调用: read_file" });
    expect(progress.status).toBe("running");
    expect(progress.progress).toBe("工具调用: read_file");
    const failed = applyHubEvent(progress, { seq: 3, at: 1_006, ref: base.task.ref, agent: "codebuddy", kind: "error", text: "worker 退出" });
    expect(failed.status).toBe("error");
    expect(failed.result).toBe("worker 退出");
    expect(isTerminalStatus(failed.status)).toBe(true);
    expect(isTerminalStatus(progress.status)).toBe(false);
  });

  it("keeps the largest seq and the newest event time", () => {
    const base = mergeTaskSnapshot(undefined, task());
    const first = applyHubEvent(base, { seq: 5, at: 1_030, ref: base.task.ref, agent: "", kind: "progress", text: "a" });
    const older = applyHubEvent(first, { seq: 3, at: 1_020, ref: base.task.ref, agent: "", kind: "progress", text: "b" });
    expect(older.lastSeq).toBe(5);
    expect(older.updatedAt).toBe(1_030);
    expect(older.task.agent).toBe("codebuddy");
  });

  it("formats elapsed time without negative values", () => {
    expect(formatElapsed(-5)).toBe("0:00");
    expect(formatElapsed(9)).toBe("0:09");
    expect(formatElapsed(65)).toBe("1:05");
    expect(formatElapsed(3_725)).toBe("1:02:05");
    expect(rowElapsedSeconds(mergeTaskSnapshot(undefined, task()), 1_042)).toBe(42);
    expect(rowElapsedSeconds(mergeTaskSnapshot(undefined, task({ status: "completed", startedAt: null })), 1_042)).toBeNull();
  });

  it("parses only well-formed stream frames", () => {
    expect(parseHubEvent('{"seq":1,"at":2,"ref":"r","agent":"a","kind":"progress","text":"t"}'))
      .toEqual({ seq: 1, at: 2, ref: "r", agent: "a", kind: "progress", text: "t" });
    expect(parseHubEvent("not json")).toBeNull();
    expect(parseHubEvent('{"seq":"1"}')).toBeNull();
  });
});
