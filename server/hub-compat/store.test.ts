import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  HubStore,
  ONLINE_WINDOW_SEC,
  atomicWriteJson,
  readResult,
  reapResult,
  safeComponent,
  updateResult,
} from "./store.ts";

const dirs: string[] = [];

// The host's shell may carry the legacy agent-hub environment (HUB_STATE_DIR,
// HUB_AGENTS_FILE, HUB_TOKEN...). Tests must never write into a live hub.
for (const key of ["HUB_TOKEN", "HUB_AGENTS_FILE", "HUB_RESULTS_DIR", "HUB_STATE_DIR", "AGENTHUB_DISCOVERY"]) {
  delete process.env[key];
}

async function tempStore(): Promise<{ store: HubStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "hub-compat-store-"));
  dirs.push(dir);
  return { store: new HubStore({ stateDir: dir }), dir };
}

afterEach(async () => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("safeComponent", () => {
  it("keeps a portable identifier and rejects traversal or reserved names", () => {
    expect(safeComponent("codebuddy-0123abcd")).toBe("codebuddy-0123abcd");
    expect(safeComponent("甲-乙")).toBe("甲-乙");
    for (const value of ["", ".", "..", "../x", "a/b", "a\\b", "a\0b", "x.", "x ", "CON", "con.txt", "lpt9"]) {
      expect(() => safeComponent(value)).toThrow();
    }
    expect(() => safeComponent("x".repeat(161))).toThrow();
    expect(safeComponent("x".repeat(160))).toHaveLength(160);
  });
});

describe("atomic JSON writes", () => {
  it("renames a complete document into place without leaving temp files", async () => {
    const { dir } = await tempStore();
    const path = join(dir, "notes.json");
    await atomicWriteJson(path, { a: 1, 中文: "值" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ a: 1, 中文: "值" });
    expect((await readdir(dir)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });
});

describe("registry and aliases", () => {
  it("registers heartbeats using the legacy alias table", async () => {
    const { store, dir } = await tempStore();
    expect(await store.heartbeat({ agent: "cb" })).toBe("codebuddy 心跳已登记。当前 10 分钟内在线: codebuddy");
    const registry = JSON.parse(await readFile(join(dir, "registry.json"), "utf8"));
    expect(registry.codebuddy.role).toBe("");
    expect(Date.now() / 1000 - registry.codebuddy.last_seen).toBeLessThan(5);
    expect(ONLINE_WINDOW_SEC).toBe(600);

    expect(await store.heartbeat({ agent: "codebuddy", role: "编程", capabilities: ["ts"] })).toContain("codebuddy");
    const updated = JSON.parse(await readFile(join(dir, "registry.json"), "utf8"));
    expect(updated.codebuddy).toMatchObject({ role: "编程", capabilities: ["ts"] });
  });

  it("returns the legacy refusal when the agent is missing", async () => {
    const { store } = await tempStore();
    await expect(store.heartbeat({})).rejects.toThrow("缺少 agent 名称");
  });
});

describe("shared task queue", () => {
  it("runs post → list → claim → complete and reports through the mailbox", async () => {
    const { store } = await tempStore();
    const posted = await store.postTask({ from_agent: "alice", title: "修 bug", detail: "细节" });
    expect(posted).toMatch(/^任务已入队: t-\d{10}-\d{4}-\d+ 「修 bug」 -> 任意代理认领$/);
    const id = /任务已入队: (\S+) /.exec(posted)?.[1] as string;

    expect(await store.listTasks({})).toBe(
      `共 1 条(最多显示50):\n- ${id} [open] 修 bug | 发起: alice -> 指派: 无 | 执行: - | 优先级: normal`,
    );
    expect(await store.listTasks({ agent: "bob" })).toBe("没有匹配的任务。");

    expect(await store.claimTask({ task_id: id, agent: "bob" })).toBe(`已认领 ${id}「修 bug」。详情: 细节`);
    expect(await store.claimTask({ task_id: id, agent: "bob" })).toBe(`任务 ${id} 当前状态为 in_progress, 认领失败。`);
    expect(await store.listTasks({ status: "in_progress", agent: "bob" })).toContain(`[in_progress] 修 bug`);

    expect(await store.completeTask({ task_id: id, agent: "bob", result: "已修好" })).toBe(
      `任务 ${id} 已标记完成, 结果已回传给 alice。`,
    );
    expect(await store.listTasks({ status: "done" })).toContain("[done] 修 bug | 发起: alice -> 指派: 无 | 执行: bob");

    const inbox = await store.readMessages({ agent: "alice" });
    expect(inbox).toMatch(/^alice 有 2 条未读，本次返回 2 条:/);
    expect(inbox).toContain(`bob 已认领任务 ${id}「修 bug」`);
    expect(inbox).toContain(`任务 ${id}「修 bug」已完成。结果: 已修好`);
    expect(await store.readMessages({ agent: "alice" })).toBe("alice 没有未读消息。");
  });

  it("keeps an assigned task away from other agents and protects completion", async () => {
    const { store } = await tempStore();
    const posted = await store.postTask({ from_agent: "alice", title: "给 bob", to_agent: "bob", priority: "high" });
    const id = /任务已入队: (\S+) /.exec(posted)?.[1] as string;
    expect(posted.endsWith("-> bob")).toBe(true);
    expect(await store.readMessages({ agent: "bob" })).toContain(`新任务 ${id}: 给 bob (用 hub_claim_task 认领)`);
    expect(await store.claimTask({ task_id: id, agent: "carol" })).toBe(`任务 ${id} 指定给 bob, carol 无权认领。`);
    await store.claimTask({ task_id: id, agent: "bob" });
    expect(await store.completeTask({ task_id: id, agent: "carol", result: "x" })).toBe(
      `任务 ${id} 必须由已认领的代理完成，当前操作未写入。`,
    );
    expect(await store.completeTask({ task_id: id, agent: "bob", result: "ok", success: false })).toBe(
      `任务 ${id} 已标记失败, 结果已回传给 alice。`,
    );
    expect(await store.claimTask({ task_id: "t-missing", agent: "bob" })).toBe("未找到任务 t-missing。");
  });

  it("honours mark_read=false and rejects incomplete arguments", async () => {
    const { store } = await tempStore();
    await store.sendMessage({ from_agent: "alice", to_agent: "bob", text: "hi" });
    const first = await store.readMessages({ agent: "bob", mark_read: false });
    expect(first).toMatch(/^bob 有 1 条未读，本次返回 1 条:\n- \[\d{2}-\d{2} \d{2}:\d{2}\] alice: hi$/);
    expect((await store.readMessages({ agent: "bob" })).startsWith("bob 有 1 条未读")).toBe(true);
    expect(await store.readMessages({ agent: "bob" })).toBe("bob 没有未读消息。");

    await expect(store.sendMessage({ from_agent: "alice", to_agent: "bob" })).rejects.toThrow(
      "缺少 to_agent / from_agent / text",
    );
    await expect(store.readMessages({})).rejects.toThrow("缺少 agent");
  });

  it("serialises concurrent posts so every task id is unique", async () => {
    const { store } = await tempStore();
    const replies = await Promise.all(
      Array.from({ length: 25 }, (_, index) => store.postTask({ from_agent: "alice", title: `t${index}` })),
    );
    const ids = replies.map((reply) => /任务已入队: (\S+) /.exec(reply)?.[1]);
    expect(new Set(ids).size).toBe(25);
    expect(await store.listTasks({})).toMatch(/^共 25 条/);
    const data = JSON.parse(await readFile(join(store.stateDir, "tasks.json"), "utf8"));
    expect(data.seq).toBe(25);
  });
});

describe("shared notes", () => {
  it("stores, reads and lists notes with the legacy wording", async () => {
    const { store } = await tempStore();
    expect(await store.noteGet({})).toBe("全部笔记: (空)");
    expect(await store.noteSet({ key: "k", value: "v" })).toBe("笔记「k」已保存。");
    expect(await store.noteGet({ key: "k" })).toBe("k = v (by unknown)");
    expect(await store.noteGet({ key: "missing" })).toBe("没有笔记「missing」。");
    expect(await store.noteGet({})).toBe("全部笔记: k");
    await expect(store.noteSet({ value: "x" })).rejects.toThrow("缺少 key");
  });
});

describe("async result records", () => {
  it("rejects corrupt records instead of treating them as empty", async () => {
    const { store } = await tempStore();
    expect(await readResult(store.resultsDir, "codebuddy-0123456789")).toBeNull();
    await mkdir(store.resultsDir, { recursive: true });
    await writeFile(join(store.resultsDir, "codebuddy-0123456789.json"), "{broken", "utf8");
    await expect(readResult(store.resultsDir, "codebuddy-0123456789")).rejects.toThrow(
      "Task result is invalid; preserve its ref",
    );
  });

  it("records status history and rewrites updated_at", async () => {
    const { store } = await tempStore();
    await mkdir(store.resultsDir, { recursive: true });
    await writeFile(
      join(store.resultsDir, "codebuddy-0123456789.json"),
      JSON.stringify({ ref: "codebuddy-0123456789", agent: "codebuddy", status: "running", updated_at: 1 }),
      "utf8",
    );
    const updated = await updateResult(store.resultsDir, "codebuddy-0123456789", { status: "completed", text: "done" });
    expect(updated.status).toBe("completed");
    expect(updated.text).toBe("done");
    expect(updated.last_confirmed_status).toBe("completed");
    expect(updated.status_history).toEqual([
      { from: "running", to: "completed", error_code: null, failure_stage: null, at: expect.any(Number) },
    ]);
    expect(updated.updated_at).toBeGreaterThan(1);

    const untouched = await updateResult(
      store.resultsDir,
      "codebuddy-0123456789",
      { status: "timeout" },
      { onlyIfRunning: true },
    );
    expect(untouched.status).toBe("completed");
  });

  it("only reaps stale running records whose process is gone", async () => {
    const { store } = await tempStore();
    await mkdir(store.resultsDir, { recursive: true });
    const stale = {
      ref: "codebuddy-aaaaaaaaaa",
      agent: "codebuddy",
      status: "running",
      updated_at: Date.now() / 1000 - 3600,
      dispatch_count: 1,
    };
    await writeFile(join(store.resultsDir, "codebuddy-aaaaaaaaaa.json"), JSON.stringify(stale), "utf8");

    const reaped = await reapResult(store.resultsDir, stale);
    expect(reaped?.status).toBe("timeout");
    expect(reaped?.text).toMatch(/^任务超时: 已 60 分钟无任何进展, 判定 worker 已异常退出。/);
    expect(reaped?.status_history?.[0]).toMatchObject({ from: "running", to: "timeout" });

    const fresh = { ref: "codebuddy-bbbbbbbbbb", status: "running", updated_at: Date.now() / 1000 };
    expect((await reapResult(store.resultsDir, fresh))?.status).toBe("running");

    const live = { ...stale, ref: "codebuddy-cccccccccc", pid: process.pid };
    expect((await reapResult(store.resultsDir, live))?.status).toBe("running");
  });

  it("summarises the results directory like hub_reap", async () => {
    const { store } = await tempStore();
    expect(await store.reap()).toBe("结果目录不存在, 暂无历史任务。");

    await mkdir(store.resultsDir, { recursive: true });
    const now = Date.now() / 1000;
    await writeFile(
      join(store.resultsDir, "codebuddy-old0000000.json"),
      JSON.stringify({ ref: "codebuddy-old0000000", agent: "codebuddy", status: "running", updated_at: now - 3600 }),
      "utf8",
    );
    await writeFile(
      join(store.resultsDir, "codebuddy-new0000000.json"),
      JSON.stringify({ ref: "codebuddy-new0000000", agent: "codebuddy", status: "running", updated_at: now }),
      "utf8",
    );
    await writeFile(
      join(store.resultsDir, "codebuddy-done000000.json"),
      JSON.stringify({ ref: "codebuddy-done000000", agent: "codebuddy", status: "completed", updated_at: now }),
      "utf8",
    );

    const report = await store.reap();
    expect(report).toContain("已判定超时并回收 1 条:");
    expect(report).toContain("codebuddy-old0000000 (停滞 60 分钟)");
    expect(report).toContain("仍在正常运行 1 条:");
    expect(report).toContain("codebuddy-new0000000 (已 0 分钟)");
    expect(report).not.toContain("codebuddy-done000000");
  });
});
