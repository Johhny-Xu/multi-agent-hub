// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chmodPrivateFile, writePrivateFileAtomic } from "./secure-file.ts";

// The only way to exercise "the replace failed after the temp file existed" without a full disk.
const fsControl = vi.hoisted(() => ({ failRename: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (fsControl.failRename) throw new Error("rename refused");
      return actual.renameSync(...args);
    },
  };
});

const mode = (path: string) => statSync(path).mode & 0o777;
const symlinks = (name: string, run: () => void) => it.skipIf(process.platform === "win32")(name, run);

describe("private config files", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omb-secure-file-"));
    fsControl.failRename = false;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a private folder and a 0600 file", () => {
    const dir = join(root, "secrets");
    const path = join(dir, "config.json");
    writePrivateFileAtomic(path, "value");
    expect(readFileSync(path, "utf8")).toBe("value");
    expect(mode(dir)).toBe(0o700);
    expect(mode(path)).toBe(0o600);
  });

  it("tightens a pre-existing 0644 file it replaces", () => {
    const path = join(root, "config.json");
    writeFileSync(path, "old");
    chmodSync(path, 0o644);
    writePrivateFileAtomic(path, "new");
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(mode(path)).toBe(0o600);
  });

  it("keeps the old file and leaves no temp file when the replace fails", () => {
    const path = join(root, "config.json");
    writeFileSync(path, "old");
    fsControl.failRename = true;
    expect(() => writePrivateFileAtomic(path, "new")).toThrow("rename refused");
    expect(readFileSync(path, "utf8")).toBe("old");
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  symlinks("refuses a file that is a link and leaves its target alone", () => {
    const target = join(root, "outside.json");
    writeFileSync(target, "outside");
    const link = join(root, "config.json");
    symlinkSync(target, link);
    expect(() => writePrivateFileAtomic(link, "new")).toThrow(/symbolic link/);
    expect(readFileSync(target, "utf8")).toBe("outside");
  });

  symlinks("refuses a folder that is a link, without reaching the folder it names", () => {
    const real = join(root, "real");
    mkdirSync(real);
    const link = join(root, "linked");
    symlinkSync(real, link);
    expect(() => writePrivateFileAtomic(join(link, "config.json"), "new")).toThrow(/symbolic link/);
    expect(readdirSync(real)).toEqual([]);
  });

  it("refuses a target that is not a regular file", () => {
    const target = join(root, "target");
    mkdirSync(target);
    expect(() => writePrivateFileAtomic(target, "new")).toThrow(/not a regular file/);
  });

  it("tightens an existing file's permissions without rewriting it", () => {
    const path = join(root, "config.json");
    writeFileSync(path, "same");
    chmodSync(path, 0o644);
    chmodPrivateFile(path);
    expect(mode(path)).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("same");
  });
});
