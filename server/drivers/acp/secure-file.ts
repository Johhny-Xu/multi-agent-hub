// Private files a driver writes into a user's home or a project folder: they hold API keys and MCP
// headers, so they are never group- or world-readable, never written through a link, and replaced
// atomically so a crash cannot leave half a config behind.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Throws unless `path` is absent or a regular file that is not a link: anything else would either be
 * written through to an unexpected target or not be a file we can replace. */
export function assertPrivateFile(path: string): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stats.isSymbolicLink()) throw new Error(`${path} is a symbolic link; refusing to write through it.`);
  if (!stats.isFile()) throw new Error(`${path} is not a regular file.`);
}

export interface PrivateDirectoryOptions {
  /** A tool's own home folder (`~/.grok`, Kimi's data root) is the person's, and dotfile setups often make it
   * a link; following it there is expected. A project folder is not: leave this off for anything a repository
   * controls. */
  followLink?: boolean;
}

/** Creates `path` as a private folder when needed. An existing folder is only checked, never chmodded:
 * the folder may be the person's own home directory. */
export function ensurePrivateDirectory(path: string, options: PrivateDirectoryOptions = {}): void {
  const look = options.followLink ? statSync : lstatSync;
  let stats;
  try {
    stats = look(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(path, { recursive: true, mode: 0o700 });
    stats = look(path);
  }
  if (stats.isSymbolicLink()) throw new Error(`${path} is a symbolic link; refusing to write through it.`);
  if (!stats.isDirectory()) throw new Error(`${path} is not a directory.`);
}

/** Replaces `path` with `content`: a sibling temp file, fsync, rename, then 0600 — so a pre-existing
 * file with looser permissions is tightened too, and a failed write leaves the old file intact. */
export function writePrivateFileAtomic(path: string, content: string, options: PrivateDirectoryOptions = {}): void {
  assertPrivateFile(path);
  const dir = dirname(path);
  ensurePrivateDirectory(dir, options);
  // PID and random bytes: two drivers writing the same config at once must not collide on the temp name.
  const temp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | null = null;
  let tempExists = false;
  try {
    fd = openSync(temp, "wx", 0o600);
    tempExists = true;
    writeSync(fd, content, null, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, path);
    tempExists = false;
    chmodSync(path, 0o600);
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
    if (tempExists) {
      try { unlinkSync(temp); } catch {}
    }
  }
}

/** Tightens a file whose content is already correct. */
export function chmodPrivateFile(path: string): void {
  assertPrivateFile(path);
  chmodSync(path, 0o600);
}
