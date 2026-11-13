import { lstat, mkdir, open, readdir, realpath, stat, writeFile, appendFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { allowsTool, type ToolScope } from "../../shared/tool-scope.ts";
import type { ChatToolCallView, ChatToolDefinition, ChatToolResult, ChatToolSession } from "./chat-mcp-tools.ts";

export const WORKDIR_LIST_MAX_ENTRIES = 500;
export const WORKDIR_READ_MAX_BYTES = 256 * 1024;
export const WORKDIR_WRITE_MAX_BYTES = 1024 * 1024;

export const WORKDIR_TOOL_NAMES = ["workdir_list", "workdir_read", "workdir_write", "workdir_mkdir"] as const;
export type WorkdirToolName = (typeof WORKDIR_TOOL_NAMES)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInside(target: string, root: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type PathCheck = { ok: true; target: string; realCwd: string } | { ok: false; error: string };

async function resolveWorkdirPath(cwd: string, rawPath?: string): Promise<PathCheck> {
  const resolvedCwd = resolve(cwd);
  let cwdStat;
  try {
    cwdStat = await stat(resolvedCwd);
  } catch {
    return { ok: false, error: `工作目录不存在：${resolvedCwd}` };
  }
  if (!cwdStat.isDirectory()) {
    return { ok: false, error: `工作目录不是文件夹：${resolvedCwd}` };
  }
  const realCwd = await realpath(resolvedCwd);
  const target = rawPath === undefined || rawPath === ""
    ? resolvedCwd
    : isAbsolute(rawPath) ? resolve(rawPath) : resolve(resolvedCwd, rawPath);

  if (!isInside(target, resolvedCwd)) {
    return { ok: false, error: `拒绝访问工作目录之外的路径：${rawPath ?? target}` };
  }

  // Verify the deepest existing ancestor (or the target itself) does not escape via symlinks.
  let probe = target;
  for (;;) {
    try {
      const st = await lstat(probe);
      if (st.isSymbolicLink() && probe === target) {
        let realTarget: string;
        try {
          realTarget = await realpath(probe);
        } catch {
          return { ok: false, error: `拒绝访问无法解析目标的符号链接：${rawPath ?? target}` };
        }
        if (!isInside(realTarget, realCwd)) {
          return { ok: false, error: `拒绝符号链接逃逸到工作目录之外：${rawPath ?? target}` };
        }
      } else {
        const realProbe = await realpath(probe);
        if (!isInside(realProbe, realCwd)) {
          return { ok: false, error: `拒绝符号链接逃逸到工作目录之外：${rawPath ?? target}` };
        }
      }
      return { ok: true, target, realCwd };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") return { ok: false, error: `无法访问路径 ${rawPath ?? target}：${formatError(error)}` };
      if (probe === resolvedCwd) return { ok: false, error: `工作目录不存在：${resolvedCwd}` };
      const parent = dirname(probe);
      if (parent === probe) return { ok: false, error: `拒绝访问工作目录之外的路径：${rawPath ?? target}` };
      probe = parent;
    }
  }
}

export function workdirToolDefinitions(cwd: string): ChatToolDefinition[] {
  const scopeNote = `只能在 bot 的工作目录 ${cwd} 内读写；操作工作目录文件时优先使用此工具，不要用 data_export 写到别处。`;
  return [
    {
      type: "function",
      function: {
        name: "workdir_list",
        description: `列出工作目录内的文件和子目录（含类型与大小，最多 ${WORKDIR_LIST_MAX_ENTRIES} 条）。${scopeNote}`,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "相对工作目录的路径（或工作目录内的绝对路径），默认当前工作目录。" },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "workdir_read",
        description: `读取工作目录内文本文件内容（单次最多 ${WORKDIR_READ_MAX_BYTES} 字节）。${scopeNote}`,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "要读取的文件路径（相对工作目录或工作目录内绝对路径）。" },
            offset: { type: "integer", minimum: 0, description: "起始字节偏移，默认 0。" },
            limit: { type: "integer", minimum: 1, maximum: WORKDIR_READ_MAX_BYTES, description: `最多读取字节数（<= ${WORKDIR_READ_MAX_BYTES}）。` },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "workdir_write",
        description: `写入或追加工作目录内文本文件（单次最多 ${WORKDIR_WRITE_MAX_BYTES} 字节，自动创建父目录）。${scopeNote}`,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "要写入的文件路径（相对工作目录或工作目录内绝对路径）。" },
            content: { type: "string", description: "要写入的 UTF-8 文本内容。" },
            append: { type: "boolean", description: "为 true 时追加到文件末尾，默认覆盖写入。" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "workdir_mkdir",
        description: `在工作目录内创建目录（递归创建父目录）。${scopeNote}`,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "要创建的目录路径（相对工作目录或工作目录内绝对路径）。" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
  ];
}

export function validateWorkdirToolArgs(name: WorkdirToolName, args: unknown): void {
  if (!isRecord(args)) throw new Error("Tool arguments must be a JSON object");
  if (name === "workdir_list") {
    if (args.path !== undefined && typeof args.path !== "string") throw new Error("path must be a string");
    return;
  }
  if (typeof args.path !== "string" || !args.path.trim()) throw new Error("path must be a non-empty string");
  if (name === "workdir_read") {
    if (args.offset !== undefined && (typeof args.offset !== "number" || !Number.isInteger(args.offset) || args.offset < 0)) {
      throw new Error("offset must be a non-negative integer");
    }
    if (args.limit !== undefined && (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1)) {
      throw new Error("limit must be a positive integer");
    }
    return;
  }
  if (name === "workdir_write") {
    if (typeof args.content !== "string") throw new Error("content must be a string");
    if (args.append !== undefined && typeof args.append !== "boolean") throw new Error("append must be a boolean");
  }
}

export function viewWorkdirTool(name: WorkdirToolName, args: Record<string, unknown>): ChatToolCallView {
  return {
    title: name,
    input: args,
    ask: name === "workdir_write" || name === "workdir_mkdir",
  };
}

export async function executeWorkdirTool(cwd: string, name: WorkdirToolName, args: Record<string, unknown>): Promise<ChatToolResult> {
  try {
    if (name === "workdir_list") {
      const rawPath = typeof args.path === "string" ? args.path : undefined;
      const checked = await resolveWorkdirPath(cwd, rawPath);
      if (!checked.ok) return { ok: false, text: checked.error };
      const st = await stat(checked.target);
      if (!st.isDirectory()) return { ok: false, text: `不是目录：${rawPath ?? "."}` };
      const entries = await readdir(checked.target, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const total = entries.length;
      const shown = entries.slice(0, WORKDIR_LIST_MAX_ENTRIES);
      const lines = await Promise.all(shown.map(async (entry) => {
        if (entry.isDirectory()) return `dir\t-\t${entry.name}/`;
        if (entry.isSymbolicLink()) return `symlink\t-\t${entry.name}`;
        if (entry.isFile()) {
          try {
            const fileStat = await lstat(resolve(checked.target, entry.name));
            return `file\t${fileStat.size}\t${entry.name}`;
          } catch {
            return `file\t?\t${entry.name}`;
          }
        }
        return `other\t-\t${entry.name}`;
      }));
      if (total > WORKDIR_LIST_MAX_ENTRIES) {
        lines.push(`... (truncated: showing ${WORKDIR_LIST_MAX_ENTRIES} of ${total} entries)`);
      }
      return { ok: true, text: lines.length ? lines.join("\n") : "(empty directory)" };
    }

    const rawPath = String(args.path ?? "");
    const checked = await resolveWorkdirPath(cwd, rawPath);
    if (!checked.ok) return { ok: false, text: checked.error };

    if (name === "workdir_read") {
      const offset = typeof args.offset === "number" ? args.offset : 0;
      const limit = typeof args.limit === "number" ? args.limit : WORKDIR_READ_MAX_BYTES;
      if (limit > WORKDIR_READ_MAX_BYTES) {
        return { ok: false, text: `读取长度超限：单次最多读取 ${WORKDIR_READ_MAX_BYTES} 字节（请求 ${limit} 字节）` };
      }
      const st = await stat(checked.target);
      if (!st.isFile()) return { ok: false, text: `不是普通文件：${rawPath}` };
      const total = st.size;
      if (offset >= total) return { ok: true, text: "" };
      const toRead = Math.min(limit, total - offset);
      const handle = await open(checked.target, "r");
      try {
        const buffer = Buffer.allocUnsafe(toRead);
        const { bytesRead } = await handle.read(buffer, 0, toRead, offset);
        const text = buffer.subarray(0, bytesRead).toString("utf8");
        if (offset + bytesRead < total) {
          return { ok: true, text: `${text}\n[truncated: read ${bytesRead} bytes at offset ${offset} of ${total} total]` };
        }
        return { ok: true, text };
      } finally {
        await handle.close();
      }
    }

    if (name === "workdir_write") {
      const content = String(args.content ?? "");
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > WORKDIR_WRITE_MAX_BYTES) {
        return { ok: false, text: `写入内容超限：单次最多写入 ${WORKDIR_WRITE_MAX_BYTES} 字节（当前 ${bytes} 字节）` };
      }
      await mkdir(dirname(checked.target), { recursive: true });
      if (args.append === true) {
        await appendFile(checked.target, content, "utf8");
      } else {
        await writeFile(checked.target, content, "utf8");
      }
      return { ok: true, text: `${args.append === true ? "Appended" : "Wrote"} ${bytes} bytes to ${rawPath}` };
    }

    if (name === "workdir_mkdir") {
      await mkdir(checked.target, { recursive: true });
      return { ok: true, text: `Created directory ${rawPath}` };
    }

    return { ok: false, text: `Unknown workdir tool: ${name}` };
  } catch (error) {
    return { ok: false, text: `工作目录操作失败：${formatError(error)}` };
  }
}

export function isWorkdirToolName(name: string): name is WorkdirToolName {
  return (WORKDIR_TOOL_NAMES as readonly string[]).includes(name);
}

/** Mounts in-process working-directory tools onto `session`, respecting `scope` and avoiding collisions. */
export function attachWorkdirTools(session: ChatToolSession, cwd: string, scope?: ToolScope): { session: ChatToolSession; definitions: ChatToolDefinition[] } {
  const existing = new Set(session.definitions.map((d) => d.function.name));
  const defs = workdirToolDefinitions(cwd).filter((d) => {
    const name = d.function.name;
    if (existing.has(name)) return false;
    return scope === undefined || allowsTool(scope, { kind: "native", name });
  });
  if (!defs.length) return { session, definitions: [] };
  const mounted = new Set(defs.map((d) => d.function.name));
  session.definitions.push(...defs);
  const wrapped: ChatToolSession = {
    get definitions() { return session.definitions; },
    get skipped() { return session.skipped; },
    get trimmed() { return session.trimmed; },
    get merged() { return session.merged; },
    get budget() { return session.budget; },
    get hasLocalComputer() { return session.hasLocalComputer; },
    refit: (limit) => session.refit(limit),
    close: () => session.close(),
    validate(name, args) {
      if (mounted.has(name) && isWorkdirToolName(name)) {
        validateWorkdirToolArgs(name, args);
        return;
      }
      session.validate(name, args);
    },
    view(name, args) {
      if (mounted.has(name) && isWorkdirToolName(name)) {
        return viewWorkdirTool(name, args);
      }
      return session.view(name, args);
    },
    execute(name, args, signal) {
      if (mounted.has(name) && isWorkdirToolName(name)) {
        return executeWorkdirTool(cwd, name, args);
      }
      return session.execute(name, args, signal);
    },
  };
  return { session: wrapped, definitions: defs };
}
