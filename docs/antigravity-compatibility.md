# Antigravity 原生客户端与 SDK 适配

本文记录 2026-10-09 的 Antigravity 接入阶段，运行组件及预览包当时为 0.9.0。部署、根 README 与 Git 状态均按该阶段保留；后续 0.9.9 的 Linux 同步、四客户端原生实测和发布状态见 [0.9.9 交付记录](release-0.9.9.md)。文末“未部署 / 未推送”不代表后续版本的当前状态。

本次增加的是第五种客户端。Hub 仍有九种 worker，其中已有的 `antigravity` worker 提供反向调用；客户端插件与 Hub 分开部署。插件通过外部 `client.json` 选择一个本机或远程 Hub，不要求本机常驻 Hub。

## 原生格式与入口

采用已安装 Antigravity 2.21.1 的官方内置插件指南：`plugin.json`、`agents/*.md`、`skills/*/SKILL.md`、`mcp_config.json`。九个 `hub-*` 子代理对应现有 worker，模型和权限继承宿主；四个 slash 工作流是 `hub-dispatch`、`hub-status`、`hub-discover`、`hub-login`。实际命令可能带插件命名空间。

旧 `workflows/*.md` 已进入迁移期，官方公告 2026-10-19 停止支持，因此采用当前 Agent Skills 标准。[官方迁移说明](https://www.antigravity.google/docs/migration/workflows-to-skills/)、[原生子代理规范](https://www.antigravity.google/docs/subagents/)。

原生安装器只复制插件资产，引用外部连接文件，不复制 SDK 环境或任何登录文件。安装前检查路径、归属与文件哈希；用户改动冲突时停止，升级先备份，写入失败回滚。首次新增目录必须重启 Antigravity 才能发现。`--inspect` 只证明磁盘资产完整，不证明宿主已加载。

源码入口：[原生说明](../integrations/antigravity/README.md)、[安装器](../integrations/antigravity/native.py)、[SDK 说明](../integrations/antigravity/sdk/README.md)。统一安装器新增 `--native-hosts antigravity`、`--antigravity-home`、`--antigravity-exe`。后者用于识别已安装程序，安装时不会启动桌面程序或另行安装测试 CLI。

## SDK 标准与版本差异

可选依赖固定 `google-antigravity==0.1.21`，使用真实 `Agent`、`LocalAgentConfig`、`SubagentConfig`、`McpStdioServer`、Hooks 与 BudgetConfig。Python 编排并行或顺序执行，SDK 的 `start_subagent` 创建相应叶子子代理；叶子不再创建代理。

**官方仓库示例不等于已发布轮子的能力。** 本轮从官方 PyPI 下载 Windows wheel，核对官方 SHA256，并逐字节比较已安装的 99 个 Python 文件；官方 Windows、Linux 0.1.21 实包均没有 `RUN_WORKFLOW` / `beta.workflows`。因此实现没有调用 `beta.run_workflow`，使用 Python 编排 SDK 原生子代理。[官方发布包](https://pypi.org/project/google-antigravity/0.1.21/)、[同 tag 工作流示例](https://github.com/google-antigravity/antigravity-sdk-python/blob/v0.1.21/examples/getting_started/workflows.py)、[实包核对记录](antigravity-sdk-package-proof.json)。

SDK 调度模型留空继承默认，不把 CLI 模型 ID 当成 API 模型 ID。当前 SDK 入口支持文本、worker 默认思考、缓冲结果；其他选项在原生 MCP 入口按 Hub 能力检查使用。SDK 调度与 worker 模型是两个独立环节，可能分别产生服务商费用。

SDK 认证使用环境中的 `GEMINI_API_KEY`。桌面客户端登录不提供这个认证。本轮 Windows 和 Linux 测试进程均没有该环境认证，`doctor` / `run` 明确返回 `blocked_auth`；未完成 SDK 真实模型推理。`validate` 的成功仅表示实际类型配置有效。[获取 SDK 密钥的官方入口](https://aistudio.google.com/app/api-keys)，凭据只放本机私有环境，不放项目或聊天。

## 派发与恢复

- SDK 只开放 `hub_dispatch`、`hub_fetch`、`hub_status`、`hub_capabilities`、`hub_discover`，先取得 ref 再查询；不开放登录写操作或长时间阻塞的 `hub_ask`。完整原生桥仍是七个工具。
- 一次 SDK 运行中按 worker 预先保留派发名额，修改任务、重复提交或未知 ref 查询被拒绝。库调用与 CLI 都检查重复 worker。运行超时、网络未知或取消不会自动重派。
- 完成状态只认观察到的 Hub 回执，要求非空字符串回答。模型口头说成功、空回答或缺少回执不能算完成。
- 默认并发 3，总体时间 300 秒，总 token 上限 120000，按所选 worker 均分；每会话最多 12 次模型调用、20 次工具调用。取消 SDK 不等于取消已受理的远程 Hub 任务，原 ref 需要保留。
- Hub 给同步/异步 CLI worker 注入真实身份；六份桥阻止已标记 worker 派发给自身，普通客户端和跨 worker 调用正常。SDK 显式传递该标记。此保护不等于跨机器循环检测或跨进程分布式幂等。

## 本轮现场结果

| 验证层 | 结果与边界 |
| --- | --- |
| Windows 原生安装 | 已安装到 `~/.gemini/config/plugins/multi-agent-hub`；9 agents、4 skills、1 MCP server，归属校验无改动；仍需重启桌面宿主发现 |
| Windows 已安装插件的 MCP | 官方 Python MCP client 初始化、七工具枚举、远端 Hub 状态与能力查询通过；不代表 Antigravity 模型自主使用工具 |
| Linux 隔离安装及 MCP | 在临时 customization 根执行原生安装，9 agents、4 skills、1 MCP server 完整；通过安装后的桥连接既有 Linux Hub，未修改 Linux 日常插件目录 |
| Windows → Linux 真实任务 | 通过新增插件桥，远端已配置的 MiMo 默认模型单次返回 `42`，ref `mimocode-15e3e6c040` |
| 指定 MiMo `26f` | 远端现有配置未声明此型号，能力检查拒绝，未算成模型成功；默认模型验证是另一项独立测试，没有修改服务器型号 |
| SDK 模型推理 | 未进行；两端缺少独立 SDK 认证，明确记录为待认证 |
| 桌面宿主实际子代理调用 | 待宿主重启及真实会话验证，未将磁盘安装或直接 MCP 调用冒充此项通过 |

通信与模型记录：[Windows 安装后 MCP](antigravity-installed-mcp-windows.json)、[Linux 隔离安装后 MCP](antigravity-installed-mcp-linux.json)、[默认模型任务](antigravity-live-mcp-default-windows.json)、[明确型号拒绝](antigravity-live-mcp-windows.json)。SDK 状态：[Windows](antigravity-sdk-windows.json)、[Linux](antigravity-sdk-linux.json)。测试使用外部虚拟环境，不为 Windows 安装本机常驻 Hub，也不恢复此前卸载的测试 CLI。

本轮没有替换现有 Linux Hub 服务。新 Hub 代码中的 worker 身份注入修复已进入分发源码；要让该保护在既有服务器生效，需要部署本轮的新 Hub 包。当前通信与 MiMo 结果来自原有服务器配置。

## 最终回归与交付

- [Windows 最终报告](antigravity-windows-regressions-final.json)：32 组全部通过；[Linux 最终报告](antigravity-linux-regressions-final.json)：29 组全部通过。两端源码哈希完全一致，测试期间和结束后均未发生源码漂移。测试使用实际 SDK 0.1.21 环境；其中 16 项 SDK 行为测试和 5 项真实 HookRunner / protobuf 协议测试均执行通过，模拟编排结果不作为模型推理证据。
- 首轮报告保留：[Windows](antigravity-windows-regressions-initial.json)、[Linux](antigravity-linux-regressions-initial.json)。Windows 揭示虚拟环境 Python 的子解释器监听端口导致旧启动器误判；已修复进程归属与停止逻辑，新增真实 venv 测试验证完整清理、外来进程保护、失败保留记录。Linux 的 UDP 测试改用隔离回环地址，避免把运行中的生产 Hub 算入测试期望；没有改动发现功能或停止生产服务。
- [凭据扫描](antigravity-secret-audit.json)无命中，另对实际连接令牌做全项目字节比对也无命中。安装包不包含密钥、client.json、SDK 虚拟环境或模型会话。
- 三种预览包 `hub / plugins / both` 已构建并验证每个文件的 manifest 哈希，[包校验记录](antigravity-preview-packages.json)保留本轮和修复前构建值。包名沿用基础版本 0.9.0，**这些是未发布预览包，不是新 Git 标签或 GitHub Release**。`plugins` 包包含 Antigravity 原生资产及可选 SDK 源码，普通插件安装不会安装 SDK。

根 README 是他人正在维护的内容，本轮保持字节不变。Changelog、分发包说明和本篇记录独立更新；本次功能未创建新版本标签或执行 push。
