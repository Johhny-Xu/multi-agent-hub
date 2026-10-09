# multi-agent-hub

![multi-agent-hub 0.9 结构图：四种原生客户端经 MCP 连接 Windows 或 Linux Hub，调度九种 worker；支持同机、跨机与双向连接](docs/architecture.svg)

**multi-agent-hub** 是一个面向多开发环境的 AI Agent 统一调度中枢。它基于标准 MCP 协议、原生插件与子代理体系，让开发者能够在 **Codex**、**ZCode**、**DeepSeek Harness (DSH)** 与**华为 CodeArts** 等客户端之间，跨平台、跨机器无缝调度各端 worker（官方 CLI 与内核）。

当前源码版本为 **0.9.1**，本阶段重点在于**使用体验深度优化**：连接选择更直观、能力与失败原因清晰可见、安装升级安全保护已有配置，并支持 CodeArts 双向接入与调度。
*(注：源码标签历史演进为 v0.5.0 → v0.6.0 → v0.7.0 → v0.8.0，安装包已在本机构建并校验。)*

---

### ✨ 核心亮点

- 🔌 **4 种原生宿主客户端**：深度适配 Codex、ZCode、DeepSeek Harness、CodeArts，提供原生子代理、斜杠命令与工作流。
- 🤖 **9 种 Worker 统一适配**：标准契约调度 Antigravity、CodeBuddy（国际/国内版）、GitHub Copilot、MiMo、MiniMax、TraeCode、ZCode、CodeArts。
- 🔄 **灵活多样的部署形态**：插件与 Hub 支持同机共存或分离部署；支持纯 Windows、纯 Linux 及 Windows ↔ Linux 跨机连接（局域网直连或 SSH 反向通道）。
- 🛡️ **严格能力预检与终态判定**：根据模型真实能力动态约束思考、流式与附件；严格判定任务终态，空响应或异常退出绝不误报成功；自带派发递归保护。
- 🔍 **智能发现与平滑切换**：局域网与本机 Hub 自动广播扫描；连接配置与凭据独立于源码，平滑升级不丢失历史任务数据。

---

## CodeArts 接入与实测状态

CodeArts 原生包包含 **9 个子代理、3 个斜杠命令、1 个调度技能、1 个 Hooks 插件和 7 个 MCP 工具**。在 CodeArts 中可直接唤起 `@hub-mimocode` 等子代理，或执行 `/hub-status`、`/hub-discover`、`/hub-login`；其他宿主向 CodeArts 派发任务时指定 `worker="codearts"`（兼容别名 `ca`、`huawei-codearts`）。

| 验证项目 | 实际结果 | 状态说明 |
| --- | --- | --- |
| Windows CodeArts 原生组件 | ✅ 通过 | 正式内核识别代理、命令、技能与插件入口；配置生效需重载 IDE 窗口 |
| Linux CodeArts 环境 | ✅ 通过 | 官方 CLI 原生文件及 MCP 已安装校验通过（当前未配置图形 IDE 本体） |
| CodeArts MCP 桥 → 其他 Worker | ✅ 通过 | Linux 环境单次派发 MiMo 成功，实际返回 `42`（证明 MCP 桥路由畅通） |
| Windows → Linux 跨机连接 | ✅ 通过 | 局域网通信正常；CodeArts 任务准确捕获并返回认证失败原因 |
| Linux → Windows 跨机连接 | ✅ 通过 | SSH 反向回环通道建立成功；CodeArts 任务准确返回 provider 未就绪 |
| CodeArts 自身模型调用 | ⚠️ 待配置 | **尚未通过**：Windows 独立内核缺 provider，Linux 非交互 CLI 缺 AK/SK 认证凭据 |

> **边界说明**：IDE 已登录不代表后台独立 CLI 已具备非交互模型调用条件。当前 CodeArts worker 仅开放默认思考与非流式文本任务，关闭文件、图片及显式思考开关。组件安装和 MCP 派发验收通过，亦不能证明 CodeArts 编排模型已自主调用工具。完整验收数据与认证配置说明详见 [CodeArts 接入说明](docs/codearts-compatibility.md)。

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

---

## 安装包选择

项目提供三种独立的预打包 ZIP，均内置本机与局域网 Hub 自动发现机制，各组件可在同一台或不同机器按需组合部署：

| 安装包 | 适用环境 | 包含内容 |
| --- | --- | --- |
| **agenthub-0.9.1-plugins.zip** | 编写代码的客户端机器（运行 Codex / ZCode / DSH / CodeArts） | 4 种客户端原生插件、MCP 桥接器、子代理与工作流（不启动本地 Hub） |
| **agenthub-0.9.1-hub.zip** | 运行各模型 CLI / worker 的服务端机器（Windows / Linux） | Python Hub 服务、Worker 适配驱动、可选网页控制台 |
| **agenthub-0.9.1-both.zip** | 客户端与 Worker 均在同一台机器运行 | 包含 plugins 与 hub 的完整组件集合 |

- **运行依赖**：
  - 安装器与 Hub 服务需要 **Python 3.11+**（Codex 项目代理安装最低需要 Python 3.11）。
  - 插件 MCP 桥及可选网页控制台需要 **Node.js 20+**（桌面 WebSocket 驱动建议 Node.js 22+）。
  - 各 Worker 依赖官方对应 CLI 及其官方登录凭据（安装器仅做环境诊断，不包含账号注册与自动登录）。

解压后，Windows 双击 **install.cmd**，Linux 执行 **bash install.sh**。安装器自动识别环境、官方 CLI 并安装到稳定目录，配置与数据均隔离在源码包外部，重复安装会自动备份并保留配置。完整参数说明见[安装说明](packaging/README.md)。

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

- **重新连接 / 切换 Hub**：后续可直接运行安装目录中的 `connect.cmd`（Linux：`./connect.sh`）重新发现并切换目标 Hub，或在客户端中输入 `/hub-discover` 查看候选（四种宿主均可调用 `hub_discover` 工具）。
- **局域网发现机制**：基于 UDP 18766 广播与无凭据 HTTP 健康检查，安全不泄露 token；设置 `AGENTHUB_DISCOVERY=0` 可关闭服务端响应。
- **客户端连接配置**：统一保存在外部 `client.json`（Windows: `%LOCALAPPDATA%\AgentHub\client.json`，Linux: `~/.config/agenthub/client.json`），支持通过环境变量 `AGENTHUB_CONFIG` 自定义。
- **SSH 反向通道**：若两台机器无法直连局域网，可通过 SSH 建立反向端口映射（例如 Windows 执行 `ssh -N -R 127.0.0.1:18765:127.0.0.1:8765 SERVER_SSH`），实现跨网安全通信。
- **Linux 常驻服务**：Linux Hub 可指定 `--systemd-user` 注册为用户级 systemd 服务。

---

## 统一工具与能力约束

宿主插件对外统一暴露 **7 个 MCP 核心工具**：
`hub_ask`、`hub_dispatch`、`hub_fetch`、`hub_status`、`hub_capabilities`、`hub_login`、`hub_discover`。

所有宿主（Codex 代理/技能、ZCode 代理、DSH 预设/工作流、CodeArts 子代理）遵循同一套任务契约：

| Worker | 默认配置模型 | 平台特性与约束 |
| --- | --- | --- |
| **Antigravity** | gemini-3.8-flash-medium | 支持多模态与标准工作流 |
| **CodeBuddy** (国际 / 国内) | deepseek-v4.1-flash | 文件工具需实际权限，使用标准代理隔离上下文 |
| **GitHub Copilot** | auto | 沿用官方 CLI 选型 |
| **MiMo** | xiaomi/mimo-v2.6-flash (26f) | 高性价比推理与代码生成 |
| **MiniMax** | MiniMax-M3.1-Flash-Preview | 仅支持图文读取，不支持关闭思考与本地写文件 |
| **TraeCode** | GLM-5.3-FlashX | 快速代码辅助 |
| **ZCode** | GLM-5.3-Flash | 显式思考切换与未验证正文流式默认禁用 |
| **CodeArts** | 沿用官方 CLI 配置 | 需账号已授权可用模型，关闭文件与图片输入 |

- **输入文件限制**：`files` 参数传输客户端本地文件内容并在 Hub 端暂存，限制最多 8 个文件、总量不超过 1 MiB。
- **工作目录说明**：`cwd` 指 **Hub 所在主机**的工作目录，不会静默映射客户端路径。
- **结果与幂等跟踪**：任务受理后返回持久化 `ref`，客户端凭 `ref` 通过 `hub_fetch` 轮询结果；空回答、超时、模型拒绝、未执行的工具协议和算错答案均不计为成功，避免网络偶发抖动造成任务丢失或重复计费。
- 更多详细参数规范见 [任务选项说明文档](docs/task-options.md)。

---

## 数据流向与安全规范

- **真实数据链路**：`宿主客户端 → 本地 MCP 桥 → 目标 Hub → 官方 CLI / 内核 → 模型服务商 API`。
- **透明无隐瞒**：自托管 Hub 仅作为任务路由与执行代理，不代表离线私有模型；提示词与附件会随官方 CLI 调用发往各服务商。
- **安全凭据隔离**：客户端与服务端的认证 Token、各厂商 API Key、会话数据均存放在仓库源码之外的独立安全目录中，绝不签入 Git。
- **传输安全**：HTTP Bearer Token 仅负责身份鉴权；在跨公网或不可信网络通信时，务必配合 HTTPS 反向代理、VPN 或 SSH 隧道进行链路加密。

---

## 版本演进与开发调试

当前体验优化版本持续推进连接引导、失败原因诊断和状态平滑恢复：

![multi-agent-hub 0.9 进度图：当前重点优化体验，展示已有基础、后续优化、0.5 至 0.9 演进和实际验证范围](docs/roadmap.svg)

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
- [网络自动发现与配对验收报告 (v0.8)](docs/release-0.8.md)
- [独立安装包与分发说明](packaging/README.md)
- [统一任务选项与参数定义](docs/task-options.md)
- [版本历史与检查点记录](docs/version-history.md)
- [版本更新日志](CHANGELOG.md)
- [Codex 插件与子代理集成](integrations/codex/README.md)
- [ZCode 原生插件集成](plugins/agenthub-workers/README.md)
- [DSH 预设与工作流集成](integrations/dsh/README.md)
- [CodeArts 原生插件与命令集成](integrations/codearts/README.md)

---

## 开源协议

本项目遵循 [MIT License](LICENSE)。
