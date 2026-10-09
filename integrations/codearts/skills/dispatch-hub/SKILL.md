---
name: dispatch-hub
description: Delegate self-contained tasks through multi-agent-hub workers, coordinate independent work and collect real results in CodeArts Agent.
---
Use the registered multi-agent-hub MCP tools and native hub-* agents. The nine worker IDs are antigravity, codebuddy, codebuddy-cn, github-copilot, mimocode, minimaxcode, traecode, zcode and codearts.

Divide parallel work into non-overlapping ownership boundaries. Each worker receives the goal, necessary context, allowed changes, acceptance criteria and output requirements. Query hub_capabilities before choosing options; omit unspecified thinking, stream and model settings. Assign implementation and review in separate phases.

Dispatch each task exactly once. Preserve its worker, host and ref. Poll the original ref with hub_fetch until completed or a definite failure. A timeout, unknown state or lost response never justifies an automatic duplicate task. Return actual answers and verify the acceptance criteria.

CodeArts is allowed as a worker from another client. From CodeArts itself, use its native hub-codearts route only when the user explicitly selected a different remote Hub host. Never build a recursive CodeArts-to-itself chain; if host identity is unclear, do not dispatch that route.

Files belong to the client machine and must be passed through the MCP files field for transport. cwd belongs to the target Hub machine. Only upload authorized files, never credentials. Model capabilities and host UI progress rendering are separate; do not claim streaming UI delivery without evidence.

Initial connection failures can invoke hub_discover. Discovery lists candidates without sending secrets or choosing a host. The user selects a target through the supplied connection setup. Authentication belongs in the external client configuration selected by AGENTHUB_CONFIG, never in skill files or project sources.

CodeArts slash commands and this skill provide native workflow instructions. They do not register a separate persistent visual workflow engine. Report the execution mechanism actually used.

