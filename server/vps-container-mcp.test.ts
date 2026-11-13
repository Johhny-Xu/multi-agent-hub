import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { vpsContainerName } from "./vps-computer.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function runBridge(bin: string, input: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./vps-container-mcp.ts", import.meta.url)),
        "production-vps",
        vpsContainerName("bridge-test"),
      ],
      {
        env: { ...process.env, OMB_EXTRA_PATH: bin, NODE_NO_WARNINGS: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

describe.skipIf(process.platform === "win32")("VPS Cua MCP bridge", () => {
  it("uses the same managed SSH connection settings as preview and startup", async () => {
    const bin = await mkdtemp(join(tmpdir(), "openmausbot-vps-mcp-"));
    temporary.push(bin);
    await writeFile(join(bin, "docker"), '#!/bin/sh\nssh "$@"\n', { mode: 0o700 });
    await writeFile(join(bin, "ssh"), '#!/bin/sh\nprintf "SSH:%s\\n" "$*" >&2\ncat\n', { mode: 0o700 });
    const input = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n';
    const result = await runBridge(bin, input);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(input);
    expect(result.stderr).toMatch(/SSH:-F .*[/\\]ssh[/\\]config -H ssh:\/\/production-vps exec/);
  });

  it("passes MCP bytes unchanged to docker exec over the validated SSH target", async () => {
    const bin = await mkdtemp(join(tmpdir(), "openmausbot-vps-mcp-"));
    temporary.push(bin);
    await writeFile(join(bin, "ssh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const fakeDocker = join(bin, "docker");
    await writeFile(fakeDocker, "#!/bin/sh\nprintf 'ARGS:%s\\n' \"$*\" >&2\ncat\n", { mode: 0o700 });
    await chmod(fakeDocker, 0o700);

    const input = `{"jsonrpc":"2.0","id":1,"method":"tools/list","data":"${"x".repeat(2 * 1024 * 1024)}"}\n`;
    const result = await runBridge(bin, input);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(input);
    expect(result.stderr).toContain(
      `ARGS:-H ssh://production-vps exec -i -u cua -e HOME=/home/cua -e DISPLAY=:1 ` +
        `-e CUA_DRIVER_INSTALL_CHANNEL=python_package -e CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${vpsContainerName("bridge-test")} ` +
        "/usr/local/libexec/openmausbot/cua-driver mcp --socket /run/user/1000/openmausbot-cua.sock",
    );
  });

  it("survives docker closing stdin before consuming the request", async () => {
    const bin = await mkdtemp(join(tmpdir(), "openmausbot-vps-mcp-"));
    temporary.push(bin);
    await writeFile(join(bin, "ssh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const fakeDocker = join(bin, "docker");
    await writeFile(fakeDocker, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(fakeDocker, 0o700);

    const result = await runBridge(bin, "x".repeat(4 * 1024 * 1024));

    expect(result.code).toBe(0);
  });

  it("answers exec itself with a shell in the same container and adds exec to the driver's tool list", async () => {
    const bin = await mkdtemp(join(tmpdir(), "openmausbot-vps-mcp-"));
    temporary.push(bin);
    await writeFile(join(bin, "ssh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    // The driver call (`... cua-driver mcp`) echoes frames back; an exec call drops docker's own options and runs the
    // `bash -c <script> omb-exec <args>` tail locally, the way the container would.
    await writeFile(join(bin, "docker"), [
      "#!/bin/bash",
      'for a in "$@"; do [ "$a" = mcp ] && exec cat; done',
      'printf "EXECARGS:%s\\n" "$*" >> "$(dirname "$0")/execargs"',
      'while [ $# -gt 0 ] && [ "$1" != bash ]; do shift; done',
      'exec "$@"',
      "",
    ].join("\n"), { mode: 0o700 });
    const listed = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "screenshot", inputSchema: { type: "object" } }] } });
    const call = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "exec", arguments: { command: "echo hello-$((40+2)); echo warn >&2; exit 4" } } });
    const result = await runBridge(bin, `${listed}\n${call}\n`);
    expect(result.code).toBe(0);
    const frames = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(frames.find((frame) => frame.id === 1).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["screenshot", "exec", "exec_status"]);
    const answer = frames.find((frame) => frame.id === 2).result;
    expect(answer.isError).toBe(true);
    expect(JSON.parse(answer.content[0].text)).toMatchObject({ ok: false, exitCode: 4, stdout: "hello-42\n", stderr: "warn\n" });
    const execArgs = await readFile(join(bin, "execargs"), "utf8");
    expect(execArgs).toContain(`EXECARGS:-H ssh://production-vps exec -i -u cua -w /home/cua -e HOME=/home/cua -e DISPLAY=:1 ${vpsContainerName("bridge-test")} bash -c`);
    // The command itself never reaches docker's argv.
    expect(execArgs).not.toContain("hello-");
  });
});
