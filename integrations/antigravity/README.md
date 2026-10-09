# Antigravity 原生插件

这份适配让 Antigravity 作为 multi-agent-hub 的客户端，连接已选择的本机或远程 Hub，并通过原生子代理与工作流派发任务。现有 `antigravity` worker 则负责相反方向：其他客户端通过 Hub 调用 Antigravity。

## 包含什么

- `plugin.json`：Antigravity 原生插件清单。
- `agents/hub-*.md`：9 个原生路由子代理，对应每种 worker。
- `skills/hub-{dispatch,status,discover,login}/SKILL.md`：4 个可通过 slash 命令调用的工作流。
- `mcp_config.json` 和 `mcp/`：7 个 Hub 工具，复用项目的 MCP 桥。
- `native.py`：Windows / Linux 安装、备份、归属检查及只读磁盘检查。

原生工作流使用当前官方 Agent Skills 格式。Google 已公告旧 `workflows/*.md` 将于 **2026-10-19** 停止工作，因此本包不新增旧格式。使用 `/hub-dispatch`、`/hub-status`、`/hub-discover` 和 `/hub-login`；实际显示的命令可能带插件命名空间。

原生 `invoke_subagent` 使用 Markdown agent 定义；Python SDK 的 `Agent`、`SubagentConfig` 属于独立的编程接口。本轮核对的官方 SDK 0.1.21 Windows 轮子不提供 `beta.run_workflow`，SDK 适配器由 Python 编排真实 SDK 子代理。源码位于仓库 `integrations/antigravity/sdk` 或安装包部署后的 `app/integrations/antigravity/sdk`；SDK 文件不复制到原生插件目录。普通原生插件不需要安装 Python SDK，也不会自动创建模型凭据。

## 安装

需要 Node.js 20+，以及已由 Hub 连接流程创建的、位于项目外的 `client.json`。安装器仅引用其绝对路径，不读取内容。插件无需启动本机 Hub；可连接 Linux 或 Windows 上已运行的 Hub。

Windows 示例（将配置路径替换为你的实际外部连接文件）：

```powershell
python integrations/antigravity/native.py --config "$env:LOCALAPPDATA\AgentHub\client.json" --dry-run
python integrations/antigravity/native.py --config "$env:LOCALAPPDATA\AgentHub\client.json" --apply
```

Linux：

```sh
python3 integrations/antigravity/native.py --config "$HOME/.config/agenthub/client.json" --dry-run
python3 integrations/antigravity/native.py --config "$HOME/.config/agenthub/client.json" --apply
```

默认安装到 `~/.gemini/config/plugins/multi-agent-hub/`。可用 `--home <customization-root>` 指定隔离配置根，或用 `--node <absolute-executable>` 指定运行时。源模板中的 `${PLUGIN_ROOT}` 会在安装时替换为绝对脚本路径；连接文件也使用绝对路径，不依赖启动目录。

安装器不会修改宿主 `config.json`、已有 MCP 配置或启用状态。插件内的 MCP 随插件一并启停。已有文件若经用户修改，安装会报告冲突并在写入前停止；再次执行相同安装是幂等操作。升级前的文件与恢复清单位于 `~/.gemini/config/.multi-agent-hub-backups/`，可用 `--backup-dir` 指定其他项目外目录。

## 验证

```sh
python3 integrations/antigravity/native.py --inspect
```

此命令仅检查磁盘中的清单、组件数及安装后变更，不证明宿主已加载。**首次新建插件目录后需重启 Antigravity**，然后在 Customizations 的 Installed 页面确认插件、9 个 agents、4 个 skills 和 1 个 MCP server。CLI 1.3.1 的 `agy plugin list` 只列导入记录，`agents` 也不能证明仅供子代理使用的条目是否载入；列表为空不等于目录插件失效。可先用 `agy plugin validate <插件目录>` 检查格式，再通过新会话实际调用本插件工具或 `hub-mimocode` 子代理确认加载。本安装器不会另行安装 CLI。

0.9.9 的 Linux CLI 实测已通过原生 `hub-mimocode` 子代理派发和原 ref 续查；Windows 桌面仍需用户重启后确认。两端完整范围见 [0.9.9 交付记录](https://github.com/Johhny-Xu/multi-agent-hub/blob/v0.9.9/docs/release-0.9.9.md)。

先调用 `/hub-status` 检查连接，再对一个已就绪 worker 派发短任务。原生组件已安装、MCP 可通信、子代理实际调用、worker 模型执行成功是不同的验收项，应分别记录。当前主模型的权限和认证不会被插件绕过。

## 派发约束

派发前读取 worker 能力。未请求的选项保持默认；不支持的思考、流式、图片或文件要求须明确拒绝。附件是客户端路径，通过 MCP 上传；cwd 是 Hub 机器上的目录。

每项任务只提交一次，保留 worker、Hub 和 ref。running、unknown、网络超时或丢失响应时继续查询原 ref；没有 ref 时先核对受理情况，禁止自动重复派发。

Antigravity 调用同名 worker 仅适用于用户明确选择的独立远端执行主机。保持防递归检查，不通过改环境变量或新开 shell 绕过。插件不会把 worker 返回的认证错误、空回答或失败改写成成功。

## 格式依据

本机核对基线：Antigravity **2.21.1**，Google Antigravity SDK skill **0.0.9**。本机官方 `builtin/skills/plugin/SKILL.md` 明确原生目录、manifest 扩展字段、首次安装需重启及只读组件检查；其 `migrate-workflows/SKILL.md` 明确工作流向 skills 迁移。

官方说明：

- [Plugins](https://www.antigravity.google/docs/plugins/)
- [Custom subagents](https://www.antigravity.google/docs/subagents/)
- [Agent skills](https://www.antigravity.google/docs/skills/)
- [Workflows to skills migration](https://www.antigravity.google/docs/migration/workflows-to-skills/)
- [MCP](https://www.antigravity.google/docs/mcp/)

官方网页部分 CLI 路径和早期 JSON schema 与新版内置指南不同。此包安装到官方共享配置根；manifest 的 displayName、version、logo、suggestedPrompts 采用本机新版指南支持的字段。子代理保留继承模型与权限，不虚构 MCP 工具白名单；实际工具以宿主加载结果为准。
