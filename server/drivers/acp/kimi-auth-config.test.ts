// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KIMI_DEVICE_SIGN_IN, ensureKimiInjectAlias } from "./kimi.ts";

const mode = (path: string) => statSync(path).mode & 0o777;

describe("Kimi's stored login", () => {
  let root: string;
  let credentials: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omb-kimi-auth-"));
    credentials = join(root, "credentials");
    mkdirSync(credentials, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function signedInWith(content: string): boolean {
    writeFileSync(join(credentials, "kimi-code.json"), content);
    return KIMI_DEVICE_SIGN_IN.signedIn!({ HOME: root, KIMI_CODE_HOME: root });
  }

  it("rejects an empty object and missing fields", () => {
    expect(signedInWith("{}")).toBe(false);
    expect(signedInWith(JSON.stringify({ access_token: undefined }))).toBe(false);
  });

  it("rejects values that are not strings", () => {
    for (const value of [null, 42, {}, [], true]) {
      expect(signedInWith(JSON.stringify({ access_token: value, refresh_token: value }))).toBe(false);
    }
  });

  it("rejects empty and whitespace-only tokens", () => {
    expect(signedInWith(JSON.stringify({ access_token: "", refresh_token: "" }))).toBe(false);
    expect(signedInWith(JSON.stringify({ access_token: "  ", refresh_token: "\n" }))).toBe(false);
  });

  it("accepts either token when it is a real string", () => {
    expect(signedInWith(JSON.stringify({ access_token: "test-access" }))).toBe(true);
    expect(signedInWith(JSON.stringify({ refresh_token: "test-refresh" }))).toBe(true);
    expect(signedInWith(JSON.stringify({ access_token: "test-access", refresh_token: "test-refresh" }))).toBe(true);
  });

  it("rejects a file that is not JSON, and a JSON document that is not an object", () => {
    expect(signedInWith("{ not json")).toBe(false);
    expect(signedInWith(JSON.stringify(null))).toBe(false);
    expect(signedInWith(JSON.stringify("test-token"))).toBe(false);
    expect(signedInWith(JSON.stringify(["test-token"]))).toBe(false);
  });
});

describe("Kimi's injected local model config", () => {
  let root: string;
  let home: string;
  let config: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omb-kimi-config-"));
    home = join(root, "kimi-code");
    config = join(home, "config.toml");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const env = () => ({ HOME: root, KIMI_CODE_HOME: home });

  it("creates a private folder and a 0600 config", () => {
    expect(ensureKimiInjectAlias("lmstudio::test-model", env())).toBe("lmstudio/test-model");
    expect(mode(home)).toBe(0o700);
    expect(mode(config)).toBe(0o600);
    expect(readFileSync(config, "utf8")).toContain('[models."lmstudio/test-model"]');
  });

  it("tightens a pre-existing 0644 config it has to extend", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(config, "[ui]\ntheme = \"dark\"\n");
    chmodSync(config, 0o644);
    ensureKimiInjectAlias("lmstudio::test-model", env());
    expect(mode(config)).toBe(0o600);
    expect(readFileSync(config, "utf8")).toContain("theme = \"dark\"");
  });

  it("tightens a 0644 config whose content is already right", () => {
    ensureKimiInjectAlias("lmstudio::test-model", env());
    const before = readFileSync(config, "utf8");
    chmodSync(config, 0o644);
    ensureKimiInjectAlias("lmstudio::test-model", env());
    expect(readFileSync(config, "utf8")).toBe(before);
    expect(mode(config)).toBe(0o600);
  });

  it("keeps existing tables and their values while adding what is missing", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(config, [
      "[ui]",
      'theme = "dark"',
      "",
      "[providers.lmstudio]",
      'type = "openai_legacy"',
      'base_url = "http://elsewhere.invalid/v1"',
      'api_key = "already-set"',
      "",
    ].join("\n"));
    ensureKimiInjectAlias("lmstudio::test-model", env());
    const text = readFileSync(config, "utf8");
    expect(text).toContain('theme = "dark"');
    // An existing provider table is never rewritten, even when its URL differs.
    expect(text).toContain('base_url = "http://elsewhere.invalid/v1"');
    expect(text).toContain('[models."lmstudio/test-model"]');
    expect(text).toContain('protocol = "openai"');
  });
});
