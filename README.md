# multi-agent-hub

![multi-agent-hub 0.9.9 结构图：五种原生客户端经 MCP 连接 Windows 或 Linux Hub，调度九种 worker；支持同机、跨机与双向连接](docs/architecture.svg)

**multi-agent-hub** 是一个面向多开发环境的 AI Agent 统一调度中枢。它基于标准 MCP 协议、原生插件与子代理体系，让开发者能够在 **Codex**、**ZCode**、**DeepSeek Harness (DSH)**、**华为 CodeArts** 与 **Antigravity** 等客户端之间，跨平台、跨机器无缝调度各端 worker（官方 CLI 与内核）。

当前源码版本为 **0.9.4**，本阶段重点在于**控制台交互革命与体验跃迁**：引入 CodeBuddy 风格三栏式交互大盘、精细时段问候语与跨平台全局头像定制、全量会话聚合归档与一键复原/彻底清理、并发深度探活替代独立心跳、Worker 启停权威同步与模型目录精炼。

---

### ✨ 核心亮点

- 🔌 **5 种原生宿主客户端**：深度适配 Codex、ZCode、DeepSeek Harness、CodeArts、Antigravity，提供原生子代理、斜杠命令与工作流。
- 🤖 **9 种 Worker 统一适配**：标准契约调度 Antigravity、CodeBuddy（国际/国内版）、GitHub Copilot、MiMo、MiniMax、TraeCode、ZCode、CodeArts（Antigravity 原生客户端为新增宿主角色，不作为第十种 Worker）。
- 🎛️ **CodeBuddy 风格三栏式交互控制台**：内置 Web 管理大盘（`--with-console`，端口 `8890`，默认监听 `0.0.0.0` 开放局域网访问），提供 48px 极简活动栏、260px 平台会话管理树、单平台沉浸式对话与右侧可折叠扩展工作台；支持 7 大时段 35 句智能问候语、跨平台全局头像自由替换；全量会话归档支持跨平台集中筛选、搜索、排序与一键复原/彻底删除；刷新时自动并发检测全量子代理真实在线状态与延迟。
- ⚡ **子代理启用开关与全端双向同步**：在 WebUI 控制台对任意 Worker（如暂时无额度或调试中的子代理）一键启停；权威状态即时同步落盘并由 Hub 调度器、WebUI 与所有客户端插件实时感知；被禁用的 Worker 在 `hub_status` 显式呈现 `[已禁用]`，派发时零延迟前置拦截（`profile_disabled`），杜绝浪费计算与配额资源。
- 🎯 **精炼去重的生产模型目录**：为各 Worker 对齐官方真实模型与积分倍率体系，全面清理无法用于代码任务的生图模型、冗余平台别名与旧代模型，保留各服务商当季旗舰与高可用选型。
- 🔄 **灵活多样的部署形态**：插件与 Hub 支持同机共存或分离部署；支持纯 Windows、纯 Linux 及 Windows ↔ Linux 跨机连接（局域网直连或 SSH 反向通道）。客户端连接特定 Hub 并非多 Hub 联邦，模型请求仍由官方 CLI 发送至服务商。
- 🛡️ **严格能力预检与终态判定**：根据模型能力约束思考、流式与附件；CodeArts 宿主环境强制执行 `tool_search → tool_describe → tool_call` 单一调用路径与单任务单次派发；拒绝空回答、已知异常退出及 agy 超时后的部分回答；保留原任务回执（ref），阻止 worker 向自身重复派发。
- 🔍 **智能发现与平滑切换**：局域网与本机 Hub 自动广播扫描与手动回退；连接配置与凭据独立于源码，平滑升级不丢失历史任务数据。

---

## 原生客户端接入与实测状态

各客户端通过专属原生插件接入调度中枢：

- **Antigravity 原生插件**：提供 `plugin.json`、9 个代理（`agents/*.md`）、4 个技能（`skills/*/SKILL.md`）及包含 7 个桥接工具的 `mcp_config.json`。可选 Python SDK 锁定 `google-antigravity==0.1.21`，提供强类型 `SubagentConfig` 与 Python 串并行编排能力；注意已安装 wheel 不包含 `beta.run_workflow` API，且 SDK API 鉴权独立于 IDE/CLI 登录（缺少 SDK 鉴权时 SDK 编排模型调用受阻）。
- **CodeArts 原生插件与驱动**：包含 9 个子代理、3 个斜杠命令、1 个调度技能、1 个 Hooks 插件和 7 个 MCP 工具。双向支持客户端调度与 Worker 被调度（`worker="codearts"`，别名 `ca`、`huawei-codearts`）。
  - **IDE 懒加载工具协议深度适配与单一路径约束**：支持 CodeArts IDE 动态工具注册体系；严格确立 `tool_search` 发现工具 → `tool_describe` 获取参数 Schema → `tool_call` 执行的**单一标准路径**；严禁在 Markdown 或纯文本推理中直出 XML 标签，杜绝引擎双重派发；任务单次派发后由客户端安全轮询。
  - **权限管控与终态轮询保障**：遇宿主权限拒绝（Permission Denied / auto-rejecting）时立即终止并返回 `blocked_permission` 与原始 ref，禁止换工具名或经父代理重试；在等待预算内以原 ref 持续轮询 `hub_fetch`，严格以符合验收条件的非空真实 worker 回答判定 `completed`，绝不以会话结束或工具调用成功冒充任务完成。
  - **Windows 官方 CLI 精准识别与环境隔离**：精准识别官方 `installers/bin/codearts.exe`，采用独立 `cli-data` 隔离目录与独立会话数据库，不再与 IDE GUI AgentKernel 混淆；继承外部认证并保持 TLS 校验；将“文件夹未被信任”准确归类为 `CODEARTS_PERMISSION_REQUIRED` 脱敏提示。
  - **Linux 进程生命周期与资源回收加固**：驱动与 Hub 统一进程组管理，确保任务取消与超时时彻底回收所有后代进程，杜绝孤立进程残留。

| 验证项目 | 实际结果 | 状态说明 |
| --- | --- | --- |
| Windows 回归测试 | ✅ 通过 (32组) | 2026-10-10 跟进修复后完整复测通过，包含真实 SDK 0.1.21 协议验证；非全量付费模型实测证明 |
| Linux 回归测试 | ✅ 通过 (29组) | 同一冻结源码完整复测通过，包含真实 SDK 0.1.21 协议验证；非全量付费模型实测证明 |
| Linux 生产 Hub 0.9.9 | ✅ 通过 | 暴露 24 个 Hub 工具与 9 种 worker，已有配置、任务历史与鉴权平滑保留 |
| Linux Antigravity CLI 1.3.1 | ✅ 真实调用通过 | gemini-3.8-flash-medium 精确标记通过，插件模式校验通过（4技能/9代理/1MCP）；真实模型调用 `hub_status` 成功返回 9 种 worker，完整原生子代理 `hub-mimocode` 派发成功（返回 `ref=mimocode-79e2416c91`，`completed`，`answer=95`） |
| Linux ZCode CLI 0.16.9 | ✅ 真实调用通过 | 原生 `agenthub-workers:mimocode` 子代理经插件派发，原 ref 续查返回 `73` |
| Windows Codex / ZCode | ✅ 真实调用通过 | 两种原生子代理分别返回 `2117`、`2077`；初轮长标记回答不完整的记录也保留 |
| Windows DSH | ⚠️ 账号余额受阻 | 10 个预设、7 个 MCP 工具及工作流注册通过；实际模型调用返回 `402 ACCOUNT_QUOTA` |
| Windows Antigravity | ✅ 真实调用通过 | 修复本地 client.json 缺失与 MCP 连接动态重试机制；实测通过 hub_status / hub_capabilities 实时返回 9 种 Worker 在线与能力状态 |
| Linux Codex & DSH CLI | ❌ 未安装 (not_installed) | Linux 实机未找到 CLI 可执行文件，未执行实测，不作通过宣称 |
| CodeArts 原生组件与通道 | ✅ 通过 | Windows 正式内核识别组件；Linux CLI 原生文件及 MCP 已安装校验通过；Windows ↔ Linux 局域网直连与 SSH 通道建立正常 |
| Windows CodeArts IDE | ⚠️ 原生派发通过，结果回收受权限限制 | DeepSeek v4.1 Flash 真实调用 `hub-mimocode`，唯一回执 `mimocode-d5f1337f8a`；Linux 实际答案为 `45`，但 IDE 后续 `hub_fetch` 被宿主拒绝，不计为完整验收 |
| Linux CodeArts 自身模型调用 | ✅ 官方模型真实任务秒级通过 | 自动加载凭据环境；显式 GLM-5.2 与 GLM-5.2-ArkTS-SPARK 派发秒级返回完成，回执真实有效，核验 driver 与 CLI 共用进程组，完成后所属进程全部安全退出 |
| Windows 独立 CodeArts CLI | ⚠️ 尚未通过模型验收 | 已修复官方 exe 发现及 CLI 专用配置；独立目录探针受到文件夹信任限制，不替代已登录 IDE 的使用状态 |

> **边界与差异说明**：
> 1. **回归测试 ≠ 全量付费实测**：Windows 32 组与 Linux 29 组回归通过为框架逻辑与离线回归，不能视为每个服务商、模型或原生宿主均已跑通真实付费任务。
> 2. **原生插件 vs 可选 Python SDK**：Antigravity 原生插件基于声明式配置直接接入 MCP 桥与子代理，已跑通真实模型调用与原生子代理派发；而可选 Python SDK 为外部编排库，当前 wheel 无 `beta.run_workflow`，且其 API 鉴权与宿主登录隔离。
> 3. **实机未安装环境如实报告**：Linux 实机未安装 Codex 与 DSH CLI，标记为 `not_installed`，不虚报通过。
> 4. **CodeArts 鉴权与调用边界**：IDE 登录不代表独立 CLI 具备调用条件，已有 9router 登录也不能替代华为账号权限。当前 worker 仅开放默认思考与非流式文本；未生效的配置不会替换用户原默认模型。
> 5. **本地与网络隐私**：客户端选定单个 Hub 并非跨 Hub 联邦；提示词与附件在调用对应 worker 时仍会发送至官方模型服务商。

完整任务回执、源码哈希、失败记录及修复后两端各 83 项增量检查见 [0.9.9 验收记录](docs/release-0.9.9.md)。

CodeArts 的 IDE 优先适配、官方认证修复及后续测试见 [2026-10-10 跟进记录](docs/codearts-ide-followup.md)。这些修复属于发布后跟进，原 `v0.9.9` 标签及已构建 ZIP 保留原内容。

示例：仅安装 CodeArts 客户端并连接远端 Hub：

```powershell
# Windows
.\install.cmd --component plugins --native-hosts codearts --project C:\Work\my-project --url http://SERVER:8765/mcp --token-file C:\private\hub-token.txt
```

```bash
# Linux
./install.sh --component plugins --native-hosts codearts --codearts-target cli --url http://SERVER:8765/mcp --token-file /private/hub-token.txt
```

*注：IDE 的 `--project` 应指向实际打开的工作区，亦可用 `--codearts-ide-settings` 指定 MCP 配置文件。未指定时会自动标为待配置。安装完成后请重载 IDE 或重启 CLI。详见 [CodeArts 原生包文档](integrations/codearts/README.md)。*

### CodeArts 换工作区后连接 Hub

CodeArts IDE (26.9.501) 按当前工作区加载 `.codeartsdoer/mcp/mcp_settings.json`。切换新项目时，无需重新输入 Hub Token 或启动本机 Hub，直接复用外部 `client.json` 即可一键登记：

```powershell
# 针对当前新工作区登记 IDE MCP 设置
python integrations/codearts/install.py --config "$env:LOCALAPPDATA/AgentHub/client.json" --ide-settings "C:/Work/new-project/.codeartsdoer/mcp/mcp_settings.json" --target ide --apply
```

登记后在 IDE 中执行“开发人员：重新加载窗口”，即可通过 `/hub-status` 验证连接与 Worker 可用性。详见 [CodeArts 原生包文档](integrations/codearts/README.md#换工作区后连接-hub)。

---

## 安装包选择

项目提供三种独立的预打包 ZIP，均内置本机与局域网 Hub 自动发现机制，各组件可在同一台或不同机器按需组合部署：

| 安装包 | 适用环境 | 包含内容 |
| --- | --- | --- |
| **agenthub-0.9.9-plugins.zip** | 编写代码的客户端机器（运行 Codex / ZCode / DSH / CodeArts / Antigravity） | 5 种客户端原生插件、MCP 桥接器、子代理与工作流（不启动本地 Hub） |
| **agenthub-0.9.9-hub.zip** | 运行各模型 CLI / worker 的服务端机器（Windows / Linux） | Python Hub 服务、9 种 Worker 适配驱动、可选网页控制台 |
| **agenthub-0.9.9-both.zip** | 客户端与 Worker 均在同一台机器运行 | 包含 plugins 与 hub 的完整组件集合 |
| **multi-agent-hub-0.9.9.carts / .vsix** | 华为 CodeArts IDE、VS Code 及兼容编辑器 | 桌面端图形扩展：一键导入、侧边栏面板、状态指示灯及工作区 MCP 自动注入 |

- **运行依赖**：
  - 安装器与 Hub 服务需要 **Python 3.8+**；Codex 项目代理安装需要 **Python 3.11+**，可选 Antigravity SDK 需要 **Python 3.10+**。
  - 插件 MCP 桥及可选网页控制台需要 **Node.js 20+**（桌面 WebSocket 驱动建议 Node.js 22+）。
  - 各 Worker 依赖官方对应 CLI 及其官方登录凭据（安装器仅做环境诊断，不包含账号注册与自动登录）。

解压后，Windows 双击 **install.cmd**，Linux 执行 **bash install.sh**。安装器自动识别环境、官方 CLI 并安装到稳定目录，配置与数据隔离在源码包外部，重复安装会自动备份并保留配置。安装包目前为本地构建，尚未上传 GitHub Release 附件。完整参数说明见[安装说明](packaging/README.md)。

---

## 快速上手与部署

### 1. 本机单机部署（Both）

使用 `both` 包解压后，一键完成插件安装并立即启动本地 Hub：

```powershell
# Windows（包含网页控制台）
.\install.cmd --component both --with-console
```

```bash
# Linux（包含网页控制台）
bash install.sh --component both --with-console
```

- **服务控制**：后续可在安装目录中通过 `start.cmd / start.sh`、`stop.cmd / stop.sh`、`status.cmd / status.sh` 管理后台服务；若仅安装不自启可加 `--no-start`。
- **能力检查**：在各宿主中调用 `hub_capabilities` 可查看各 Worker 可用性，调用 `hub_login` 可获取官方授权指引与登录状态。

---

### 2. Windows 与 Linux 分离部署

当 Hub 运行在 Linux 服务器、客户端运行在 Windows（或反之）时：

#### 步骤 A：服务端启动 Hub（以 Linux 为例）

```bash
# 解压 hub 包，指定监听局域网地址与端口
bash install.sh --component hub --bind 0.0.0.0 --port 8765
```
*注：非回环地址监听必须鉴权。安装器会在外部配置目录生成 `hub-token.txt`。*

#### 步骤 B：客户端安装插件并连接（以 Windows 为例）

首次安装 plugins 包且未配置连接时，安装器会自动扫描局域网与本机 Hub 并列出候选列表：

```powershell
# 解压 plugins 包，指定目标 Hub 地址与 Token 文件
.\install.cmd --component plugins --url http://SERVER_LAN_IP:8765/mcp --token-file C:\private\hub-token.txt
```

- **重新连接 / 切换 Hub**：后续可直接运行安装目录中的 `connect.cmd`（Linux：`./connect.sh`）重新发现并切换目标 Hub，或在客户端中输入 `/hub-discover` 查看候选（五种宿主均可调用 `hub_discover` 工具）。
- **局域网发现机制**：基于 UDP 18766 广播与无凭据 HTTP 健康检查，安全不泄露 token；设置 `AGENTHUB_DISCOVERY=0` 可关闭服务端响应。
- **客户端连接配置**：统一保存在外部 `client.json`（Windows: `%LOCALAPPDATA%\AgentHub\client.json`，Linux: `~/.config/agenthub/client.json`），支持通过环境变量 `AGENTHUB_CONFIG` 自定义。
- **SSH 反向通道**：若两台机器无法直连局域网，可通过 SSH 建立反向端口映射（例如 Windows 执行 `ssh -N -R 127.0.0.1:18765:127.0.0.1:8765 SERVER_SSH`），实现跨网安全通信。
- **Linux 常驻服务**：Linux Hub 可指定 `--systemd-user` 注册为用户级 systemd 服务。

---

## Web 控制台与管理大盘 (Console & WebUI)

Hub 提供内置的轻量化现代 Web 管理大盘（在安装或启动时指定 `--with-console` 即可开启，默认运行在 Node.js 服务端口 `8890`）：

- 🔘 **Worker 一键激活/禁用开关 (Subagent Toggle Switch)**：每个 Worker 卡片内置原生启用切换开关。当某个模型服务商无额度、账号欠费或处于维护调试期时，可随时一键关闭该子代理；状态即时持久化落盘至 `agents.json` 并通过 Hub 调度器向全端生效。
- ⚡ **权威状态双向同步与免派发拦截**：禁用的 Worker 在 `hub_status` 中明确显示为 `[已禁用]`，`hub_capabilities` 返回 `enabled: false`，在派发任务（`hub_dispatch` / `hub_ask`）时触发秒级前置快速拦截（`profile_disabled`），杜绝因误调用产生无谓等待与额度报警。
- 🎛️ **监控状态栏自定义面板**：底部状态栏新增自定义指标控制面板，支持一键呼出多选面板，按需勾选或隐藏实时监控项（包括子代理、模型、网络延时、吞吐 TPS、会话 Token、平台额度等），配置自动持久化至本地存储。
- ⚙️ **模型选型与思考强度抽屉**：点击状态栏模型标签即可平滑呼出参数面板；子代理运行参数全面升级为平滑的思考强度（`low` / `medium` / `high` / `max`）分级控制，解除阻塞式单开关限制。
- 🏷️ **官方积分倍率与福利标识**：深度适配 TraeCode、CodeBuddy-CN 等平台的积分倍率显示，直观呈现 `0.06x ~ 2.00x` 换算比率，以及 `[会员 5 折]`、`[限时 1 折]`、`[专属补贴]` 等专属视觉标签。
- 💳 **实时额度与通道余额监控**：支持自动解析并呈现 MiniMax、9router 等上游通道的剩余积分与调用配额。

---

## 统一工具与能力约束

宿主插件对外统一暴露 **7 个 MCP 核心工具**：
`hub_ask`、`hub_dispatch`、`hub_fetch`、`hub_status`、`hub_capabilities`、`hub_login`、`hub_discover`。

所有宿主（Codex 代理/技能、ZCode 代理、DSH 预设/工作流、CodeArts 子代理、Antigravity 技能/代理）遵循同一套任务契约：

| Worker | 默认配置模型 | 平台特性、目录收敛与倍率规则 |
| --- | --- | --- |
| **Antigravity** | gemini-3.8-flash-medium | 精简保留 3.8 Flash (High/Medium)、3.1 Pro High、Claude 4.6 (Sonnet/Opus) 等 6 款旗舰；支持多模态与标准工作流（作为 Worker 角色；Antigravity 原生客户端为宿主角色） |
| **CodeBuddy** (国内版) | deepseek-v4.1-flash (x0.11) | 剔除生图及老旧模型，精炼至 DeepSeek V4.1/Pro、MiniMax-M3、GLM-5.3/5.2/5.1、Kimi-K3/K2.8/K2.7、混元系列等 13 款代码模型，完整标注官方积分倍率（x0.06 ~ x2.00）与试用标 |
| **CodeBuddy** (国际版) | deepseek-v4.1-flash | 精简收敛至 18 款主流高可用模型；文件工具需实际权限，使用标准代理隔离上下文 |
| **GitHub Copilot** | auto | 沿用官方 CLI 选型 |
| **MiMo** | xiaomi/mimo-v2.6-flash (26f) | 精炼收敛为 MiMo-V2.6 Flash/Pro/UltraSpeed 及 9router/trae 通道共 4 款高效选型 |
| **MiniMax** | MiniMax-M3.1-Flash-Preview | 精简收敛为 M3.1 Flash（512K/1M）与 M3（1M 上下文）当季双旗舰；支持 9router 通道积分余额展示 |
| **TraeCode** | GLM-5.3-FlashX (0.31x) | 精简收敛至 20 款官方模型，精准标注 `0.06x ~ 1.50x` 官方积分倍率与 `[会员 5 折]`、`[限时 1 折]`、`[专属补贴]` 营销标识 |
| **ZCode** | GLM-5.3-Flash | 显式思考切换与未验证正文流式默认禁用 |
| **CodeArts** | GLM-5.2 (0.70x) | 完整保留 4 款企业级官方模型（`GLM-5.2`、`GLM-5.2-ArkTS-SPARK`、`OpenPangu-2.0-Pro`、`OpenPangu-2.0-Flash`）；支持 Linux CLI 自动加载 AK/SK、IDE 动态工具协议与独立数据隔离 |

上表是新安装的默认配置。已有服务器保留原模型；本轮 Linux MiMo 实测使用其既有 `9router/trae`，不代表 `26f` 已实测。

- **输入文件限制**：`files` 参数传输客户端本地文件内容并在 Hub 端暂存，限制最多 8 个文件、总量不超过 1 MiB。
- **工作目录说明**：`cwd` 指 **Hub 所在主机**的工作目录，不会静默映射客户端路径。
- **结果与任务跟踪**：任务受理后返回持久化 `ref`，客户端凭 `ref` 通过 `hub_fetch` 轮询结果，无需重复派发。Hub 拒绝空回答、已知超时及未完成的工具协议；`completed` 表示任务执行完成，答案是否正确仍需调用方按任务要求验收。
- 更多详细参数规范见 [任务选项说明文档](docs/task-options.md)。

---

## 数据流向与安全规范

- **真实数据链路**：`宿主客户端 → 本地 MCP 桥 → 目标 Hub → 官方 CLI / 内核 → 模型服务商 API`。
- **透明无隐瞒**：自托管 Hub 仅作为任务路由与执行代理，不代表离线私有模型；提示词与附件会随官方 CLI 调用发往各服务商。
- **安全凭据隔离**：客户端与服务端的认证 Token、各厂商 API Key、会话数据均存放在仓库源码之外的独立安全目录中，绝不签入 Git。
- **传输安全**：HTTP Bearer Token 仅负责身份鉴权；在跨公网或不可信网络通信时，务必配合 HTTPS 反向代理、VPN 或 SSH 隧道进行链路加密。

---

## 版本演进与开发调试

当前 0.9.9 体验优化版本持续推进连接引导、失败原因诊断和状态平滑恢复：

![multi-agent-hub 0.9.9 进度图：当前重点优化体验，展示已有基础、后续优化、版本演进和实际验证范围](docs/roadmap.svg)

### 离线回归与安全检查

```bash
# 克隆仓库
git clone https://github.com/Johhny-Xu/multi-agent-hub.git
cd multi-agent-hub

# 执行全量隔离回归测试（不产生真实模型费用）
python tests/run_regressions.py --report docs/local-validation.json

# 扫描源码凭据泄漏风险
python scripts/audit_secrets.py --history

# 构建分发包（输出至仓库外部）
python packaging/build.py --output ../agenthub-releases
```

---

## 关联文档与导航

- [CodeArts 双向接入、任务实测与认证边界](docs/codearts-compatibility.md)
- [CodeArts IDE 优先适配与实测跟进](docs/codearts-ide-followup.md)
- [CodeArts 接入已有模型路由](docs/codearts-custom-provider.md)
- [Antigravity 原生插件与可选 SDK](integrations/antigravity/README.md)
- [网络自动发现与配对验收报告 (v0.8)](docs/release-0.8.md)
- [独立安装包与分发说明](packaging/README.md)
- [统一任务选项与参数定义](docs/task-options.md)
- [版本历史与检查点记录](docs/version-history.md)
- [版本更新日志](CHANGELOG.md)
- [Codex 插件与子代理集成](integrations/codex/README.md)
- [ZCode 原生插件集成](plugins/agenthub-workers/README.md)
- [DSH 预设与工作流集成](integrations/dsh/README.md)
- [CodeArts 原生插件与命令集成](integrations/codearts/README.md)
- [CodeArts IDE & VS Code 桌面扩展 (CARTS / VSIX)](integrations/vscode/README.md)

---

## 开源协议

本项目遵循 [MIT License](LICENSE)。
