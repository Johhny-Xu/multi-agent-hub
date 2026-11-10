// dispatch.ts 的单文件测试：假 8801（含 bot/线程/回复时序/instances 快照）+ 假 TraeClaw 网关。
// 覆盖任务书验收 1（dispatch→wait_result→completed 文本格式照老实现）与
// 验收 2 的 B 侧（真实 mcp/hub.mjs 的 ask()/fetchRef()/taskStatus() 经 HTTP 驱动本工具集）。
// 验收 3（tools/list 与 contract.json 逐字一致）属于 A 的 main.ts 注册表，A 侧自测。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createDispatchTools, qualifyDefaultModel } from "./dispatch.ts";

/** mcp/hub.mjs is plain JS with no type declarations; importing it by URL keeps tsc from requiring one. */
interface HubClient {
  ask(worker: string, task: string, timeoutS?: number, options?: Record<string, unknown>): Promise<Record<string, any>>;
  fetchRef(ref: string): Promise<Record<string, any>>;
  taskStatus(ref: string): Promise<Record<string, any>>;
}
const importHubClient = async (): Promise<HubClient> => import(new URL("../../mcp/hub.mjs", import.meta.url).href);

// 本机 shell 可能带着老部署的 HUB_AGENTS_FILE；测试必须只看自己的临时 stateDir，
// 否则会读到真实 agents.json 的停用标记（并可能写坏它）。
const savedAgentsFile = process.env.HUB_AGENTS_FILE;
delete process.env.HUB_AGENTS_FILE;
afterAll(() => {
  if (savedAgentsFile === undefined) delete process.env.HUB_AGENTS_FILE;
  else process.env.HUB_AGENTS_FILE = savedAgentsFile;
});
// 注意：mcp/hub.mjs 不能在模块顶层静态 import——它加载即按真实 ~/.config/agenthub/client.json
// 建连（会指向生产 8765）。契约测试一律在设置 AGENTHUB_URL/HUB_TOKEN 之后带 query 动态 import。

// ---------------------------------------------------------------- 假 8801

interface FakeBot { id: string; name: string; threadId: string; modelSelection: Record<string, string>; hidden?: boolean; movedTo?: unknown }
/** 8801 的消息行带回合标记：requestMessageId 指明属于哪次请求，turnId 指明属于哪一轮。 */
interface FakeMessage {
  role: string; kind: string; text: string; at: number;
  id?: string; turnId?: string; requestMessageId?: string;
  turnSucceeded?: boolean; turnTerminal?: boolean;
  requestCancelled?: boolean; requestPending?: boolean;
  tool?: { name: string; ok?: boolean | null };
  digest?: { reply?: string; [k: string]: unknown };
}

async function startFakeOm(config: {
  replyText?: string; replyDelayMs?: number; createErrorStatus?: number; instances?: any[];
  /** E19：回给「把汇报写完」那条追问的文本；不设则消息接口不回话。 */
  followupReplyText?: string;
  /** The workbench refuses the write-back when this is set. */
  originPostStatus?: number;
  /** E3：GET /hub/quota 的响应体；不设则 404（额度未知）。 */
  hubQuota?: unknown;
  /** E3：GET /api/plan-usage 的响应体；不设则 404。 */
  planUsage?: unknown;
} = {}): Promise<{
  server: Server; url: string; calls: string[]; bots: FakeBot[];
  /** Every write-back the hub sent into an asking thread. */
  originPosts: Array<{ threadId: string; text: string }>;
  threads: Map<string, FakeMessage[]>; threadCwd: Map<string, string>;
  threadBusy: Map<string, boolean>;
  /** E25：覆盖 job 视图的 state（不设时 busy→running，否则 idle）。 */
  threadJobState: Map<string, string>;
  setThreadGone: (id: string) => void;
  setThreadBusy: (id: string, busy: boolean) => void;
  pushMessage: (id: string, message: FakeMessage) => void;
}> {
  const state = {
    calls: [] as string[],
    bots: [] as FakeBot[],
    originPosts: [] as Array<{ threadId: string; text: string }>,
    threads: new Map<string, FakeMessage[]>(),
    threadCwd: new Map<string, string>(),
    threadBusy: new Map<string, boolean>(),
    threadJobState: new Map<string, string>(),
    turns: new Map<string, { turnId: string; requestMessageId: string }>(),
    goneThreads: new Set<string>(),
    instances: [...(config.instances ?? [
      { instanceId: "codebuddy", driverKind: "codebuddyAgent", displayName: "CodeBuddy",
        snapshot: { state: "available", version: "2.181.0", authenticated: true },
        models: { default: "deepseek-v4.1-flash", options: [
          { id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
          { id: "cb-alt", label: "CB Alt" },
        ] } },
      { instanceId: "codebuddyCn", driverKind: "codebuddyCnAgent", displayName: "CodeBuddy CN",
        snapshot: { state: "available", version: "2.181.0", authenticated: true },
        models: { default: "deepseek-v4.1-flash", options: [
          { id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
          { id: "cbcn-alt", label: "CB CN Alt" },
        ] } },
      { instanceId: "zcode", driverKind: "zcodeAgent", displayName: "ZCode",
        snapshot: { state: "available", version: "0.16.9", authenticated: true },
        models: { default: "GLM-5.3-Flash", options: [
          { id: "GLM-5.3-Flash", label: "GLM-5.3-Flash" },
          { id: "GLM-5.3", label: "GLM-5.3" },
          { id: "deepseek-v4.1-flash", label: "deepseek-v4.1-flash" },
          { id: "stealth", label: "stealth" },
        ] } },
    ])],
  };
  const push = (threadId: string, message: FakeMessage) => {
    const list = state.threads.get(threadId) ?? [];
    // bot 的消息默认挂到本线程当前这一轮上：真 8801 也是这么标的。
    if (message.role === "bot" && message.turnId === undefined) {
      const turn = state.turns.get(threadId);
      if (turn) {
        message.turnId = turn.turnId;
        if (message.requestMessageId === undefined) message.requestMessageId = turn.requestMessageId;
      }
    }
    list.push(message);
    state.threads.set(threadId, list);
  };
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    state.calls.push(`${req.method} ${url.split("?")[0]}`);
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const replyLater = (threadId: string, text = config.replyText ?? "OK") => {
        setTimeout(() => {
          // 真 8801：回合终了的那条 bot 文本带 turnTerminal/turnSucceeded。
          push(threadId, { role: "bot", kind: "text", text, at: Date.now(),
            turnSucceeded: true, turnTerminal: true });
          state.threadBusy.set(threadId, false);
        }, config.replyDelayMs ?? 1200);
      };
      if (req.method === "POST" && url.split("?")[0] === "/api/hub/origin") {
        state.originPosts.push({ threadId: String(body?.threadId ?? ""), text: String(body?.text ?? "") });
        if (config.originPostStatus && config.originPostStatus >= 400) return json(config.originPostStatus, { error: "nope" });
        return json(201, { ok: true });
      }
      if (req.method === "GET" && url.split("?")[0] === "/api/bots") {
        const botsWithTasks = state.bots.map((b) => ({
          ...b,
          tasks: Array.from(state.threads.keys()).map((tid) => ({
            threadId: tid,
            busy: state.threadBusy.get(tid) ?? false,
            activity: state.threadBusy.get(tid) ? "working" : "idle",
          })),
        }));
        return json(200, { bots: botsWithTasks });
      }
      if (req.method === "POST" && url === "/api/bots") {
        if (config.createErrorStatus) return json(config.createErrorStatus, { error: "nope" });
        // 真 8801：POST /api/bots 必须带 modelSelection.model，否则 400。
        if (!body?.modelSelection?.model) {
          return json(400, { error: "modelSelection.model is not valid" });
        }
        const bot: FakeBot = {
          id: randomUUID(), name: String(body.name ?? ""),
          threadId: randomUUID(),
          modelSelection: body.modelSelection ?? {},
        };
        state.bots.push(bot);
        // 真 8801 建 bot 会先发一条问候 bot 文本（早于任何派活，必须被时间过滤掉）。
        push(bot.threadId, { role: "bot", kind: "text", text: `Hi, I'm ${bot.name}.`, at: Date.now() });
        return json(201, { bot });
      }
      const patchBot = /^\/api\/bots\/([\w-]+)$/.exec(url);
      if (req.method === "PATCH" && patchBot) {
        const bot = state.bots.find((b) => b.id === patchBot[1]);
        if (!bot) return json(404, { error: "bot not found" });
        if (body.modelSelection && !body.modelSelection.model) {
          return json(400, { error: "modelSelection.model is not valid" });
        }
        bot.modelSelection = body.modelSelection ?? bot.modelSelection;
        if (typeof body.hidden === "boolean") bot.hidden = body.hidden;
        return json(200, { ok: true });
      }
      const tasksMatch = /^\/api\/bots\/([\w-]+)\/tasks$/.exec(url);
      if (req.method === "POST" && tasksMatch) {
        const bot = state.bots.find((b) => b.id === tasksMatch[1]);
        if (!bot) return json(404, { error: "bot not found" });
        const threadId = randomUUID();
        state.threads.set(threadId, []);
        state.threadCwd.set(threadId, String(body.cwd ?? ""));
        state.threadBusy.set(threadId, true);
        replyLater(threadId);
        // 真 8801 的响应形状是 { bot, task: { threadId, ... } }。
        return json(201, { bot, task: { id: threadId, threadId, title: "New task" } });
      }
      const msgMatch = /^\/api\/bots\/([\w-]+)\/messages$/.exec(url);
      if (req.method === "POST" && msgMatch) {
        const bot = state.bots.find((b) => b.id === msgMatch[1]);
        if (!bot) return json(404, { error: "bot not found" });
        const threadId = String(body.threadId ?? "");
        if (!state.threads.has(threadId)) return json(404, { error: "thread not found" });
        state.threadBusy.set(threadId, true);
        // 真 8801 回执里的那条 user 消息 id，就是这一轮的锚。
        const requestMessageId = randomUUID();
        const turnId = `turn-${randomUUID()}`;
        state.turns.set(threadId, { turnId, requestMessageId });
        push(threadId, { role: "user", kind: "text", text: String(body.text ?? ""), at: Date.now(), id: requestMessageId });
        if (config.followupReplyText !== undefined && String(body.text ?? "").includes("把汇报写完")) {
          replyLater(threadId, config.followupReplyText);
        }
        return json(202, { ok: true, threadId, message: { id: requestMessageId, at: Date.now() } });
      }
      const jobMatch = /^\/api\/threads\/([\w-]+)\/job$/.exec(url.split("?")[0]);
      if (req.method === "GET" && jobMatch) {
        const threadId = jobMatch[1];
        if (state.goneThreads.has(threadId)) return json(404, { error: "thread not found" });
        const busy = state.threadBusy.get(threadId) ?? false;
        return json(200, {
          threadId,
          state: state.threadJobState.get(threadId) ?? (busy ? "running" : "idle"),
          conversation: { kind: "bot", busy, activity: busy ? "working" : "idle", queued: 0 },
        });
      }
      const threadMatch = /^\/api\/threads\/([\w-]+)\/messages$/.exec(url.split("?")[0]);
      if (req.method === "GET" && threadMatch) {
        if (state.goneThreads.has(threadMatch[1])) return json(404, { error: "thread not found" });
        return json(200, { messages: state.threads.get(threadMatch[1]) ?? [] });
      }
      if (req.method === "GET" && url === "/api/instances") {
        return json(200, { instances: state.instances });
      }
      if (req.method === "GET" && url.split("?")[0] === "/hub/quota" && config.hubQuota !== undefined) {
        return json(200, config.hubQuota);
      }
      if (req.method === "GET" && url.split("?")[0] === "/api/plan-usage" && config.planUsage !== undefined) {
        return json(200, config.planUsage);
      }
      const patchInstance = /^\/api\/instances\/([\w.-]+)$/.exec(url);
      if (req.method === "PATCH" && patchInstance) {
        const inst = state.instances.find((item: any) => item.instanceId === patchInstance[1]);
        if (!inst) return json(404, { error: "unknown instance" });
        if (body.disabled === true) inst.disabled = true;
        else if (body.disabled === false) delete inst.disabled;
        return json(200, { instances: state.instances });
      }
      return json(404, { error: "not found" });
    });
  });
  return await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${(addr as { port: number }).port}`, ...state,
        setThreadGone: (id: string) => state.goneThreads.add(id),
        // 真 8801 在回合结束时给最后一条助手文本打 turnTerminal，并写 turnSucceeded（server/index.ts 的 turn.completed）。
        setThreadBusy: (id: string, busy: boolean) => {
          state.threadBusy.set(id, busy);
          if (busy) return;
          const rows = state.threads.get(id) ?? [];
          const lastText = rows.filter((row) => row.role === "bot" && row.kind === "text").at(-1);
          if (lastText && lastText.turnSucceeded === undefined) {
            lastText.turnTerminal = true;
            lastText.turnSucceeded = true;
          }
        },
        pushMessage: (id: string, message: FakeMessage) => push(id, message),
      });
    });
  });
}

// ---------------------------------------------------------------- 假 TraeClaw 网关

async function startFakeTrae(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const json = (data: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.method === "GET" && url === "/health") {
        return json({ data: { status: "up", automation: { ready: true, target: { title: "Trae" } } } });
      }
      if (req.method === "POST" && url === "/v1/chat") {
        return json({ data: { session: { sessionId: "sess-123", status: "completed" },
          result: { text: "TRAE_DONE", status: "completed" } } });
      }
      if (req.method === "POST" && url === "/v1/mode") return json({ ok: true });
      res.writeHead(404); res.end("{}");
    });
  });
  return await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
    });
  });
}

// ---------------------------------------------------------------- 公共夹具

const stateDirs: string[] = [];
function freshStateDir(): string {
  const stateDir = mkdtempSync(join(tmpdir(), "hubcompat-dispatch-"));
  stateDirs.push(stateDir);
  return stateDir;
}
function freshTools(omUrl: string, stateDir = freshStateDir()) {
  return createDispatchTools({ omBase: omUrl, stateDir, retryGraceS: 0 });
}

function refOf(receipt: string): string {
  const match = /^\[([^\]\r\n]+)\]/.exec(receipt);
  return match ? match[1].split("/").at(-1)! : "";
}

async function waitFor(ref: string, tools: ReturnType<typeof createDispatchTools>, waitS = 30): Promise<string> {
  return tools.hub_wait_result({ ref, wait_s: waitS });
}

// ---------------------------------------------------------------- 测试

describe("hub-compat dispatch", () => {
  let om: Awaited<ReturnType<typeof startFakeOm>>;
  let trae: Awaited<ReturnType<typeof startFakeTrae>>;
  const oldTraeGateway = process.env.TRAE_GATEWAY;

  beforeAll(async () => {
    om = await startFakeOm();
    trae = await startFakeTrae();
    process.env.TRAE_GATEWAY = trae.url;
  });
  afterAll(() => {
    process.env.TRAE_GATEWAY = oldTraeGateway;
    om.server.close();
    trae.server.close();
  });

  it("dispatch → wait_result → completed，文本格式与老实现逐字一致", async () => {
    const tools = freshTools(om.url);
    const receipt = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "只回复两个字母:OK", timeout_s: 60 });
    const ref = refOf(receipt);
    expect(ref).toMatch(/^codebuddy-[0-9a-f]{10}$/);
    // 老 agent_hub.py:901 逐字
    expect(receipt).toBe(`[codebuddy/${ref}] 任务已异步受理 (此类任务耗时长, 不阻塞等待)。\n`
      + `查询结果: hub_result(ref="${ref}")\n`
      + `查存活状态: hub_task_status(ref="${ref}")  ← 先看 verdict，再看结果\n`
      + `verdict=working/alive_waiting/gui_working 时任务仍在工作，不要按墙钟截断；`
      + `只有终态或 worker_exited_result_missing 才需要处理。`);
    const final = await waitFor(ref, tools);
    // 老 _format_result 逐字：completed + dispatch_count=1 + 正文（bot 回复）+ (exit=0)
    expect(final).toBe(`[${ref}] agent=codebuddy status=completed dispatch_count=1\nOK\n(exit=0)`);
  });

  it("remembers the asking thread and writes the acceptance back into it", async () => {
    const stateDir = freshStateDir();
    const tools = freshTools(om.url, stateDir);
    const receipt = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "只回复两个字母:OK", timeout_s: 60 },
      { originThreadId: "thread-ask-1" });
    const ref = refOf(receipt);
    expect(ref).toBeTruthy();
    const record = JSON.parse(readFileSync(join(stateDir, "results", `${ref}.json`), "utf8"));
    expect(record.origin_thread_id).toBe("thread-ask-1");
    expect(om.originPosts.some((post) => post.threadId === "thread-ask-1" && post.text.includes("已受理"))).toBe(true);
  });

  it("writes nothing back when the caller sent no thread", async () => {
    const stateDir = freshStateDir();
    const tools = freshTools(om.url, stateDir);
    const before = om.originPosts.length;
    const receipt = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "只回复两个字母:OK", timeout_s: 60 });
    const ref = refOf(receipt);
    expect(om.originPosts.length).toBe(before);
    const record = JSON.parse(readFileSync(join(stateDir, "results", `${ref}.json`), "utf8"));
    expect(record.origin_thread_id).toBeUndefined();
  });

  it("keeps a refused write-back out of the dispatch", async () => {
    const refusing = await startFakeOm({ originPostStatus: 500 });
    try {
      const tools = freshTools(refusing.url);
      const receipt = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "只回复两个字母:OK", timeout_s: 60 },
        { originThreadId: "thread-ask-2" });
      expect(receipt).toContain("已异步受理");
      expect(refusing.originPosts.length).toBeGreaterThan(0);
      const ref = refOf(receipt);
      await waitFor(ref, tools, 10);
      const done = JSON.parse(await tools.hub_task_status({ ref, json: true }));
      expect(done.status).toBe("completed");
    } finally {
      refusing.server.close();
    }
  });

  it("回复文本来自 bot 线程，不混入任务文本", async () => {
    const tools = freshTools(om.url);
    const receipt = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "TASK-BODY-MARKER", timeout_s: 60 });
    const final = await waitFor(refOf(receipt), tools);
    expect(final).toContain("\nOK\n(exit=0)");
    expect(final).not.toContain("TASK-BODY-MARKER");
  });

  it("hub_result 未知 ref / hub_result_json / hub_task_status(completed) 格式", async () => {
    const tools = freshTools(om.url);
    expect(await tools.hub_result({ ref: "codebuddy-deadbeef00" }))
      .toBe("[codebuddy-deadbeef00] status=unknown\n未找到任务结果，请核对 ref。");
    const receipt = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "hello", timeout_s: 60 });
    const ref = refOf(receipt);
    await waitFor(ref, tools);
    expect(await tools.hub_result({ ref }))
      .toBe(`[${ref}] agent=codebuddy status=completed dispatch_count=1\nOK\n(exit=0)`);
    const asJson = JSON.parse(await tools.hub_result_json({ ref }));
    expect(asJson).toMatchObject({ ref, agent: "codebuddy", status: "completed", exit_code: 0,
      dispatch_count: 1, text: "OK", verdict: "completed" });
    expect(asJson.liveness).toMatchObject({ verdict: "completed", action: "done",
      guidance: "任务已完成，直接读取结果。", preserve_ref: false });
    const statusJson = JSON.parse(await tools.hub_task_status({ ref, json: true }));
    expect(statusJson).toMatchObject({ ref, agent: "codebuddy", status: "completed", verdict: "completed" });
    const statusText = await tools.hub_task_status({ ref });
    expect(statusText.split("\n")[0]).toBe(`[${ref}] agent=codebuddy status=completed`);
    expect(statusText.split("\n")[1]).toBe("verdict=completed action=done");
    expect(statusText.split("\n")[2]).toBe("process=finished");
    expect(statusText).toContain("output=2B");
    expect(statusText).toContain("guidance: 任务已完成，直接读取结果。");
  });

  it("running 期间无新输出 → alive_waiting，wait_result 预算尽快照照老实现", async () => {
    const slow = await startFakeOm({ replyDelayMs: 9000 });
    try {
      const tools = freshTools(slow.url);
      const receipt = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "slow", timeout_s: 120 });
      const ref = refOf(receipt);
      const running = JSON.parse(await tools.hub_task_status({ ref, json: true }));
      expect(running.status).toBe("running");
      expect(running.verdict).toBe("alive_waiting");
      expect(running.process_alive).toBeNull();
      expect(running.liveness_source).toBe("gui");
      const waitText = await tools.hub_wait_result({ ref, wait_s: 3 });
      expect(waitText).toContain(`[${ref}] status=running (等待预算用尽, 任务仍在执行)`);
      expect(waitText).toContain("[受控端界面快照] (暂无)");
      expect(waitText).toContain("[存活] verdict=alive_waiting action=wait pid=- cpu=nulls output=0B (+nullB)");
      expect(waitText).toContain("建议: 再次调用本工具 (wait_s=110) 继续等待；看到 verdict=working/alive_waiting 时不要按墙钟截断。");
    } finally { slow.server.close(); }
  });

  it("线程消失（404）→ verdict worker_exited_result_missing", async () => {
    const gone = await startFakeOm({ replyDelayMs: 60_000 });
    try {
      const tools = freshTools(gone.url);
      const receipt = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "bye", timeout_s: 120 });
      const ref = refOf(receipt);
      // 等后台轮询建好任务线程（线程 id 记在假 8801 的 threadCwd 里）
      let threadId = "";
      for (let i = 0; i < 30 && !threadId; i++) {
        await new Promise((r) => setTimeout(r, 300));
        threadId = [...gone.threadCwd.keys()].at(-1) ?? "";
      }
      expect(threadId).toBeTruthy();
      gone.setThreadGone(threadId);
      // 后台轮询周期 2s：等一个周期让 runTurn 把 thread_missing 落盘
      await new Promise((r) => setTimeout(r, 2600));
      const status = JSON.parse(await tools.hub_task_status({ ref, json: true }));
      expect(status.status).toBe("running");
      expect(status.verdict).toBe("worker_exited_result_missing");
      expect(status.action).toBe("inspect_delivery");
    } finally { gone.server.close(); }
  });

  it("别名 cb 解析到 codebuddy；未知 worker 返回老实现「未配置 CLI」文本", async () => {
    const tools = freshTools(om.url);
    const receipt = await tools.hub_dispatch_cli({ agent: "cb", task: "alias test", timeout_s: 60 });
    expect(refOf(receipt)).toMatch(/^codebuddy-/);
    const unknown = await tools.hub_dispatch_cli({ agent: "mimocode", task: "x" });
    expect(unknown).toBe("mimocode 未配置 CLI (agents.json 中 cli 为 null)。"
      + "确认该工具的无头调用命令后, 填入 agents.json 的 cli 字段即可。");
  });

  it("不支持的 thinking/attachments/stream/permission 组合照老实现拒绝", async () => {
    const tools = freshTools(om.url);
    await expect(tools.hub_dispatch_cli({ agent: "codebuddy", task: "t", thinking: "on" }))
      .rejects.toThrow("UNSUPPORTED: 此通道尚未验证思考开关或附件输入；请使用对应官方 CLI");
    await expect(tools.hub_dispatch_cli({ agent: "codebuddy", task: "t", attachments: [{ name: "a" }] }))
      .rejects.toThrow("UNSUPPORTED: 此通道尚未验证思考开关或附件输入；请使用对应官方 CLI");
    await expect(tools.hub_dispatch_cli({ agent: "codebuddy", task: "t", stream: "yes" }))
      .rejects.toThrow("stream 必须是布尔值");
    await expect(tools.hub_dispatch_cli({ agent: "codebuddy", task: "t", permission: "yolo" }))
      .rejects.toThrow("UNSUPPORTED: 此通道不支持的 permission 参数");
    await expect(tools.hub_dispatch_cli({ agent: "codebuddy", task: 42 }))
      .rejects.toThrow("task 必须是字符串");
    await expect(tools.hub_dispatch_cli({ agent: "codebuddy", task: "  " }))
      .rejects.toThrow("缺少 task");
  });

  it("zcode：常驻 bot 用 GLM-5.3-Flash；model 参数 PATCH；bot 复用；cwd 缺省 $HOME", async () => {
    const tools = freshTools(om.url);
    const receipt = await tools.hub_dispatch_cli({ agent: "zcode", task: "z1", timeout_s: 60 });
    expect(refOf(receipt)).toMatch(/^zcode-/);
    await waitFor(refOf(receipt), tools);
    const created = om.bots.find((b) => b.name === "hub·zcode");
    expect(created?.modelSelection).toMatchObject({ instanceId: "zcode", model: "GLM-5.3-Flash" });
    const botsBefore = om.calls.filter((c) => c === "POST /api/bots").length;
    await tools.hub_dispatch_cli({ agent: "zcode", task: "z2", model: "GLM-5.3", timeout_s: 60 });
    await tools.hub_dispatch_cli({ agent: "zcode", task: "z3", model: "stealth", timeout_s: 60 });
    expect(om.calls.filter((c) => c === "POST /api/bots").length).toBe(botsBefore);
    expect(om.bots.find((b) => b.name === "hub·zcode")?.modelSelection.model).toBe("stealth");
    // cwd：缺省 $HOME 展开为本机 home；显式 cwd 透传
    const receiptHome = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "cwd default", timeout_s: 60 });
    await waitFor(refOf(receiptHome), tools);
    const explicit = tmpdir();
    const receiptExplicit = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "cwd explicit", cwd: explicit, timeout_s: 60 });
    await waitFor(refOf(receiptExplicit), tools);
    const cwds = [...om.threadCwd.values()];
    expect(cwds).toContain(homedir());
    expect(cwds).toContain(explicit);
  });

  it("zcode_delegate wait=false 异步回执 + wait=true 同步格式 + zcode-last 落盘", async () => {
    const tools = freshTools(om.url);
    const asyncReceipt = await tools.zcode_delegate({ task: "async zcode", wait: false, timeout_s: 60 });
    const ref = refOf(asyncReceipt);
    expect(asyncReceipt).toBe(`[zcode/${ref}] 已异步受理, status=running。\n查询结果: zcode_result(ref="${ref}")`);
    await tools.hub_wait_result({ ref, wait_s: 30 });
    const final = await tools.zcode_result({ ref });
    expect(final).toBe(`[${ref}] agent=zcode status=completed dispatch_count=1\nOK\n(exit=0)`);
    const sync = await tools.zcode_delegate({ task: "sync zcode", wait: true, timeout_s: 60 });
    expect(sync).toBe("[zcode] status=completed exit=0\nOK");
  });

  it("trae_status / trae_delegate 异步+同步 / trae_new_chat 照老实现", async () => {
    const tools = freshTools(om.url);
    expect(await tools.trae_status({}))
      .toBe("TraeClaw 网关: up | CDP 自动化: 就绪 | 目标窗口: Trae");
    const receipt = await tools.trae_delegate({ task: "trae job", wait: false, timeout_s: 60 });
    const ref = refOf(receipt);
    expect(receipt).toBe(`[traecode/${ref}] 已异步受理, status=running。\n查询结果: trae_result(ref="${ref}")`);
    await waitFor(ref, tools);
    const final = await tools.trae_result({ ref });
    // 老 trae 完成不更新 worker_status（async_worker 只在 cmd 模式置 completed）→ 照实打印
    expect(final).toContain(`[${ref}] agent=traecode status=completed worker_status=running dispatch_count=1`);
    expect(final).toContain("TRAE_DONE");
    const sync = await tools.trae_delegate({ task: "trae sync", wait: true, timeout_s: 60 });
    expect(sync).toBe("[trae/sess-123] status=completed\nTRAE_DONE\n(继续对话请带 session_id: sess-123)");
    expect(await tools.trae_new_chat({})).toBe("已请求 Trae 切换/新建会话。");
  });

  it("hub_dispatch_cli 对 traecode 自动转 trae_delegate（老 dedicated 通道）", async () => {
    const tools = freshTools(om.url);
    const receipt = await tools.hub_dispatch_cli({ agent: "trae", task: "via cli tool", wait: false, timeout_s: 60 });
    expect(receipt).toContain("已异步受理, status=running");
    expect(refOf(receipt)).toMatch(/^(?:traecode|trae)-[0-9a-f]{10}$/);
    const final = await waitFor(refOf(receipt), tools);
    expect(final).toContain("TRAE_DONE");
  });

  it("hub_list_agents / hub_capabilities / hub_list_models / hub_login 现读 /api/instances", async () => {
    const tools = freshTools(om.url);
    const agents = await tools.hub_list_agents({});
    expect(agents).toContain("已注册代理:\n");
    expect(agents).toContain("- zcode [在线] 角色: worker | CLI: om:zcode (ZCode)");
    expect(agents).toContain("- codebuddy [在线] 角色: worker | CLI: om:codebuddy (CodeBuddy)");
    expect(agents).toContain("- traecode [就绪] 角色: worker | 调度通道: TraeClaw 网关");
    const caps = JSON.parse(await tools.hub_capabilities({ agent: "zcode" }));
    expect(caps).toMatchObject({ schema_version: 2, platform: process.platform,
      attachment_limit_bytes: 1024 * 1024 });
    expect(caps.workers.zcode).toMatchObject({ configured: true, default_model: "GLM-5.3-Flash",
      model_selection: true, stream: "gui_snapshot" });
    expect(caps.workers.zcode.availability).toMatchObject({ enabled: true, code: "ok" });
    expect(caps.workers.zcode.models.map((m: { id: string }) => m.id))
      .toEqual(["GLM-5.3-Flash", "GLM-5.3", "deepseek-v4.1-flash", "stealth"]);
    const models = await tools.hub_list_models({ agent: "zcode" });
    expect(models).toBe("各 worker 可选模型:\n- zcode: model_arg=未配置 | "
      + "GLM-5.3-Flash→GLM-5.3-Flash, GLM-5.3→GLM-5.3, deepseek-v4.1-flash→deepseek-v4.1-flash, stealth→stealth, 默认→GLM-5.3-Flash");
    const login = JSON.parse(await tools.hub_login({ agent: "zcode", action: "status" }));
    expect(login).toMatchObject({ ok: false, worker: "zcode", action: "status", status: "unavailable" });
  });

  it("8801 必填 model：缺省取 instance models.default，无 default 退 options[0]", async () => {
    // 假 8801 与真 8801 同款校验：不带 modelSelection.model 的 POST /api/bots 直接 400。
    const bare = await fetch(om.url + "/api/bots", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bare", modelSelection: { instanceId: "codebuddyCn" } }),
    });
    expect(bare.status).toBe(400);
    expect(((await bare.json()) as { error: string }).error).toContain("modelSelection.model");

    const withDefault = await startFakeOm({ instances: [
      { instanceId: "codebuddyCn", displayName: "CodeBuddy CN",
        snapshot: { state: "available", authenticated: true },
        models: { default: "cbcn-instance-default",
          options: [{ id: "cbcn-instance-default" }, { id: "other" }] } },
    ] });
    try {
      const tools = freshTools(withDefault.url);
      const receipt = await tools.hub_dispatch_cli({ agent: "cbcn", task: "model from default", timeout_s: 60 });
      const ref = refOf(receipt);
      expect(ref).toMatch(/^codebuddy-cn-[0-9a-f]{10}$/);
      await waitFor(ref, tools);
      expect(withDefault.bots.find((b) => b.name === "hub·codebuddy-cn")?.modelSelection)
        .toMatchObject({ instanceId: "codebuddyCn", model: "cbcn-instance-default" });
    } finally { withDefault.server.close(); }

    const optionOnly = await startFakeOm({ instances: [
      { instanceId: "codebuddyCn", displayName: "CodeBuddy CN",
        snapshot: { state: "available", authenticated: true },
        models: { options: [{ id: "only-option" }] } },
    ] });
    try {
      const tools = freshTools(optionOnly.url);
      const receipt = await tools.hub_dispatch_cli({ agent: "cbcn", task: "model from option", timeout_s: 60 });
      await waitFor(refOf(receipt), tools);
      expect(optionOnly.bots[0]?.modelSelection)
        .toMatchObject({ instanceId: "codebuddyCn", model: "only-option" });
    } finally { optionOnly.server.close(); }
  });

  it("zcode 缺省模型必须在 instance options 里，否则拒绝且不建 bot", async () => {
    const z = await startFakeOm({ instances: [
      { instanceId: "zcode", displayName: "ZCode",
        snapshot: { state: "available", authenticated: true },
        models: { default: "deepseek-v4.1-flash", options: [{ id: "stealth" }] } },
    ] });
    try {
      const tools = freshTools(z.url);
      const refused = await tools.hub_dispatch_cli({ agent: "zcode", task: "z", timeout_s: 60 });
      expect(refused).toBe("zcode CLI 启动失败: UNSUPPORTED: 模型 GLM-5.3-Flash 不在 zcode 引擎的可选模型中");
      expect(z.calls).not.toContain("POST /api/bots");
    } finally { z.server.close(); }
  });

  it("停用真源在 8801 实例设置：列表/能力/派活三处一致，agents.json 旧标记不再生效", async () => {
    const stateDir = freshStateDir();
    // 老 agents.json 里的停用标记不迁移：写一个 zcode 已禁用的旧文件，列表仍按 8801 显示在线。
    writeFileSync(join(stateDir, "agents.json"), JSON.stringify({ agents: { zcode: { disabled: true } } }), "utf8");
    const tools = createDispatchTools({ omBase: om.url, stateDir });
    expect(await tools.hub_list_agents({})).toContain("- zcode [在线] 角色: worker | CLI: om:zcode (ZCode)");

    expect(JSON.parse(await tools.hub_set_agent_status({ agent: "zcode", enabled: false })))
      .toEqual({ ok: true, agent: "zcode", enabled: false,
        message: "子代理 zcode 已禁用，全端（WebUI 及各插件）已同步生效。" });
    // 别名 cbcn 经 hub_set_agent_status 落到 8801 的 codebuddyCn 实例。
    expect(JSON.parse(await tools.hub_set_agent_status({ agent: "cbcn", disabled: true })))
      .toMatchObject({ ok: true, agent: "codebuddy-cn", enabled: false });
    expect(om.calls).toContain("PATCH /api/instances/zcode");
    expect(om.calls).toContain("PATCH /api/instances/codebuddyCn");

    const agents = await tools.hub_list_agents({});
    expect(agents).toContain("- zcode [已禁用] 角色: worker | CLI: om:zcode (ZCode)");
    expect(agents).toContain("- codebuddy-cn [已禁用] 角色: worker | CLI: om:codebuddyCn (CodeBuddy CN)");
    // 未停用的 worker 仍按 8801 状态显示。
    expect(agents).toContain("- codebuddy [在线] 角色: worker | CLI: om:codebuddy (CodeBuddy)");

    const caps = JSON.parse(await tools.hub_capabilities({ agent: "zcode" }));
    expect(caps.workers.zcode.availability).toEqual({ enabled: false, code: "profile_disabled",
      reason: "已在控制台或配置中禁用此 worker。", refreshable: false });
    expect(caps.workers.zcode.models.length).toBeGreaterThan(0);
    for (const model of caps.workers.zcode.models) {
      expect(model.availability).toMatchObject({ enabled: false, code: "profile_disabled" });
    }

    await expect(tools.hub_dispatch_cli({ agent: "zcode", task: "blocked" }))
      .rejects.toThrow("UNAVAILABLE: profile_disabled: 已在控制台或配置中禁用此 worker。");
    await expect(tools.hub_dispatch_cli({ agent: "cbcn", task: "blocked" }))
      .rejects.toThrow("UNAVAILABLE: profile_disabled: 已在控制台或配置中禁用此 worker。");
    await expect(tools.zcode_delegate({ task: "blocked", wait: false }))
      .rejects.toThrow("UNAVAILABLE: profile_disabled");

    await expect(tools.hub_set_agent_status({ agent: "ghost", enabled: false })).rejects.toThrow("未知 agent: ghost");
    await expect(tools.hub_set_agent_status({ agent: "zcode" })).rejects.toThrow("缺少 enabled 或 disabled 参数");

    // 复原，后面的用例仍按启用状态看 zcode。
    expect(JSON.parse(await tools.hub_set_agent_status({ agent: "zcode", enabled: true })))
      .toMatchObject({ ok: true, agent: "zcode", enabled: true });
    expect(JSON.parse(await tools.hub_set_agent_status({ agent: "cbcn", disabled: false })))
      .toMatchObject({ ok: true, agent: "codebuddy-cn", enabled: true });
    expect(await tools.hub_list_agents({})).toContain("- zcode [在线] 角色: worker | CLI: om:zcode (ZCode)");
  });

  it("隐藏模型只影响 UI 下拉：hub_list_models / hub_capabilities 仍列出", async () => {
    const hidden = await startFakeOm({ instances: [
      { instanceId: "zcode", displayName: "ZCode",
        snapshot: { state: "available", authenticated: true },
        models: { default: "glm-5.3-flash", options: [
          { id: "glm-5.3-flash", label: "GLM-5.3-Flash" },
          { id: "glm-5.3", label: "GLM-5.3", hidden: true },
        ] } },
    ] });
    try {
      const tools = freshTools(hidden.url);
      const models = await tools.hub_list_models({ agent: "zcode" });
      expect(models).toContain("glm-5.3-flash→glm-5.3-flash");
      expect(models).toContain("glm-5.3→glm-5.3");
      const caps = JSON.parse(await tools.hub_capabilities({ agent: "zcode" }));
      expect(caps.workers.zcode.models.map((model: { id: string }) => model.id)).toEqual(["glm-5.3-flash", "glm-5.3"]);
    } finally { hidden.server.close(); }
  });

  it("假 8801 模拟先出 text、继续 activity、最后出总结 text 并结束回合：中途 running，结束后为最终总结", async () => {
    const multiPhase = await startFakeOm({ replyDelayMs: 999999 });
    try {
      const tools = freshTools(multiPhase.url);
      const receipt = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "two-phase reply", timeout_s: 60 });
      const ref = refOf(receipt);

      // 获取创建的 threadId
      let threadId = "";
      for (let i = 0; i < 30 && !threadId; i++) {
        await new Promise((r) => setTimeout(r, 100));
        threadId = [...multiPhase.threadCwd.keys()].at(-1) ?? "";
      }
      expect(threadId).toBeTruthy();

      // 阶段 1：先出一句 bot text，但回合依然 busy
      multiPhase.pushMessage(threadId, { role: "bot", kind: "text", text: "I'll read the task document first.", at: Date.now() });

      // 等一个轮询周期（>2s）
      await new Promise((r) => setTimeout(r, 2200));

      // 断言此时回合仍在进行，hub_result 必须返回 status=running，绝不能错标为 completed
      const midResult = await tools.hub_result({ ref });
      expect(midResult).toContain(`[${ref}] agent=codebuddy status=running`);
      expect(midResult).not.toContain("status=completed");

      // 阶段 2：继续产生 activity
      multiPhase.pushMessage(threadId, { role: "bot", kind: "activity", text: "", at: Date.now() });
      await new Promise((r) => setTimeout(r, 2200));

      // 查 hub_task_status，断言根据 activity/text 最新时间判定为 working
      const midStatus = JSON.parse(await tools.hub_task_status({ ref, json: true }));
      expect(midStatus.status).toBe("running");
      expect(midStatus.verdict).toBe("working");

      // 阶段 3：出最终总结 text，并结束回合（busy=false）
      multiPhase.pushMessage(threadId, { role: "bot", kind: "text", text: "Task completed successfully. All tests pass.", at: Date.now() });
      multiPhase.setThreadBusy(threadId, false);

      // 等待任务完成
      const finalResult = await tools.hub_wait_result({ ref, wait_s: 10 });
      expect(finalResult).toContain("status=completed");
      expect(finalResult).toContain("Task completed successfully. All tests pass.");
      expect(finalResult).not.toContain("I'll read the task document first.");

      // 验证 hub_result 也是最终总结
      expect(await tools.hub_result({ ref })).toContain("Task completed successfully. All tests pass.");
    } finally {
      multiPhase.server.close();
    }
  });

  it("被错标为 completed 的记录在回合未结束时被查询自动纠正为 running，并在结束后给出真实最终结果", async () => {
    const healOm = await startFakeOm({ replyDelayMs: 999999 });
    try {
      const stateDir = freshStateDir();
      const tools = createDispatchTools({ omBase: healOm.url, stateDir });
      const threadId = randomUUID();
      healOm.threads.set(threadId, [
        { role: "user", kind: "text", text: "work", at: Date.now() - 5000 },
        { role: "bot", kind: "text", text: "I'll read first.", at: Date.now() - 4000 },
        { role: "bot", kind: "activity", text: "", at: Date.now() - 2000 },
      ]);
      healOm.setThreadBusy(threadId, true);

      // 模拟磁盘上有被老代码错标为 completed 的 json 记录
      const ref = "codebuddy-testheal01";
      const resultsDir = join(stateDir, "results");
      writeFileSync(join(resultsDir, `${ref}.json`), JSON.stringify({
        ref, agent: "codebuddy", status: "completed", worker_status: "completed",
        task: "work", thread_id: threadId, started_at: (Date.now() - 5000) / 1000,
        text: "I'll read first.", exit_code: 0, dispatch_message_at: (Date.now() - 5000) / 1000,
      }), "utf8");

      // 首次查询 hub_result：必须被纠正为 running！
      const res = await tools.hub_result({ ref });
      expect(res).toContain(`[${ref}] agent=codebuddy status=running`);
      expect(res).not.toContain("status=completed");

      // 磁盘上的结果文件也已纠正为 running
      const onDisk = JSON.parse(readFileSync(join(resultsDir, `${ref}.json`), "utf8"));
      expect(onDisk.status).toBe("running");

      // 随后回合结束，输出最终文本
      healOm.pushMessage(threadId, { role: "bot", kind: "text", text: "Final healed result.", at: Date.now() });
      healOm.setThreadBusy(threadId, false);

      // wait_result 查出最终真实结果
      const final = await tools.hub_wait_result({ ref, wait_s: 10 });
      expect(final).toContain("status=completed");
      expect(final).toContain("Final healed result.");
      expect(final).not.toContain("I'll read first.");
    } finally {
      healOm.server.close();
    }
  });

  it("回合因报错或中断结束时标记 error 并给出原因", async () => {
    const errOm = await startFakeOm({ replyDelayMs: 999999 });
    try {
      const tools = freshTools(errOm.url);
      const receipt = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "failing task", timeout_s: 60 });
      const ref = refOf(receipt);

      let threadId = "";
      for (let i = 0; i < 30 && !threadId; i++) {
        await new Promise((r) => setTimeout(r, 100));
        threadId = [...errOm.threadCwd.keys()].at(-1) ?? "";
      }
      expect(threadId).toBeTruthy();

      // 推入错误活动并结束回合
      errOm.pushMessage(threadId, {
        role: "bot", kind: "activity", text: "error: process exited with code 137 (OOM)", at: Date.now(),
      });
      errOm.setThreadBusy(threadId, false);

      const res = await tools.hub_wait_result({ ref, wait_s: 10 });
      expect(res).toContain("status=error");
      expect(res).toContain("error_code=WORKER_FAILED");
      expect(res).toContain("process exited with code 137");
    } finally {
      errOm.server.close();
    }
  });
});

// ---------------------------------------------------------------- 契约测试：真实 mcp/hub.mjs 驱动

describe("contract: mcp/hub.mjs ask/fetchRef/taskStatus over HTTP", () => {
  let om2: Awaited<ReturnType<typeof startFakeOm>>;
  let currentTools: Record<string, (args: any) => Promise<string>>;

  function startHubShim(provider: () => Record<string, (args: any) => Promise<string>>): Promise<number> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        const reply = (payload: unknown, status = 200) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if ((req.headers.authorization ?? "") !== "Bearer testtoken") return reply({ error: "unauthorized" }, 401);
        let message: any;
        try { message = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { return reply({ error: "bad json" }, 400); }
        if (message?.method !== "tools/call") {
          return reply({ jsonrpc: "2.0", id: message?.id ?? null,
            result: { content: [{ type: "text", text: "shim: only tools/call" }] } });
        }
        const name = String(message.params?.name ?? "");
        const impl = provider()[name];
        if (!impl) {
          return reply({ jsonrpc: "2.0", id: message.id,
            error: { code: -32601, message: `tool ${name} not found` } });
        }
        try {
          const text = await impl(message.params?.arguments ?? {});
          return reply({ jsonrpc: "2.0", id: message.id,
            result: { content: [{ type: "text", text }] } });
        } catch (error) {
          return reply({ jsonrpc: "2.0", id: message.id,
            error: { code: -32000, message: String((error as Error).message ?? error) } });
        }
      });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
  }

  beforeAll(async () => {
    om2 = await startFakeOm();
    currentTools = freshTools(om2.url);
    const port = await startHubShim(() => currentTools);
    // hub.mjs 在模块顶层读一次连接：必须在 import 前用环境变量指向假枢纽。
    process.env.AGENTHUB_URL = `http://127.0.0.1:${port}/mcp`;
    process.env.HUB_TOKEN = "testtoken";
    delete process.env.AGENTHUB_WORKER_ID;
  });
  afterAll(() => {
    om2.server.close();
  });

  it("ask(cb, …) 全链路：受理 → completed，answer/ok/ref 正确", async () => {
    const hub = await importHubClient();
    const result = await hub.ask("cb", "只回复两个字母:OK", 90);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.worker).toBe("codebuddy");
    expect(String(result.ref)).toMatch(/^codebuddy-[0-9a-f]{10}$/);
    expect(result.answer).toBe("OK");
  });

  it("fetchRef(ref) running→completed 两态；taskStatus(ref) verdict 正确", async () => {
    const hub = await importHubClient();
    const slow = await startFakeOm({ replyDelayMs: 6000 });
    try {
      const tools = freshTools(slow.url);
      const previous = currentTools;
      currentTools = tools; // fetchRef 走 shim，必须命中同一个结果目录
      try {
      const receipt = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "slow one", timeout_s: 120 });
      const ref = refOf(receipt);
      const running = await hub.fetchRef(ref);
      expect(running.status).toBe("running");
      expect(running.ref).toBe(ref);
      await tools.hub_wait_result({ ref, wait_s: 30 });
      const done = await hub.fetchRef(ref);
      expect(done.status).toBe("completed");
      expect(done.answer).toBe("OK");
      const status = await hub.taskStatus(ref);
      expect(status.ok).toBe(true);
      expect(status.status).toBe("completed");
      expect(status.verdict).toBe("completed");
      expect(status.answer).toBe("任务已完成，直接读取结果。");
      expect(status.preserve_ref).toBe(false);
      } finally { currentTools = previous; }
    } finally { slow.server.close(); }
  });
});

// ---------------------------------------------------------------- 事件流（hub_events）

describe("hub-compat 事件流", () => {
  it("dispatch → accepted/started/progress/done；hub_events 增量只返回新事件", async () => {
    const om = await startFakeOm();
    try {
      const tools = freshTools(om.url);
      const receipt = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "事件流", timeout_s: 60 });
      const ref = refOf(receipt);
      const first = JSON.parse(await tools.hub_events({ ref }));
      expect(first.ref).toBe(ref);
      expect(first.status).toBe("running");
      expect(first.events[0]).toMatchObject({ ref, agent: "codebuddy", kind: "accepted" });
      expect(first.events.every((event: any) => typeof event.at === "number" && event.text.length > 0)).toBe(true);

      await waitFor(ref, tools);
      const all = JSON.parse(await tools.hub_events({ ref }));
      const kinds = all.events.map((event: any) => event.kind);
      expect(kinds[0]).toBe("accepted");
      expect(kinds).toContain("started");
      expect(kinds).toContain("progress");
      expect(kinds.at(-1)).toBe("done");
      expect(all.status).toBe("completed");
      expect(all.next).toBe(all.events.at(-1).seq);
      // 序号严格递增，客户端可以只记 lastSeq
      expect(all.events.map((event: any) => event.seq)).toEqual(
        all.events.map((event: any) => event.seq).sort((a: number, b: number) => a - b));

      const incremental = JSON.parse(await tools.hub_events({ ref, since: all.next }));
      expect(incremental.events).toEqual([]);
      expect(incremental.next).toBe(all.next);
    } finally {
      om.server.close();
    }
  });

  it("事件文本不带 token，长输出压成一行", async () => {
    const secret = "Bearer abcdef123456";
    const om = await startFakeOm({ replyText: `OK ${secret} sk-abcdefgh12345678\nsecond line` });
    try {
      const tools = freshTools(om.url);
      const ref = refOf(await tools.hub_dispatch_cli({ agent: "codebuddy", task: "带密钥的回复", timeout_s: 60 }));
      await waitFor(ref, tools);
      const all = JSON.parse(await tools.hub_events({ ref }));
      const text = all.events.map((event: any) => event.text).join(" | ");
      expect(text).not.toContain("abcdef123456");
      expect(text).not.toContain("sk-abcdefgh12345678");
      expect(text).toContain("[REDACTED]");
      expect(text).not.toContain("\n");
    } finally {
      om.server.close();
    }
  });

  it("unknown ref 仍返回空事件集而不是报错", async () => {
    const tools = freshTools("http://127.0.0.1:9");
    const result = JSON.parse(await tools.hub_events({ ref: "codebuddy-deadbeef00" }));
    expect(result).toEqual({ ref: "codebuddy-deadbeef00", agent: null, status: "unknown", events: [], next: 0 });
  });
});

// ---------------------------------------------------------------- R6-A 验收用例

/**
 * R6-A 的 14 条验收用例。
 *
 * 结算路径（settleTurn）有两种入口，这里都覆盖：
 * - 直接驱动 reaped()：把一条已落盘的回合记录和对应的假 8801 线程摆好，再用
 *   hub_task_status/hub_result 触发一次结算（快，不依赖轮询周期）。
 * - 走真实派活：hub_dispatch_cli 之后的 2s 轮询循环，用来验证两个超时窗口。
 */
describe("R6-A 验收：结算口径、超时窗口与登记状态", () => {
  interface SeededTurn {
    om: Awaited<ReturnType<typeof startFakeOm>>;
    tools: ReturnType<typeof createDispatchTools>;
    stateDir: string;
    ref: string;
    requestId: string;
    threadId: string;
  }

  /** 摆好一条回合记录 + 对应线程，让一次查询就能触发结算。 */
  async function seedTurn(opts: {
    messages?: (requestId: string, at: number) => FakeMessage[];
    status?: string; text?: string; errorCode?: string;
    idleTimeoutS?: number; hardTimeoutS?: number;
    busy?: boolean; gone?: boolean;
    /** 额外写进结果记录的字段（status_history、partial_text、last_worker_progress_at…）。 */
    extra?: Record<string, unknown>;
    toolOpts?: { idleSettleS?: number; retryGraceS?: number };
  }): Promise<SeededTurn> {
    const om = await startFakeOm();
    const stateDir = freshStateDir();
    const tools = createDispatchTools({ omBase: om.url, stateDir, ...opts.toolOpts });
    const requestId = `req-${randomUUID()}`;
    const threadId = `thr-${randomUUID()}`;
    const at = Date.now();
    const messages = opts.messages
      ? opts.messages(requestId, at)
      : [{ role: "user", kind: "text", text: "seeded task", at, id: requestId }];
    om.threads.set(threadId, messages);
    om.threadBusy.set(threadId, opts.busy ?? false);
    if (opts.gone) om.setThreadGone(threadId);
    const ref = `codebuddy-seed${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const record: Record<string, unknown> = {
      ref, agent: "codebuddy", status: opts.status ?? "running", worker_status: "running",
      task: "seeded turn", text: opts.text ?? "", thread_id: threadId, bot_id: "bot-seed",
      request_message_id: requestId, request_message_at_ms: at,
      dispatch_message_at: at / 1000, started_at: at / 1000,
      idle_timeout_s: opts.idleTimeoutS ?? 3600, hard_timeout_s: opts.hardTimeoutS ?? 3600,
      last_worker_progress_at: Date.now() / 1000, dispatch_count: 1, output_bytes: 0,
    };
    if (opts.errorCode) record.error_code = opts.errorCode;
    Object.assign(record, opts.extra ?? {});
    writeFileSync(join(stateDir, "results", `${ref}.json`), JSON.stringify(record), "utf8");
    return { om, tools, stateDir, ref, requestId, threadId };
  }

  function recordOf(turn: SeededTurn): any {
    return JSON.parse(readFileSync(join(turn.stateDir, "results", `${turn.ref}.json`), "utf8"));
  }

  it("1. 空闲/查询失败都不算成功：没有明确终态就保持 running", async () => {
    // 回合已经不在跑，但没有终态标记：不算成功，继续等。
    const idle = await seedTurn({ messages: (requestId, at) => [
      { role: "user", kind: "text", text: "task", at, id: requestId },
      { role: "bot", kind: "text", text: "先读一下文档", at: at + 1000 },
    ] });
    try {
      const status = JSON.parse(await idle.tools.hub_task_status({ ref: idle.ref, json: true }));
      expect(status.status).toBe("running");
      expect(status.verdict).not.toBe("completed");
      expect(recordOf(idle).status).toBe("running");
    } finally { idle.om.server.close(); }

    // 线程查不到（404）：仍然不是成功，只是标记 thread_missing。
    const gone = await seedTurn({ gone: true });
    try {
      const status = JSON.parse(await gone.tools.hub_task_status({ ref: gone.ref, json: true }));
      expect(status.status).toBe("running");
      expect(status.verdict).toBe("worker_exited_result_missing");
    } finally { gone.om.server.close(); }
  });

  it("2. 错误加非空文本仍为失败：过程文本留在 partial_text", async () => {
    const turn = await seedTurn({ messages: (requestId, at) => [
      { role: "user", kind: "text", text: "task", at, id: requestId },
      { role: "bot", kind: "text", text: "已经做了一半", at: at + 1000 },
      { role: "bot", kind: "activity", text: "", at: at + 2000, tool: { name: "bash", ok: false } },
    ] });
    try {
      const status = JSON.parse(await turn.tools.hub_task_status({ ref: turn.ref, json: true }));
      expect(status.status).toBe("error");
      expect(status.verdict).toBe("error");
      const record = recordOf(turn);
      expect(record.error_code).toBe("WORKER_FAILED");
      expect(record.partial_text).toContain("已经做了一半");
      expect(record.text).not.toContain("已经做了一半");
    } finally { turn.om.server.close(); }
  });

  it("3. 取消优先于文本：取消码 + 保留 partial_text", async () => {
    // 真 8801 的取消现场：requestCancelled 标在请求行上（这行的 at 是请求时刻），
    // 回合里那条助手文本照样带 turnSucceeded（引擎被中断时仍报 ok:true），
    // 并且留下一条 stopped: 活动行。取消必须压过这条"看起来成功"的终态。
    const turn = await seedTurn({ messages: (requestId, at) => [
      { role: "user", kind: "text", text: "task", at, id: requestId, requestCancelled: true },
      { role: "bot", kind: "text", text: "取消前的输出", at: at + 1000, turnSucceeded: true, turnTerminal: true },
      { role: "bot", kind: "activity", text: "", at: at + 2000, tool: { name: "stopped: You stopped this.", ok: true } },
    ] });
    try {
      const status = JSON.parse(await turn.tools.hub_task_status({ ref: turn.ref, json: true }));
      expect(status.status).toBe("error");
      const record = recordOf(turn);
      expect(record.error_code).toBe("WORKER_CANCELLED");
      // 过程文本留在 partial_text，不当成结果交出去。
      expect(record.partial_text).toContain("取消前的输出");
      expect(record.text).toContain("取消");
      expect(record.text).not.toContain("取消前的输出");
    } finally { turn.om.server.close(); }
  });

  it("3b. E40：工具输出正文含 cancelled 不算整轮取消", async () => {
    const turn = await seedTurn({ messages: (requestId, at) => [
      { role: "user", kind: "text", text: "task", at, id: requestId },
      { role: "bot", kind: "activity", text: "approval_pending: the person cancelled (timeout 60s)", at: at + 500, tool: { name: "pinky.phone_connect", ok: true } },
      { role: "bot", kind: "activity", text: "", at: at + 600, tool: { name: "secret: the person cancelled", ok: true } },
      { role: "bot", kind: "text", text: "等用户批准后重试，已完成", at: at + 1000, turnSucceeded: true, turnTerminal: true },
    ] });
    try {
      await turn.tools.hub_task_status({ ref: turn.ref, json: true });
      const record = recordOf(turn);
      expect(record.error_code).toBeUndefined();
      expect(record.status).toBe("completed");
      expect(record.text).toContain("已完成");
    } finally { turn.om.server.close(); }
  });

  it("4. 真空终态失败：回合结束但没有任何交付物", async () => {
    const turn = await seedTurn({ messages: (requestId, at) => [
      { role: "user", kind: "text", text: "task", at, id: requestId },
      { role: "bot", kind: "text", text: "", at: at + 1000, turnSucceeded: true, turnTerminal: true },
    ] });
    try {
      const status = JSON.parse(await turn.tools.hub_task_status({ ref: turn.ref, json: true }));
      expect(status.status).toBe("error");
      expect(recordOf(turn).error_code).toBe("WORKER_EMPTY_RESULT");
    } finally { turn.om.server.close(); }
  });

  it("5. 纯文本回答成功：有交付物的终态才算 completed", async () => {
    const turn = await seedTurn({ messages: (requestId, at) => [
      { role: "user", kind: "text", text: "task", at, id: requestId },
      { role: "bot", kind: "text", text: "最终答案", at: at + 1000, turnSucceeded: true, turnTerminal: true },
    ] });
    try {
      const status = JSON.parse(await turn.tools.hub_task_status({ ref: turn.ref, json: true }));
      expect(status.status).toBe("completed");
      expect(status.verdict).toBe("completed");
      expect(recordOf(turn).text).toBe("最终答案");
    } finally { turn.om.server.close(); }
  });

  it("6. 持续进展不触发静默超时：worker 有产出就续期", async () => {
    const om = await startFakeOm({ replyDelayMs: 999999 });
    try {
      const stateDir = freshStateDir();
      const tools = createDispatchTools({ omBase: om.url, stateDir });
      const receipt = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "long work", timeout_s: 5 });
      const ref = refOf(receipt);
      let threadId = "";
      for (let i = 0; i < 40 && !threadId; i++) {
        await new Promise((r) => setTimeout(r, 100));
        threadId = [...om.threadCwd.keys()].at(-1) ?? "";
      }
      expect(threadId).toBeTruthy();
      // worker 一直有新产出：静默窗口（5s）早就过了，但窗口按真实进展续期。
      const ticker = setInterval(() => {
        om.pushMessage(threadId, { role: "bot", kind: "text", text: `progress ${Date.now()}`, at: Date.now() });
      }, 1000);
      try {
        await new Promise((r) => setTimeout(r, 9000));
      } finally { clearInterval(ticker); }
      const record = JSON.parse(readFileSync(join(stateDir, "results", `${ref}.json`), "utf8"));
      expect(record.status).toBe("running");
      expect(record.last_worker_progress_at).toBeGreaterThan(record.started_at);
    } finally { om.server.close(); }
  });

  it("7. 只有 Hub 心跳的静默 worker 仍会超时：心跳不续期（8801 也不说它在跑）", async () => {
    const om = await startFakeOm({ replyDelayMs: 999999 });
    try {
      const stateDir = freshStateDir();
      const tools = createDispatchTools({ omBase: om.url, stateDir });
      const receipt = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "silent worker", timeout_s: 1 });
      const ref = refOf(receipt);
      let threadId = "";
      for (let i = 0; i < 40 && !threadId; i++) {
        await new Promise((r) => setTimeout(r, 100));
        threadId = [...om.threadCwd.keys()].at(-1) ?? "";
      }
      // E6/E10 之后 busy 的 worker 不判静默超时；这里 worker 不忙、也没有任何产出。
      om.threadBusy.set(threadId, false);
      await new Promise((r) => setTimeout(r, 3500));
      const record = JSON.parse(readFileSync(join(stateDir, "results", `${ref}.json`), "utf8"));
      expect(record.status).toBe("timeout");
      expect(record.text).toContain("没有任何进展");
      expect(record.idle_timeout_s).toBe(1);
    } finally { om.server.close(); }
  });

  it("8. 硬上限独立生效：worker 一直有进展也撞 hard_timeout_s", async () => {
    const om = await startFakeOm({ replyDelayMs: 999999 });
    try {
      const stateDir = freshStateDir();
      const tools = createDispatchTools({ omBase: om.url, stateDir });
      const receipt = await tools.hub_dispatch_cli({
        agent: "codebuddy", task: "hard cap", timeout_s: 600, hard_timeout_s: 1,
      });
      const ref = refOf(receipt);
      let threadId = "";
      for (let i = 0; i < 40 && !threadId; i++) {
        await new Promise((r) => setTimeout(r, 100));
        threadId = [...om.threadCwd.keys()].at(-1) ?? "";
      }
      const ticker = setInterval(() => {
        om.pushMessage(threadId, { role: "bot", kind: "text", text: `tick ${Date.now()}`, at: Date.now() });
      }, 700);
      try {
        await new Promise((r) => setTimeout(r, 4000));
      } finally { clearInterval(ticker); }
      const record = JSON.parse(readFileSync(join(stateDir, "results", `${ref}.json`), "utf8"));
      expect(record.status).toBe("timeout");
      expect(record.text).toContain("硬上限");
    } finally { om.server.close(); }
  });

  it("9. 恢复观察器沿用预算：重启后不重置静默窗口与硬上限", async () => {
    const turn = await seedTurn({ busy: true, idleTimeoutS: 3, hardTimeoutS: 3600 });
    try {
      // 一次查询就会拉起恢复观察器；观察器沿用记录里的 3s 静默窗口，而不是默认 900s。
      await turn.tools.hub_task_status({ ref: turn.ref, json: true });
      const record = recordOf(turn);
      expect(record.idle_timeout_s).toBe(3);
      expect(record.hard_timeout_s).toBe(3600);
      // E6/E10：busy 时不判静默超时；worker 不再忙且一直没产出，观察器按记录里的 3s 窗口收尾。
      turn.om.threadBusy.set(turn.threadId, false);
      let settled = record;
      for (let i = 0; i < 40 && settled.status === "running"; i++) {
        await new Promise((r) => setTimeout(r, 250));
        settled = recordOf(turn);
      }
      expect(settled.status).toBe("timeout");
      expect(settled.text).toContain("没有任何进展");
      expect(settled.idle_timeout_s).toBe(3);
    } finally { turn.om.server.close(); }
  });

  it("10. timeout 后同一回合迟到成功可补结算", async () => {
    const turn = await seedTurn({ status: "timeout", text: "任务超时: 已 1 分钟没有任何进展", messages: (requestId, at) => [
      { role: "user", kind: "text", text: "task", at, id: requestId },
      { role: "bot", kind: "text", text: "迟到的最终答案", at: at + 1000,
        requestMessageId: requestId, turnSucceeded: true, turnTerminal: true },
    ] });
    try {
      const status = JSON.parse(await turn.tools.hub_task_status({ ref: turn.ref, json: true }));
      expect(status.status).toBe("completed");
      expect(recordOf(turn).text).toBe("迟到的最终答案");
    } finally { turn.om.server.close(); }
  });

  it("E11. 失败后 8801 自动续跑并成功：按续跑结果记 completed", async () => {
    const turn = await seedTurn({ messages: (requestId, at) => [
      { role: "user", kind: "text", text: "task", at, id: requestId },
      { role: "bot", kind: "text", text: "做了一半被拒", at: at + 1000, requestMessageId: requestId, turnSucceeded: false, turnTerminal: true },
      { role: "bot", kind: "activity", text: "error: refused", at: at + 1100, requestMessageId: requestId, tool: { name: "error: refusal", ok: false } },
      { role: "user", kind: "text", text: "[From OpenMausBot · retry · information only — requested by OpenMausBot, automatically, once] Continue the request above", at: at + 2000, id: `${requestId}-retry` },
      { role: "bot", kind: "text", text: "续跑完成，交付齐了", at: at + 3000, requestMessageId: `${requestId}-retry`, turnSucceeded: true, turnTerminal: true },
    ] });
    try {
      const status = JSON.parse(await turn.tools.hub_task_status({ ref: turn.ref, json: true }));
      expect(status.status).toBe("completed");
      expect(recordOf(turn).text).toContain("续跑完成");
    } finally { turn.om.server.close(); }
  });

  it("E11. 已记失败的记录在自动续跑成功后补结算；没有续跑的失败不动", async () => {
    const retried = await seedTurn({ status: "error", errorCode: "WORKER_FAILED", text: "任务失败: refusal", messages: (requestId, at) => [
      { role: "user", kind: "text", text: "task", at, id: requestId },
      { role: "bot", kind: "text", text: "被拒", at: at + 1000, requestMessageId: requestId, turnSucceeded: false, turnTerminal: true },
      { role: "user", kind: "text", text: "[From OpenMausBot · retry · information only] Continue", at: at + 2000, id: `${requestId}-retry` },
      { role: "bot", kind: "text", text: "续跑交付", at: at + 3000, requestMessageId: `${requestId}-retry`, turnSucceeded: true, turnTerminal: true },
    ] });
    try {
      await retried.tools.hub_task_status({ ref: retried.ref, json: true });
      expect(recordOf(retried).status).toBe("completed");
      expect(recordOf(retried).text).toBe("续跑交付");
    } finally { retried.om.server.close(); }
    const plain = await seedTurn({ status: "error", errorCode: "WORKER_FAILED", text: "任务失败: x", messages: (requestId, at) => [
      { role: "user", kind: "text", text: "task", at, id: requestId },
      { role: "bot", kind: "text", text: "失败", at: at + 1000, requestMessageId: requestId, turnSucceeded: false, turnTerminal: true },
    ] });
    try {
      await plain.tools.hub_task_status({ ref: plain.ref, json: true });
      expect(recordOf(plain).status).toBe("error");
      expect(recordOf(plain).text).toBe("任务失败: x");
    } finally { plain.om.server.close(); }
  });

  it("E11. 续跑还在跑：保持 running，不被前一段失败结算", async () => {
    const turn = await seedTurn({ busy: true, messages: (requestId, at) => [
      { role: "user", kind: "text", text: "task", at, id: requestId },
      { role: "bot", kind: "text", text: "被拒", at: at + 1000, requestMessageId: requestId, turnSucceeded: false, turnTerminal: true },
      { role: "user", kind: "text", text: "[From OpenMausBot · retry · information only] Continue", at: at + 2000, id: `${requestId}-retry` },
      { role: "bot", kind: "activity", text: "", at: at + 2500, requestMessageId: `${requestId}-retry`, tool: { name: "bash", ok: true } },
    ] });
    try {
      const status = JSON.parse(await turn.tools.hub_task_status({ ref: turn.ref, json: true }));
      expect(status.status).toBe("running");
    } finally { turn.om.server.close(); }
  });

  it("11. 别的回合的成功不串进来", async () => {
    const turn = await seedTurn({ status: "timeout", text: "任务超时: 已 1 分钟没有任何进展", messages: (requestId, at) => [
      { role: "user", kind: "text", text: "task", at, id: requestId },
      { role: "user", kind: "text", text: "下一轮的任务", at: at + 1000, id: `${requestId}-next` },
      { role: "bot", kind: "text", text: "别的回合的成功", at: at + 2000,
        requestMessageId: `${requestId}-next`, turnSucceeded: true, turnTerminal: true },
    ] });
    try {
      const status = JSON.parse(await turn.tools.hub_task_status({ ref: turn.ref, json: true }));
      expect(status.status).toBe("timeout");
      expect(recordOf(turn).text).not.toContain("别的回合的成功");
    } finally { turn.om.server.close(); }
  });

  it("12. 已结算记录状态随文本一起重算", async () => {
    // 文本变了：completed 的正文跟着更新。
    const retext = await seedTurn({ status: "completed", text: "旧答案", messages: (requestId, at) => [
      { role: "user", kind: "text", text: "task", at, id: requestId },
      { role: "bot", kind: "text", text: "新答案", at: at + 1000,
        requestMessageId: requestId, turnSucceeded: true, turnTerminal: true },
    ] });
    try {
      await retext.tools.hub_task_status({ ref: retext.ref, json: true });
      expect(recordOf(retext).status).toBe("completed");
      expect(recordOf(retext).text).toBe("新答案");
    } finally { retext.om.server.close(); }

    // 终态其实失败：completed 不能留着，要重算成 error。
    const failed = await seedTurn({ status: "completed", text: "旧答案", messages: (requestId, at) => [
      { role: "user", kind: "text", text: "task", at, id: requestId },
      { role: "bot", kind: "activity", text: "error: 崩了", at: at + 1000, requestMessageId: requestId },
    ] });
    try {
      const status = JSON.parse(await failed.tools.hub_task_status({ ref: failed.ref, json: true }));
      expect(status.status).toBe("error");
      expect(recordOf(failed).error_code).toBe("WORKER_FAILED");
    } finally { failed.om.server.close(); }
  });

  it("13. E5：登记的 bot 被归档时派活前自动取消归档；迁走的 bot 明确拒绝", async () => {
    const om = await startFakeOm();
    try {
      const stateDir = freshStateDir();
      const tools = createDispatchTools({ omBase: om.url, stateDir, retryGraceS: 0 });
      const botId = "bot-archived-1";
      om.bots.push({ id: botId, name: "hub·codebuddy", threadId: "thr-archived",
        modelSelection: { instanceId: "codebuddy", model: "deepseek-v4.1-flash" }, hidden: true });
      writeFileSync(join(stateDir, "dispatch-bots.json"),
        JSON.stringify({ bots: { codebuddy: { botId } } }), "utf8");

      const receipt = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "archived", timeout_s: 60 });
      expect(receipt).toContain("已异步受理");
      // 不重建同名 bot，而是把原来那个取消归档。
      expect(om.calls).not.toContain("POST /api/bots");
      expect(om.calls).toContain(`PATCH /api/bots/${botId}`);
      expect(om.bots.find((b) => b.id === botId)?.hidden).toBe(false);
      const ref = refOf(receipt);
      const evs = await tools.hub_events({ ref });
      expect(evs).toContain("已自动取消归档");
      expect(await waitFor(ref, tools)).toContain("status=completed");

      // 迁移到别的电脑的 bot 不在这台机器上了：拒绝，不解归档。
      const moved = "bot-moved-1";
      om.bots.push({ id: moved, name: "hub·codebuddy-cn", threadId: "thr-moved", hidden: true,
        movedTo: { state: "moved" }, modelSelection: { instanceId: "codebuddyCn", model: "deepseek-v4.1-flash" } });
      writeFileSync(join(stateDir, "dispatch-bots.json"),
        JSON.stringify({ bots: { codebuddy: { botId }, "codebuddy-cn": { botId: moved } } }), "utf8");
      const refused = await tools.hub_dispatch_cli({ agent: "codebuddy-cn", task: "moved", timeout_s: 60 });
      expect(refused).toContain("worker_archived");
      expect(refused).toContain("迁移");
      expect(om.bots.find((b) => b.id === moved)?.hidden).toBe(true);
    } finally { om.server.close(); }
  });

  it("14. 登记的 bot 被删除时重建同名 bot", async () => {
    const om = await startFakeOm();
    try {
      const stateDir = freshStateDir();
      const tools = createDispatchTools({ omBase: om.url, stateDir });
      // 登记里的 bot 已经不在 8801 上了：判定为已删除，重建一个同名的。
      writeFileSync(join(stateDir, "dispatch-bots.json"),
        JSON.stringify({ bots: { codebuddy: { botId: "bot-deleted-1" } } }), "utf8");

      const receipt = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "rebuild", timeout_s: 60 });
      expect(receipt).toContain("已异步受理");
      expect(om.calls).toContain("POST /api/bots");
      const created = om.bots.find((b) => b.name === "hub·codebuddy");
      expect(created).toBeTruthy();
      expect(created?.id).not.toBe("bot-deleted-1");
    } finally { om.server.close(); }
  });

  it("GUI 受控端大量工具调用后由 digest 终结：成功转 completed 且提取最终文本", async () => {
    const turn = await seedTurn({
      messages: (_requestId, at) => {
        const msgs: FakeMessage[] = [];
        for (let i = 0; i < 60; i++) {
          msgs.push({ role: "bot", kind: "activity", text: "", at: at + (i + 1) * 100, tool: { name: "shell", ok: true } });
        }
        msgs.push({
          role: "bot",
          kind: "digest",
          text: "[digest] · tools: shell ×60",
          at: at + 7000,
          turnSucceeded: true,
          digest: { reply: "全部命令执行完毕，汇报已生成。" },
        });
        return msgs;
      },
    });
    try {
      const status = JSON.parse(await turn.tools.hub_task_status({ ref: turn.ref, json: true }));
      expect(status.status).toBe("completed");
      expect(status.verdict).toBe("completed");

      const res = await turn.tools.hub_result({ ref: turn.ref });
      expect(res).toContain("status=completed");
      expect(res).toContain("全部命令执行完毕，汇报已生成。");
      expect(res).not.toContain("alive_waiting");
      expect(res).not.toContain("(尚无文本)");
    } finally {
      turn.om.server.close();
    }
  });

  it("GUI 受控端普通回合完成：界面空闲带最终助手文本转 completed", async () => {
    const turn = await seedTurn({
      messages: (requestId, at) => [
        { role: "user", kind: "text", text: "task", at, id: requestId },
        { role: "bot", kind: "activity", text: "", at: at + 500, tool: { name: "edit", ok: true } },
        { role: "bot", kind: "text", text: "修改完成，测试全绿。", at: at + 1000, turnTerminal: true, turnSucceeded: true },
      ],
    });
    try {
      const status = JSON.parse(await turn.tools.hub_task_status({ ref: turn.ref, json: true }));
      expect(status.status).toBe("completed");
      expect(status.verdict).toBe("completed");

      const res = await turn.tools.hub_result({ ref: turn.ref });
      expect(res).toContain("status=completed");
      expect(res).toContain("修改完成，测试全绿。");
    } finally {
      turn.om.server.close();
    }
  });

  it("GUI 受控端仍在执行中：界面 busy 时即使已有中间文本与 activity 仍保持 running", async () => {
    const turn = await seedTurn({
      busy: true,
      messages: (requestId, at) => [
        { role: "user", kind: "text", text: "task", at, id: requestId },
        { role: "bot", kind: "text", text: "正在分析代码结构...", at: at + 500 },
        { role: "bot", kind: "activity", text: "", at: at + 1000, tool: { name: "search", ok: true } },
      ],
    });
    try {
      const status = JSON.parse(await turn.tools.hub_task_status({ ref: turn.ref, json: true }));
      expect(status.status).toBe("running");
      expect(status.verdict).not.toBe("completed");
      expect(recordOf(turn).status).toBe("running");

      const res = await turn.tools.hub_result({ ref: turn.ref });
      expect(res).toContain("status=running");
      expect(res).not.toContain("status=completed");
    } finally {
      turn.om.server.close();
    }
  });
  // ------------------------------------------------------------ U8：hub-compat 禁区修复（2026-11-10）

  it("E2. 零工具调用且本轮无回复：记 WORKER_EMPTY_RESULT，不拿上一轮 partial_text 冒充交付；有回复的零工具回合照常 completed", async () => {
    const empty = await seedTurn({
      extra: { partial_text: "上一轮的旧文本" },
      messages: (requestId, at) => [
        { role: "user", kind: "text", text: "task", at, id: requestId },
        { role: "bot", kind: "digest", text: "[digest] · no tool activity observed in this turn · files: none changed",
          at: at + 1000, requestMessageId: requestId, turnSucceeded: true, digest: {} },
      ],
    });
    try {
      const status = JSON.parse(await empty.tools.hub_task_status({ ref: empty.ref, json: true }));
      expect(status.status).toBe("error");
      const record = recordOf(empty);
      expect(record.error_code).toBe("WORKER_EMPTY_RESULT");
      expect(record.text).not.toContain("上一轮的旧文本");
    } finally { empty.om.server.close(); }

    const ok = await seedTurn({ messages: (requestId, at) => [
      { role: "user", kind: "text", text: "task", at, id: requestId },
      { role: "bot", kind: "text", text: "OK", at: at + 1000, requestMessageId: requestId, turnSucceeded: true, turnTerminal: true },
    ] });
    try {
      await ok.tools.hub_task_status({ ref: ok.ref, json: true });
      expect(recordOf(ok).status).toBe("completed");
      expect(recordOf(ok).text).toBe("OK");
    } finally { ok.om.server.close(); }
  });

  it("E3. 额度源说用完：派活前拒绝并报可读错误，不建线程；force:true 可硬派", async () => {
    const om = await startFakeOm({ hubQuota: { updatedAt: "x", workers: {
      codebuddy: { plan: "Free", quotas: [{ name: "credits", displayName: "积分", remaining: 0, total: 100, remainingPercentage: 0 }] },
      "codebuddy-cn": { plan: "Pro", quotas: [{ name: "credits", remaining: 40, total: 100, remainingPercentage: 40 }] },
    } } });
    try {
      const stateDir = freshStateDir();
      const tools = createDispatchTools({ omBase: om.url, stateDir, retryGraceS: 0 });
      await expect(tools.hub_dispatch_cli({ agent: "codebuddy", task: "no quota", timeout_s: 60 }))
        .rejects.toThrow(/quota_exhausted: codebuddy 额度已用完.*积分 剩余 0/);
      expect(om.calls.filter((c) => c.endsWith("/tasks"))).toHaveLength(0);
      // 有额度的 worker 照常派。
      const okReceipt = await tools.hub_dispatch_cli({ agent: "codebuddy-cn", task: "has quota", timeout_s: 60 });
      expect(okReceipt).toContain("已异步受理");
      // 确需硬派：force:true 绕过额度闸。
      const forced = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "forced", timeout_s: 60, force: true });
      expect(forced).toContain("已异步受理");
      await waitFor(refOf(forced), tools);
      await waitFor(refOf(okReceipt), tools);
    } finally { om.server.close(); }
  });

  it("E3. 8801 套餐用量窗口为 0 也拒派", async () => {
    const om = await startFakeOm({ planUsage: { fetchedAt: "x", providers: [
      { id: "zcode", ok: true, fiveHour: { available: true, remainingPercent: 0, usedPercent: 100, resetsAt: "02:00" },
        weekly: { available: true, remainingPercent: 30, usedPercent: 70, resetsAt: null }, extra: [], models: [] },
    ] } });
    try {
      const tools = createDispatchTools({ omBase: om.url, stateDir: freshStateDir(), retryGraceS: 0 });
      await expect(tools.hub_dispatch_cli({ agent: "zcode", task: "plan empty", timeout_s: 60 }))
        .rejects.toThrow(/quota_exhausted: zcode 额度已用完（8801 套餐用量: 剩余 0%，02:00 重置）/);
    } finally { om.server.close(); }
  });

  it("E3. 回合因额度用完失败：记 WORKER_QUOTA_EXHAUSTED，随后同一 worker 的派活被拒，别的 worker 不受影响", async () => {
    const om = await startFakeOm({ replyDelayMs: 999999 });
    try {
      const stateDir = freshStateDir();
      const tools = createDispatchTools({ omBase: om.url, stateDir, retryGraceS: 0 });
      const receipt = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "will hit quota", timeout_s: 60 });
      const ref = refOf(receipt);
      let threadId = "";
      for (let i = 0; i < 40 && !threadId; i++) {
        await new Promise((r) => setTimeout(r, 100));
        threadId = [...om.threadCwd.keys()].at(-1) ?? "";
      }
      om.pushMessage(threadId, { role: "bot", kind: "activity", text: "error: the plan's quota is used up (1005)",
        at: Date.now(), tool: { name: "error: the plan's quota is used up (1005)", ok: false } });
      om.pushMessage(threadId, { role: "bot", kind: "text", text: "", at: Date.now(), turnSucceeded: false, turnTerminal: true });
      om.threadBusy.set(threadId, false);
      const res = await waitFor(ref, tools, 15);
      expect(res).toContain("status=error");
      expect(res).toContain("error_code=WORKER_QUOTA_EXHAUSTED");
      expect(res).toContain("额度");
      await expect(tools.hub_dispatch_cli({ agent: "codebuddy", task: "again", timeout_s: 60 }))
        .rejects.toThrow(new RegExp(`quota_exhausted: codebuddy 上一个任务 \\(${ref}\\)因额度用完失败`));
      const other = await tools.hub_dispatch_cli({ agent: "codebuddy-cn", task: "other worker", timeout_s: 60 });
      expect(other).toContain("已异步受理");
    } finally { om.server.close(); }
  });

  it("E6/E10. worker 仍在跑（job.busy）且长时间无新消息：后台轮询与查询都不判静默超时", async () => {
    const om = await startFakeOm({ replyDelayMs: 999999 });
    try {
      const stateDir = freshStateDir();
      const tools = createDispatchTools({ omBase: om.url, stateDir });
      const receipt = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "long silent build", timeout_s: 1 });
      const ref = refOf(receipt);
      await new Promise((r) => setTimeout(r, 4500));
      const live = JSON.parse(await tools.hub_task_status({ ref, json: true }));
      expect(live.status).toBe("running");
      const record = JSON.parse(readFileSync(join(stateDir, "results", `${ref}.json`), "utf8"));
      expect(record.status).toBe("running");
      expect(record.worker_busy_at).toBeGreaterThan(record.started_at);
    } finally { om.server.close(); }

    // 恢复路径（重启后首个查询）：静默早已超窗，但 8801 说 busy，不判超时。
    const turn = await seedTurn({ busy: true, idleTimeoutS: 1, extra: { last_worker_progress_at: Date.now() / 1000 - 600 } });
    try {
      const status = JSON.parse(await turn.tools.hub_task_status({ ref: turn.ref, json: true }));
      expect(status.status).toBe("running");
      expect(recordOf(turn).status).toBe("running");
    } finally { turn.om.server.close(); }
  });

  it("E6/E10. 8801 判引擎 no-signal 时 busy 不再算在跑的证据", async () => {
    const turn = await seedTurn({ busy: true, idleTimeoutS: 3600 });
    turn.om.threadJobState.set(turn.threadId, "stalled");
    try {
      const status = JSON.parse(await turn.tools.hub_task_status({ ref: turn.ref, json: true }));
      expect(status.status).toBe("error");
      expect(recordOf(turn).error_code).toBe("WORKER_FAILED");
    } finally { turn.om.server.close(); }
  });

  it("E11. 中途 refusal 而 worker 仍在跑：保持 running；同一回合随后成功收尾记 completed", async () => {
    const turn = await seedTurn({ busy: true, messages: (requestId, at) => [
      { role: "user", kind: "text", text: "task", at, id: requestId },
      { role: "bot", kind: "text", text: "先读任务书", at: at + 500, requestMessageId: requestId, turnSucceeded: false, turnTerminal: true },
      { role: "bot", kind: "activity", text: "", at: at + 900, requestMessageId: requestId,
        tool: { name: "error: CodeBuddy refused to go on with this request (stop reason: refusal).", ok: false } },
    ] });
    try {
      const mid = JSON.parse(await turn.tools.hub_task_status({ ref: turn.ref, json: true }));
      expect(mid.status).toBe("running");
      // 种子消息的时间戳在 at+500/+900，新消息要排在它们之后。
      turn.om.pushMessage(turn.threadId, { role: "bot", kind: "activity", text: "", at: Date.now() + 5000,
        requestMessageId: turn.requestId, tool: { name: "edit", ok: true } });
      turn.om.pushMessage(turn.threadId, { role: "bot", kind: "text", text: "R6-D 已交付，测试全过", at: Date.now() + 5001,
        requestMessageId: turn.requestId, turnSucceeded: true, turnTerminal: true });
      turn.om.threadBusy.set(turn.threadId, false);
      const final = await turn.tools.hub_wait_result({ ref: turn.ref, wait_s: 15 });
      expect(final).toContain("status=completed");
      expect(final).toContain("R6-D 已交付");
    } finally { turn.om.server.close(); }
  });

  it("E11. 已记 WORKER_REFUSED/FAILED 的记录：同一回合（无 8801 续跑）后来成功收尾也补结算；终态是拒答时错误码为 WORKER_REFUSED", async () => {
    const healed = await seedTurn({ status: "error", errorCode: "WORKER_REFUSED", text: "任务失败: refusal", messages: (requestId, at) => [
      { role: "user", kind: "text", text: "task", at, id: requestId },
      { role: "bot", kind: "activity", text: "", at: at + 500, requestMessageId: requestId, tool: { name: "error: stop reason: refusal", ok: false } },
      { role: "bot", kind: "text", text: "做完了，汇报已写", at: at + 3000, requestMessageId: requestId, turnSucceeded: true, turnTerminal: true },
    ] });
    try {
      await healed.tools.hub_task_status({ ref: healed.ref, json: true });
      expect(recordOf(healed).status).toBe("completed");
      expect(recordOf(healed).text).toBe("做完了，汇报已写");
    } finally { healed.om.server.close(); }

    const refused = await seedTurn({ messages: (requestId, at) => [
      { role: "user", kind: "text", text: "task", at, id: requestId },
      { role: "bot", kind: "text", text: "读任务", at: at + 500, requestMessageId: requestId, turnSucceeded: false, turnTerminal: true },
      { role: "bot", kind: "activity", text: "", at: at + 900, requestMessageId: requestId,
        tool: { name: "error: CodeBuddy refused to go on with this request (stop reason: refusal).", ok: false } },
    ] });
    try {
      await refused.tools.hub_task_status({ ref: refused.ref, json: true });
      expect(recordOf(refused).status).toBe("error");
      expect(recordOf(refused).error_code).toBe("WORKER_REFUSED");
    } finally { refused.om.server.close(); }
  });

  it("E25 残余. 没有 turnTerminal/digest：job 视图 completed 即按完成结算；job 仅 idle 时安静够久且有回复才结算", async () => {
    const byJob = await seedTurn({ messages: (requestId, at) => [
      { role: "user", kind: "text", text: "task", at, id: requestId },
      { role: "bot", kind: "activity", text: "", at: at + 300, requestMessageId: requestId, tool: { name: "edit", ok: true } },
      { role: "bot", kind: "text", text: "GUI 回合完成", at: at + 600, requestMessageId: requestId },
    ] });
    byJob.om.threadJobState.set(byJob.threadId, "completed");
    try {
      await byJob.tools.hub_task_status({ ref: byJob.ref, json: true });
      expect(recordOf(byJob).status).toBe("completed");
      expect(recordOf(byJob).text).toBe("GUI 回合完成");
    } finally { byJob.om.server.close(); }

    const quiet = await seedTurn({ toolOpts: { idleSettleS: 1 }, messages: (requestId, at) => [
      { role: "user", kind: "text", text: "task", at: at - 5000, id: requestId },
      { role: "bot", kind: "text", text: "界面空闲后的最终回复", at: at - 4000, requestMessageId: requestId },
    ] });
    try {
      await quiet.tools.hub_task_status({ ref: quiet.ref, json: true });
      expect(recordOf(quiet).status).toBe("completed");
      expect(recordOf(quiet).text).toBe("界面空闲后的最终回复");
    } finally { quiet.om.server.close(); }
  });

  it("E40. 取消是终态：worker 仍 busy 也不在 error/running 间来回翻", async () => {
    const turn = await seedTurn({ busy: true, status: "error", errorCode: "WORKER_CANCELLED", text: "任务失败: 任务被取消",
      extra: { status_history: [{ from: null, to: "running", at: Date.now() / 1000 - 10 }, { from: "running", to: "error", at: Date.now() / 1000 - 5 }] },
      messages: (requestId, at) => [
        { role: "user", kind: "text", text: "task", at, id: requestId, requestCancelled: true },
        { role: "bot", kind: "activity", text: "", at: Date.now(), requestMessageId: requestId, tool: { name: "bash", ok: true } },
      ] });
    try {
      for (let i = 0; i < 3; i++) {
        const status = JSON.parse(await turn.tools.hub_task_status({ ref: turn.ref, json: true }));
        expect(status.status).toBe("error");
      }
      const record = recordOf(turn);
      expect(record.error_code).toBe("WORKER_CANCELLED");
      expect(record.status_history).toHaveLength(2);
    } finally { turn.om.server.close(); }
  });

  it("E40. 失败记录在 busy 但没有新产出时保持终态；终态之后有新产出才单向恢复 running", async () => {
    const terminalAt = Date.now() / 1000 - 5;
    const turn = await seedTurn({ busy: true, status: "error", errorCode: "WORKER_FAILED", text: "任务失败: x",
      extra: { status_history: [{ from: null, to: "running", at: terminalAt - 10 }, { from: "running", to: "error", at: terminalAt }] },
      messages: (requestId, at) => [
        { role: "user", kind: "text", text: "task", at: at - 20000, id: requestId },
        { role: "bot", kind: "activity", text: "", at: (terminalAt - 3) * 1000, requestMessageId: requestId, tool: { name: "bash", ok: false } },
      ] });
    try {
      for (let i = 0; i < 2; i++) {
        expect(JSON.parse(await turn.tools.hub_task_status({ ref: turn.ref, json: true })).status).toBe("error");
      }
      expect(recordOf(turn).status_history).toHaveLength(2);
      // 终态之后 worker 又有了新产出：明确「仍在跑」，恢复一次 running。
      turn.om.pushMessage(turn.threadId, { role: "bot", kind: "text", text: "继续修", at: Date.now(), requestMessageId: turn.requestId });
      expect(JSON.parse(await turn.tools.hub_task_status({ ref: turn.ref, json: true })).status).toBe("running");
      expect(JSON.parse(await turn.tools.hub_task_status({ ref: turn.ref, json: true })).status).toBe("running");
      const history = recordOf(turn).status_history;
      expect(history).toHaveLength(3);
      expect(history.at(-1).to).toBe("running");
    } finally { turn.om.server.close(); }
  });

  it("E51. 8801 重启把过程叙述打成终态、之后的工具没收尾：已记 completed 的重算为 WORKER_INTERRUPTED", async () => {
    const turn = await seedTurn({ status: "completed", text: "Now core.ts — the snapshot fallback…", messages: (requestId, at) => [
      { role: "user", kind: "text", text: "task", at, id: requestId },
      { role: "bot", kind: "activity", text: "", at: at + 200, requestMessageId: requestId, tool: { name: "edit", ok: true } },
      { role: "bot", kind: "text", text: "Now core.ts — the snapshot fallback…", at: at + 400, requestMessageId: requestId,
        turnSucceeded: true, turnTerminal: true },
      { role: "bot", kind: "activity", text: "", at: at + 600, requestMessageId: requestId, tool: { name: "read", ok: true } },
      { role: "bot", kind: "activity", text: "", at: at + 800, requestMessageId: requestId, tool: { name: "edit" } },
      { role: "bot", kind: "digest", text: "[digest] · tools: edit ×2 · reply: Now core.ts", at: at + 900, requestMessageId: requestId,
        turnSucceeded: true, digest: { reply: "Now core.ts — the snapshot fallback…" } },
    ] });
    try {
      const status = JSON.parse(await turn.tools.hub_task_status({ ref: turn.ref, json: true }));
      expect(status.status).toBe("error");
      const record = recordOf(turn);
      expect(record.error_code).toBe("WORKER_INTERRUPTED");
      expect(record.partial_text).toContain("Now core.ts");
    } finally { turn.om.server.close(); }
  });

  it("E51. 轮询中发现回合被打断：自动追问续跑一次，用续跑后的汇报收尾", async () => {
    const om = await startFakeOm({ replyDelayMs: 999999 });
    try {
      const stateDir = freshStateDir();
      const tools = createDispatchTools({ omBase: om.url, stateDir, retryGraceS: 0 });
      const receipt = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "will be cut", timeout_s: 60 });
      const ref = refOf(receipt);
      let threadId = "";
      for (let i = 0; i < 40 && !threadId; i++) {
        await new Promise((r) => setTimeout(r, 100));
        threadId = [...om.threadCwd.keys()].at(-1) ?? "";
      }
      const t = Date.now();
      om.pushMessage(threadId, { role: "bot", kind: "text", text: "Now core.ts —", at: t, turnSucceeded: true, turnTerminal: true });
      om.pushMessage(threadId, { role: "bot", kind: "activity", text: "", at: t + 1, tool: { name: "edit" } });
      om.threadBusy.set(threadId, false);
      // 等轮询器发出续跑追问，再由「worker」回汇报并收尾。
      let asked = false;
      for (let i = 0; i < 60 && !asked; i++) {
        await new Promise((r) => setTimeout(r, 200));
        asked = (om.threads.get(threadId) ?? []).some((m) => m.role === "user" && String(m.text).includes("被打断"));
      }
      expect(asked).toBe(true);
      om.pushMessage(threadId, { role: "bot", kind: "text", text: "# 汇报\n\n续跑完成，测试通过。", at: Date.now(),
        turnSucceeded: true, turnTerminal: true });
      om.threadBusy.set(threadId, false);
      const final = await waitFor(ref, tools, 20);
      expect(final).toContain("status=completed");
      expect(final).toContain("续跑完成，测试通过。");
      const record = JSON.parse(readFileSync(join(stateDir, "results", `${ref}.json`), "utf8"));
      expect(record.interrupted).toBe(true);
      const asks = (om.threads.get(threadId) ?? []).filter((m) => m.role === "user" && String(m.text).includes("被打断"));
      expect(asks).toHaveLength(1);
    } finally { om.server.close(); }
  });

});

describe("E19：回合在长命令期间收尾时追问一次汇报", () => {
  it("最后一条只是进度时标 needs_followup，自动追问「把汇报写完」一次，并用追问后的汇报收尾", async () => {
    const om = await startFakeOm({ replyText: "正在运行测试验证...", followupReplyText: "# 汇报\n\n测试通过，任务完成。", replyDelayMs: 300 });
    const stateDir = freshStateDir();
    const tools = freshTools(om.url, stateDir);
    try {
      const receipt = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "跑测试并写汇报", timeout_s: 60 });
      const ref = refOf(receipt);
      const final = await waitFor(ref, tools);
      expect(final).toContain("status=completed");
      expect(final).toContain("测试通过，任务完成。");

      const record = JSON.parse(readFileSync(join(stateDir, "results", `${ref}.json`), "utf8"));
      expect(record.needs_followup).toBe(true);
      expect(record.followup_sent).toBe(true);
      const asks = (om.threads.get(record.thread_id) ?? [])
        .filter((m) => m.role === "user" && String(m.text).includes("把汇报写完"));
      expect(asks).toHaveLength(1);
    } finally { om.server.close(); }
  });

  it("追问后仍然只回进度时不再追问，按最后一次结果收尾", async () => {
    const om = await startFakeOm({ replyText: "正在运行测试验证...", followupReplyText: "仍在等待测试跑完...", replyDelayMs: 300 });
    const stateDir = freshStateDir();
    const tools = freshTools(om.url, stateDir);
    try {
      const receipt = await tools.hub_dispatch_cli({ agent: "codebuddy", task: "跑测试并写汇报", timeout_s: 60 });
      const ref = refOf(receipt);
      const final = await waitFor(ref, tools);
      expect(final).toContain("status=completed");
      expect(final).toContain("仍在等待测试跑完...");

      const record = JSON.parse(readFileSync(join(stateDir, "results", `${ref}.json`), "utf8"));
      const asks = (om.threads.get(record.thread_id) ?? [])
        .filter((m) => m.role === "user" && String(m.text).includes("把汇报写完"));
      expect(asks).toHaveLength(1);
    } finally { om.server.close(); }
  });
});

describe("qualifyDefaultModel (E13)", () => {
  it("目录只有带前缀的同名模型时取 start plan，其次第一个；裸 id 在目录里或无同名时原样", () => {
    const opts = ["omb-zcode-plan/GLM-5.3-Flash", "account:bigmodel-start-plan/GLM-5.3-Flash", "GLM-5.3"];
    expect(qualifyDefaultModel("GLM-5.3-Flash", opts)).toBe("account:bigmodel-start-plan/GLM-5.3-Flash");
    expect(qualifyDefaultModel("GLM-5.3-Flash", ["omb-zcode-plan/GLM-5.3-Flash"])).toBe("omb-zcode-plan/GLM-5.3-Flash");
    expect(qualifyDefaultModel("GLM-5.3", opts)).toBe("GLM-5.3");
    expect(qualifyDefaultModel("GLM-5.3-Flash", ["GLM-5.3-Flash"])).toBe("GLM-5.3-Flash");
    expect(qualifyDefaultModel("GLM-5.3-Flash", [])).toBe("GLM-5.3-Flash");
    expect(qualifyDefaultModel(undefined, opts)).toBeUndefined();
  });
});
