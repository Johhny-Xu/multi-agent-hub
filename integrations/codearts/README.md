# multi-agent-hub for CodeArts Agent

CodeArts 码道的原生客户端包：一个 JavaScript Hooks 插件、九个子智能体、三个斜杠命令、一个调度技能，以及独立的 stdio MCP 桥。Windows 和 Linux 使用同一份包。运行模型的是目标 Hub 上的 worker，客户端包本身不启动 Hub。

## 安装

需要 Python 3.9+ 和 Node.js 20+。先用 multi-agent-hub 连接设置生成外部 `client.json`，其中保存选定 Hub 的地址和认证信息。此安装器只登记文件路径，不读取或复制凭据。

```powershell
python integrations/codearts/install.py --home "$env:USERPROFILE/.codeartsdoer" --plugin-dir "C:/Apps/multi-agent-hub/integrations/codearts" --config "$env:LOCALAPPDATA/AgentHub/client.json" --ide-settings "C:/Work/project/.codeartsdoer/mcp/mcp_settings.json" --target both --dry-run
```

```sh
python3 integrations/codearts/install.py --home "$HOME/.codeartsdoer" --plugin-dir /opt/multi-agent-hub/integrations/codearts --config "$HOME/.config/agenthub/client.json" --ide-settings /home/me/project/.codeartsdoer/mcp/mcp_settings.json --target both --dry-run
```

将 `--dry-run` 改为 `--apply` 完成安装，然后重载 CodeArts IDE 或重启 CLI。`--target ide`、`cli` 或 `both` 可分别安装。`--home` 是选定的 `.codeartsdoer` 目录，可用用户级目录或项目级目录；`--ide-settings` 指定 IDE 实际打开的 MCP 设置文件，省略时为 `<home>/mcp/mcp_settings.json`。CLI 默认使用 `<home>/codearts_cli.jsonc`，已有 `.json` 时保持该格式；可用 `--cli-settings` 显式指定。

安装器会保留其他 MCP、模型配置及 JSONC 注释。修改前将原文件备份至 `<home>/.multi-agent-hub-backups`，或 `--backup-dir` 指定的外部目录。已有同名用户代理、插件或被用户修改的已安装文件会报告冲突，不会覆盖。`.multi-agent-hub-install.json` 只记录本包拥有的文件摘要与 MCP 条目摘要，供后续升级核验。

IDE 原生 MCP 使用 `mcpServers`，`command`、`args`、`env`；CLI 使用 `mcp`，`type: local`、数组 `command`、`environment`。两者仅注入 `AGENTHUB_CONFIG` 和 `AGENTHUB_CONNECTION_MODE=file`，不把 Token 写入源码。IDE 的项目设置路径因版本和工作区而异，安装时必须以“配置 MCP”打开的实际路径为准。

## 使用

在 CodeArts 中使用 `/hub-status`、`/hub-discover` 或 `/hub-login`。子智能体为 `hub-antigravity`、`hub-codebuddy`、`hub-codebuddy-cn`、`hub-github-copilot`、`hub-mimocode`、`hub-minimaxcode`、`hub-traecode`、`hub-zcode`、`hub-codearts`。使用 `@hub-mimocode` 等委派任务，或让主智能体按 `dispatch-hub` 技能组织并行任务。

先查询 `hub_capabilities`，再选择模型、思考模式、流式和附件。不存在的能力不应显示为可用。首次连接可扫描本机和局域网；实际目标由用户选择。配置连接 Linux Hub 后，Windows CodeArts 可以调度其 worker；反向连接同理。附件内容通过桥发送，`cwd` 使用目标 Hub 的系统路径。

`hub-codearts` 从 CodeArts 客户端发起时，仅允许用户明确选择另一个远端 Hub 主机。运行 CodeArts worker 的启动器应设置 `AGENTHUB_WORKER_ID=codearts`；本包 MCP 桥在派发前拒绝该 worker 再向 `codearts` 派发，启用时的原生 hook 另提供一层检查。CLI 的纯净模式可能跳过 hook，因此递归保护同时放在桥中。不要将此防护当作跨主机身份验证；选择正确端点仍由连接配置负责。

其他客户端调度 CodeArts 由 Hub worker 驱动实现。CLI `run` 是独立入口，IDE 已登录不代表 CLI 已具备可用 provider。安装成功不代表已完成真实模型调用；以 Hub 的能力检查和实测结果为准。此包不会修改 CodeArts 全局执行权限或启动未认证网络监听。

## 官方依据

- [IDE 自定义智能体](https://support.huaweicloud.com/usermanual-codeartsagent/codeartsagent_ug_0051.html)：`name` 必须与 Markdown 文件名一致，支持 `mode: subagent`。
- [IDE MCP](https://support.huaweicloud.com/usermanual-codeartsagent/codeartsagent_ug_0010.html) 与 [CLI MCP](https://support.huaweicloud.com/usermanual-cli/codeartsagent_cli_0035.html)：两种宿主的配置格式不同。
- [IDE Hooks](https://support.huaweicloud.com/usermanual-codeartsagent/codeartsagent_ug_0036.html) 与 [CLI Hooks](https://support.huaweicloud.com/usermanual-cli/codeartsagent_cli_0018.html)：自动加载 `.codeartsdoer/plugin` 或 `plugins` 下的 JavaScript/TypeScript 模块。
- [IDE 命令](https://support.huaweicloud.com/usermanual-codeartsagent/codeartsagent_ug_0038.html)、[CLI 命令定义](https://support.huaweicloud.com/usermanual-cli/codeartsagent_cli_0010.html)、[CLI 技能](https://support.huaweicloud.com/usermanual-cli/codeartsagent_cli_0019.html)。
- [CLI 运行参数](https://support.huaweicloud.com/usermanual-cli/codeartsagent_cli_0034.html)：`run --format json`、`--file`、`--agent`；`--thinking` 是显示思考块，`--variant` 才是模型支持的思考强度设置。
