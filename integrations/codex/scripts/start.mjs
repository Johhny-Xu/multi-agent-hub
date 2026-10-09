// Keep MCP stdout exclusively for protocol messages.
if (Number(process.versions.node.split(".")[0]) < 20) {
  process.stderr.write("AgentHub requires Node.js 20 or newer.\n");
  process.exitCode = 1;
} else {
  await import("../mcp/server.mjs");
}

