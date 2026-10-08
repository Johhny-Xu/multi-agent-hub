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

还在嫌各家白嫖配额用得提心吊胆、到处手动切“毒鸡蛋”太心累？还在担心本地代码被云端看了个一清二楚？**Multi-Agent Hub**（`multi-agent-hub`）替你一站式解决！本项目源于日常薅各家 AI 额度时，受够了“额度一光满盘皆输、切号切环境切到怀疑人生”的糟心体验，索性把 Trae、Antigravity、Copilot 等多路 Agent 全接到一条本地总线上，自动故障转移与配额调度，代码和任务全在局域网内跑。

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
│   └── dsh/                  # DeepSeek Harness (DSH) 一键插件与适配器
└── docs/                     # 架构设计图与品牌资产
    ├── architecture.svg
    └── logo.png
```

### ⚡ 快速开始（一键启动）

#### 依赖环境
- **Python 3.8+**（标准库，无需 pip 安装）
- **Node.js 20+**（内置模块，需原生 WebSocket，无需 npm install）
- （可选）VNC + Chromium 系桌面 AI（仅使用 `drivers/` 驱动桌面客户端时需要）

#### Windows（🌟 官方首推 / 重点支持）
1. 将 `.env.example` 复制一份并重命名为 `.env`（本地回环直接使用默认值即可）；
2. 双击运行 **`start.bat`** 即可一键拉起任务总线与 Web 控制台！
3. 浏览器打开 **`http://localhost:8890/dashboard`** 即可进入一体化控制台；
4. 停止服务随时双击运行 **`stop.bat`**。

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

### 🛡️ 反代会封号，本项目绝不封号

- ❌ **逆向反代 / 非官方 API 转发**：将 Web 网页端逆向破解为非官方 API 接口、跳过客户端签名与风控调用——这是各大厂商明确打击的违规行为，也是批量封号的头号元凶。
- ✅ **本项目**：只使用各大厂商**官方 CLI 的无头执行模式**（如 `codebuddy -p`、`copilot -p`、`mmx text chat`、`antigravity` 等）与你自己登录的官方桌面应用（CDP 仅负责驱动本机窗口）——与你在终端手动敲命令、在桌面正常操作属于同一种完全合规的交互形式，只是将“手动触发”交由总线自动化调度。

### 🔌 官方客户端插件与集成 / Integrations & Plugins

除了使用独立的 Web 控制台与命令行调用外，本项目深度适配各大主流 AI 开发桌面端：

1. **ZCode 桌面端插件 (`agenthub-workers`)【✅ 完全就绪 / Production Ready】**：
   - **8 大原生子智能体类型**：深度无缝接入 ZCode 子智能体体系，支持自然语言与简称自动识别（`agy` ➔ Antigravity、`cb` ➔ CodeBuddy 国际版、`cbcn` ➔ CodeBuddy 国内版、`zcode` ➔ Linux ZCode、`trae` ➔ TraeCode、`gcp` ➔ GitHub Copilot、`mmx` ➔ MiniMax、`mimo` ➔ MiMoCode）。
   - **突破工作流 30 秒超时限制**：内置专门打造的 `hub-bridge` MCP 工具面（`hub_ask`、`hub_dispatch`、`hub_fetch`），以“秒级返回 ref + 增量异步轮询”机制彻底攻克工作流子代理 30s 框架调用上限，支撑高并发扇出压测与复杂流水线。
   - **状态探活与调度技能**：内置 `/hub-status` 快捷指令及 `dispatch-hub` 协同编排技能。
   - **免服务器双击运行保障**：产物输出严格遵循无依赖单文件规范（CSS/JS 内联，Base64/Web Audio 程序化资产），支持在操作系统文件管理器中直接双击 HTML 文件（`file://` 协议）离线流畅运行。

2. **DeepSeek Harness (DSH) 原生适配套件【🚀 积极适配中 / Under Active Adaptation】**：
   - 目录：[`integrations/dsh/`](integrations/dsh/)
   - **Cordis 微内核与预设方案**：基于 `@deepseek-ai/dsh-agent-preset` 与 `@deepseek-ai/dsh-mcp-client` 规范，预研打造全量子代理预设（Presets）与 MCP 桥接。
   - **原生工作流模板库**：包含 `hub-fanout.dsh.js`（多 Agent 并发扇出）、`code-audit.dsh.js`（双代理流水线代码审查）、`competitive-solve.dsh.js`（多模型交叉解题验证）三大开箱即用脚本。
   - **适配进展**：团队正全面进行 Cordis 微内核多环境隔离测试，以确保在生产环境中的平滑免损注入与极致稳定性。

3. **Codex 生态适配【⏳ 下阶段规划 / Planned】**：
   - 计划实现与 Codex 扩展协议的深度打通，实现跨平台智能体双向任务流转与上下文无缝衔接。

---

## English

Tired of tiptoeing around quota limits and constantly swapping "free-tier tokens" by hand? Worried about your local codebase being laid completely bare to third-party clouds? **Multi-Agent Hub** (`multi-agent-hub`) has got you covered! Born out of pure frustration with juggling disposable free-tier AI accounts—getting cut off mid-task and having to reset everything—this project wires multiple AI agents (Trae, Antigravity, Copilot, and more) into a single self-hosted bus. It auto-fails over when quotas run dry and keeps your sessions and code strictly within your LAN.

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
│   └── dsh/                  # DeepSeek Harness (DSH) one-click plugin
└── docs/                     # Architecture diagrams and assets
```

### ⚡ Quickstart (One-Command)

#### Prerequisites
- **Python 3.8+** (standard library only, no pip needed)
- **Node.js 20+** (native WebSocket required, built-in modules only, no npm install needed)
- Optional: VNC + Chromium-based desktop AI clients (only needed for desktop drivers)

#### Windows (🌟 Primary Recommended Platform)
1. Copy `.env.example` to `.env` (defaults work out-of-the-box for localhost).
2. Double-click **`start.bat`** to start both the Task Bus and Web Console in one second!
3. Open **`http://localhost:8890/dashboard`** in your browser.
4. To stop the services, double-click **`stop.bat`**.

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

1. **ZCode Desktop Plugin (`agenthub-workers`)【✅ Production Ready】**:
   - **8 Native Subagent Types**: Deeply integrated into ZCode's subagent ecosystem, with automatic alias routing (`agy` ➔ Antigravity, `cb` ➔ CodeBuddy International, `cbcn` ➔ CodeBuddy CN, `zcode` ➔ Linux ZCode, `trae` ➔ TraeCode, `gcp` ➔ GitHub Copilot, `mmx` ➔ MiniMax, `mimo` ➔ MiMoCode).
   - **Bypassing 30-Second Workflow Timeout**: Dedicated `hub-bridge` MCP suite (`hub_ask`, `hub_dispatch`, `hub_fetch`) utilizing instant ref return + incremental async polling to conquer workflow timeout ceilings.
   - **Heartbeat & Dispatch Skills**: Integrated `/hub-status` command and `dispatch-hub` orchestration skill.
   - **Zero-Server Direct Launch**: Generated artifacts adhere strictly to self-contained single-file HTML standards (inline CSS/JS, Base64/Web Audio data), allowing double-click execution directly via `file://`.

2. **DeepSeek Harness (DSH) Native Integration【🚀 Under Active Adaptation】**:
   - Location: [`integrations/dsh/`](integrations/dsh/)
   - **Cordis Microkernel & Presets**: Pre-architected native subagent presets via `@deepseek-ai/dsh-agent-preset` and `@deepseek-ai/dsh-mcp-client`.
   - **Native Workflows**: Includes ready-to-run workflow templates: `hub-fanout.dsh.js`, `code-audit.dsh.js`, and `competitive-solve.dsh.js`.
   - **Status**: The engineering team is actively testing and hardening multi-profile Cordis integration to ensure zero-risk desktop stability.

3. **Codex Ecosystem Integration【⏳ Planned】**:
   - Scheduled cross-platform bidirectional agent orchestration and streaming context bridging with Codex.

---

## 致谢 / Acknowledgements

- [TraeClaw](https://github.com/firerlAGI/TraeClaw) — MIT License, © 2026 firerlAGI. The Trae channel gateway depends on this project.
- [lobehub icons](https://github.com/lobehub/lobe-icons) — MIT License. Brand icons used in the web console are from this project.

## License / 许可证

[MIT](./LICENSE) © agenthub contributors
