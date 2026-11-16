// @vitest-environment node
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureGrokInjectSlug } from "./grok.ts";

const mode = (path: string) => statSync(path).mode & 0o777;

describe("Grok's injected local model config", () => {
  let root: string;
  let home: string;
  let config: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omb-grok-inject-"));
    home = join(root, ".grok");
    config = join(home, "config.toml");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const env = () => ({ HOME: root, GROK_HOME: home });

  it("creates a private home and a 0600 config for a new install", () => {
    expect(ensureGrokInjectSlug("lmstudio::test-model", env())).toBe("lmstudio-test-model");
    expect(mode(home)).toBe(0o700);
    expect(mode(config)).toBe(0o600);
    expect(readFileSync(config, "utf8")).toContain("[model.lmstudio-test-model]");
  });

  it("tightens a 0644 config it extends", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(config, "# kept\n");
    chmodSync(config, 0o644);
    ensureGrokInjectSlug("lmstudio::test-model", env());
    expect(mode(config)).toBe(0o600);
    expect(readFileSync(config, "utf8")).toContain("# kept");
  });

  it("reuses a slug that already points at the same host and tightens the old file", () => {
    mkdirSync(home, { recursive: true });
    const before = [
      "[model.lmstudio-test-model]",
      'model = "test-model"',
      'base_url = "http://127.0.0.1:1234/v1"',
      'name = "picked earlier"',
      "",
    ].join("\n");
    writeFileSync(config, before);
    chmodSync(config, 0o644);
    expect(ensureGrokInjectSlug("lmstudio::test-model", env())).toBe("lmstudio-test-model");
    expect(readFileSync(config, "utf8")).toBe(before);
    expect(mode(config)).toBe(0o600);
  });

  it("does not create Grok's home for a cloud model", () => {
    expect(ensureGrokInjectSlug("grok-4.5", env())).toBe("grok-4.5");
    expect(existsSync(home)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("follows a home the person linked elsewhere", () => {
    const real = join(root, "real-grok");
    mkdirSync(real);
    symlinkSync(real, home);
    ensureGrokInjectSlug("lmstudio::test-model", env());
    expect(existsSync(join(real, "config.toml"))).toBe(true);
    expect(mode(join(real, "config.toml"))).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("refuses a config that is a link and leaves its target alone", () => {
    mkdirSync(home, { recursive: true });
    const target = join(root, "outside.toml");
    writeFileSync(target, "# outside\n");
    symlinkSync(target, config);
    expect(() => ensureGrokInjectSlug("lmstudio::test-model", env())).toThrow(/symbolic link/);
    expect(readFileSync(target, "utf8")).toBe("# outside\n");
  });
});
