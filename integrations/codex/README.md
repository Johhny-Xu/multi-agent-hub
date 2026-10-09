# AgentHub for Codex

此目录是独立的 Codex 插件包：3 个工作流技能、stdio MCP 桥接，以及 8 个项目级原生代理模板。包版本为 `0.7.0`。Node.js 需要 **20 或更高**；项目安装脚本需要 Python **3.11 或更高**。MCP 的五个文件直接复制仓库根 `mcp/`，无需 npm 依赖。可独立安装并连接其他机器上的 Hub，见[安装包说明](../../packaging/README.md)。

原生 `agenthub_*` 代理仍使用父会话的 Codex 模型和权限，通过 MCP 派发给外部 worker。外部 worker 的认证、模型与运行目录由 Hub 的 profile 决定。代理模板不指定模型，不降低 sandbox，不代替 Hub 登录。

## 隔离、可预览的项目安装

```powershell
python integrations/codex/install.py --project "C:/path/to/project" --dry-run
python integrations/codex/install.py --project "C:/path/to/project" --apply
```

必须显式选择 `--project` 和 `--dry-run` 或 `--apply`。默认插件包复制到项目 `.codex/plugins/agenthub-workers/`，代理写入 `.codex/agents/*.toml`，配置建议写入 `.codex/agenthub.config.fragment.toml`。也可用 `--plugin-dir "C:/path/to/separate/plugin"` 指定独立插件目标。

脚本从不改写现有 `.codex/config.toml` 或个人配置；同路径内容不同的文件会使整个预检查失败，相同内容可重复运行。请审阅配置 fragment 后，把需要的表合并进项目配置，避免覆盖已有 MCP 或 `[agents]` 设置；这里的并发建议为 `max_concurrent_threads_per_session = 8`，并非外部 worker 同时可用的保证。通过 fragment 启动桥接与安装插件是两种可选路径，选一种以免出现两组同名工具。

## 使用

插件路径可供 Codex 本地插件安装流程使用；有 `plugin.json/mcp.json` 便携入口及 `.codex-plugin/plugin.json/.mcp.json` 兼容入口。采用项目 fragment 时，MCP 使用复制包的绝对入口路径，并显式转发 `AGENTHUB_URL`、`HUB_MCP_URL`、`HUB_TOKEN` 环境变量名；文件不存凭据。Hub 默认连接 `http://127.0.0.1:8765/mcp`。

### 原生插件的 Hub 地址

0.7.0 安装包统一使用外部 `client.json`：Windows 为 `%LOCALAPPDATA%/AgentHub/client.json`，Linux 为 `$XDG_CONFIG_HOME/agenthub/client.json` 或 `~/.config/agenthub/client.json`，字段为 `url` 和可选 `token`。插件读取该文件不依赖 Codex 转发自定义环境。安装器用 `AGENTHUB_CONFIG` 指定路径，并设置 `AGENTHUB_CONNECTION_MODE=file`，固定读取文件，防止宿主继承的旧 URL/token 覆盖新连接。未设置该模式的源码入口仍是显式环境优先；更换 URL 时不会把另一端点保存的 token 发过去。下面的 `PLUGIN_DATA` 配置仍兼容，并优先于标准位置。

原生插件与项目 MCP fragment 的环境传递不同：实测 Codex `0.162.0-alpha.2` 会过滤插件子进程环境，直接给 Codex 设置 `AGENTHUB_URL` 不会传给插件；便携 `mcp.json` 里的 `${env.AGENTHUB_URL}` 也不会展开。插件启动器因此支持宿主提供的 `PLUGIN_DATA/agenthub.json`。在 `codex mcp list --json` 的 agenthub transport.env.PLUGIN_DATA 中找到本次安装的数据目录，在该目录写入：

```json
{"url":"http://127.0.0.1:8765/mcp"}
```

远程 Hub 的 token 可作为可选字符串字段放在该私有数据文件中；不要写进插件包、项目或报告。通过直接 MCP fragment 显式传入的环境优先于数据文件。数据文件缺失时仍使用环境与默认地址；格式无效会阻止启动，并返回不含设置值的错误。

- `$hub-parallel-research`：多路调研后整合证据。
- `$hub-implement-review`：一个 worker 实施，另一个审查实际 diff。
- `$hub-consult`：独立会诊和交叉验证。
- 点名 `agenthub_codebuddy_cn`、`agenthub_minimaxcode` 等原生代理，或直接调用 `hub_dispatch` / `hub_fetch`。

每个任务仅派发一次并保留 ref。running/unknown/空输出继续跟踪原任务，不能被当成 completed，也不能自动重派。登录链接按用户请求用 `hub_login` 获取。

桥提供 6 个工具：`hub_ask`、`hub_dispatch`、`hub_fetch`、`hub_status`、`hub_capabilities`、`hub_login`。派发支持 `model`、`thinking`（default/on/off）、`stream`（布尔值）、`files` 与 `cwd`。先查询目标 worker 的 `hub_capabilities`，未验证的能力会在执行前拒绝。`files` 是插件机器上的绝对路径数组，最多 8 个、合计 1 MiB；桥发送文件内容，Hub 在自己的主机暂存，因此可以跨 Windows/Linux 传附件。`cwd` 则是 Hub 主机上的目录。不要发送凭据文件。

`stream=true` 请求 worker 流式输出。MCP 客户端提供 `_meta.progressToken` 时桥可以发送进度通知；没有该 token 时 `delivery=buffered_no_progress_token`，不能据此宣称客户端已经实时显示。

## 验证范围与来源

`python tests/codex_adapter_smoke.py` 检查 manifest、TOML、拷贝一致性、dry-run/重复安装/冲突保护，并在隔离 mock Hub 上对已复制的 stdio MCP 做初始化、派发、续查和失败处理验证。设置 `CODEX_TEST_BINARY` 为本机 CLI 路径，还可验证配置片段、本地 marketplace 和 stdio 初始化。这套回归不执行厂商模型。

2026-10-08 另以真实 Windows CLI、隔离 CODEX_HOME/项目与既有官方登录验证：原生 `agenthub_codebuddy_cn` 子代理通过已安装插件派发并回收真实 CN worker；thinking=on 的算术任务，以及 thinking=off 的文本+图片内容读取均成功，stream 请求已传入。Codex UI 实时进度显示未测试。该版本 `--ephemeral` 的原生子代理出现 rollout 缺失错误，实际子代理测试使用隔离持久会话。完整边界见 [原生验证报告](../../docs/native-plugins-windows.md)。

在 `codex-cli 0.162.0-alpha.2` 中，便携 `mcp.json` 的 `${PLUGIN_ROOT}` 会展开；兼容 `.mcp.json` 不展开这个变量或 `${CLAUDE_PLUGIN_ROOT}`。因此兼容入口采用 `cwd = "./"` 和相对脚本路径，由宿主解析工作目录为安装根。两种入口都经过原生 CLI 的隔离加载验证。

官方格式依据（2026-10-08）：[插件打包](https://developers.openai.com/plugins/build/plugins)、[原生自定义代理](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[MCP 项目配置](https://learn.chatgpt.com/docs/extend/mcp)。

