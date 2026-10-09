# AgentHub for Codex

此目录是独立的本地 Codex 插件包：3 个工作流技能、stdio MCP 桥接，以及 8 个项目级原生代理模板。包版本 `0.6.0` 是本地源码版本。Node.js 需要 **20 或更高**；安装脚本需要 Python **3.11 或更高**。MCP 的四个文件直接复制仓库根 `mcp/`，无需 npm 依赖。

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

- `$hub-parallel-research`：多路调研后整合证据。
- `$hub-implement-review`：一个 worker 实施，另一个审查实际 diff。
- `$hub-consult`：独立会诊和交叉验证。
- 点名 `agenthub_codebuddy_cn`、`agenthub_minimaxcode` 等原生代理，或直接调用 `hub_dispatch` / `hub_fetch`。

每个任务仅派发一次并保留 ref。running/unknown/空输出继续跟踪原任务，不能被当成 completed，也不能自动重派。登录链接按用户请求用 `hub_login` 获取。

## 验证范围与来源

`python tests/codex_adapter_smoke.py` 检查 manifest、TOML、拷贝一致性、dry-run/重复安装/冲突保护，并在隔离 mock Hub 上对已复制的 stdio MCP 做初始化、派发、续查和失败处理验证。设置 `CODEX_TEST_BINARY` 为本机 CLI 路径，还可在全新 HOME、CODEX_HOME 和项目目录中验证配置片段解析，以及便携/兼容包的本地 marketplace 安装、路径解析和 stdio 初始化。测试不登录厂商，不执行模型；Codex UI 和原生代理任务发现尚未实测。

在 `codex-cli 0.162.0-alpha.2` 中，便携 `mcp.json` 的 `${PLUGIN_ROOT}` 会展开；兼容 `.mcp.json` 不展开这个变量或 `${CLAUDE_PLUGIN_ROOT}`。因此兼容入口采用 `cwd = "./"` 和相对脚本路径，由宿主解析工作目录为安装根。两种入口都经过原生 CLI 的隔离加载验证。

官方格式依据（2026-10-08）：[插件打包](https://developers.openai.com/plugins/build/plugins)、[原生自定义代理](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[MCP 项目配置](https://learn.chatgpt.com/docs/extend/mcp)。

