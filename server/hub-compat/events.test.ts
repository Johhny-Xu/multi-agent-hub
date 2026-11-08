// hub-compat 事件日志：seq 连续、增量读取、重启续号、敏感串脱敏。
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HubEventLog, hubEventLog, redactEventText } from "./events.ts";

const dirs: string[] = [];
async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hub-events-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("hub event log", () => {
  it("numbers events per ref, persists them and replays only what is new", async () => {
    const dir = await freshDir();
    const log = new HubEventLog(dir);
    const accepted = log.emit("codebuddy-0123456789", "codebuddy", "accepted", "任务已受理");
    const progress = log.emit("codebuddy-0123456789", "codebuddy", "progress", "工具调用: read_file");
    const done = log.emit("codebuddy-0123456789", "codebuddy", "done", "完成");
    expect([accepted.seq, progress.seq, done.seq]).toEqual([1, 2, 3]);
    expect(log.list("codebuddy-0123456789", 1).map((event) => event.kind)).toEqual(["progress", "done"]);
    expect(log.list("codebuddy-0123456789", done.seq)).toEqual([]);

    // Another reader (the workbench bridge) only has the file, and sees the same thing.
    const other = new HubEventLog(dir);
    expect(other.list("codebuddy-0123456789").map((event) => event.text)).toEqual(["任务已受理", "工具调用: read_file", "完成"]);

    const lines = (await readFile(join(dir, "events", "codebuddy-0123456789.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  it("continues the sequence after a restart instead of starting over", async () => {
    const dir = await freshDir();
    new HubEventLog(dir).emit("zcode-aaaabbbbcc", "zcode", "accepted", "一");
    const restarted = new HubEventLog(dir);
    expect(restarted.emit("zcode-aaaabbbbcc", "zcode", "started", "二").seq).toBe(2);
  });

  it("hands live events to subscribers and stops after unsubscribe", async () => {
    const dir = await freshDir();
    const log = hubEventLog(dir);
    const seen: string[] = [];
    const off = log.subscribe("qoder-1122334455", (event) => seen.push(event.kind));
    log.emit("qoder-1122334455", "qoder", "accepted", "一");
    off();
    log.emit("qoder-1122334455", "qoder", "done", "二");
    expect(seen).toEqual(["accepted"]);
  });

  it("shares one log per state directory", async () => {
    const dir = await freshDir();
    expect(hubEventLog(dir)).toBe(hubEventLog(dir));
  });

  it("scrubs credentials and keeps one short line", () => {
    const text = redactEventText("调用 Bearer abcdef123456 now\nhttps://x/?token=deadbeef&a=1 sk-abcdefgh12345678");
    expect(text).not.toContain("abcdef123456");
    expect(text).not.toContain("deadbeef");
    expect(text).not.toContain("sk-abcdefgh12345678");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("\n");
  });

  it("redacts the configured hub token even without a known prefix", () => {
    const previous = process.env.HUB_TOKEN;
    process.env.HUB_TOKEN = "plain-hub-token-value";
    try {
      expect(redactEventText("auth plain-hub-token-value end")).toBe("auth [REDACTED] end");
    } finally {
      if (previous === undefined) delete process.env.HUB_TOKEN;
      else process.env.HUB_TOKEN = previous;
    }
  });
});
