# CodeArts 双向接入与验证边界

本页保留 0.9.0 接入阶段的历史结果，该实现随后随 v0.9.1 源码标签发布。发布部署见 [0.9.9 交付记录](release-0.9.9.md)，IDE 原生调用和 Linux GLM-5.2 成功任务见 [2026-10-10 跟进记录](codearts-ide-followup.md)，自定义路由接入步骤见 [CodeArts 私有模型配置](codearts-custom-provider.md)。

检查日期：2026-10-09。实现版本：multi-agent-hub 0.9.0。

CodeArts 同时有两种角色：作为客户端，通过原生 Hooks、子代理、命令、技能和 MCP 调度 Hub 上的 worker；作为 worker，通过正式 CodeArts CLI 或 IDE 内置 AgentKernel 接收其他客户端的任务。两种角色的认证要求不同，安装插件不代表 worker 已能调用模型。

## 本轮实际结果

| 项目 | 结果 | 边界 |
| --- | --- | --- |
| Windows CodeArts IDE | 检测到 26.9.501 与正式内置 AgentKernel | 保留已有会话；安装后需重载当前 IDE 窗口 |
| Windows 原生组件 | 真实内核确认九个子代理、三个命令、技能和插件入口可见 | 不是宿主模型自动编排任务的证明 |
| Windows CodeArts MCP | 七个工具枚举通过；使用私有连接文件查询 Linux Hub 成功 | 凭据在用户配置目录，不在项目中 |
| Windows CodeArts worker | 正确阻断 | 独立内核返回 `no providers found`；驱动返回 `CODEARTS_PROVIDER_UNAVAILABLE`，不把 exit=0 当成功 |
| Linux CodeArts | 检测到正式 CLI 26.9.12 | 现有桌面快捷方式启动 CLI；检查范围内未发现图形 IDE，不能声称 Linux IDE 已验收 |
| Linux CodeArts worker | 正确阻断 | CLI 非交互入口要求 `CODEARTS_CLI_AK/CODEARTS_CLI_SK`；已有 OAuth 记录未满足此入口 |
| Linux 生产 Hub | 已升级 0.9.0，九个 worker、24 个 Hub 工具 | 原八个 worker 配置、历史结果和鉴权保留，服务切换前已备份 |
| Linux CodeArts MCP → MiMo | 实际单次任务完成，回答 `42` | 验证已安装 MCP 桥派发；CodeArts 模型自主发起工具调用未验收 |
| Windows → Linux | 局域网通信通过，实际任务返回 `CODEARTS_AUTH_REQUIRED` | 传输通过，CodeArts 模型未成功 |
| Linux → Windows | SSH 反向回环转发通过，实际任务返回 `CODEARTS_PROVIDER_UNAVAILABLE` | Windows 临时 Hub 已停止；不是 Windows 常驻服务或直接局域网入站验收 |
| 派发保护 | 通过 | CodeArts worker 不能通过本包 MCP 再派发给 CodeArts；校验发生在发 HTTP 请求前 |

原生加载和通信通过不等于模型成功。跨机路由、服务切换及真实其他 worker 的任务结果分别记录在本目录的 `codearts-*.json` 报告中；没有成功模型回答的项目均保留 blocked 状态。

## 两个方向怎样使用

```text
CodeArts 原生客户端 → 本包 MCP → 选定 Windows/Linux Hub → 其他 worker
Codex / ZCode / DSH → 本包 MCP → 选定 Windows/Linux Hub → CodeArts 正式 CLI
```

客户端与 worker 主机可以分开。客户端 `files` 表示客户端机器的文件；桥负责传输内容。`cwd` 始终表示 worker 所在 Hub 主机的目录。跨机连接不会让本地路径自动变成远程可见路径。

CodeArts 子代理名是 `hub-codearts`、`hub-mimocode` 等，完整名单见 [原生包](../integrations/codearts/README.md)。三个命令是 `/hub-status`、`/hub-discover`、`/hub-login`。其他客户端的 worker 参数使用 `codearts`，也接受 `ca`、`huawei-codearts`。

CodeArts 客户端可以明确选择另一台 Hub 的 CodeArts worker；作为已被委派的 CodeArts worker 时，驱动设置 `AGENTHUB_WORKER_ID=codearts`，共享 MCP 在 `hub_ask` 和 `hub_dispatch` 中拒绝 CodeArts 自派发。`--pure` 可能跳过原生 Hooks，因此保护也在 MCP 桥实现。此保护针对本包的派发接口，不是跨主机身份认证，也不会改变第三方 MCP 的行为。

## 原生安装与连接

使用 0.9.0 plugins 包时，可以只选择 CodeArts：

```powershell
.\install.cmd --component plugins --native-hosts codearts --project C:\Work\project --url SERVER:8765 --token-file C:\private\hub-token.txt
```

```sh
./install.sh --component plugins --native-hosts codearts --codearts-target cli --url SERVER:8765 --token-file /private/hub-token.txt
```

IDE 的 MCP 设置是工作区 `.codeartsdoer/mcp/mcp_settings.json`，顶层为 `mcpServers`；CLI 的配置是用户 `.codeartsdoer/codearts_cli.jsonc` 或已有 `.json`，顶层为 `mcp`。实际版本若使用其他位置，可传 `--codearts-ide-settings`。未指定实际工作区时，自动安装将 IDE 连接列为待配置，不把用户目录中的猜测路径当作已生效的 IDE 设置。

本轮独立安装在 Windows `%LOCALAPPDATA%/AgentHub-CodeArts/plugin`，私有连接为其上级目录的 `client.json`；Linux 为 `~/.local/share/AgentHub-CodeArts/plugin`，私有连接为 `~/.config/agenthub-codearts/client.json`。这些是本轮部署位置；通用安装包仍支持 `--prefix` 与 `--config-dir`。

安装器只合并本包 MCP 条目，并保存原配置备份；模型、其他 MCP 和 JSONC 注释保持不变。自定义同名代理或用户修改过的包文件会导致冲突，不会被强制覆盖。插件本身不启动本地 Hub。

## Worker 的选项与认证

| 选项 | 当前开放状态 | 原因 |
| --- | --- | --- |
| 模型默认值 | 沿用官方 CLI 配置 | 空默认值是继承选择，不是虚构的模型 ID |
| 指定模型 | 必须是本机声明且官方目录存在的 `provider/model` | 不静默退回账号当前模型 |
| 思考 | 仅 `default` | `--thinking` 只是显示思考内容；没有验证严格开关 |
| 流式 | 仅 `false` | 当前 JSON 通道输出完成的文本块，未证明实时答案增量 |
| 文件 | 默认关闭 | 参数存在，但未通过已认证模型的读取验收 |
| 图片 | 关闭 | 当前 CLI 文件通道可能标记为 `text/plain`，不能据此声明图片理解 |

认证失败必须在 CodeArts 官方配置或运行环境中修复。不要将 AK、SK、Token、账号文件放进源码、提示词、附件或测试报告。IDE 已登录不能证明非交互 CLI 已登录。修复后通过 `hub_capabilities(worker="codearts", refresh=true)` 清除失败提示，再执行一次独立任务验证；刷新本身不调用模型，也不证明登录成功。

驱动用新的会话数据库，不恢复用户 IDE 对话；任务通过 stdin 交给官方 CLI。非零退出、结构化错误、权限拒绝、空回答、多个会话或缺少明确终态都不会被报告为 completed。超时保留失败或未确认语义，不自动重复派发。

## 验证和实现位置

- 驱动：`drivers/codearts_cli.py`，独立于平台 shell，不将厂商原始日志返回给 Hub。
- 原生包：`integrations/codearts/`，安装器与 MCP 可独立部署。
- 回归：`tests/codearts_driver_regressions.py`、`codearts_native_install.py`、`codearts_native_plugin.mjs`、`codearts_hub_contract.py`、`codearts_packaging.py`。
- 真实前置检查：`codearts-windows-preflight.json`、`codearts-linux-preflight.json`；Windows 原生验收：`codearts-windows-native.json`。
- Windows 全量回归：`codearts-windows-final.json`，26/26 组通过，测试期间源码未变。
- Linux 回归：`codearts-linux-regressions.json`。首次全量 23 组中 22 组通过，打包测试的 mock 参数不兼容已修复；最终六组增量通过，最后同步测试修订后再次通过驱动 19 项。报告保留首次失败、各轮哈希与覆盖范围，不将增量验收称为全量重跑。
- Linux 服务升级和原生安装：`codearts-linux-deployment.json`、`codearts-linux-native-install.json`；真实 MiMo 任务：`codearts-linux-native-bridge-live.json`。
- 跨机实测：`codearts-windows-to-linux.json`、`codearts-linux-to-windows.json`。反向探针共两轮；首轮结束时日志句柄清理异常，第二轮完成报告。首轮残留两份无凭据日志，删除被自动审批拒绝，未绕过；自建进程均已退出。
- 交付包与哈希：`codearts-release-artifacts.json`；源码和 Git 历史扫描：`codearts-secret-audit.json`。扫描不等于对所有未知凭据格式的保证。

官方依据：[CLI 运行参数](https://support.huaweicloud.com/usermanual-cli/codeartsagent_cli_0034.html)、[CodeArts 原生 Hooks](https://support.huaweicloud.com/usermanual-codeartsagent/codeartsagent_ug_0036.html)、[子智能体](https://support.huaweicloud.com/usermanual-codeartsagent/codeartsagent_ug_0051.html)、[CLI MCP](https://support.huaweicloud.com/usermanual-cli/codeartsagent_cli_0035.html)。实际已安装版本的行为优先于参数名推断。

## 2026-10-23 升级 Linux CLI 26.9.12 → 26.10.9

在线升级：`codearts upgrade`（下载 `codearts-install-26.10.9-linux-x64-baseline.tar.gz`，SHA256 校验通过，旧二进制保留为 `installers/bin/codearts.delete`）。新版与 Hub 驱动之间需要处理三件事：

| 变化 | 现象 | 处理 |
| --- | --- | --- |
| 启动脚本改用 `BASH_SOURCE` 定位自身目录 | 经 `~/.local/bin/codearts` 软链调用时报 `.../bin/codearts: No such file or directory` | 把该软链换成 3 行 `exec /home/johhny/.codeartsdoer/installers/codearts "$@"` 包装；`PATH` 里的名字不变，后续升级替换 installers/ 也不会再坏 |
| 新增「文件夹信任」门（`~/.codeartsdoer/cli-data/settings.json` 的 `security.folderTrust`） | 任务 `cwd` 不在 `trustedFolders` 时直接失败：`文件夹未被信任: <dir>`，驱动归类为 `CODEARTS_PERMISSION_REQUIRED` | 这台单用户 Hub 需保持升级前的行为：`folderTrust.enabled=false`，并把 `/`、`/home/johhny` 留在 `trustedFolders`（备份 `settings.json.bak-20261023-*`） |
| `--format json` 事件流 | 未变：`step_start` / `text` / `step_finish(reason=stop)`，字段仍是 `sessionID` + `part.id/text`；排队提示（`模型排队`）会混在 stdout，解析器按非 JSON 行忽略，不误判为失败 | 无需改驱动；`codearts models` 仍是 `model_id/model_name` 表格，表头与标尺解析通过 |

模型目录（`codearts models`，7 个，与客户端内置列表一致）：`huaweicloud-maas/GLM-5.2`、`glm-5.2-sft-harmony`（GLM-5.2-ArkTS-SPARK）、`openpangu-2.0-pro`、`openpangu-2.0-flash`、`glm-5.3`、`deepseek-v4.1-flash`、`kimi-k3`。线上 `agents.json` 的 `codearts.models` 已补 `DeepSeek-V4.1-Flash`（别名 `v41f`）与 `Kimi-K3`，默认模型改为 `huaweicloud-maas/deepseek-v4.1-flash`。

升级后实测（`hub_dispatch_cli` 异步派发，均为真实模型回答）：GLM-5.2 → `10`，默认 DeepSeek-V4.1-Flash → `15`，Kimi-K3 → `7`。高峰期 DeepSeek-V4.1-Flash 会提示「模型排队」（曾排到 250+ 位），这是上游配额队列，不是驱动或 Hub 超时；`timeout_s` 现为「无进展超时」，排队期间没有输出仍会按预算回收，需要时可调大或改用低倍率模型。
