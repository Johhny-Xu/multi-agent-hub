// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyQuiet, waitingOutLimit } from "./quiet-status.ts";
import { parseQoderLogLine, qoderRunLogPath } from "./qoder.ts";

// A real queue line from ~/.qoder-cn/logs/runs/*/qodercli.log (2026-10-22), model key replaced.
const QUEUED = String.raw`Thu 2026-10-22 10:42 AM CST (UTC+08:00) ERROR debug.message [PayloadParser] SSE event #1: Qoder API error: statusCode=FORBIDDEN, statusCodeValue=403, body(first 3000)={"code":"403","message":"{\"code\":\"10605\",\"message\":\"{\\\"isQueued\\\":true,\\\"modelKey\\\":\\\"test-model\\\",\\\"queueCount\\\":1,\\\"queueType\\\":\\\"p4\\\",\\\"retryAfterSeconds\\\":60,\\\"serviceAvailable\\\":false,\\\"subCode\\\":\\\"RESOURCE_LIMIT\\\",\\\"waitTime\\\":60}\",\"subCode\":\"RESOURCE_LIMIT\"}"}`;

// The CLI's queue poll lines from ~/.qoder-cn-tmp1/logs/runs/*/qodercli.log (2026-11-16), ids shortened.
const QUEUE_POLL = "Mon 2026-11-16 9:59 PM CST (UTC+08:00) INFO  debug.message [qoder-server-request] <-- operation=checkModelQueueStatus host=gateway.qoder.com.cn path=/api/v2/service/ask/queue/status status=200 traceId=404860 serverRequestId=cd2c3cf1 duration=128ms";
const QUEUE_POLL_SENT = "Mon 2026-11-16 9:59 PM CST (UTC+08:00) INFO  debug.message [qoder-server-request] --> operation=checkModelQueueStatus method=GET url=https://gateway.qoder.com.cn/api/v2/service/ask/queue/status traceId=404860";

describe("parseQoderLogLine", () => {
  it("reads a 10605 / RESOURCE_LIMIT queue line as a 403 retry with retryAfter as the delay", () => {
    expect(parseQoderLogLine(QUEUED)).toEqual({ kind: "retry", status: 403, delayMs: 60_000, attempt: null });
  });
  it("takes the queue's own retryAfterSeconds", () => {
    expect(parseQoderLogLine(QUEUED.replace(/retryAfterSeconds(\\+)":60/, 'retryAfterSeconds$1":30'))).toMatchObject({ kind: "retry", delayMs: 30_000 });
  });
  it("reads the CLI's queue poll while it waits as the queue still holding the request", () => {
    expect(parseQoderLogLine(QUEUE_POLL)).toEqual({ kind: "retry", status: 403, delayMs: null, attempt: null });
    expect(parseQoderLogLine(QUEUE_POLL.replace("status=200", "status=<failed>"))).toBeNull();
    expect(parseQoderLogLine(QUEUE_POLL_SENT)).toBeNull();
  });
  it("ignores ordinary log lines", () => {
    expect(parseQoderLogLine("Thu 2026-10-22 10:42 AM CST INFO debug.message [Agent] tool call finished")).toBeNull();
  });
  it("is a retry the quiet watch shows as retrying, not a usage limit that ends the turn", () => {
    const signal = parseQoderLogLine(QUEUED)!;
    expect(waitingOutLimit(signal)).toBe(false);
    expect(classifyQuiet({ logged: signal, context: null, sample: { cpuMs: 0, connections: 0 }, previous: null, sinceMs: 0 }).kind).toBe("retrying");
  });
});

describe("qoderRunLogPath", () => {
  let home: string | null = null;
  afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); home = null; });
  const run = (configDir: string, name: string): string => {
    const dir = join(home!, configDir, "logs", "runs", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "qodercli.log"), "");
    return join(dir, "qodercli.log");
  };

  it("finds the run directory named after the ACP child's pid, in ~/.qoder or ~/.qoder-cn", () => {
    home = mkdtempSync(join(tmpdir(), "qoder-log-"));
    run(".qoder", "2026-11-16T18-13-40-253+08-00-le1yj4-p4242");
    const cn = run(".qoder-cn", "2026-11-16T18-13-40-229+08-00-vokx5i-p777");
    expect(qoderRunLogPath({ HOME: home }, "s", 777)).toBe(cn);
    expect(qoderRunLogPath({ HOME: home }, "s", 4242)).toBe(join(home, ".qoder", "logs", "runs", "2026-11-16T18-13-40-253+08-00-le1yj4-p4242", "qodercli.log"));
  });
  it("finds a wrapper's --config-dir (~/.qoder-cn-tmp2) and does not match a longer pid", () => {
    home = mkdtempSync(join(tmpdir(), "qoder-log-"));
    run(".qoder-cn", "2026-11-16T10-00-00-000+08-00-aaaaaa-p1234");
    const tmp = run(".qoder-cn-tmp2", "2026-11-16T18-13-40-994+08-00-y9jn4b-p234");
    expect(qoderRunLogPath({ HOME: home }, "s", 234)).toBe(tmp);
  });
  it("picks the newest directory when a pid was recycled", () => {
    home = mkdtempSync(join(tmpdir(), "qoder-log-"));
    const old = run(".qoder", "2026-10-01T00-00-00-000+08-00-old000-p55");
    const fresh = run(".qoder", "2026-11-16T00-00-00-000+08-00-new000-p55");
    const past = new Date("2026-10-01T00:00:00Z");
    utimesSync(join(old, ".."), past, past);
    expect(qoderRunLogPath({ HOME: home }, "s", 55)).toBe(fresh);
  });
  it("returns null without a pid or a matching directory", () => {
    home = mkdtempSync(join(tmpdir(), "qoder-log-"));
    run(".qoder", "2026-11-16T00-00-00-000+08-00-abcdef-p1");
    expect(qoderRunLogPath({ HOME: home }, "s", undefined)).toBeNull();
    expect(qoderRunLogPath({ HOME: home }, "s", 2)).toBeNull();
    expect(qoderRunLogPath({ HOME: join(home, "missing") }, "s", 1)).toBeNull();
  });
});
