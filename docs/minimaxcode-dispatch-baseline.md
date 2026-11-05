# MiniMaxCode messages_file 附件派发修复 — 实施基线

- 源码根目录：`/home/johhny/multi-agent-hub`（git 仓库，`main`，`ac1ea17`）
- 基线工作树：`git status --porcelain` 输出为空（无既有未提交改动需要保护）
- 需求规格：`.codeartsdoer/specs/minimaxcode_dispatch/{spec,design,tasks}.md` 未随仓库分发；
  本次以任务正文附带的 spec/design/tasks 为准（已完整阅读）。

## 拟修改文件清单

| 文件 | 任务项 |
|------|--------|
| `hub/task_contract.py` | 1.2 1.3 2.2 2.3 2.4 3.1 |
| `hub/dispatch_audit.py`（新增） | 1.4 |
| `hub/result_store.py` | 1.5 4.5 |
| `hub/async_worker.py` | 1.5 5.1 |
| `hub/agent_hub.py` | 3.2 3.5 4.5 |
| `hub/capabilities.json` | 2.2 6.1（显式声明 MiniMaxCode 附件策略） |
| `mcp/hub.mjs`、`mcp/server.mjs` + 七份副本 | 2.1 2.5 3.3 3.4 4.1-4.4 6.1-6.3 |
| `plugins/agenthub-workers/mcp/*`、`integrations/{dsh,codex,codearts,antigravity,vscode}/mcp/*` | 6.3 |
| `tests/task_contract_regressions.py` | 7.1 7.2 7.3 |
| `tests/hub_core_regressions.py` | 7.5 |
| `tests/mcp_bridge.test.mjs`、`tests/task_bridge.test.mjs` | 7.2 7.4 |
| `tests/live_minimaxcode_attachment.mjs`（新增） | 5.3 5.4 |
| `integrations/codearts/agents/hub-minimaxcode.md` | 5.5 |
| `docs/minimaxcode-dispatch-offline.json`（回归产物） | 7.7 |

## 边界

- 仅在上述源码库修改；不使用 CodeArts 安装副本作为实现基线。
- 不 commit / 不 push / 不重启服务 / 不修改权限。
- 公开 MCP 工具名、必填参数、状态枚举与 `additionalProperties=false` 保持不变。
- 第 8 项（实时 MiniMaxCode 验收）不在本次执行范围，由主代理通过公开 MCP 完成。
