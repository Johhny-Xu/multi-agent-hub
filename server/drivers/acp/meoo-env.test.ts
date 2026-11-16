// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readMeooEnvValue } from "./meoo-env.ts";
import { meooSignedInHome } from "./meoo.ts";

describe("Meoo's env files", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omb-meoo-env-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function read(content: string, key = "MEOO_AK"): string {
    const path = join(root, "creds.env");
    writeFileSync(path, content);
    return readMeooEnvValue(path, key);
  }

  it("reads a plain assignment and an export prefix", () => {
    expect(read("MEOO_AK=test-key")).toBe("test-key");
    expect(read("export MEOO_AK=test-key")).toBe("test-key");
    expect(read("  MEOO_AK =  test-key  ")).toBe("test-key");
  });

  it("reads single- and double-quoted values", () => {
    expect(read("MEOO_AK='test-key'")).toBe("test-key");
    expect(read('MEOO_AK="test-key"')).toBe("test-key");
    expect(read('export MEOO_AK="test-key"')).toBe("test-key");
  });

  it("keeps a # inside quotes and drops a trailing comment outside them", () => {
    expect(read("MEOO_AK='te#st-key'")).toBe("te#st-key");
    expect(read('MEOO_AK="te#st-key"')).toBe("te#st-key");
    expect(read("MEOO_AK=test-key # rotated monthly")).toBe("test-key");
    expect(read("MEOO_AK=a#b")).toBe("a#b");
    expect(read("MEOO_AK= # nothing yet")).toBe("");
  });

  it("matches the key exactly and skips comments and blank lines", () => {
    expect(read("# MEOO_AK=commented\n\nOTHER=x\nMEOO_AK=test-key")).toBe("test-key");
    expect(read("MEOO_AK_EXTRA=other\nMEOO_AK=test-key")).toBe("test-key");
    expect(read("XBMEOO_AK=other\nMEOO_AK=test-key")).toBe("test-key");
    expect(read("MEOO_AK_EXTRA=other")).toBe("");
  });

  it("returns an empty value for an unclosed quote, an empty value and a missing file", () => {
    expect(read("MEOO_AK='test-key")).toBe("");
    expect(read('MEOO_AK="test-key')).toBe("");
    expect(read("MEOO_AK=")).toBe("");
    expect(readMeooEnvValue(join(root, "missing.env"), "MEOO_AK")).toBe("");
  });

  it("reads a project id with the same rules", () => {
    const path = join(root, "project.env");
    writeFileSync(path, "export MEOO_PROJECT_URL_ID='demo-project' # fixture\n");
    expect(readMeooEnvValue(path, "MEOO_PROJECT_URL_ID")).toBe("demo-project");
  });

  it("decides 'configured' with the same parser a run uses", () => {
    const home = join(root, "home");
    const path = join(home, ".config", "agenthub-meoo", "meoo-auth.env");
    mkdirSync(dirname(path), { recursive: true });
    for (const content of ["MEOO_AK=test-key", "export MEOO_AK='test-key'", "MEOO_AK=test-key # fixture"]) {
      writeFileSync(path, content);
      expect(readMeooEnvValue(path, "MEOO_AK")).toBe("test-key");
      expect(meooSignedInHome({ OMB_MEOO_HOME: home, HOME: root })).toBe(home);
    }
    for (const content of ["MEOO_AK=", "# MEOO_AK=test-key", "MEOO_AK='unclosed", 'MEOO_AK=""']) {
      writeFileSync(path, content);
      expect(readMeooEnvValue(path, "MEOO_AK")).toBe("");
      expect(meooSignedInHome({ OMB_MEOO_HOME: home, HOME: root })).not.toBe(home);
    }
  });
});
