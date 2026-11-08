// origin.ts 的单测：回写的行、节流、终态摘要、脱敏，以及回写失败不影响派活。
import { describe, expect, it } from "vitest";

import {
  ORIGIN_PROGRESS_THROTTLE_MS,
  createOriginWriter,
  originLine,
  originTerminalLine,
  originThreadOf,
  type OriginWriteBack,
} from "./origin.ts";

describe("originThreadOf", () => {
  it("takes the thread id out of the header", () => {
    expect(originThreadOf("thread-1")).toBe("thread-1");
    expect(originThreadOf(["thread-2"])).toBe("thread-2");
  });

  it("has no thread when the header is absent or empty", () => {
    expect(originThreadOf(undefined)).toBeUndefined();
    expect(originThreadOf("  ")).toBeUndefined();
  });
});

describe("the lines", () => {
  it("names the agent, the ref and that the task was accepted", () => {
    expect(originLine("mmx", "mmx-abc123", "accepted", "")).toBe("[hub mmx/mmx-abc123] 已受理，正在执行。");
  });

  it("keeps a progress line to one line", () => {
    const line = originLine("mmx", "mmx-abc123", "progress", "第一行\n第二行");
    expect(line).toContain("[hub mmx/mmx-abc123] 进行中：");
    expect(line).not.toContain("\n");
  });

  it("writes the terminal summary and the elapsed time", () => {
    const line = originTerminalLine("mmx", "mmx-abc123", "completed", "结论是 OK", 75);
    expect(line).toContain("[hub mmx/mmx-abc123] 完成（耗时 1m15s）");
    expect(line).toContain("结论是 OK");
  });

  it("calls a failed task a failure and a late one a timeout", () => {
    expect(originTerminalLine("mmx", "r", "error", "炸了", 3)).toContain("失败（耗时 3s）");
    expect(originTerminalLine("mmx", "r", "timeout", "", 90)).toContain("超时（耗时 1m30s）");
  });

  it("takes the first 300 characters of the summary", () => {
    const line = originTerminalLine("mmx", "r", "completed", "y".repeat(1000), 1);
    expect(line).not.toContain("y".repeat(301));
    expect(line.match(/y/g)?.length).toBe(300);
  });

  it("keeps a key or a token out of the line", () => {
    const line = originTerminalLine("mmx", "r", "completed", "token sk-abcdefgh12345678 and Bearer abcdefgh12345678", 1);
    expect(line).not.toContain("sk-abcdefgh12345678");
    expect(line).not.toContain("abcdefgh12345678");
    expect(line).toContain("[REDACTED]");
  });
});

describe("the writer", () => {
  function writer(send: (write: OriginWriteBack) => Promise<boolean>, clock: { at: number } = { at: 1000 }) {
    const sent: OriginWriteBack[] = [];
    const origin = createOriginWriter({
      omBase: "http://127.0.0.1:1",
      now: () => clock.at,
      send: async (write) => { sent.push(write); return send(write); },
    });
    return { origin, sent, clock };
  }

  it("writes nothing when the caller sent no thread", async () => {
    const { origin, sent } = writer(async () => true);
    await origin.accepted("mmx-1", "mmx", undefined);
    await origin.progress("mmx-1", "mmx", "在做");
    await origin.terminal("mmx-1", "mmx", "completed", "好了", 5);
    expect(sent).toEqual([]);
  });

  it("writes the acceptance, the progress and the terminal line into the asking thread", async () => {
    const { origin, sent } = writer(async () => true);
    await origin.accepted("mmx-1", "mmx", "thread-9");
    await origin.progress("mmx-1", "mmx", "在做");
    await origin.terminal("mmx-1", "mmx", "completed", "好了", 5);
    expect(sent.map((write) => write.threadId)).toEqual(["thread-9", "thread-9", "thread-9"]);
    expect(sent[0]?.text).toContain("已受理");
    expect(sent[1]?.text).toContain("进行中");
    expect(sent[2]?.text).toContain("完成");
  });

  it("keeps progress lines at least a quarter of a minute apart", async () => {
    const { origin, sent, clock } = writer(async () => true);
    await origin.accepted("mmx-1", "mmx", "thread-9");
    await origin.progress("mmx-1", "mmx", "第一次");
    clock.at += ORIGIN_PROGRESS_THROTTLE_MS - 1;
    await origin.progress("mmx-1", "mmx", "第二次");
    expect(sent).toHaveLength(2);
    clock.at += 1;
    await origin.progress("mmx-1", "mmx", "第三次");
    expect(sent).toHaveLength(3);
  });

  it("writes the terminal line even right after a progress line", async () => {
    const { origin, sent } = writer(async () => true);
    await origin.accepted("mmx-1", "mmx", "thread-9");
    await origin.progress("mmx-1", "mmx", "在做");
    await origin.terminal("mmx-1", "mmx", "completed", "好了", 5);
    expect(sent).toHaveLength(3);
  });

  it("keeps a failed write-back to itself", async () => {
    const { origin, sent } = writer(async () => false);
    await origin.accepted("mmx-1", "mmx", "thread-9");
    await expect(origin.progress("mmx-1", "mmx", "在做")).resolves.toBeUndefined();
    await expect(origin.terminal("mmx-1", "mmx", "completed", "好了", 5)).resolves.toBeUndefined();
    expect(sent).toHaveLength(3);
  });

  it("survives a transport that throws", async () => {
    const { origin } = writer(async () => { throw new Error("8801 不在"); });
    await expect(origin.accepted("mmx-1", "mmx", "thread-9")).resolves.toBeUndefined();
  });

  it("remembers the thread of a task", async () => {
    const { origin } = writer(async () => true);
    await origin.accepted("mmx-1", "mmx", "thread-9");
    expect(origin.threadOf("mmx-1")).toBe("thread-9");
    expect(origin.threadOf("other")).toBeUndefined();
  });
});
