---
description: 汇总 Agent Hub 注册代理与最近任务状态
argument-hint: 无参数
---

# /hub-status — Agent Hub 状态总览

只读命令：仅汇总状态，不派发任务、不写文件。严格使用下方列出的工具与命令，不要臆造其他工具或参数。

## 1. 列出注册代理

调用 MCP 工具 `mcp__agent-hub__hub_list_agents`（无参数）。

记录返回的每个代理名称及其在线/离线状态，供步骤 4 表格的 agent 列使用。

## 2. 取最近任务 ref

在 Bash 中执行：

```bash
ssh n5095-server 'ls -t ~/agent-hub/results/ | head -11'
```

从输出取最近的任务 ref，最多 10 个（忽略空行及非 ref 行）。按输出顺序保留，作为下一步的输入列表。

## 3. 逐个 ref 查询结果

对步骤 2 得到的每个 ref，调用 MCP 工具 `mcp__agent-hub-subagent__subagent_result`，传入该 ref，读取：

- `status`：任务状态（如 running / completed / failed）。
- `text`：结果摘要文本。

表格中 `text` 截断为 100 字。

## 4. 输出

输出一张紧凑表格，列为 ref / agent / status / 摘要：

| ref | agent | status | 摘要 |
|-----|-------|--------|------|
| <ref> | <agent> | <status> | <text 截断 100 字> |

规则：

- 每个 ref 一行，顺序与步骤 2 的列表一致。
- `status` 为 failed 的行必须显式标出（例如 status 写成 `failed ⚠`）。
- 对 failed 的行，在表格之后附上该 ref 的 `text` 全文（不截断）。
- 若某 ref 查不到结果，status 记为 `unknown` 并注明。
