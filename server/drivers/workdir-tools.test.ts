import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../contracts.ts";

import { createDumateDriver } from "./dumate.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";
import {
  WORKDIR_LIST_MAX_ENTRIES,
  WORKDIR_READ_MAX_BYTES,
  WORKDIR_WRITE_MAX_BYTES,
  attachWorkdirTools,
  executeWorkdirTool,
  workdirToolDefinitions,
} from "./workdir-tools.ts";
import type { ChatToolSession } from "./chat-mcp-tools.ts";

const dirs: string[] = [];
function tempDir(prefix = "omb-workdir-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

function fakeSession(overrides: Partial<ChatToolSession> = {}): ChatToolSession {
  return {
    definitions: [],
    skipped: [],
    trimmed: [],
    merged: [],
    budget: { total: 0, cap: 128, trimmed: 0 },
    refit: async () => {},
    validate: () => {},
    view: (name, input) => ({ title: name, input, ask: false }),
    execute: async () => ({ ok: true, text: "ok" }),
    close: async () => {},
    ...overrides,
  };
}

function fakeServer(toolName: string) {
  const script = `
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      buf += c;
      for (let i = buf.indexOf("\\n"); i !== -1; i = buf.indexOf("\\n")) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1" } } }) + "\\n");
        } else if (msg.method === "tools/list") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: ${JSON.stringify(toolName)}, description: "fake", inputSchema: { type: "object", properties: {} } }] } }) + "\\n");
        } else if (msg.id !== undefined) {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
        }
      }
    });
  `;
  return { command: process.execPath, args: ["-e", script], env: {} };
}

describe("workdir tools", () => {
  it("writes, creates parent directories, and reads text inside cwd", async () => {
    const cwd = tempDir();
    const w = await executeWorkdirTool(cwd, "workdir_write", { path: "sub/dir/hello.txt", content: "hello world" });
    expect(w.ok).toBe(true);
    expect(readFileSync(join(cwd, "sub/dir/hello.txt"), "utf8")).toBe("hello world");

    const r = await executeWorkdirTool(cwd, "workdir_read", { path: "sub/dir/hello.txt" });
    expect(r).toEqual({ ok: true, text: "hello world" });
  });

  it("appends to an existing file when append is true", async () => {
    const cwd = tempDir();
    await executeWorkdirTool(cwd, "workdir_write", { path: "log.txt", content: "line1\n" });
    const a = await executeWorkdirTool(cwd, "workdir_write", { path: "log.txt", content: "line2\n", append: true });
    expect(a.ok).toBe(true);
    const r = await executeWorkdirTool(cwd, "workdir_read", { path: "log.txt" });
    expect(r).toEqual({ ok: true, text: "line1\nline2\n" });
  });

  it("lists directory entries with types and sizes and caps at 500 entries", async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, "alpha"));
    writeFileSync(join(cwd, "beta.txt"), "12345", "utf8");
    const list = await executeWorkdirTool(cwd, "workdir_list", {});
    expect(list.ok).toBe(true);
    expect(list.text).toContain("dir\t-\talpha/");
    expect(list.text).toContain("file\t5\tbeta.txt");

    const big = tempDir();
    for (let i = 0; i < WORKDIR_LIST_MAX_ENTRIES + 5; i++) {
      writeFileSync(join(big, `f-${String(i).padStart(4, "0")}.txt`), "x");
    }
    const capped = await executeWorkdirTool(big, "workdir_list", {});
    expect(capped.ok).toBe(true);
    expect(capped.text).toContain(`showing ${WORKDIR_LIST_MAX_ENTRIES} of ${WORKDIR_LIST_MAX_ENTRIES + 5} entries`);
  });

  it("creates nested directories with workdir_mkdir", async () => {
    const cwd = tempDir();
    const res = await executeWorkdirTool(cwd, "workdir_mkdir", { path: "a/b/c" });
    expect(res.ok).toBe(true);
    expect(existsSync(join(cwd, "a/b/c"))).toBe(true);
  });

  it("reads slices with offset/limit and rejects limits above 256 KB", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "slice.txt"), "abcdefghij", "utf8");
    const slice = await executeWorkdirTool(cwd, "workdir_read", { path: "slice.txt", offset: 2, limit: 4 });
    expect(slice.ok).toBe(true);
    expect(slice.text).toContain("cdef");
    expect(slice.text).toContain("truncated");

    const tooBig = await executeWorkdirTool(cwd, "workdir_read", { path: "slice.txt", limit: WORKDIR_READ_MAX_BYTES + 1 });
    expect(tooBig.ok).toBe(false);
    expect(tooBig.text).toContain("262144");
  });

  it("rejects ../x traversal across read, write, list, and mkdir", async () => {
    const cwd = tempDir();
    for (const [name, args] of [
      ["workdir_read", { path: "../secret.txt" }],
      ["workdir_write", { path: "../escape.txt", content: "bad" }],
      ["workdir_list", { path: ".." }],
      ["workdir_mkdir", { path: "../escape-dir" }],
    ] as const) {
      const res = await executeWorkdirTool(cwd, name, args);
      expect(res.ok).toBe(false);
      expect(res.text).toContain("工作目录之外");
    }
  });

  it("rejects out-of-bounds absolute paths while allowing absolute paths inside cwd", async () => {
    const cwd = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "out.txt"), "secret");

    const bad = await executeWorkdirTool(cwd, "workdir_read", { path: join(outside, "out.txt") });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("工作目录之外");

    const goodWrite = await executeWorkdirTool(cwd, "workdir_write", { path: join(cwd, "inside.txt"), content: "ok" });
    expect(goodWrite.ok).toBe(true);
    const goodRead = await executeWorkdirTool(cwd, "workdir_read", { path: join(cwd, "inside.txt") });
    expect(goodRead).toEqual({ ok: true, text: "ok" });
  });

  it("rejects symlink escapes for files, parent directories, and dangling links", async () => {
    const cwd = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "secret.txt"), "top-secret");

    symlinkSync(join(outside, "secret.txt"), join(cwd, "link-file.txt"));
    symlinkSync(outside, join(cwd, "link-dir"));
    symlinkSync(join(outside, "missing.txt"), join(cwd, "dangling.txt"));

    const readLink = await executeWorkdirTool(cwd, "workdir_read", { path: "link-file.txt" });
    expect(readLink.ok).toBe(false);
    expect(readLink.text).toContain("符号链接逃逸");

    const writeViaDir = await executeWorkdirTool(cwd, "workdir_write", { path: "link-dir/pwn.txt", content: "no" });
    expect(writeViaDir.ok).toBe(false);
    expect(writeViaDir.text).toContain("符号链接逃逸");
    expect(existsSync(join(outside, "pwn.txt"))).toBe(false);

    const readDangling = await executeWorkdirTool(cwd, "workdir_read", { path: "dangling.txt" });
    expect(readDangling.ok).toBe(false);
    expect(readDangling.text).toContain("符号链接");
  });

  it("rejects writes exceeding 1 MB", async () => {
    const cwd = tempDir();
    const huge = "a".repeat(WORKDIR_WRITE_MAX_BYTES + 1);
    const res = await executeWorkdirTool(cwd, "workdir_write", { path: "huge.txt", content: huge });
    expect(res.ok).toBe(false);
    expect(res.text).toContain("1048576");
    expect(existsSync(join(cwd, "huge.txt"))).toBe(false);
  });

  it("returns an error when cwd does not exist and does not create it", async () => {
    const parent = tempDir();
    const missingCwd = join(parent, "does-not-exist");
    const res = await executeWorkdirTool(missingCwd, "workdir_write", { path: "a.txt", content: "hi" });
    expect(res.ok).toBe(false);
    expect(res.text).toContain("工作目录不存在");
    expect(existsSync(missingCwd)).toBe(false);
  });

  it("mentions the bot working directory constraint in tool descriptions", () => {
    const defs = workdirToolDefinitions("/tmp/bot-cwd");
    expect(defs.map((d) => d.function.name)).toEqual(["workdir_list", "workdir_read", "workdir_write", "workdir_mkdir"]);
    for (const def of defs) {
      expect(def.function.description).toContain("只能在 bot 的工作目录 /tmp/bot-cwd 内读写");
    }
  });

  it("does not attach workdir tools when already present or excluded by toolScope", () => {
    const session = fakeSession();
    const { definitions } = attachWorkdirTools(session, "/tmp/cwd", { allow: ["native:workdir_read"] });
    expect(definitions.map((d) => d.function.name)).toEqual(["workdir_read"]);
  });

  it("mounts workdir tools in openai-chat only when workdirTools=true, cwd exists, and localComputer is absent", async () => {
    const cwd = tempDir();
    const seenTools: string[][] = [];
    const mockFetch = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      seenTools.push((body.tools ?? []).map((t: { function: { name: string } }) => t.function.name));
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    const runTurn = async (workdirTools: boolean | undefined, turn: { threadId: string; text: string; cwd?: string; workdir?: string; integrations?: { localComputer: ReturnType<typeof fakeServer> } }) => {
      const runtime = createOpenAIChatRuntime({
        input: { instanceId: "t", displayName: "t", enabled: true, config: {}, environment: {} },
        driverKind: "test",
        apiKey: "test-key",
        apiUrl: "https://api.example.com/v1/chat/completions",
        models: () => ({ default: "m1", options: [{ id: "m1", label: "m1" }] }),
        requestBody: (model, messages, stream) => ({ model, messages, stream }),
        fetch: mockFetch as typeof fetch,
        httpErrorLabel: "Test",
        missingKeyError: "no key",
        unavailableReason: "no key",
        timeoutMs: 10_000,
        computerUse: true,
        ...(workdirTools !== undefined ? { workdirTools } : {}),
        nativeLog: { source: "test", outgoing: () => ({}), incoming: () => ({}) },
      });
      const events: RuntimeEvent[] = [];
      runtime.adapter.onEvent((e) => events.push(e));
      await runtime.adapter.sendTurn(turn);
      await vi.waitFor(() => { if (!events.some((e) => e.type === "turn.completed")) throw new Error("still running"); });
      await runtime.dispose();
    };

    // 1. workdirTools=true + cwd + no localComputer -> mounted
    await runTurn(true, { threadId: "t1", text: "hi", cwd });
    expect(seenTools[0]).toEqual(expect.arrayContaining(["workdir_list", "workdir_read", "workdir_write", "workdir_mkdir"]));

    // 2. workdirTools=true + no cwd -> not mounted
    await runTurn(true, { threadId: "t2", text: "hi" });
    expect(seenTools[1]).not.toContain("workdir_write");

    // 3. workdirTools off (default) + cwd -> not mounted
    await runTurn(undefined, { threadId: "t3", text: "hi", cwd });
    expect(seenTools[2]).not.toContain("workdir_write");

    // 4. workdirTools=true + cwd + localComputer -> not mounted
    await runTurn(true, {
      threadId: "t4",
      text: "hi",
      cwd,
      integrations: { localComputer: fakeServer("bash") },
    });
    expect(seenTools[3]).toContain("computer_bash");
    expect(seenTools[3]).not.toContain("workdir_write");

    // 5. E108: chat engines get no cwd from the server, only `workdir` (the folder the person set) -> mounted
    await runTurn(true, { threadId: "t5", text: "hi", workdir: cwd });
    expect(seenTools[4]).toEqual(expect.arrayContaining(["workdir_write"]));
  });

  it("enables workdirTools in dumate driver", async () => {
    const cwd = tempDir();
    let sentTools: string[] = [];
    const driver = createDumateDriver({
      loadStore: (async () => ({ accounts: [{ id: "a1", uid: "u1", name: "n1", cookie: "BDUSS=1" }] })) as never,
      gatewayToken: (async () => ({ ok: true, token: "gt-1", expiresAt: Date.now() + 60_000 })) as never,
      fetch: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        sentTools = (body.tools ?? []).map((t: { function: { name: string } }) => t.function.name);
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }) as never,
    });
    const runtime = await driver.create({ instanceId: "dumate", displayName: "百度搭子 DuMate", enabled: true, config: {}, environment: {} });
    const events: RuntimeEvent[] = [];
    runtime.adapter.onEvent((e) => events.push(e));
    await runtime.adapter.sendTurn({ threadId: "t-dm", text: "write file", cwd });
    await vi.waitFor(() => { if (!events.some((e) => e.type === "turn.completed")) throw new Error("still running"); });
    await runtime.dispose();
    expect(sentTools).toEqual(expect.arrayContaining(["workdir_list", "workdir_read", "workdir_write", "workdir_mkdir"]));
  });
});
