---
name: hub-dispatch
description: Delegates tasks through multi-agent-hub with Antigravity native worker subagents, coordinates independent work, and collects verified results.
---

# Dispatch Hub tasks

Use the loaded multi-agent-hub MCP tools and native `hub-*` subagents. Worker IDs are antigravity, codebuddy, codebuddy-cn, github-copilot, mimocode, minimaxcode, traecode, zcode and codearts. The native subagent is a routing role; the selected Hub worker executes the delegated task.

1. Establish the selected Hub with hub_status. Query hub_capabilities before selecting a worker, model, thinking, stream or attachment option. Omit options the user did not request and reject unsupported ones.
2. Divide independent work by file ownership or other clear boundaries. Give each assignment a goal, relevant context, allowed changes, acceptance criteria and expected output. Keep dependent work sequential.
3. Invoke the appropriate native `hub-<worker>` subagent using the host's `invoke_subagent` tool. If native subagents are unavailable on the current surface, state that limitation and use the same MCP route directly.
4. Every assignment is dispatched exactly once. Keep worker, selected Hub and ref together. Use hub_fetch for running or unknown states. A timeout or missing response never proves rejection; retain the original ref, and reconcile uncertain acceptance without duplicate dispatch.
5. Collect actual results, check acceptance criteria and report failures or blocked authentication individually. Do not summarize a missing answer as success. A review stage may use another worker after implementation finishes.

Antigravity-to-Antigravity delegation requires an explicitly selected separate remote execution host. Do not create a self-dispatch chain or override a worker recursion guard. Native agents must not create further routing subagents.

Files are client-side absolute paths; transfer authorized content through the MCP files parameter. cwd is a directory on the Hub machine. Never read or upload credentials. Model streaming support and actual host progress rendering are different capabilities.

Use hub_discover on first setup or connection failure. Discovery does not choose a target or transmit authentication. Connection secrets belong in the external client.json selected by AGENTHUB_CONFIG.

This is the current Antigravity native workflow format: a slash-invokable Agent Skill. It is independent of the Python SDK programming interface.
