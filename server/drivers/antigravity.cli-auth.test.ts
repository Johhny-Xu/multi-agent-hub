// An added agy CLI account signs in through `agy acp --login`, whose flow ids the browser controller does not know:
// polling with the wrong controller answers `expired` for a flow that is still waiting.
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { antigravityProfileDirectory } from "./antigravity-acp.ts";
import { AntigravityAuthController } from "./antigravity-auth.ts";
import { AntigravityCliLoginController } from "./antigravity-cli-login.ts";
import { AntigravityDriver } from "./antigravity.ts";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-acp-cli.ts");
const URL = "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=c&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=s";
const FLOW_TTL_MS = 10 * 60_000;

const scratch: string[] = [];

/** A stand-in for `agy acp --login`: prints the link, accepts "good-code" after a beat, rejects anything else. */
function fakeAgy(): string {
  const directory = mkdtempSync(join(tmpdir(), "agy-cli-auth-"));
  scratch.push(directory);
  const script = join(directory, "agy");
  writeFileSync(script, String.raw`#!/usr/bin/env node
console.log("Open this link in a browser to log in with Google:\n\n  ${URL}\n\nThen paste the authorization code:");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  if (!buf.includes("\n")) return;
  if (buf.trim() === "good-code") {
    console.log("Logged in.");
    setTimeout(() => process.exit(0), 150);
  } else {
    console.error("couldn't log in: token exchange failed: oauth2: \"invalid_grant\" https://oauth2.googleapis.com/token");
    process.exit(1);
  }
});
`);
  chmodSync(script, 0o755);
  return script;
}

/** A packaged runtime: the harness sibling is what marks the pair, so the CLI sign-in path is not taken. */
function fakePackagedRuntime(): string {
  const directory = mkdtempSync(join(tmpdir(), "omb-antigravity-browser-"));
  scratch.push(directory);
  const executable = join(directory, "fake-antigravity.ts");
  const harness = join(directory, "localharness_external");
  copyFileSync(FAKE_ACP, executable);
  copyFileSync(FAKE_ACP, harness);
  chmodSync(executable, 0o755);
  chmodSync(harness, 0o755);
  return executable;
}

function fakeHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "agy-cli-auth-home-"));
  scratch.push(directory);
  return directory;
}

async function cliInstance(instanceId: string, executable: string): Promise<ProviderInstance> {
  return AntigravityDriver.create({
    instanceId,
    displayName: "Antigravity CLI fixture",
    enabled: true,
    config: { cli: executable, fullAuto: false },
    environment: { HOME: fakeHome() },
  });
}

async function drop(instance: ProviderInstance | undefined, instanceId: string): Promise<void> {
  await instance?.dispose();
  rmSync(antigravityProfileDirectory(instanceId), { recursive: true, force: true });
}

beforeEach(() => {
  ensureDirs();
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

describe("antigravity CLI sign-in status", () => {
  it("answers a fresh CLI flow as waiting, then verifying, then succeeded", async () => {
    const instanceId = "antigravity-cli-auth-ok";
    const executable = fakeAgy();
    const browserGet = vi.spyOn(AntigravityAuthController.prototype, "get").mockRejectedValue(new Error("browser controller used"));
    const browserComplete = vi.spyOn(AntigravityAuthController.prototype, "complete").mockRejectedValue(new Error("browser controller used"));
    const instance = await cliInstance(instanceId, executable);
    try {
      const started = await instance.startAuthentication!();
      expect(started).toMatchObject({ phase: "waiting", authorizationUrl: URL });
      const flowId = started.flowId!;

      await expect(instance.getAuthentication!(flowId)).resolves.toMatchObject({
        phase: "waiting",
        flowId,
        authorizationUrl: null,
      });

      const completing = instance.completeAuthentication!(flowId, "good-code");
      await expect(instance.getAuthentication!(flowId)).resolves.toMatchObject({ phase: "verifying", flowId });
      await completing;
      await expect(instance.getAuthentication!(flowId)).resolves.toMatchObject({ phase: "succeeded", flowId });

      expect(browserGet).not.toHaveBeenCalled();
      expect(browserComplete).not.toHaveBeenCalled();
    } finally {
      await drop(instance, instanceId);
    }
  });

  it("maps a rejected code to failed, keeping the CLI's reason without its URLs", async () => {
    const instanceId = "antigravity-cli-auth-failed";
    const instance = await cliInstance(instanceId, fakeAgy());
    try {
      const started = await instance.startAuthentication!();
      const flowId = started.flowId!;
      const failure = await instance.completeAuthentication!(flowId, "bad").catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("invalid_grant");
      expect((failure as Error).message).not.toContain("https://");

      const status = await instance.getAuthentication!(flowId);
      expect(status).toMatchObject({ phase: "failed", flowId });
      expect(status.message).toContain("invalid_grant");
      expect(status.message).not.toContain("https://");
    } finally {
      await drop(instance, instanceId);
    }
  });

  it("maps a cancelled flow, and a flow the controller never saw, to cancelled and expired", async () => {
    const instanceId = "antigravity-cli-auth-cancel";
    const instance = await cliInstance(instanceId, fakeAgy());
    try {
      const started = await instance.startAuthentication!();
      const flowId = started.flowId!;
      await instance.cancelAuthentication!();
      await expect(instance.getAuthentication!(flowId)).resolves.toMatchObject({ phase: "cancelled", flowId });
      await expect(instance.getAuthentication!("another-flow")).resolves.toMatchObject({ phase: "expired" });
    } finally {
      await drop(instance, instanceId);
    }
  });

  it("maps a flow past its lifetime to expired while the process is still waiting", async () => {
    const instanceId = "antigravity-cli-auth-expired";
    const instance = await cliInstance(instanceId, fakeAgy());
    try {
      const started = await instance.startAuthentication!();
      const flowId = started.flowId!;
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + FLOW_TTL_MS + 1);
      await expect(instance.getAuthentication!(flowId)).resolves.toMatchObject({ phase: "expired", flowId });
    } finally {
      await drop(instance, instanceId);
    }
  });
});

describe("antigravity browser sign-in status", () => {
  it("keeps a browser flow out of the CLI controller", async () => {
    const instanceId = "primary-antigravity-fixture";
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const browserStart = vi.spyOn(AntigravityAuthController.prototype, "start").mockResolvedValue({
      phase: "waiting",
      flowId: "browser-flow",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=fixture",
      expiresAt,
    });
    const browserGet = vi.spyOn(AntigravityAuthController.prototype, "get").mockResolvedValue({
      phase: "waiting",
      flowId: "browser-flow",
      authorizationUrl: null,
      expiresAt,
    });
    const cliStart = vi.spyOn(AntigravityCliLoginController.prototype, "start");
    const cliGet = vi.spyOn(AntigravityCliLoginController.prototype, "get");
    const instance = await AntigravityDriver.create({
      instanceId,
      displayName: "Antigravity fixture",
      enabled: true,
      config: { cli: fakePackagedRuntime(), fullAuto: false },
      environment: { HOME: fakeHome() },
    });
    try {
      const started = await instance.startAuthentication!();
      expect(started.flowId).toBe("browser-flow");
      await expect(instance.getAuthentication!("browser-flow")).resolves.toMatchObject({ phase: "waiting" });
      expect(browserStart).toHaveBeenCalledOnce();
      expect(browserGet).toHaveBeenCalledWith("browser-flow");
      expect(cliStart).not.toHaveBeenCalled();
      expect(cliGet).not.toHaveBeenCalled();
    } finally {
      await drop(instance, instanceId);
    }
  });
});
