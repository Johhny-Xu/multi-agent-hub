# agenthub-workers

将 `multi-agent-hub` 的 9 个外部 worker 桥接为宿主原生插件能力（Skill + 自包含 stdio MCP + 原生子代理）。宿主模型负责任务划分与结果验收，worker 的 CLI、模型与认证在 Hub 主机上执行。

本插件包采用多清单零冲突共存结构，**一个目录同时原生适配四大插件规范**：
- **MiniMax Plugin V1（MiniMax Code 桌面端 / MiniMax Agent 云端）**：[`.minimax-plugin/plugin.json`](./.minimax-plugin/plugin.json) + [`hub-bridge.mcp.json`](./hub-bridge.mcp.json) + [`skills/dispatch-hub/SKILL.md`](./skills/dispatch-hub/SKILL.md)
- **MiniMax Code CLI (`mcode 0.4.0+`) / Claude Code**：[`.claude-plugin/plugin.json`](./.claude-plugin/plugin.json)
- **ZCode IDE / CLI**：[`.zcode-plugin/plugin.json`](./.zcode-plugin/plugin.json)
- **Agent Plugins Specification v1.0.0 (`agent-plugins.org`)**：[`plugin.json`](./plugin.json)

## 原生组件（9 大 Worker）

| Agent 类型 | worker |
| --- | --- |
| `agenthub-workers:zcode` | `zcode` |
| `agenthub-workers:antigravity` | `antigravity` |
| `agenthub-workers:codebuddy` | `codebuddy`（国际版） |
| `agenthub-workers:codebuddy-cn` | `codebuddy-cn`（国内版） |
| `agenthub-workers:github-copilot` | `github-copilot` |
| `agenthub-workers:minimaxcode` | `minimaxcode` |
| `agenthub-workers:mimocode` | `mimocode` |
| `agenthub-workers:traecode` | `traecode` |
| `agenthub-workers:codearts` | `codearts` |

模型与工具能力以 Hub 配置及 `hub_capabilities` 返回为准。别名由桥归一；国际版和国内版使用独立官方登录。`skills/dispatch-hub/SKILL.md` 提供并发协作与多代理调度指导；`commands/` 提供 `hub-status`、`hub-login`、`hub-discover`。

## 七个 MCP 工具

server 名为 `hub-bridge`；宿主会给工具名添加插件命名空间。

- `hub_ask`：派发一次并在 `timeout_s` 总预算内等待，返回 `ok/status/worker/ref/answer`。
- `hub_dispatch`：异步受理并返回原始 `ref`。
- `hub_fetch`：继续查询同一 `ref`。
- `hub_status`：查询 Hub 注册代理与在线状态。
- `hub_capabilities`：查询每个 worker 已验证的模型与选项能力。
- `hub_login`：`status/start/cancel` 官方登录流程，仅返回公开状态与用户需要的链接和验证码。
- `hub_discover`：只读扫描本机和局域网 Hub，返回候选地址，不发送凭据、不修改连接。

派发接受 `worker`、`task`、`timeout_s`，以及 `model`、`thinking`（`default/on/off`）、`stream`（布尔值）、`files`、`cwd`。`files` 是插件机器上的绝对路径数组，最多 8 个、合计 1 MiB；桥编码内容，Hub 在自己的机器暂存，支持跨 Windows/Linux 附件传送。`cwd` 则是 Hub 主机的目录。先查询能力；不支持的选项在执行前拒绝。禁止发送凭据文件。

`stream=true` 请求流式生成。客户端提供 MCP `_meta.progressToken` 才能收到进度通知；没有 token 时 `delivery=buffered_no_progress_token`。保留原始 `ref` 和状态：只有 `ok=true`、`status=completed` 且答案符合验收条件才表示成功。

## 加载与配置

需要 Node.js 20+、已运行的 Hub，以及插件主机与 Hub 的网络连通。无需另装外部 subagent MCP 服务。

外部连接设置统一保存在插件包之外：
- **Windows**：`%LOCALAPPDATA%/AgentHub/client.json`
- **Linux / macOS**：`~/.config/agenthub/client.json`（支持 `XDG_CONFIG_HOME`）

字段为 `url` 和可选 `token`；自定义位置使用 `AGENTHUB_CONFIG`，也可通过环境变量 `AGENTHUB_URL`（默认 `http://127.0.0.1:8765/mcp`）和 `HUB_TOKEN` 配置连接。私有设置与凭据切勿写入插件包内。

首次连接或 Hub 连接失败时，调用 `hub_discover {}` 展示候选地址让用户选择。扫描使用 UDP `18766` 和无凭据 `/health` 确认，不自动切换、不保存连接。用安装目录的 `connect.cmd` 或 `./connect.sh` 完成所选目标的配对。

### 1. MiniMax Code / MiniMax Agent 加载方式
- **MiniMax Plugin V1（桌面端导入 / 官方 Marketplace 提交）**：
  - 直接导入独立插件包 `agenthub-workers-0.9.9.9-minimax-plugin.zip`（ZIP 根目录直接包含 `.minimax-plugin/plugin.json`），或在 GitHub 提交表单中指定仓库子目录 `plugins/agenthub-workers`。
- **MiniMax Code CLI (`mcode`) 本地加载**：
  - 使用 `mcode --plugin-dir /path/to/plugins/agenthub-workers` 或通过仓库根目录一键安装脚本 `install.cmd` / `./install.sh` 自动注册。

### 2. ZCode 加载方式
可在 ZCode 设置的插件发现页安装仓库 `https://github.com/Johhny-Xu/multi-agent-hub.git`，或在项目 `zcode.json` 中使用本地目录配置：

```json
{"plugins":{"enabled":true,"dirs":["C:/PATH/TO/multi-agent-hub/plugins/agenthub-workers"]}}
```

## 登录与命令行工具

按用户要求调用 `hub_login start` 或 `/hub-login`，再查询 `status`。只有 `authenticated` 表示授权完成；`awaiting_user` 表示等待用户操作。遵照工具指引，不索取账号密码或密钥。

CLI 也可直接调用：
- `node <插件目录>/mcp/ask.mjs <worker> <task> [timeout_s]`
- `node <插件目录>/mcp/login.mjs <worker> status`

