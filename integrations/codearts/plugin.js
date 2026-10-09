// Official CodeArts Agent Hooks API; no third-party runtime dependencies.
// This hook never opens a listener or changes the host's tool permissions.
export const ROUTING_INSTRUCTIONS = `multi-agent-hub provides external workers through its MCP tools.
Use directly registered MCP tools directly when the host exposes them. If the CodeArts IDE exposes MCP tools through its lazy tool registry, first use tool_search to discover the tool, then tool_describe(id=...) to load its schema, and tool_call(id=..., args=...) to execute it using that schema. A discovered MCP name is not automatically a directly callable tool; do not repeat direct calls after the host says it is not directly callable.
If permission for an action is denied or rejected, stop that action immediately and report blocked_permission with the original ref (if available). Do not retry it under another tool name, through another transport, or from the parent agent; resume only after explicit authorization. Never change permission settings or add automatic approval.
Inspect hub_capabilities before choosing model, thinking, stream or attachments. Do not invent support.
Dispatch each task once. Preserve its worker, host and ref.
Within the total waiting budget, keep querying the original ref with hub_fetch until completed or a definite failure, with a short delay between checks. On budget exhaustion, return running or unknown with the original ref so the parent can continue within its authorized budget. A running result is not completed. A permission denial stops recovery as described above; handing off the ref does not authorize a parent retry. A timeout or unknown result never justifies redispatch.
Only report completed with a nonempty worker answer that meets the acceptance criteria; a completed agent turn or tool call alone is insufficient.
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
