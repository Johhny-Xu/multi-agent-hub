# agenthub-workers

把 Agent Hub 的子代理桥接为 zcode 原生能力：8 个 worker 注册为原生子智能体类型，`hub_ask` MCP 工具让任何会话/子代理/工作流一行调用就把任务交给枢纽 worker 并拿回最终结果。

## 用途

### 1. 原生子智能体（agents/）

8 个 worker 注册为 Agent 工具类型（名称 = 枢纽规范名，与控制台一致）：

| 子智能体类型 | 枢纽规范名 | 通道 / 默认模型 | 备注 |
|--------------|----------|------|------|
| `agenthub:zcode` | zcode | ZCode 内置 CLI / 当前账号模型；也支持 CDP 桌面通道 | CLI 配置为空时才回退桌面通道；不可重启自身宿主服务 |
| `agenthub:antigravity` | antigravity | Antigravity CLI / gemini-3.8-flash-medium | 即旧称 agy；个人额度；别名 gemini/claude/opus/pro/flash |
| `agenthub:codebuddy` | codebuddy | 官方 codebuddy CLI / deepseek-v4.1-flash | 国际版（"cb"），配置与国内版分开 |
| `agenthub:codebuddy-cn` | codebuddy-cn | 官方 codebuddy CLI + internal 环境 / deepseek-v4.1-flash | 国内版（"cbcn"），独立配置目录 |
| `agenthub:mimocode` | mimocode | mimo run --pure / xiaomi/mimo-v2.6-flash（Windows 模板） | "mimo"；模型别名 "v2.6f" |
| `agenthub:github-copilot` | github-copilot | copilot CLI / auto（锁死自动选型） | "gcp" |
| `agenthub:minimaxcode` | minimaxcode | mmx text chat / MiniMax-M3.1-Flash-Preview（Windows 模板） | "mmx"；模型别名 "m31flash"；**API 聊天型，无文件操作能力** |
| `agenthub:traecode` | traecode | trae_delegate 网关（无 CLI）/ GLM-5.3-Flash | "trae"；派发配方与其他 worker 不同，见其定义 |

### 2. MCP 桥接 hub-bridge（v0.5.0，含官方登录链接）

`mcp/server.mjs` 注册为 MCP server `hub-bridge`，提供：

- **`hub_ask`** {worker, task, timeout_s?=300}：把任务派给任意 worker 并**阻塞到出最终结果**，返回 `{ok,status,worker,ref,answer}`。内部完成 派发→轮询→提取，调用方只需一次调用。简称（agy/cb/cbcnintl/mimo/gcp/mmx/trae）自动归一。
- **`hub_status`** {}：列出枢纽注册代理与在线状态。
- **`hub_login`** {worker, action?="status"}：在 worker 所在的枢纽宿主机发起或查询官方登录流程。`start` 返回授权链接和验证码（如有）；用户在浏览器完成授权后，用 `status` 查询；`cancel` 取消当前等待流程。返回公开的 `{ok,worker,action,status,login_url?,user_code?,expires_at?,instructions?,error?}`，不返回凭据。

配套 CLI（无 MCP 时也可用，工作流 `world.run` 友好）：

```bash
node "<插件目录>/mcp/ask.mjs" <worker> <task...> [timeout_s]   # 阻塞出答案，exit 0/1
node "<插件目录>/mcp/login.mjs" <worker> start              # 获取官方授权链接
node "<插件目录>/mcp/login.mjs" <worker> status             # 查询授权是否完成
```

登录需要枢纽端提供 `hub_login` 工具。插件客户端只请求该工具，登录状态保存在真正运行 worker 的宿主机。CodeBuddy 国际版和国内版使用独立配置目录，国内版设置 `CODEBUDDY_INTERNET_ENVIRONMENT=internal`。Windows 上的 MiMo 支持自动获取官方登录链接，授权等待上限为 300 秒；Linux 上的 MiMo 仍返回 `manual_required`，按指引在宿主机终端登录。Antigravity 等缺少已验证链接登录方式的 worker 也返回人工操作指引。`awaiting_user` 表示尚未完成授权，只有 `authenticated` 才表示已登录。临时授权链接和验证码不要写进仓库或报告。

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
│   ├── hub-status.md             # /hub-status 命令：汇总注册代理与最近任务状态
│   └── hub-login.md              # /hub-login：获取授权链接、查询和取消登录
└── mcp/                          # hub-bridge MCP（v0.5.0）
    ├── hub.mjs                   # 桥接引擎：派发+阻塞回收+别名归一
    ├── server.mjs                # stdio MCP server（含 hub_login）
    ├── ask.mjs                   # CLI 一次性工具（world.run / 脚本友好）
    └── login.mjs                 # 官方登录流程 CLI 客户端
```

## 前提

- `~/.zcode/cli/config.json` 中已注册 `agent-hub-subagent` 与 `agent-hub` 两个 MCP server（子智能体派发用）；hub-bridge 自身只需 `node ≥ 18` 与到任务总线（默认 `127.0.0.1:8765`）的网络连通。

## 安装

1. 打开 ZCode「设置 → 插件管理 → 发现」。
2. 点击右上角 `+` 号输入 GitHub 仓库地址 `https://github.com/Johhny-Xu/multi-agent-hub.git`。
3. 找到 `Multi-Agent Hub 子代理桥接 (agenthub-workers)` 点击获取安装，**新开会话**生效。

Windows 的 Hub 可从仓库 [`hub/agents.windows.example.json`](../../hub/agents.windows.example.json) 创建 `hub/agents.json`：把 `C:/PATH/TO` 改为官方 CLI 的稳定安装位置，只保留已安装的 worker。用 `npm root -g` 查询全局 npm 包目录。CodeBuddy 两版使用独立配置目录；MiniMax 默认采用实测通过的 `MiniMax-M3.1-Flash-Preview`（别名 `m31flash`）；MiMo 默认 `xiaomi/mimo-v2.6-flash`（别名 `v2.6f`）；Trae 桌面通道需要网关。登录可调用 `hub_login` 或 `/hub-login cb start`，完成授权后 `/hub-login cb status`；MiMo 对应 `/hub-login mimo start` 和 `/hub-login mimo status`。无 MCP 时运行 `node "<插件目录>/mcp/login.mjs" mimo start` 获取 MiMo 官方链接。

ZCode 独立 CLI 的 `env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 必须指向桌面端已生成的 `zcode-builtin.json`。在 `%USERPROFILE%/.zcode/v2/runtime/provider/windows-x86_64/<版本>/<目录>/` 中定位该文件，再替换模板中的 `C:/PATH/TO/zcode-builtin.json`；可按根 README 的 PowerShell 命令仅列出路径。保留现有文件，不把内容或凭据复制进仓库。

## 验证清单

- [ ] 新会话 Agent 工具类型列表出现 8 个 `agenthub:` 前缀类型（**以此为准**；「设置 → 子智能体管理」页只管用户级定义）。
- [ ] MCP 列表出现 `hub-bridge`；会话中调用 `hub_ask`（worker=agy，task="回复OK"）能一次拿到最终回答。
- [ ] `/hub-status` 命令可用。
- [ ] `/hub-login cb start` 能返回官方授权链接；用户授权后 `/hub-login cb status` 显示 `authenticated`。
- [ ] 工作流子代理可调用 `hub_ask`（2026-10-06 已实测工作流子代理具备 MCP 工具面）。

## 故障排查

- **codebuddy 派发返回 403**：改用 zcode 或 antigravity；禁止原地重试。
- **hub_ask 超时未完**：返回里带 `ref`，稍后可用 `hub_result(ref)` 续查；或加大 timeout_s。
- **minimaxcode 派了文件操作任务**：API 聊天型，只能文本进文本出；文件类任务改派其他 worker。
- **hub-bridge 连不上枢纽**：检查总线端口（默认 8765）连通与 Token 配置（可在环境变量设置 `AGENTHUB_URL` 或 `HUB_TOKEN`）。
- **额度**：zcode 体验套餐每日重置；antigravity 个人额度；mmx 配额看 `mmx quota`。
