// Keep MCP stdout exclusively for protocol messages.
if (Number(process.versions.node.split(".")[0]) < 20) {
  process.stderr.write("AgentHub requires Node.js 20 or newer.\n");
  process.exitCode = 1;
} else {
  try {
    await (await import('./config.mjs')).pluginEnvironment();
    await import("../mcp/server.mjs");
  } catch (error) {
    // Settings may contain a private token; never echo their source or values.
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

