// A session whose tree could not be confirmed stopped must stay tracked, so dispose still reaches it: a failed kill is
// retried, and dispose stops the trees it captured even when a retry throws.
import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderInstance, RuntimeEvent } from "../../contracts.ts";
import * as procs from "../../procs.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

const SUPPORT: AcpSupport = {
  driverKind: "closingTest",
  displayName: "Closing Test",
  models: { default: "m-one", options: [{ id: "m-one", label: "One" }] },
  defaultCli: FAKE_CLI,
  nativeSource: "closing-test.acp",
  loginNote: "never reached",
  spawnArgs: () => [],
  shareProcess: false,
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
};

const scratches: string[] = [];
const instances: ProviderInstance[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose().catch(() => undefined);
  vi.restoreAllMocks();
  for (const scratch of scratches.splice(0)) removeTempDir(scratch);
});

async function fixture(support: Partial<AcpSupport> = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "omb-acp-closing-"));
  scratches.push(scratch);
  const spawned: ChildProcess[] = [];
  const spawn = procs.spawnCli;
  vi.spyOn(procs, "spawnCli").mockImplementation((...args) => {
    const child = spawn(...args);
    spawned.push(child);
    return child;
  });
  const driver = createAcpDriver({ ...SUPPORT, ...support });
  const instance = await driver.create({
    instanceId: "closing-test", displayName: "Closing Test", enabled: true,
    config: { cli: FAKE_CLI, fullAuto: true, workspace: scratch },
    environment: { FAKE_ACP_RPC_DUMP: join(scratch, "methods.json"), FAKE_ACP_SESSION_CLOSE: "1" },
  });
  instances.push(instance);
  const recorder = recordEvents(instance.adapter);
  const { turnId } = await instance.adapter.sendTurn({ threadId: "thread-a", text: "fixture", cwd: scratch, approvalMode: "full" });
  await recorder.until((event: RuntimeEvent) => event.type === "turn.completed" && event.turnId === turnId);
  expect(spawned).toHaveLength(1);
  return { instance, engine: spawned[0]! };
}

/** Counts the kills aimed at this engine and lets the test answer the first ones. */
function countKills(engine: ChildProcess, answer: (call: number) => "real" | false | "throw") {
  const real = procs.killCliTree;
  let calls = 0;
  vi.spyOn(procs, "killCliTree").mockImplementation(async (child, timeoutMs) => {
    if (child !== engine) return real(child, timeoutMs);
    calls += 1;
    const verdict = answer(calls);
    if (verdict === "throw") throw new Error("kill failed");
    if (verdict === false) return false;
    return real(child, timeoutMs);
  });
  return () => calls;
}

describe("an ACP child that could not be confirmed stopped", () => {
  it("stays tracked after a failed kill, and dispose stops it again", async () => {
    const { instance, engine } = await fixture();
    const calls = countKills(engine, (call) => (call === 1 ? false : "real"));

    await instance.adapter.stopAll();
    expect(calls()).toBe(1);

    await instance.dispose();
    expect(calls()).toBe(2);
  });

  it("still runs the final tree cleanup when a kill throws, and keeps tracking the child", async () => {
    const { instance, engine } = await fixture();
    const calls = countKills(engine, () => "throw");

    await expect(instance.adapter.stopAll()).rejects.toThrow("kill failed");
    await expect(instance.dispose()).rejects.toThrow("kill failed");
    // The dispose retry, and stopEngineTrees' own attempt in dispose's finally.
    expect(calls()).toBe(3);
  });

  it("drops a child whose stop was confirmed, so dispose does not signal it again", async () => {
    const { instance, engine } = await fixture();
    const calls = countKills(engine, () => "real");

    await instance.adapter.stopAll();
    expect(calls()).toBe(1);

    await instance.dispose();
    expect(calls()).toBe(1);
  });

  it("leaves the restartOnMcpChange retirement path to its own set", async () => {
    const { instance, engine } = await fixture({ restartOnMcpChange: true });
    const calls = countKills(engine, () => "real");

    await instance.adapter.stopAll();
    // stopAll and awaitAllClosing may both enter retireChild for the same child; what matters is that the
    // closing/leaving bookkeeping does not hand dispose a child this path already stopped.
    const afterStop = calls();
    expect(afterStop).toBeGreaterThanOrEqual(1);

    await instance.dispose();
    expect(calls()).toBe(afterStop);
  });
});
