# multi-agent-hub

[English](README.en.md) · **简体中文**

> 一个本地多 AI Agent 调度枢纽：把散落在各处的 AI 编码 CLI 统一成一个可派活、可协作的 Worker 池。

![multi-agent-hub 结构图：任意 MCP 客户端接入、6 款原生深度宿主与零客户端 WebUI 独立管理，9 种 Worker 统一调度](docs/architecture.svg)

**当前版本：v1.0.0**（首个公开正式版） · 协议：[Apache-2.0](LICENSE) · 更新日志：[CHANGELOG.md](CHANGELOG.md)

---

## 目录

- [它能做什么](#它能做什么)
- [快速开始](#快速开始)
- [选择接入方式](#选择接入方式)
- [原生宿主插件](#原生宿主插件)
- [Worker 与默认模型](#worker-与默认模型)
- [统一 MCP 工具与任务契约](#统一-mcp-工具与任务契约)
- [Web 控制台](#web-控制台)
- [实测状态](#实测状态)
- [数据流向与安全](#数据流向与安全)
- [预打包文件](#预打包文件)
- [开发与测试](#开发与测试)
- [版本演进](#版本演进)
- [文档导航](#文档导航)
- [致谢](#致谢)

---

## 它能做什么

multi-agent-hub 基于标准 MCP 协议、原生插件与子代理体系，为 **9 种 AI 编码 Worker** 和 **6 款原生宿主**（外加任意 MCP 客户端）提供统一的任务派发、结果回传、配额监控、账号管理和 WebUI 管理大盘。

接入了 Hub 的任意 AI 客户端，都能把任务派给其他 AI 执行（各自走自己的账号额度），并共享任务队列、邮箱与笔记。

三种接入形态：

| 形态 | 适合谁 | 你需要做的 |
| --- | --- | --- |
| **任意 MCP 客户端直连** | Cursor、Claude Desktop、Windsurf、Cline / Roo Code、Continue 等 | 填一个 MCP URL |
| **6 款原生宿主深度适配** | Codex、ZCode、MiniMax Code（含 Claude Code / Agent Plugins 1.0）、DeepSeek Harness (DSH)、华为 CodeArts、Antigravity | 运行安装器，自动装好专属子代理 `hub-*.md`、技能与斜杠命令 |
| **零客户端独立使用** | 没有 IDE / AI 客户端时 | 打开内置的三栏式 WebUI，直接对话、派发与监控 |

**核心亮点**

- 🤖 **9 种 Worker，一套契约**：Antigravity、CodeBuddy（国际 / 国内）、GitHub Copilot、MiMo、MiniMax、TraeCode、ZCode、CodeArts。
- 🔌 **6 款原生宿主**：原生子代理、斜杠命令与工作流，上下文自动隔离，免手动配参数。
- 🔐 **WebUI 内完成 9 家 OAuth 登录**：免 SSH 授权、登出、多账号保存与秒切；以真实凭据落盘判定登录状态，不报假成功。
- ⚡ **Worker 一键启停，全端同步**：被禁用的 Worker 在派发前就被拦截（`profile_disabled`），不浪费额度。
- 🛡️ **严格的终态判定**：拒绝空回答、已知异常退出和超时后的半截回答；保留原任务 `ref`，禁止 Worker 给自己重复派发。
- 🔄 **灵活部署**：同机或分离部署；纯 Windows、纯 Linux、Windows ↔ Linux（局域网直连或 SSH 反向通道）均可。
- 🔍 **自动发现**：局域网 / 本机 Hub 广播扫描，配置恢复后 MCP 桥自动重连；配置与凭据独立于源码，升级不丢任务历史。
- 🖥️ **离线 Demo**：`demo.html` 单文件、零依赖，无需后端即可体验完整控制台。

---

## 快速开始

### 环境要求

- **Python 3.8+**（安装 Codex 原生插件需 3.11+）
- **Node.js 20+**（MCP 桥接与 Web 控制台）
- 各 Worker 对应厂商的**官方 CLI 及其登录态**（如 `agy`、`cb`、`trae`、`codearts`）。安装器只负责环境探测和指令调用，不包含账号注册与自动登录。

### 三步跑起来

```bash
# 1. 获取代码
git clone https://github.com/Johhny-Xu/multi-agent-hub.git
cd multi-agent-hub

# 2. 安装并启动 Hub + Web 控制台 + 本机已有宿主的原生插件
sh install.sh --with-console          # Windows：.\install.cmd --with-console

# 3. 打开控制台
#    http://localhost:8890
```

- 也可以从 [Releases](https://github.com/Johhny-Xu/multi-agent-hub/releases) 下载 `agenthub-1.0.0-both.zip` 解压后执行同样的命令。
- 在源码目录直接执行时，安装器会先在临时目录构建发行包再安装，无需手动打包。
- 日常启停：`sh start.sh` / `sh stop.sh`（Windows：`start.bat` / `stop.bat`）。
- 想先看看界面：直接用浏览器打开仓库里的 `demo.html`。

> 💡 用 `sh install.sh` 而不是 `./install.sh`，可以避免某些解压工具丢失执行位导致的 `Permission denied`。详见 [RUN_ON_LINUX.md](RUN_ON_LINUX.md)。

### 两个默认端口，别搞混

| 端口 | 服务 | 什么时候用 |
| --- | --- | --- |
| `8765` | **Hub**（`http://<host>:8765/mcp`，需要 Token） | 原生插件、跨机连接 |
| `8890` | **Web 控制台**（需 `--with-console`） | 浏览器管理大盘 |
| `8790` | **控制台内置的子代理 MCP 端点**（`http://127.0.0.1:8790/mcp`，随控制台启动） | 通用 MCP 客户端免插件直连 |

---

## 选择接入方式

### 方案零：一句话交给你的 AI 自动安装（推荐）

把下面对应的一句话复制给你正在用的 AI 助手，它会自动克隆、安装并配置。

<details>
<summary><b>原生宿主通用版</b>（Antigravity / CodeArts / ZCode / Codex / DSH / MiniMax Code）</summary>

```text
请帮我克隆 https://github.com/Johhny-Xu/multi-agent-hub.git 到本地，阅读其中的 README.md，根据我当前所在的客户端环境执行对应的 install.cmd（Windows）或 sh install.sh（Linux/macOS）完成 Multi-Agent Hub 服务与当前客户端原生深度插件（子代理、Skills 与 MCP 桥）的安装配置，并调用 hub_status 验证连接状态。
```
</details>

<details>
<summary><b>分客户端精准版</b></summary>

- **Google Antigravity**
  ```text
  请帮我克隆 https://github.com/Johhny-Xu/multi-agent-hub.git，运行 install.cmd（Linux 用 sh install.sh）并指定 --native-hosts antigravity，把 Multi-Agent Hub 原生插件与 9 个 hub-* 子代理安装到 ~/.gemini/config/plugins/multi-agent-hub 并启动 Hub 服务。
  ```
- **华为 CodeArts（IDE / CLI）**
  ```text
  请帮我克隆 https://github.com/Johhny-Xu/multi-agent-hub.git，为当前工作区执行 install.cmd --native-hosts codearts --project <当前项目路径>（Linux 用 sh install.sh），完成 Multi-Agent Hub 服务与当前工作区 .codeartsdoer/mcp/mcp_settings.json 及专属子代理的自动注册。
  ```
- **MiniMax Code（`mcode`）/ Claude Code**
  ```text
  请帮我克隆 https://github.com/Johhny-Xu/multi-agent-hub.git，启动其中的 Multi-Agent Hub 服务，并将仓库内的 plugins/agenthub-workers 目录作为原生插件（含 .minimax-plugin/plugin.json、.claude-plugin/plugin.json、hub-bridge.mcp.json 与 dispatch-hub 技能）加载配置到当前客户端中。
  ```
- **ZCode（IDE / CLI）**
  ```text
  请帮我克隆 https://github.com/Johhny-Xu/multi-agent-hub.git，运行 install.cmd --native-hosts zcode（Linux 用 sh install.sh），将 plugins/agenthub-workers 原生插件（含 9 个外部 Worker 子代理与 MCP 桥）注册到我的 ZCode 环境中并启动 Hub。
  ```
- **OpenAI Codex**
  ```text
  请帮我克隆 https://github.com/Johhny-Xu/multi-agent-hub.git，针对当前项目工作区运行 install.cmd --native-hosts codex --project <当前项目路径>（Linux 用 sh install.sh），自动配置 Codex 原生插件市场与 .codex/agents/ 路由规则。
  ```
- **DeepSeek Harness（DSH）**
  ```text
  请帮我克隆 https://github.com/Johhny-Xu/multi-agent-hub.git，运行 install.cmd --native-hosts dsh（Linux 用 sh install.sh）或通过 dsh plugin add file:./integrations/dsh 挂载原生预设与工作流插件。
  ```
</details>

<details>
<summary><b>通用 MCP 客户端版</b>（Cursor / Windsurf / Claude Desktop / Cline / Roo Code / Continue）</summary>

已有运行中的 Hub 与控制台：

```text
请帮我在当前客户端的 MCP 配置文件中添加名为 "multi-agent-hub" 的 Streamable HTTP MCP 服务，URL 为 http://127.0.0.1:8790/mcp（若为局域网服务器请替换为对应 IP），配置完成后调用 subagent_agents 工具查看当前可用的外部子代理列表。
```

从零开始：

```text
请帮我克隆 https://github.com/Johhny-Xu/multi-agent-hub.git，执行里面的 install.cmd --with-console（Linux 用 sh install.sh --with-console）启动 Multi-Agent Hub 与 Web 控制台服务（:8890 / :8790），然后把 http://127.0.0.1:8790/mcp 自动写入我当前客户端的 MCP 配置文件中。
```
</details>

### 方案一：本机一键安装

适合在一台电脑上开发，希望一次配齐 Hub、控制台和已安装 IDE 的插件。按 [快速开始](#快速开始) 执行即可：安装器会自动检查环境，并探测注册本机上的 Codex、ZCode、DSH、CodeArts、Antigravity 原生插件与子代理。

### 方案二：任意 MCP 客户端免插件直连

适合 Cursor、Claude Desktop、Windsurf、Cline / Roo Code / Continue 等。先用 `--with-console` 启动控制台，然后二选一：

- 在控制台「子代理接入端点」卡片点 **【复制本文（发给Agent配置）】**，把提示词发给 AI，它会自己写好配置；
- 或手动写入：

```json
{
  "mcpServers": {
    "multi-agent-hub": { "url": "http://127.0.0.1:8790/mcp" }
  }
}
```

可用工具：`subagent_run`（服务端等结果，大产物落盘只回摘要，不占会话上下文）、`subagent_result`、`subagent_artifact`、`subagent_agents`。

### 方案三：跨机部署（服务端 + 个人电脑）

适合在家庭服务器、NAS 或云主机上集中运行 Hub 和 Worker，在另一台电脑上写代码。

```bash
# 服务端：监听局域网并开启控制台（会在外部配置目录自动生成随机令牌 hub-token.txt）
sh install.sh --component hub --bind 0.0.0.0 --port 8765 --with-console
```

```powershell
# 客户端：指定服务器与令牌完成配对
.\install.cmd --component plugins --url http://SERVER_IP:8765/mcp --token-file C:\private\hub-token.txt
```

- **自动发现**：客户端不指定 `--url` 时会 UDP 广播扫描局域网内的 Hub，交互选择即可。
- **切换 Hub**：之后随时运行 `connect.cmd`（Linux：`sh connect.sh`）。
- **不在同一局域网**：用 SSH 反向通道，例如 `ssh -N -R 127.0.0.1:18765:127.0.0.1:8765 user@SERVER`。
- **Linux 常驻**：加 `--systemd-user` 注册为用户级 systemd 服务（该模式仅支持 Hub，不含控制台）。

### 方案四：只给某一个宿主装插件

见下一节 [原生宿主插件](#原生宿主插件)。

---

## 原生宿主插件

| 宿主 | 安装方式 | 说明文档 |
| --- | --- | --- |
| **华为 CodeArts / VS Code** | IDE 扩展面板「从 VSIX/CARTS 安装」导入 `multi-agent-hub-1.0.0.carts` / `.vsix`；或 `.\install.cmd --component plugins --native-hosts codearts --project <工作区>` | [codearts](integrations/codearts/README.md) · [vscode](integrations/vscode/README.md) |
| **MiniMax Code / Claude Code** | 桌面端 / 云端导入 `agenthub-workers-1.0.0-minimax-plugin.zip`；CLI：`mcode --plugin-dir ./plugins/agenthub-workers` | [agenthub-workers](plugins/agenthub-workers/README.md) |
| **ZCode IDE / CLI** | `.\install.cmd --component plugins --native-hosts zcode`；或在 `zcode.json` 配置 `{"plugins":{"enabled":true,"dirs":[".../plugins/agenthub-workers"]}}` | [agenthub-workers](plugins/agenthub-workers/README.md) |
| **OpenAI Codex** | `.\install.cmd --component plugins --native-hosts codex --project <工作区>`，自动注册本地插件市场并把 9 个子代理写入 `.codex/agents/` | [codex](integrations/codex/README.md) |
| **DeepSeek Harness (DSH)** | `.\install.cmd --component plugins --native-hosts dsh --profile agenthub-client`；或 `dsh plugin --profile <PROFILE> add file:./integrations/dsh --ignore-scripts` | [dsh](integrations/dsh/README.md) |
| **Google Antigravity** | `.\install.cmd --component plugins --native-hosts antigravity`，安装到 `~/.gemini/config/plugins/multi-agent-hub`，重启生效 | [antigravity](integrations/antigravity/README.md) |

Linux 下把 `.\install.cmd` 换成 `sh install.sh` 即可。

<details>
<summary><b>Antigravity 补充说明</b></summary>

- 原生插件包含 `plugin.json`、9 个代理（`agents/*.md`）、4 个技能（`skills/*/SKILL.md`）及含 8 个桥接工具的 `mcp_config.json`。
- 可选 Python SDK 锁定 `google-antigravity==0.1.21`，提供强类型 `SubagentConfig` 与串并行编排。注意：已安装的 wheel 不含 `beta.run_workflow`；SDK 的 API 鉴权独立于 IDE/CLI 登录。
</details>

<details>
<summary><b>CodeArts 补充说明</b></summary>

包含 9 个子代理、3 个斜杠命令、1 个调度技能、1 个 Hooks 插件和 8 个 MCP 工具；既能作为客户端调度别人，也能作为 Worker 被调度（`worker="codearts"`，别名 `ca`、`huawei-codearts`）。

- **单一调用路径**：严格遵循 `tool_search → tool_describe → tool_call`；禁止在正文中直出 XML 标签，杜绝双重派发；单任务只派发一次，之后由客户端轮询。
- **权限与终态**：遇宿主权限拒绝时立即返回 `blocked_permission` 与原始 ref，不换工具名重试；只以非空的真实 Worker 回答判定 `completed`。
- **Windows CLI 识别**：精准识别官方 `installers/bin/codearts.exe`，使用独立 `cli-data` 目录与会话数据库，不与 IDE 混淆；“文件夹未被信任”归类为 `CODEARTS_PERMISSION_REQUIRED`。
- **Linux 进程回收**：驱动与 Hub 统一进程组，取消或超时时彻底回收后代进程。

仅安装 CodeArts 插件并连接远端 Hub：

```powershell
.\install.cmd --component plugins --native-hosts codearts --project C:\Work\my-project --url http://SERVER:8765/mcp --token-file C:\private\hub-token.txt
```

```bash
sh install.sh --component plugins --native-hosts codearts --codearts-target cli --url http://SERVER:8765/mcp --token-file /private/hub-token.txt
```

`--project` 应指向 IDE 实际打开的工作区，也可用 `--codearts-ide-settings` 指定 MCP 配置文件；安装后重载 IDE 或重启 CLI。

**换工作区后重新登记**（无需重新输入 Token，复用外部 `client.json`）：

```powershell
python integrations/codearts/install.py --config "$env:LOCALAPPDATA/AgentHub/client.json" --ide-settings "C:/Work/new-project/.codeartsdoer/mcp/mcp_settings.json" --target ide --apply
```

然后在 IDE 中执行“开发人员：重新加载窗口”，用 `/hub-status` 验证。详见 [CodeArts 原生包文档](integrations/codearts/README.md#换工作区后连接-hub)。
</details>

---

## Worker 与默认模型

| Worker | 默认模型 | 要点 |
| --- | --- | --- |
| **Antigravity** | gemini-3.8-flash-medium | 保留 3.8 Flash (High/Medium)、3.1 Pro High、Claude 4.6 (Sonnet/Opus) 等 6 款；支持多模态 |
| **CodeBuddy**（国内版） | deepseek-v4.1-flash (x0.11) | 13 款代码模型，标注官方积分倍率 x0.06 ~ x2.00；对齐 XDG 共享会话存储 |
| **CodeBuddy**（国际版） | deepseek-v4.1-flash | 18 款主流模型；文件工具需实际权限 |
| **GitHub Copilot** | auto | 沿用官方选型；支持 WebUI 设备码登录与 GNOME Keyring |
| **MiMo** | xiaomi/mimo-v2.6-flash (26f) | 4 款 V2.6 选型；API Key 与小米 OAuth 身份分离 |
| **MiniMax** | MiniMax-M3 | M3（1M 上下文）与 M3.1-Flash-Preview（512K）一键切换 |
| **TraeCode** | GLM-5.3-FlashX (0.31x) | 20 款官方模型，倍率 0.06x ~ 1.50x；双区 PKCE OAuth 与 TraeClaw 网关 |
| **ZCode** | GLM-5.3-Flash | 国内（BigModel）/ 国际（Z.ai）双区；`enc:v1:` AES-256-GCM 加密落盘 |
| **CodeArts** | GLM-5.2 (0.70x) | 4 款企业模型（GLM-5.2、GLM-5.2-ArkTS-SPARK、OpenPangu-2.0-Pro/Flash）；Linux CLI 自动加载 AK/SK |

上表是**新安装**的默认值；已有服务器会保留原模型配置。

---

## 统一 MCP 工具与任务契约

宿主插件通过 MCP 桥暴露 **8 个工具**：

| 工具 | 作用 |
| --- | --- |
| `hub_ask` | 派发并等待结果 |
| `hub_dispatch` | 只派发，立即返回 `ref` |
| `hub_fetch` | 凭 `ref` 查询结果 |
| `hub_status` | 查看 Worker 在线与启停状态 |
| `hub_capabilities` | 查询模型能力（思考 / 流式 / 附件） |
| `hub_login` | 查询或发起 Worker 登录 |
| `hub_discover` | 只读发现可用 Hub |
| `hub_set_status` | 启用 / 禁用某个 Worker（全端同步） |

所有宿主遵循同一套任务契约：

- **附件**：`files` 最多 8 个文件，总量不超过 1 MiB，在 Hub 端暂存。
- **工作目录**：`cwd` 指 **Hub 所在主机**的目录，不会自动映射客户端路径。
- **结果跟踪**：受理后返回持久化 `ref`，用 `hub_fetch` 轮询，不要重复派发。`completed` 只代表执行完成，答案是否正确仍需调用方验收。
- 完整参数见 [任务选项说明](docs/task-options.md)。

---

## Web 控制台

用 `--with-console` 启用，默认端口 `8890`。

| 能力 | 说明 |
| --- | --- |
| **三栏布局** | 极窄活动栏 + 平台会话树 + 沉浸式对话，右侧可折叠工作台；移动端改为底部导航 |
| **智能收展** | 顶栏、活动栏、侧栏随光标自动展开 / 收起；左上角品牌锚点可切换“自动收展 / 常驻”并记住选择 |
| **主题** | Mocha、Shell、Aurora、Dusk、Cyber、Grid 6 套预设，各有深 / 浅两种（共 12 种），通过 WCAG AA 对比度校准 |
| **自定义壁纸** | 上传壁纸后全局切换为毛玻璃半透明风格 |
| **子代理主题色** | 发送按钮、进度条与二级菜单跟随当前子代理品牌色 |
| **账号与额度** | 9 家 OAuth 登录、多账号秒切；实时额度监控（60s 缓存 + 并发合并） |
| **Worker 启停** | 卡片内开关，状态写入 `agents.json` 并全端生效 |
| **会话归档** | 跨平台聚合、筛选、搜索、一键复原，删除前二次确认 |
| **子代理 MCP 端点** | `:8790/mcp`，一键复制 URL 或“发给 Agent 的配置提示词” |
| **剪贴板兼容** | 局域网 IP（非安全上下文）下自动降级，复制始终可用 |

<details>
<summary><b>交互细节（给前端开发者）</b></summary>

- 品牌锚点 `#brand-logo-pin`（`z-index: 120`）永不隐藏；顶栏触发区 `Y ≤ 38px`、活动栏 `X ≤ 42px`，90ms 防误触展开、650ms 防抖收起；弹窗打开、输入聚焦或会话侧栏展开时保持常驻。
- 侧栏触发区为完整占位宽度（`1440px` 视口下 `X ≤ 324px`）；卡片单行化，按需挂载 `/api/chat/agent-summary` 摘要。
- 顶栏 `z-index: 100`、会话头 `z-index: 50` 独立层叠，下拉菜单不会被代码块或工作台截断。
- 毛玻璃：`body.has-custom-bg` 下 `backdrop-filter: blur(20px~24px) saturate(180%~190%)`；中性灰面统一为 `--gem-bg-card`，`--gem-surface-high` 仅用于交互态与进度条轨道。
- 子代理色 `--agent-accent` 贯通发送按钮、上下文进度条与 `#panel-chat` 二级菜单；模型名保持正文色 `--gem-text`。
- 状态栏整条可点击，弹出显示项配置（模型、延时、TPS、Token、额度）；模型抽屉支持思考档位与流式开关。
- 页脚右侧显示版本号 `v1.0.0`，可被后端 `snap.version` 覆盖。
- 离线 Demo：`scripts/build_demo.py` + `scripts/demo_engine.js` 生成 `demo.html` 与 `demo/index.html`。
</details>

---

## 实测状态

> **回归测试 ≠ 全量付费实测。** 下表的回归通过证明框架逻辑正确，不代表每个服务商、模型或宿主都已跑通真实付费任务。

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| Windows 回归 & DOM 断言 | ✅ 32 组 + 7 项 DOM | 见 `docs/refactor-validation.json`、`tests/console_layout_theme_dom.mjs` |
| Linux 回归 & 压测 | ✅ 29 组 + 4,500 余次压测 | 360 并发 0 报错；见 `docs/stage3-stress-report.json` 等 |
| Linux 生产 Hub | ✅ 通过 | 24 个 Hub 工具、9 种 Worker；配置、历史与鉴权平滑保留 |
| Linux Antigravity CLI 1.3.1 | ✅ 真实调用 | 原生子代理 `hub-mimocode` 派发成功 |
| Linux ZCode CLI 0.16.9 | ✅ 真实调用 | 原 ref 续查返回正确答案 |
| Windows Codex / ZCode | ✅ 真实调用 | 两种原生子代理均返回结果 |
| Windows Antigravity | ✅ 真实调用 | `hub_status` / `hub_capabilities` 返回 9 种 Worker |
| CodeArts 原生组件与通道 | ✅ 通过 | Windows ↔ Linux 局域网与 SSH 通道正常 |
| Linux CodeArts 自身模型 | ✅ 真实调用 | GLM-5.2 系列秒级完成，进程全部安全退出 |
| Windows DSH | ⚠️ 账号余额受阻 | 注册通过；模型调用返回 `402 ACCOUNT_QUOTA` |
| Windows CodeArts IDE | ⚠️ 部分通过 | 派发成功，但 IDE 后续 `hub_fetch` 被宿主拒绝 |
| Windows 独立 CodeArts CLI | ⚠️ 未通过模型验收 | 受文件夹信任限制 |
| Linux Codex & DSH CLI | ❌ 未安装 | 未执行实测，不作通过宣称 |

<details>
<summary><b>边界说明</b></summary>

1. **原生插件 vs 可选 SDK**：Antigravity 原生插件已跑通真实调用；可选 Python SDK 是外部编排库，当前 wheel 无 `beta.run_workflow`，鉴权与宿主登录隔离。
2. **CodeArts 鉴权**：IDE 登录不代表独立 CLI 可调用；其他服务的登录态不能替代华为账号权限。当前仅开放默认思考与非流式文本。
3. **隐私**：客户端选定单个 Hub 并非跨 Hub 联邦；提示词与附件仍会发送给对应模型服务商。

完整回执、源码哈希与失败记录见 [0.9.9 验收记录](docs/release-0.9.9.md)；CodeArts 后续跟进见 [2026-10-10 跟进记录](docs/codearts-ide-followup.md)。
</details>

---

## 数据流向与安全

- **数据链路**：`宿主客户端 → 本地 MCP 桥 → Hub → 官方 CLI / 内核 → 模型服务商 API`。
- **不是离线模型**：Hub 只做路由与执行代理，提示词和附件会随官方 CLI 发往各服务商。
- **凭据隔离**：Token、API Key 与会话数据都存放在源码目录之外，绝不入库。
- **传输安全**：Bearer Token 只负责鉴权；跨公网请配合 HTTPS 反向代理、VPN 或 SSH 隧道。
- 漏洞报告请见 [SECURITY.md](SECURITY.md)。

---

## 预打包文件

| 文件 | 适用场景 |
| --- | --- |
| `agenthub-1.0.0-both.zip` | 客户端与 Hub 在同一台机器（最推荐） |
| `agenthub-1.0.0-plugins.zip` | 只写代码的客户端电脑 |
| `agenthub-1.0.0-hub.zip` | 只跑 Worker 的服务器 |
| `agenthub-workers-1.0.0-minimax-plugin.zip` | MiniMax Code 桌面端 / 云端（Plugin V1 规范） |
| `multi-agent-hub-1.0.0.carts` / `.vsix` | 华为 CodeArts IDE、VS Code 及兼容编辑器 |

自行构建：`python packaging/build.py --output <仓库外目录> --component all`。完整参数见 [packaging/README.md](packaging/README.md)。

---

## 开发与测试

```bash
# 全量隔离回归（不产生模型费用）
python tests/run_regressions.py --report docs/local-validation.json

# 控制台 DOM / 主题 / 收展断言
node --test tests/console_layout_theme_dom.mjs

# 扫描源码与 Git 历史中的凭据泄漏
python scripts/audit_secrets.py --history

# 改了 console/client/index.html 后重建离线 Demo
python scripts/build_demo.py

# 构建分发包（输出到仓库外）
python packaging/build.py --output ../agenthub-releases
```

可选：安装下面两个依赖后，原本跳过的真实 SDK / CLI 用例也会执行：

```bash
pip install google-antigravity==0.1.21
npm i -g @openai/codex && export CODEX_TEST_BINARY=$(command -v codex)
```

贡献约定（提交前检查、提交信息规范）见 [CONTRIBUTING.md](CONTRIBUTING.md)，行为准则见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

---

## 版本演进

| 版本 | 重点 |
| --- | --- |
| **1.0.0** | 首个公开正式版：审计清理、致谢 TraeClaw、交接文档脱敏、补齐贡献者公约 |
| 0.9.9.9 | 重画架构图与进度图，补交接文档 |
| 0.9.9.8 | Node 20 WebSocket 兼容、登录与控制台路径发现、测试与宿主解耦；补齐贡献指南、安全政策与英文 README |
| 0.9.9.7 | 修复 Linux 源码安装链路：执行位丢失、源码目录直接安装、回环请求被代理劫持 |
| 0.9.9.3 ~ 0.9.9.6 | 9 Worker 登录状态检测重构；WebUI 体系化打磨、6 套主题、毛玻璃与智能收展 |

![multi-agent-hub 进度图](docs/roadmap.svg)

完整记录见 [CHANGELOG.md](CHANGELOG.md) 与 [版本历史](docs/version-history.md)。

---

## 文档导航

**入门与部署**
- [Linux 运行说明](RUN_ON_LINUX.md)
- [安装包构建与完整参数](packaging/README.md)
- [统一任务选项](docs/task-options.md)

**宿主集成**
- [Codex](integrations/codex/README.md) · [ZCode / MiniMax Code](plugins/agenthub-workers/README.md) · [DSH](integrations/dsh/README.md) · [Antigravity](integrations/antigravity/README.md)
- [CodeArts 原生插件](integrations/codearts/README.md) · [CodeArts IDE & VS Code 扩展](integrations/vscode/README.md)
- [CodeArts 双向接入与认证边界](docs/codearts-compatibility.md) · [CodeArts IDE 跟进](docs/codearts-ide-followup.md) · [CodeArts 接入已有模型路由](docs/codearts-custom-provider.md)

**版本与验收**
- [更新日志](CHANGELOG.md) · [版本历史](docs/version-history.md)
- [0.9.9 验收记录](docs/release-0.9.9.md) · [网络自动发现验收（v0.8）](docs/release-0.8.md)
- [开发交接记录](docs/HANDOVER_20261016.md)

---

## 致谢

- [LobeHub / Lobe Icons](https://github.com/lobehub/lobe-icons)：控制台与子代理头像使用的品牌 SVG 图标。
- [TraeClaw](https://github.com/firerlAGI/TraeClaw)：`trae_delegate` 通道所依赖的本地桥接与 CDP/DOM 自动化。
- Huawei CodeArts、Google Antigravity、Tencent CodeBuddy、GitHub Copilot、Xiaomi MiMo、MiniMax、ByteDance Trae、Z.ai 等官方 CLI 与开放生态。
- 所有提供反馈与建议的开发者。

## 开源协议

[Apache License 2.0](LICENSE)：允许使用、修改与分发；衍生作品须保留版权声明、许可证文本及修改说明。
