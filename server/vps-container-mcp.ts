// Stdio bridge to the Cua MCP server in a VPS container; auth is the user's SSH config and agent, and nothing is stored here.
import { runMcpBridge } from "./mcp-bridge.ts";
import { vpsContainerMcpArgs, vpsDockerArgs } from "./vps-computer.ts";
import { DATA_DIR } from "./config.ts";
import { augmentedPath } from "./env-path.ts";
import { createVpsExecRelay, spawnVpsExecRun, withVpsExecTools } from "./vps-exec.ts";
import { ensureVpsSshMaster, prepareVpsSsh } from "./vps-ssh.ts";

const [alias, containerName] = process.argv.slice(2);
const sshAlias = alias ?? "";
let args: string[];
try {
  args = vpsContainerMcpArgs(sshAlias, containerName ?? "");
} catch {
  process.stderr.write("invalid VPS MCP connection\n");
  process.exit(2);
}

// The driving pair rides in env, not argv: argv is world-readable through `ps`.
const controlUrl = process.env.OMB_CONTROL_URL ?? "";
const controlToken = process.env.OMB_CONTROL_TOKEN ?? "";
const ssh = prepareVpsSsh(DATA_DIR, augmentedPath());

try { await ensureVpsSshMaster(ssh, sshAlias); }
catch (error) {
  process.stderr.write(`VPS SSH initialization failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const env = { ...process.env, PATH: ssh.path };
// The driver only serves the screen; shell commands run beside it in the same container over the same SSH master.
const execRelay = createVpsExecRelay({ alias: sshAlias, container: containerName!, run: spawnVpsExecRun(env) });

runMcpBridge({
  command: "docker",
  args,
  env,
  label: "VPS Cua Driver",
  // Probe the transport, not the driver: a busy desktop mid-tool-call must never look dead.
  liveness: { command: "docker", args: vpsDockerArgs(sshAlias, ["version", "--format", "{{.Server.Version}}"]) },
  ...(controlUrl && controlToken ? { gate: { url: controlUrl, token: controlToken } } : {}),
  rewriteResponse: withVpsExecTools,
  relay: (call) => execRelay(call),
});
