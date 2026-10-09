// Official CodeArts Agent Hooks API; no third-party runtime dependencies.
// This hook never opens a listener or changes the host's tool permissions.
export const ROUTING_INSTRUCTIONS = `multi-agent-hub provides external workers through its MCP tools.
Inspect hub_capabilities before choosing model, thinking, stream or attachments. Do not invent support.
Dispatch each task once. Preserve its ref, and use hub_fetch for running or unknown results.
Native hub-* agents route tasks; their own narration is not an external worker result.
CodeArts-to-CodeArts routing requires the user's explicit selection of a different remote Hub host.
Never automatically route a task back to the same CodeArts worker or recursively spawn routing agents.
Only pass authorized files; cwd belongs to the target Hub host. Never send credential files.`;

export function isHubDispatch(tool) {
  return typeof tool === 'string' && /^(?:(?:mcp[_:]+)?(?:multi[-_]agent[-_]hub|agenthub)(?:[-_]hub[-_]bridge)?[_:]+)?hub_(?:ask|dispatch)$/.test(tool);
}

export const MultiAgentHubPlugin = async () => ({
  'experimental.chat.system.transform': async (_input, output) => {
    if (Array.isArray(output.system) && !output.system.includes(ROUTING_INSTRUCTIONS)) {
      output.system.push(ROUTING_INSTRUCTIONS);
    }
  },
  'tool.execute.before': async (input, output) => {
    // A CodeArts process running as a Hub worker must not dispatch to itself.
    // Other CodeArts clients can still explicitly use a different remote host.
    const worker = String(output?.args?.worker || '').trim().toLowerCase();
    if (process.env.AGENTHUB_WORKER_ID === 'codearts' && isHubDispatch(input?.tool)
        && ['codearts', 'ca', 'codearts-agent', 'huawei-codearts'].includes(worker)) {
      throw new Error('multi-agent-hub: recursive CodeArts worker dispatch is disabled');
    }
  },
});
