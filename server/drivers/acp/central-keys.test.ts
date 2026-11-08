import { chmodSync, existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR, ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const CONFIG_FILE = join(DATA_DIR, "config.json");

const KEY_SUPPORT: AcpSupport = {
  driverKind: "centralKeyTest",
  displayName: "Central key test",
  models: { default: "m-one", options: [{ id: "m-one", label: "One" }] },
  defaultCli: "fake",
  nativeSource: "test.acp",
  loginNote: "never reached",
  spawnArgs: () => [],
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
  credentialEnv: ["GEMINI_API_KEY"],
};

const driver = createAcpDriver({ ...KEY_SUPPORT, selectModel: undefined });

let savedConfig: string | null = null;
let scratch: string;
let instance: ProviderInstance | undefined;

beforeEach(() => {
  ensureDirs();
  chmodSync(FAKE_CLI, 0o755);
  scratch = mkdtempSync(join(tmpdir(), "omb-central-key-"));
  savedConfig = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, "utf8") : null;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.ZHIPU_API_KEY;
});

afterEach(async () => {
  await instance?.dispose();
  instance = undefined;
  if (savedConfig === null) {
    if (existsSync(CONFIG_FILE)) unlinkSync(CONFIG_FILE);
  } else {
    writeFileSync(CONFIG_FILE, savedConfig);
  }
  delete process.env.FAKE_ACP_DUMP;
  await removeTempDir(scratch);
});

async function turnEnv(deployed: Record<string, unknown>, environment: Record<string, string> = {}): Promise<Record<string, string>> {
  writeFileSync(CONFIG_FILE, JSON.stringify(deployed));
  const dump = join(scratch, "env.json");
  process.env.FAKE_ACP_DUMP = dump;
  instance = await driver.create({
    instanceId: "central-key-test",
    displayName: "Central key test",
    environment,
    enabled: true,
    config: { cli: FAKE_CLI, fullAuto: false },
  });
  const recorder = recordEvents(instance.adapter);
  await instance.adapter.sendTurn({ threadId: "t-central-key", text: "go" });
  await recorder.until((event) => event.type === "turn.completed");
  recorder.stop();
  return JSON.parse(readFileSync(dump, "utf8")).env;
}

describe("a key deployed once", () => {
  it("reaches a CLI that declared it reads one", async () => {
    const env = await turnEnv({ gemini: { key: "AIza-deployed" } });
    expect(env.GEMINI_API_KEY).toBe("AIza-deployed");
  });

  it("does not reach a CLI that reads no such key", async () => {
    const env = await turnEnv({ zhipu: { key: "zhipu-deployed" } });
    expect(env.ZHIPU_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });

  it("never overrides a key the instance set for itself", async () => {
    const env = await turnEnv({ gemini: { key: "AIza-deployed" } }, { GEMINI_API_KEY: "own-key" });
    expect(env.GEMINI_API_KEY).toBe("own-key");
  });
});
