import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { AcpHost, PrivateResponseIds, type AcpInbound } from "./host.ts";

// Native logging has its own 250 ms flush timer; keeping it out of the module keeps this file's timer
// counts about the host's requests only.
const nativeLog = vi.hoisted(() => ({ entries: [] as Array<{ threadId: string; dir: string; msg: any }> }));
vi.mock("../native.ts", () => ({
  appendNative: (threadId: string, entry: { dir: string; msg: any }) => {
    nativeLog.entries.push({ threadId, ...entry });
  },
}));

function fakeChild() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, pid: undefined });
  const written: any[] = [];
  child.stdin.on("data", (chunk: Buffer) => { for (const line of chunk.toString().split("\n").filter(Boolean)) written.push(JSON.parse(line)); });
  const say = (msg: unknown) => child.stdout.write(JSON.stringify(msg) + "\n");
  return { child: child as unknown as ChildProcessWithoutNullStreams, written, say };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

function hostWith(key: string | null) {
  const { child, written, say } = fakeChild();
  const refused: any[] = [];
  const host = new AcpHost(child, key, { source: "test.acp", logMessage: (msg) => msg, unrouted: (msg) => refused.push(msg) });
  const heard = new Map<string, any[]>();
  const link = (threadId: string, sessionId: string | null) => {
    const linked = host.link(threadId, `/work/${threadId}`);
    linked.sessionId = sessionId;
    const inbox: any[] = [];
    heard.set(threadId, inbox);
    linked.inbound = { request: (msg) => inbox.push(msg), notification: (msg) => inbox.push(msg), exit: () => {}, error: () => {}, busy: () => false } satisfies AcpInbound;
    return linked;
  };
  return { host, written, say, refused, heard, link };
}

describe("an ACP process's exit", () => {
  it("hands each listening thread the code and signal, with the last stderr lines kept masked", async () => {
    const { child } = fakeChild();
    const host = new AcpHost(child, null, { source: "test.acp", logMessage: (msg) => msg, unrouted: () => {} });
    const exits: Array<[number | null, NodeJS.Signals | null, string]> = [];
    const linked = host.link("a", "/work/a");
    linked.inbound = { request: () => {}, notification: () => {}, error: () => {}, busy: () => false, exit: (code, signal) => exits.push([code, signal, host.stderrTail.text]) };
    const stderr = child.stderr as unknown as PassThrough;
    stderr.write("starting\nOpen https://accounts.google.com/o/oauth2/v2/auth?state=private-state\n");
    stderr.write("fatal: out of cheese");
    await flush();
    child.emit("close", null, "SIGABRT");
    expect(exits).toEqual([[null, "SIGABRT", expect.stringMatching(/^starting \| Open https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?«redacted \d+ chars» \| fatal: out of cheese$/u)]]);
    expect(exits[0]![2]).not.toContain("private-state");
  });
});

describe("one ACP process for several threads", () => {
  it("gives each thread only its own session's traffic, and refuses a request for a session no thread holds", async () => {
    const h = hostWith("shared");
    const a = h.link("a", "s-a");
    h.link("b", "s-b");
    h.say({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-b", update: { sessionUpdate: "agent_message_chunk" } } });
    h.say({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: { sessionId: "s-a" } });
    await flush();
    expect(h.heard.get("a")!.map((msg) => msg.id ?? msg.params.sessionId)).toEqual([7]);
    expect(h.heard.get("b")!.map((msg) => msg.params.sessionId)).toEqual(["s-b"]);
    a.close();
    h.say({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-a", update: { sessionUpdate: "agent_message_chunk" } } });
    h.say({ jsonrpc: "2.0", id: 8, method: "session/request_permission", params: { sessionId: "s-a" } });
    await flush();
    expect(h.heard.get("b")!).toHaveLength(1);
    expect(h.refused.map((msg) => msg.id)).toEqual([8]);
  });

  it("answers each request to the thread that asked, and fails only that thread's requests when it leaves", async () => {
    const h = hostWith("shared");
    const a = h.link("a", "s-a");
    const b = h.link("b", "s-b");
    const fromA = a.request("session/prompt", { sessionId: "s-a" });
    const fromB = b.request("session/prompt", { sessionId: "s-b" });
    await flush();
    const ids = h.written.map((msg) => msg.id);
    h.say({ jsonrpc: "2.0", id: ids[1], result: { stopReason: "end_turn" } });
    await expect(fromB).resolves.toEqual({ stopReason: "end_turn" });
    a.close();
    await expect(fromA).rejects.toThrow("session closed");
  });

  it("keeps a single thread's process routing everything to it, as before sharing", async () => {
    const h = hostWith(null);
    h.link("only", "s-1");
    h.say({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "agent-renamed", update: {} } });
    h.say({ jsonrpc: "2.0", method: "session/update", params: { update: {} } });
    await flush();
    expect(h.heard.get("only")).toHaveLength(2);
  });
});

describe("an ACP request's deadlines", () => {
  async function timed(run: () => Promise<void>): Promise<void> {
    vi.useFakeTimers();
    try {
      await run();
    } finally {
      vi.useRealTimers();
    }
  }

  it("clears both deadlines once a private response arrives", () => timed(async () => {
    const h = hostWith(null);
    const link = h.link("a", "s-1");
    const answer = link.request("_x.ai/mcp/list", {}, 1_000, undefined, 500);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(2);
    const id = h.written.at(-1)!.id;
    h.say({ jsonrpc: "2.0", id, result: { servers: [] } });
    await expect(answer).resolves.toEqual({ servers: [] });
    expect(vi.getTimerCount()).toBe(0);
  }));

  it("rejects once on the request deadline and never on the idle one", () => timed(async () => {
    const h = hostWith(null);
    const link = h.link("a", "s-1");
    const answer = link.request("_x.ai/mcp/list", {}, 100, undefined, 300);
    answer.catch(() => {});
    await vi.advanceTimersByTimeAsync(110);
    await expect(answer).rejects.toThrow("timed out");
    expect(vi.getTimerCount()).toBe(0);
    // The idle deadline was cleared with it: nothing fires when its moment passes.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(0);
  }));

  it("rejects on idle silence and clears the hard deadline", () => timed(async () => {
    const h = hostWith(null);
    const link = h.link("a", "s-1");
    const answer = link.request("_x.ai/mcp/list", {}, 300, undefined, 100);
    answer.catch(() => {});
    await vi.advanceTimersByTimeAsync(110);
    await expect(answer).rejects.toThrow(/stopped responding/);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(0);
  }));

  it("clears both deadlines when the thread leaves", () => timed(async () => {
    const h = hostWith(null);
    const link = h.link("a", "s-1");
    const answer = link.request("_x.ai/mcp/list", {}, 1_000, undefined, 500);
    answer.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(2);
    link.close();
    await expect(answer).rejects.toThrow("session closed");
    expect(vi.getTimerCount()).toBe(0);
  }));

  it("returns to the timer baseline after repeated private requests", () => timed(async () => {
    const h = hostWith(null);
    const link = h.link("a", "s-1");
    const baseline = vi.getTimerCount();
    for (let round = 0; round < 5; round++) {
      const answer = link.request("_x.ai/mcp/list", {}, 1_000, undefined, 500) as Promise<unknown>;
      await vi.advanceTimersByTimeAsync(0);
      h.say({ jsonrpc: "2.0", id: h.written.at(-1)!.id, result: {} });
      await answer;
    }
    expect(vi.getTimerCount()).toBe(baseline);
  }));

  it("keeps a late private response masked after its request timed out", () => timed(async () => {
    const h = hostWith(null);
    const link = h.link("a", "s-1");
    const answer = link.request("_x.ai/mcp/list", {}, 100);
    answer.catch(() => {});
    const id = h.written.at(-1)!.id;
    await vi.advanceTimersByTimeAsync(110);
    await expect(answer).rejects.toThrow("timed out");
    nativeLog.entries.length = 0;
    h.say({ jsonrpc: "2.0", id, result: { servers: [{ name: "private-fixture", headers: { Authorization: "Bearer private-fixture" } }] } });
    await vi.advanceTimersByTimeAsync(0);
    const logged = nativeLog.entries.filter((entry) => entry.dir === "in" && entry.msg.id === id);
    expect(logged).toHaveLength(1);
    expect(logged[0]!.msg).toEqual({ jsonrpc: "2.0", id, result: "[MCP catalog omitted]" });
    expect(JSON.stringify(logged)).not.toContain("Bearer");
  }));

  it("forgets an expired private ID and keeps the record list bounded", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const ids = new PrivateResponseIds();
      ids.add(1);
      ids.retire(1);
      expect(ids.has(1)).toBe(true);
      vi.setSystemTime(PrivateResponseIds.TTL_MS + 1);
      ids.prune();
      expect(ids.has(1)).toBe(false);

      for (let index = 0; index < PrivateResponseIds.LIMIT + 2; index++) {
        ids.add(1_000 + index);
        ids.retire(1_000 + index);
      }
      expect(ids.has(1_000)).toBe(false);
      expect(ids.has(1_000 + PrivateResponseIds.LIMIT + 1)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
