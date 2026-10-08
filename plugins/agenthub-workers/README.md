# agenthub-workers

把 Agent Hub 的子代理桥接为 zcode 原生能力：8 个 worker 注册为原生子智能体类型，`hub_ask` MCP 工具让任何会话/子代理/工作流一行调用就把任务交给枢纽 worker 并拿回最终结果。

## 用途

### 1. 原生子智能体（agents/）

8 个 worker 注册为 Agent 工具类型（名称 = 枢纽规范名，与控制台一致）：

| 子智能体类型 | 枢纽规范名 | 通道 / 默认模型 | 备注 |
|--------------|----------|------|------|
| `agenthub:zcode` | zcode | CDP GUI 驱动 ZCode 桌面版 / GLM-5.3-Flash | 体验套餐每日重置；不可重启自身宿主服务 |
| `agenthub:antigravity` | antigravity | Antigravity CLI / gemini-3.8-flash-medium | 即旧称 agy；个人额度；别名 gemini/claude/opus/pro/flash |
| `agenthub:codebuddy` | codebuddy | codebuddy-intl CLI / deepseek-v4.1-flash(0 积分倍率) | 国际版（"cb"）；有 403 前科，仅点名使用 |
| `agenthub:codebuddy-cn` | codebuddy-cn | codebuddy-cn CLI / deepseek-v4.1-flash | 国内版（"cbcn"），独立配置目录 |
| `agenthub:mimocode` | mimocode | mimo run / 9router→deepseek-v4.1-flash | "mimo" |
| `agenthub:github-copilot` | github-copilot | copilot CLI / auto（锁死自动选型） | "gcp" |
| `agenthub:minimaxcode` | minimaxcode | mmx text chat / MiniMax-M3 | "mmx"；**API 聊天型，无文件操作能力** |
| `agenthub:traecode` | traecode | trae_delegate 网关（无 CLI）/ GLM-5.3-Flash | "trae"；派发配方与其他 worker 不同，见其定义 |

### 2. MCP 桥接 hub-bridge（v0.3.0 新增，阻塞式一次调用）

`mcp/server.mjs` 注册为 MCP server `hub-bridge`，提供：

- **`hub_ask`** {worker, task, timeout_s?=300}：把任务派给任意 worker 并**阻塞到出最终结果**，返回 `{ok,status,worker,ref,answer}`。内部完成 派发→轮询→提取，调用方只需一次调用。简称（agy/cb/cbcnintl/mimo/gcp/mmx/trae）自动归一。
- **`hub_status`** {}：列出枢纽注册代理与在线状态。

配套 CLI（无 MCP 时也可用，工作流 `world.run` 友好）：

```bash
node "<插件目录>/mcp/ask.mjs" <worker> <task...> [timeout_s]   # 阻塞出答案，exit 0/1
```

**在工作流里把 hub worker 当执行节点**（已实测：工作流子代理可调用插件 MCP 工具）：

- 让工作流子代理转手：`agent("agy 通道")` 的 persona 写明"调用 mcp__hub-bridge__hub_ask(worker=antigravity, task=…)，把 answer 返回"——任务实际由枢纽 worker 执行，工作流负责编排与汇流；
- 或脚本直调：`world.run("node", ["<插件目录>/mcp/ask.mjs", "antigravity", task])`；
- 同一任务发给多 worker 对比答案：用随插件理念保存的全局工作流 **`hub-fanout`**（并行派发→阻塞回收→汇总报告）。

## 组件树

```
agenthub-workers/
├── README.md                     # 本说明
├── agents/                       # 8 个子智能体定义（名称=枢纽规范名）
│   ├── zcode.md / antigravity.md / codebuddy.md / codebuddy-cn.md
│   ├── mimocode.md / github-copilot.md / minimaxcode.md / traecode.md
├── skills/
│   └── dispatch-hub/             # 并发调度技能：向多个 Agent Hub 代理并发派活
├── commands/
│   └── hub-status.md             # /hub-status 命令：汇总注册代理与最近任务状态
└── mcp/                          # hub-bridge MCP（v0.3.0）
    ├── hub.mjs                   # 桥接引擎：派发+阻塞回收+别名归一
    ├── server.mjs                # stdio MCP server（hub_ask / hub_status）
    └── ask.mjs                   # CLI 一次性工具（world.run / 脚本友好）
```

## 前提

- `~/.zcode/cli/config.json` 中已注册 `agent-hub-subagent` 与 `agent-hub` 两个 MCP server（子智能体派发用）；hub-bridge 自身只需 `node ≥ 18` 与到任务总线（默认 `127.0.0.1:8765`）的网络连通。

## 安装

1. 打开 ZCode「设置 → 插件管理 → 发现」。
2. 点击右上角 `+` 号输入 GitHub 仓库地址 `https://github.com/Johhny-Xu/multi-agent-hub.git`。
3. 找到 `Multi-Agent Hub 子代理桥接 (agenthub-workers)` 点击获取安装，**新开会话**生效。

## 验证清单

- [ ] 新会话 Agent 工具类型列表出现 8 个 `agenthub:` 前缀类型（**以此为准**；「设置 → 子智能体管理」页只管用户级定义）。
- [ ] MCP 列表出现 `hub-bridge`；会话中调用 `hub_ask`（worker=agy，task="回复OK"）能一次拿到最终回答。
- [ ] `/hub-status` 命令可用。
- [ ] 工作流子代理可调用 `hub_ask`（2026-10-06 已实测工作流子代理具备 MCP 工具面）。

## 故障排查

- **codebuddy 派发返回 403**：改用 zcode 或 antigravity；禁止原地重试。
- **hub_ask 超时未完**：返回里带 `ref`，稍后可用 `hub_result(ref)` 续查；或加大 timeout_s。
- **minimaxcode 派了文件操作任务**：API 聊天型，只能文本进文本出；文件类任务改派其他 worker。
- **hub-bridge 连不上枢纽**：检查总线端口（默认 8765）连通与 Token 配置（可在环境变量设置 `AGENTHUB_URL` 或 `HUB_TOKEN`）。
- **额度**：zcode 体验套餐每日重置；antigravity 个人额度；mmx 配额看 `mmx quota`。
