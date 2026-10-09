# Multi-Agent Hub

[中文](#中文) | [English](#english)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python 3.8+](https://img.shields.io/badge/Python-3.8+-green.svg)](https://www.python.org/)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![GitHub Repo](https://img.shields.io/badge/GitHub-all--in--one--agent--hub-blue)](https://github.com/Johhny-Xu/multi-agent-hub)

![Multi-Agent Hub 架构与数据流 / Architecture & Data Flow](docs/architecture.svg)

![Multi-Agent Hub 发展路线图 / Development Roadmap](docs/roadmap.svg)

---

## 中文

**Multi-Agent Hub** 将多个官方 CLI 和桌面代理接到本地任务总线，提供派发、状态查询、任务队列与会话控制台。各 worker 使用自己的官方账号和模型服务；调用厂商模型时，请求仍会发送到对应厂商。

本轮修复与适配见 [CHANGELOG.md](CHANGELOG.md)，Windows 实测见 [兼容性报告](docs/windows-compatibility.md)。

### 架构与核心组件

架构与数据流图见本 README 顶部（双语标注）：任务总线统一接收派发，异步 worker 落到各 CLI / 桌面代理执行，结果回写后由控制台总览。

三个组件相互协同：

- **hub/** —— **核心任务总线**（Python 标准库，零第三方依赖）。提供统一 JSON-RPC MCP 接口、共享任务队列、代理邮箱、共享笔记、心跳注册表与通用 CLI 派活；`async_worker.py` 负责异步任务执行与空闲回收（配合 `reap_idle.sh`），`vnc-watchdog.sh` 守护桌面会话。状态以文件形式保存在 `state/`，多进程可共享。
- **console/** —— **一体化 Web 控制台**。`server.mjs` 为 Node 后端（内置模块，零 npm 依赖），`client/index.html` 为轻量单页前端（CodeBuddy 风格三栏 UI），支持全平台会话记录流、实时模型配额、思维链折叠与手机端竖屏全自适应。
- **drivers/** —— **桌面驱动套件**（CDP 驱动脚本）。通过 Chrome DevTools Protocol (CDP) 驱动 VNC 中运行的 ZCode / TraeCode 桌面版客户端，让没有公开 API 的桌面 AI 也能自动接收任务并回传增量结果。

### 目录结构

```
multi-agent-hub/
├── start.sh                  # ⚡ Linux/macOS 一键拉起全部服务
├── stop.sh                   # ⏹ Linux/macOS 一键安全停止
├── start.bat                 # ⚡ Windows 一键启动
├── stop.bat                  # ⏹ Windows 一键停止
├── .env.example              # 根目录一体化配置文件示例
├── CHANGELOG.md              # 规范化版本更新日志
├── LICENSE                   # MIT 开源许可证
├── README.md                 # 双语使用与开发文档
├── hub/                      # 任务总线（MCP over HTTP / stdio）
│   ├── agent_hub.py          # 主服务：四工具联动枢纽 MCP Server
│   ├── async_worker.py       # 异步任务 worker
│   ├── trae_mcp_server.py    # Trae 侧 MCP 接入
│   ├── reap_idle.sh          # 空闲代理回收
│   ├── vnc-watchdog.sh       # VNC 桌面会话守护
│   ├── agents.example.json   # 智能体清单示例（复制为 agents.json 使用）
│   └── .env.example          # 子模块环境变量示例
├── console/                  # Web 控制台
│   ├── server.mjs            # Node 后端
│   ├── client/index.html     # 单页前端（三栏 UI + 移动端自适应）
│   ├── run.sh                # 控制台单独启动脚本
│   └── miniapp-api.ts        # 前端 API 类型定义
├── drivers/                  # 桌面驱动（CDP → VNC 桌面 AI）
│   ├── zcode_dom.js
│   ├── zcode_read.js
│   ├── dom_probe.js
│   ├── dom_probe_zcode.js
│   └── dom_read.js
├── integrations/             # 官方宿主客户端扩展与插件
│   ├── codex/                # Codex 本地插件、子代理与技能
│   └── dsh/                  # DeepSeek Harness (DSH) 插件与工作流
└── docs/                     # 架构设计图与品牌资产
    ├── architecture.svg
    └── logo.png
```

### ⚡ 快速开始（一键启动）

#### 依赖环境
- **Python 3.8+**（标准库，无需 pip 安装）
- **Node.js 20+**（控制台与 MCP 桥无需 npm install）；桌面 CDP 驱动使用原生 WebSocket，需 **Node.js 22+**。见 [Node 官方说明](https://nodejs.org/api/globals.html#websocket)。
- （可选）VNC + Chromium 系桌面 AI（仅使用 `drivers/` 驱动桌面客户端时需要）

#### Windows（🌟 官方首推 / 重点支持）
1. 将 `.env.example` 复制一份并重命名为 `.env`（本地回环直接使用默认值即可）；
2. 双击运行 **`start.bat`** 即可一键拉起任务总线与 Web 控制台！
3. 浏览器打开 **`http://localhost:8890/dashboard`** 即可进入一体化控制台；
4. 停止服务随时双击运行 **`stop.bat`**。

启动器会加载根目录 `.env`（其次为 `hub/.env`）、验证服务健康并保留配置端口。若 Python 命令只是 Windows Store 别名，可在 `.env` 设置 `HUB_PYTHON` 为实际 `python.exe` 路径。仅停止本目录记录且进程身份匹配的服务。

创建 worker 配置时可使用 [`hub/agents.windows.example.json`](hub/agents.windows.example.json)：把各 `cli` 中的 `C:/PATH/TO` 替换为官方 CLI 的稳定安装位置，只保留已安装的 worker，再保存为 `hub/agents.json`。npm 工具的实际安装根目录可用 `npm root -g` 查询。CodeBuddy 配置使用 `node + 官方入口脚本`，两版分别使用 `%USERPROFILE%/.codebuddy`、`%USERPROFILE%/.codebuddy-cn`；国内版设置 `CODEBUDDY_INTERNET_ENVIRONMENT=internal`。MiniMax 默认采用实测通过的 `MiniMax-M3.1-Flash-Preview`（别名 `m31flash`）。MiMo 默认模型为 `xiaomi/mimo-v2.6-flash`，别名 `v2.6f`。Trae 桌面通道仍需配置网关。

ZCode 独立 CLI 还需要把 `env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 改为桌面端已经生成的 `zcode-builtin.json` 路径，通常位于 `%USERPROFILE%/.zcode/v2/runtime/provider/windows-x86_64/<版本>/<目录>/zcode-builtin.json`。在 PowerShell 中用 `Get-ChildItem -LiteralPath "$env:USERPROFILE/.zcode/v2/runtime/provider/windows-x86_64" -Recurse -Filter zcode-builtin.json | Select-Object -ExpandProperty FullName` 仅列出文件路径，再填入模板中的 `C:/PATH/TO/zcode-builtin.json`；不要把该文件内容或凭据复制进仓库。

插件 v0.5.0 提供 `hub_login(worker, action="start"|"status"|"cancel")` 和 `/hub-login`：在 worker 所在的 Hub 宿主机获取官方授权链接，用户完成浏览器授权后查询状态。也可运行 `node mcp/login.mjs cb start`，随后 `node mcp/login.mjs cb status`。Windows 上的 MiMo 支持自动获取官方登录链接，可用 `/hub-login mimo start` 发起，授权等待上限为 300 秒，再用 `/hub-login mimo status` 查询。`awaiting_user` 表示等待用户授权，只有 `authenticated` 才表示已登录；Linux 上的 MiMo 仍需按 `manual_required` 指引在宿主机终端登录，Antigravity 等没有已验证链接登录接口的 worker 也返回人工操作指引。工具不返回凭据，临时链接和验证码不要写入仓库。

#### Linux 部署（⏸️ 暂缓搁置·排在 DSH 适配后重构）
> 💡 **优先级调整公告**：为确保核心功能扎实稳定，团队当前全力攻坚 Windows 平台的极致开箱体验与 DeepSeek Harness (DSH) 原生适配，Linux 的生产级服务化启动（如 systemd 守护进程、跨发行版环境自检）**暂时搁置，排在 DSH 适配完成之后集中推进**。
> Linux 开发者仍可测试运行：
```bash
cp .env.example .env
./start.sh
# 停止服务随时运行: ./stop.sh
```

---

### 🧩 按需启用：本地只有 1~2 个 Agent 可以跑吗？（以 MiniMax + Trae 为例）

**完全可以，支持任意 Agent 组合或单 Agent 极简运行！**

本项目各 Agent 通道完全解耦：
- **无需配齐全部 8 个环境**：如果你本地只安装了 MiniMax 官方 CLI（`minimaxcode`）和 TraeCode 桌面端（`traecode`），或者只有 GitHub Copilot，完全不需要强行安装其他工具。
- **开箱极简配置**：
  ```bash
  # 复制极简配置模板（仅启用 minimaxcode + traecode）
  cp hub/agents.minimal.example.json hub/agents.json
  ```
- **自动优雅降级**：
  - Web 控制台只会加载并展示你实际配置了的 Agent 平台；
  - 自动调度模式（Auto）会自动在当前已配置且在线的 Worker 间轮转，绝不会把任务错派给未启用的 Agent；
  - 若在外部工作流中偶然调用了未配置的 Agent，总线会返回友好提示（如 `xx 未配置 CLI` 或 `Trae 网关未连接`），绝不会导致总线崩溃或静默卡死。

---

### 高级手动分步启动

若需要将总线与控制台部署在不同机器，可手动分步运行：

```bash
# 1. 启动任务总线 (默认 127.0.0.1:8765/mcp)
cd hub
cp agents.example.json agents.json
python3 agent_hub.py --http 8765 --host 0.0.0.0

# 2. 启动异步任务执行器 (按需)
python3 async_worker.py

# 3. 启动 Web 控制台 (默认 :8890)
cd ../console
node server.mjs
```

### 安全提示

- **首次对外暴露务必设置 `HUB_TOKEN`**：总线与控制台之间通过 Token 进行强校验，默认空 Token 仅限本机回环 (`127.0.0.1`) 安全测试。若需要监听 `0.0.0.0` 供局域网访问，必须在 `.env` 中填写强 Token。
- 局域网访问建议配合防火墙规则，请勿将未鉴权服务直接映射到公网。
- `state/` 包含本地任务与会话记录，属于敏感本地数据，请注意访问权限与备份。

### CLI 与桌面调用方式

CLI 通道使用配置中的官方无头命令；桌面通道通过 CDP 驱动本机客户端。Hub 负责调度与保存结果，认证和模型服务由各官方客户端处理。

### 回归验证

使用可用的 Python 3.11+ 和 Node.js，运行 `python tests/run_regressions.py`。脚本使用隔离目录、合成 worker 和 mock Hub，验证总线、登录运行时、控制台、Codex/DSH 适配与 Windows 启停；结果和源码哈希保存到 [`docs/refactor-validation.json`](docs/refactor-validation.json)。不调用厂商模型，不改当前客户端配置。Unix 启停脚本本轮仅做语法检查。

### 🔌 官方客户端插件与集成 / Integrations & Plugins

除了使用独立的 Web 控制台与命令行调用外，本项目深度适配各大主流 AI 开发桌面端：

1. **ZCode 桌面端插件源码 (`agenthub-workers`)**：
   - **一键安装**：打开 ZCode **设置 ➔ 插件管理 ➔ 发现**，点击右上角 **`+`** 按钮，直接粘贴 GitHub 仓库地址 `https://github.com/Johhny-Xu/multi-agent-hub.git`，即可在卡片列表中点击“获取”一键安装！
   - **8 大原生子智能体类型**：深度无缝接入 ZCode 子智能体体系，支持自然语言与简称自动识别（`agy` ➔ Antigravity、`cb` ➔ CodeBuddy 国际版、`cbcn` ➔ CodeBuddy 国内版、`zcode` ➔ Linux ZCode、`trae` ➔ TraeCode、`gcp` ➔ GitHub Copilot、`mmx` ➔ MiniMax、`mimo` ➔ MiMoCode）。
   - **突破工作流 30 秒超时限制**：内置专门打造的 `hub-bridge` MCP 工具面（`hub_ask`、`hub_dispatch`、`hub_fetch`），以“秒级返回 ref + 增量异步轮询”机制彻底攻克工作流子代理 30s 框架调用上限，支撑高并发扇出压测与复杂流水线。
   - **状态探活与调度技能**：内置 `/hub-status` 快捷指令及 `dispatch-hub` 协同编排技能。
   - **官方登录链接（v0.5.0）**：`hub_login` 与 `/hub-login` 支持发起、查询及取消宿主机上的 worker 登录流程，用户在浏览器完成官方授权。
   - **免服务器双击运行保障**：产物输出严格遵循无依赖单文件规范（CSS/JS 内联，Base64/Web Audio 程序化资产），支持在操作系统文件管理器中直接双击 HTML 文件（`file://` 协议）离线流畅运行。

2. **DeepSeek Harness (DSH) 适配源码**：
   - [`integrations/dsh/README.md`](integrations/dsh/README.md)：8 个 worker 子代理预设、三个原生工作流及确定性 Node runner。
   - 已按官方 Cordis、`agent`/`parallel` 接口修复并进行隔离测试；安装脚本保留 profile 原有配置，实际激活遵循官方插件命令。

3. **Codex 本地插件与子代理适配源码**：
   - [`integrations/codex/README.md`](integrations/codex/README.md)：本地插件 MCP、8 个项目子代理 TOML 模板和三个工作流技能。
   - 安装预览及测试使用隔离项目；子代理继承宿主模型与权限，通过 Hub 调用外部 worker。

Codex 和 DSH 均尚未安装到当前客户端；源码、配置与 mock 流程已验证，宿主内真实模型调用仍需安装后验证。

---

## English

**Multi-Agent Hub** connects official CLIs and desktop agents through a local task bus, with dispatch, result polling, task queues and a conversation console. Vendor model calls still reach the respective vendor's service. Changes are recorded in [CHANGELOG.md](CHANGELOG.md); Windows results are in [the compatibility report](docs/windows-compatibility.md).

### Architecture & Components

See the bilingual architecture & data-flow diagram at the top of this README.

- **hub/** — **Core Task Bus** (Python standard library only, zero third-party dependencies). Provides unified JSON-RPC MCP endpoints, shared task queue, agent mailboxes, shared notes, heartbeat registry, and generic CLI dispatch; `async_worker.py` handles background async execution, and `reap_idle.sh` cleans up idle processes.
- **console/** — **Multi-Agent Web Console**. Built with lightweight Node.js (zero npm install required) and a single-page frontend. Features real-time multi-agent conversation streams, live quota tracking, collapsible reasoning chains, and full responsive vertical mobile support.
- **drivers/** — **Desktop CDP Drivers** (5 standalone JS scripts). Automates official ZCode and TraeCode desktop applications in VNC environments via Chrome DevTools Protocol, bridging desktop-only AIs into the task bus.

### Directory Layout

```
multi-agent-hub/
├── start.sh                  # ⚡ One-command launcher for Linux/macOS
├── stop.sh                   # ⏹ One-command stopper for Linux/macOS
├── start.bat                 # ⚡ One-click launcher for Windows
├── stop.bat                  # ⏹ One-click stopper for Windows
├── .env.example              # Unified root environment configuration
├── CHANGELOG.md              # Standardized release changelog
├── LICENSE                   # MIT License
├── README.md                 # Bilingual documentation
├── hub/                      # Task bus (Python MCP over HTTP / stdio)
├── console/                  # Web console (Node.js + responsive SPA)
├── drivers/                  # Desktop CDP drivers for VNC
├── integrations/             # Native client integrations & plugins
│   ├── codex/                # Codex local plugin, subagents and skills
│   └── dsh/                  # DeepSeek Harness (DSH) integration
└── docs/                     # Architecture diagrams and assets
```

### ⚡ Quickstart (One-Command)

#### Prerequisites
- **Python 3.8+** (standard library only, no pip needed)
- **Node.js 20+** for the console and MCP bridge; desktop CDP drivers require **Node.js 22+** for the built-in WebSocket. See [Node documentation](https://nodejs.org/api/globals.html#websocket).
- Optional: VNC + Chromium-based desktop AI clients (only needed for desktop drivers)

#### Windows (🌟 Primary Recommended Platform)
1. Copy `.env.example` to `.env` (defaults work out-of-the-box for localhost).
2. Double-click **`start.bat`** to start both the Task Bus and Web Console in one second!
3. Open **`http://localhost:8890/dashboard`** in your browser.
4. To stop the services, double-click **`stop.bat`**.

For a new worker configuration, use [`hub/agents.windows.example.json`](hub/agents.windows.example.json), replace each `C:/PATH/TO` with the official CLI's stable installation path, keep the installed workers, and save it as `hub/agents.json`. Use `npm root -g` to locate global npm packages. CodeBuddy uses `node + official entry script`, with separate `%USERPROFILE%/.codebuddy` and `%USERPROFILE%/.codebuddy-cn` directories; the CN edition uses `CODEBUDDY_INTERNET_ENVIRONMENT=internal`. MiniMax defaults to the tested `MiniMax-M3.1-Flash-Preview` (alias `m31flash`). MiMo defaults to `xiaomi/mimo-v2.6-flash` (alias `v2.6f`). The Trae desktop channel still requires its gateway.

The standalone ZCode CLI also needs `env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` to point to the desktop-generated `zcode-builtin.json`, usually under `%USERPROFILE%/.zcode/v2/runtime/provider/windows-x86_64/<version>/<directory>/zcode-builtin.json`. In PowerShell, run `Get-ChildItem -LiteralPath "$env:USERPROFILE/.zcode/v2/runtime/provider/windows-x86_64" -Recurse -Filter zcode-builtin.json | Select-Object -ExpandProperty FullName` to list paths only, then replace `C:/PATH/TO/zcode-builtin.json` in the template. Do not copy the file contents or credentials into the repository.

Plugin v0.5.0 adds `hub_login(worker, action="start"|"status"|"cancel")` and `/hub-login`. It obtains an official authorization link on the worker's Hub host; the user completes authorization in their browser and then checks status. The CLI equivalent is `node mcp/login.mjs cb start`, followed by `node mcp/login.mjs cb status`. MiMo on Windows supports automatic official login links: use `/hub-login mimo start`, complete authorization within the 300-second waiting period, then use `/hub-login mimo status`. `awaiting_user` means authorization is pending; only `authenticated` means signed in. MiMo on Linux still returns `manual_required` with host-terminal login instructions, as do workers without a verified link flow, such as Antigravity. Credentials are never returned; do not save temporary authorization links or user codes in the repository.

#### Linux Deployment (⏸️ Paused / Scheduled after DSH)
> 💡 **Strategic Realignment**: The development team is prioritizing a seamless Windows out-of-the-box experience and native DeepSeek Harness (DSH) adaptation. Production-grade Linux service automation (systemd daemons, multi-distro dependency checks) is **temporarily paused and scheduled right after DSH adaptation**.
> Linux developers can still test via scripts:
```bash
cp .env.example .env
./start.sh
# To stop: ./stop.sh
```

---

### 🧩 Minimal / Partial Setup: Can I run with only 1 or 2 Agents? (e.g. MiniMax + Trae)

**Absolutely! Any combination or single-agent setup is fully supported.**

Every agent channel in Multi-Agent Hub is completely decoupled:
- **No need to install all 8 agents**: If you only have the official MiniMax CLI (`minimaxcode`) and TraeCode desktop (`traecode`), or only GitHub Copilot, you do NOT need to set up the rest.
- **Minimal Configuration Template**:
  ```bash
  # Copy the minimal template (only enables minimaxcode + traecode)
  cp hub/agents.minimal.example.json hub/agents.json
  ```
- **Graceful Degradation**:
  - The Web Console only renders and tracks your actively configured agents.
  - The Auto-dispatch algorithm rotates only among configured, online agents and will never route tasks to missing tools.
  - If an unconfigured agent is called externally, the hub returns a clean informative message (e.g., `CLI not configured` or `Trae gateway unreachable`) instead of crashing or hanging.

---

### Security Notes

- **Set a secure `HUB_TOKEN` before exposing externally**: Communication between the console, agents, and bus is authenticated via token. An empty token is only permitted for localhost (`127.0.0.1`). If binding to `0.0.0.0` or a LAN interface, a strong token is strictly required.
- Do not expose unauthenticated instances to the public internet.

### 🛡️ Reverse Proxies Get You Banned — This Project Doesn't

- ❌ **Reverse proxies / unofficial API wrappers**: Re-engineering web applications into unofficial API endpoints bypasses provider rate limits and risk controls, which violates terms of service and is the leading cause of account bans.
- ✅ **This project**: Uses only each vendor's **official CLI in headless mode** (`codebuddy -p`, `copilot -p`, `mmx text chat`, `antigravity`, etc.) and official desktop clients that you have logged into personally. It operates in the exact same legitimate manner as running commands in your own terminal.

### 🔌 Client Integrations & Plugins

In addition to the standalone web console and CLI tools, native integrations are designed for major AI development desktop environments:

1. **ZCode Desktop Plugin Source (`agenthub-workers`)**:
   - **One-Click Install**: Open ZCode **Settings ➔ Plugin Management ➔ Discover**, click the top-right **`+`** button, paste the GitHub repository URL `https://github.com/Johhny-Xu/multi-agent-hub.git`, and click "Get" on the card to install!
   - **8 Native Subagent Types**: Deeply integrated into ZCode's subagent ecosystem, with automatic alias routing (`agy` ➔ Antigravity, `cb` ➔ CodeBuddy International, `cbcn` ➔ CodeBuddy CN, `zcode` ➔ Linux ZCode, `trae` ➔ TraeCode, `gcp` ➔ GitHub Copilot, `mmx` ➔ MiniMax, `mimo` ➔ MiMoCode).
   - **Bypassing 30-Second Workflow Timeout**: Dedicated `hub-bridge` MCP suite (`hub_ask`, `hub_dispatch`, `hub_fetch`) utilizing instant ref return + incremental async polling to conquer workflow timeout ceilings.
   - **Heartbeat & Dispatch Skills**: Integrated `/hub-status` command and `dispatch-hub` orchestration skill.
   - **Official Login Links (v0.5.0)**: `hub_login` and `/hub-login` start, inspect, and cancel worker login flows on the Hub host; users complete official authorization in their browser.
   - **Zero-Server Direct Launch**: Generated artifacts adhere strictly to self-contained single-file HTML standards (inline CSS/JS, Base64/Web Audio data), allowing double-click execution directly via `file://`.

2. **DeepSeek Harness (DSH) adapter source**: [integration guide](integrations/dsh/README.md), with eight worker presets, three native workflows and a deterministic Node runner. The installer preserves the selected profile's existing settings.

3. **Codex local plugin and subagent adapter source**: [integration guide](integrations/codex/README.md), with MCP manifests, eight project subagent TOML templates and three workflow skills.

Both adapters have isolated configuration/mock validation. They have not been installed into the current clients or exercised with real models inside those hosts.

---

## 致谢 / Acknowledgements

- [TraeClaw](https://github.com/firerlAGI/TraeClaw) — MIT License, © 2026 firerlAGI. The Trae channel gateway depends on this project.
- [lobehub icons](https://github.com/lobehub/lobe-icons) — MIT License. Brand icons used in the web console are from this project.

## License / 许可证

[MIT](./LICENSE) © agenthub contributors
