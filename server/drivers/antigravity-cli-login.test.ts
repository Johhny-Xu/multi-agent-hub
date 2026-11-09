import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AntigravityCliLoginController } from "./antigravity-cli-login.ts";
import type { AntigravityProfile } from "./antigravity-acp.ts";
import type { AntigravityRuntime } from "./antigravity-runtime.ts";

const URL = "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=c&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=s";

/** A stand-in for `agy acp --login`: prints the link, then accepts "good-code" only. */
function fakeAgy(mode: "login" | "already" | "silent"): { runtime: AntigravityRuntime; profile: AntigravityProfile; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), "agy-cli-login-"));
  const marker = join(dir, "args.txt");
  const script = join(dir, "agy");
  const body = mode === "already"
    ? `require("fs").writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(" ")); console.log("Already signed in."); process.exit(0);`
    : mode === "silent"
      ? `setTimeout(() => {}, 60000);`
      : `require("fs").writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(" ") + "|" + process.env.HOME);
console.log("Open this link in a browser to log in with Google:\\n\\n  ${URL}\\n\\nThen paste the authorization code:");
let buf = ""; process.stdin.on("data", (c) => { buf += c; if (buf.includes("\\n")) {
  if (buf.trim() === "good-code" || buf.trim().startsWith("https://antigravity.google/oauth-callback?code=good")) { console.log("Logged in."); process.exit(0); }
  console.error("couldn't log in: token exchange failed: oauth2: \\"invalid_grant\\" https://oauth2.googleapis.com/token"); process.exit(1); } });`;
  writeFileSync(script, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(script, 0o755);
  return {
    runtime: { executablePath: script, harnessPath: "", source: "path", version: null, spawnArgs: ["acp"], kind: "cli" },
    profile: { directory: dir, tokenPath: join(dir, "token"), environment: { ...process.env, HOME: join(dir, "home") } },
    marker,
  };
}

describe("AntigravityCliLoginController", () => {
  it("returns the Google link from `agy acp --login` and signs in with a pasted code", async () => {
    const { runtime, profile, marker } = fakeAgy("login");
    let signedIn = 0;
    const controller = new AntigravityCliLoginController(() => { signedIn++; });
    const started = await controller.start(runtime, profile);
    expect(started.phase).toBe("waiting");
    expect(started.authorizationUrl).toBe(URL);
    expect(started.flowId).toBeTruthy();
    await controller.complete(started.flowId!, "  good-code  ");
    expect(signedIn).toBe(1);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8")).toBe(`acp --login|${join(profile.directory, "home")}`);
  });

  it("accepts the full landing page URL", async () => {
    const { runtime, profile } = fakeAgy("login");
    const controller = new AntigravityCliLoginController();
    const started = await controller.start(runtime, profile);
    await expect(controller.complete(started.flowId!, "https://antigravity.google/oauth-callback?code=good&state=s")).resolves.toBeUndefined();
  });

  it("reports a rejected code without echoing URLs, and the flow ends", async () => {
    const { runtime, profile } = fakeAgy("login");
    let signedIn = 0;
    const controller = new AntigravityCliLoginController(() => { signedIn++; });
    const started = await controller.start(runtime, profile);
    const failure = await controller.complete(started.flowId!, "bad").catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("invalid_grant");
    expect((failure as Error).message).not.toContain("https://");
    expect(signedIn).toBe(0);
    await expect(controller.complete(started.flowId!, "good-code")).rejects.toThrow(/no longer active/);
  });

  it("rejects a wrong flow id and multi-line input before touching the CLI", async () => {
    const { runtime, profile } = fakeAgy("login");
    const controller = new AntigravityCliLoginController();
    const started = await controller.start(runtime, profile);
    await expect(controller.complete("other", "good-code")).rejects.toThrow(/no longer active/);
    await expect(controller.complete(started.flowId!, "good\ncode")).rejects.toThrow(/Paste the authorization code/);
    controller.cancel();
  });

  it("treats a login that exits cleanly without a link as already signed in", async () => {
    const { runtime, profile } = fakeAgy("already");
    let signedIn = 0;
    const controller = new AntigravityCliLoginController(() => { signedIn++; });
    await expect(controller.start(runtime, profile)).resolves.toMatchObject({ phase: "succeeded", flowId: null });
    expect(signedIn).toBe(1);
  });

  it("times out when the CLI never prints a link", async () => {
    const { runtime, profile } = fakeAgy("silent");
    const controller = new AntigravityCliLoginController(() => {}, undefined, 300);
    await expect(controller.start(runtime, profile)).rejects.toThrow(/did not start in time/);
  });
});
