---
name: dispatch-hub
description: Delegate self-contained tasks through multi-agent-hub workers, coordinate independent work and collect real results in CodeArts Agent.
---
Use the registered multi-agent-hub MCP tools and native hub-* agents. The nine worker IDs are antigravity, codebuddy, codebuddy-cn, github-copilot, mimocode, minimaxcode, traecode, zcode and codearts.

Use directly registered MCP tools directly when the host exposes them. If the CodeArts IDE exposes MCP tools through its lazy tool registry, first use tool_search to discover the tool, then tool_describe(id=...) to load its schema, and tool_call(id=..., args=...) to execute it using that schema. A discovered MCP name is not automatically a directly callable tool; do not repeat direct calls after the host says it is not directly callable.

If permission for an action is denied or rejected, stop that action immediately and report blocked_permission with the original ref (if available). Do not retry it under another tool name, through another transport, or from the parent agent; resume only after explicit authorization. Never change permission settings or add automatic approval.

Divide parallel work into non-overlapping ownership boundaries. Each worker receives the goal, necessary context, allowed changes, acceptance criteria and output requirements. Query hub_capabilities before choosing options; omit unspecified thinking, stream and model settings. Assign implementation and review in separate phases.

Dispatch each task exactly once. Preserve its worker, host and ref. Within the total waiting budget, keep querying the original ref with hub_fetch until completed or a definite failure, with a short delay between checks. On budget exhaustion, return running or unknown with the original ref so the parent can continue within its authorized budget. A running result is not completed. A permission denial stops recovery as described above; handing off the ref does not authorize a parent retry. A timeout or unknown result never justifies redispatch. Only report completed with a nonempty worker answer that meets the acceptance criteria; a completed agent turn or tool call alone is insufficient. Return actual answers and verification evidence.

CodeArts is allowed as a worker from another client. From CodeArts itself, use its native hub-codearts route only when the user explicitly selected a different remote Hub host. Never build a recursive CodeArts-to-itself chain; if host identity is unclear, do not dispatch that route.

Files belong to the client machine and must be passed through the MCP files field for transport. cwd belongs to the target Hub machine. Only upload authorized files, never credentials. Model capabilities and host UI progress rendering are separate; do not claim streaming UI delivery without evidence.

Initial connection failures can invoke hub_discover. Discovery lists candidates without sending secrets or choosing a host. The user selects a target through the supplied connection setup. Authentication belongs in the external client configuration selected by AGENTHUB_CONFIG, never in skill files or project sources.

CodeArts slash commands and this skill provide native workflow instructions. They do not register a separate persistent visual workflow engine. Report the execution mechanism actually used.

