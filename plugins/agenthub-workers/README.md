# agenthub-workers

将 AgentHub 的八个外部 worker 注册为 ZCode 原生子代理，并提供自包含 stdio MCP。宿主模型负责任务编排，worker 的 CLI、模型与认证在 Hub 主机上执行。

## 原生组件

| Agent 类型 | worker |
| --- | --- |
| agenthub-workers:zcode | zcode |
| agenthub-workers:antigravity | antigravity |
| agenthub-workers:codebuddy | codebuddy（国际版） |
| agenthub-workers:codebuddy-cn | codebuddy-cn（国内版） |
| agenthub-workers:github-copilot | github-copilot |
| agenthub-workers:minimaxcode | minimaxcode |
| agenthub-workers:mimocode | mimocode |
| agenthub-workers:traecode | traecode |

模型与工具能力以 Hub 配置及 hub_capabilities 返回为准。别名由桥归一；国际版和国内版使用独立官方登录。MiniMax 支持适配范围内的图文输入与文本输出，但没有本地文件编辑工具；Trae 可采用 Hub 配置的 CLI 或桌面网关。

`skills/dispatch-hub/SKILL.md` 提供并发协作与原生工作流节点配方；`commands/` 提供 hub-status、hub-login、hub-discover。技能不自动注册全局保存的命名工作流。

## 七个 MCP 工具

server 名为 hub-bridge；宿主会给工具名添加插件命名空间。 原生 Agent 的登记 ID 也可能带插件前缀；以当前 Agent 工具实际列出的类型为准。已实测的 profileId 为 agenthub-workers:mimocode 和 codebuddy-cn，其定义路径均来自本插件 agents/；不要硬编码旧的 agenthub: 前缀或绕到其他代理。

- hub_ask：派发一次并在 timeout_s 总预算内等待，返回 ok/status/worker/ref/answer。
- hub_dispatch：异步受理并返回原始 ref。
- hub_fetch：继续查询同一 ref。
- hub_status：查询 Hub 注册代理。
- hub_capabilities：查询每个 worker 已验证的模型与选项能力。
- hub_login：status/start/cancel 官方登录流程，仅返回公开状态与用户需要的链接和验证码。
- hub_discover：只读扫描本机和局域网 Hub，返回候选地址，不发送凭据、不修改连接。

派发接受 worker、task、timeout_s，以及 model、thinking（default/on/off）、stream（布尔值）、files、cwd。files 是插件机器上的绝对路径数组，最多 8 个、合计 1 MiB；桥编码内容，Hub 在自己的机器暂存，支持跨 Windows/Linux 附件传送。cwd 则是 Hub 主机的目录。先查询能力；不支持的选项在执行前拒绝。禁止发送凭据文件。

stream=true 请求流式生成。客户端提供 MCP `_meta.progressToken` 才能收到进度通知；没有 token 时 delivery=buffered_no_progress_token。生成方式与客户端实时展示是两项不同的验证。

保留原始 ref 和状态。只有 ok=true、status=completed 且答案符合验收条件才表示成功。running/unknown、空输出、HTTP 超时或协议错误不能自动重派；有 ref 时继续查同一任务。completed 中的拒绝或无法执行解释也不能算任务成功。

## 加载

需要 Node.js 20+、已运行的 Hub，以及插件主机与 Hub 的网络连通。无需另装外部 subagent MCP 服务。

0.8.0 的独立 `plugins` 安装包不启动本地 Hub，可连接 Windows 或 Linux 服务器。外部连接设置统一放在 Windows `%LOCALAPPDATA%/AgentHub/client.json` 或 Linux `~/.config/agenthub/client.json`（支持 XDG_CONFIG_HOME），字段为 `url` 和可选 `token`；自定义位置使用 `AGENTHUB_CONFIG`。安装器设置 `AGENTHUB_CONNECTION_MODE=file` 固定使用该文件，忽略宿主继承的旧 URL/token。见[安装说明](../../packaging/README.md)。

首次连接或 Hub 连接失败时，调用 `hub_discover {}` 或 `/hub-discover`，展示候选地址让用户选择。扫描使用 UDP 18766 和无凭据 `/health` 确认，不自动切换、不保存连接。用安装目录的 `connect.cmd` 或 `./connect.sh` 完成所选目标的配对；未发现目标时手动填写地址。保存后重启宿主或 MCP 连接。连接文件缺失或损坏时仍可发现，固定文件模式的派发返回 `SETUP_REQUIRED`。已有 ref 仍属于原 Hub，不能因连接故障重派任务。

ZCode 安装插件不会自动执行 slash 命令或技能；安装包向导负责首次连接，`hub_discover` 是会话中的只读入口。

可在 ZCode 设置的插件发现页安装仓库 https://github.com/Johhny-Xu/multi-agent-hub.git，或在独立测试项目 zcode.json 中使用官方本地目录配置：

```json
{"plugins":{"enabled":true,"dirs":["C:/PATH/TO/agenthub/plugins/agenthub-workers"]}}
```

通过环境 AGENTHUB_URL（默认 http://127.0.0.1:8765/mcp）、HUB_TOKEN 配置连接，私有设置不要写入插件包。新会话生效。Windows Hub 配置示例见 [agents.windows.example.json](../../hub/agents.windows.example.json)。

独立 ZCode CLI 复用桌面官方登录时，可设置 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 为桌面已经生成的 zcode-builtin.json 路径；只引用文件，不复制内容或认证数据。ZCODE_STORAGE_DIR 可隔离运行记录与插件缓存，用户账号配置仍取原用户目录。

## 实测范围

2026-10-08 在 ZCode 0.16.9 Windows 原生 CLI 验证：插件 validate 无诊断，list 发现插件、技能、命令；Agent 实际加载 mimocode 子代理并通过插件 MCP→Hub→官方 MiMo 返回真实算术结果。thinking=off、stream=true 的文本+图片附件任务也已完成；客户端未提供 progressToken，实际为缓冲交付。原生工作流执行及 GUI 实时展示不计入本次通过范围。详见 [原生验证报告](../../docs/native-plugins-windows.md)。

headless build 模式没有 MCP permission client，工具调用会被拒绝。实测使用显式 yolo，同时禁用 Bash/Read/Write/Edit/Glob/Grep 本地工具，仍可调用指定插件工具；不要据此降低日常会话的权限设置。完全隔离用户 HOME 的 profile 没有官方账号关联，模型创建会失败，需要复用既有官方登录。

## 登录

按用户要求调用 hub_login start 或 /hub-login，再查询 status。只有 authenticated 表示授权完成；awaiting_user 表示等待用户操作。MiMo Windows 官方链接最多等待 300 秒，Linux 可能返回 manual_required；遵照工具指引，不索取账号密码或密钥。授权链接与验证码不要写入仓库。

CLI 也可使用 `node <插件目录>/mcp/ask.mjs <worker> <task> [timeout_s]`，或 `node <插件目录>/mcp/login.mjs <worker> status`。带附件和模型选项的任务使用 MCP schema。

格式依据：[ZCode 官方插件文档](https://zcode.z.ai/en/docs/plugin)、[官方 CLI 文档](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/README.md)。
