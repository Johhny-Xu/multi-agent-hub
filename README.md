# All-in-One Agent Hub

[中文](#中文) | [English](#english)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python 3.8+](https://img.shields.io/badge/Python-3.8+-green.svg)](https://www.python.org/)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![GitHub Repo](https://img.shields.io/badge/GitHub-all--in--one--agent--hub-blue)](https://github.com/Johhny-Xu/all-in-one-agent-hub)

![All-in-One Agent Hub 架构与数据流 / Architecture & Data Flow](docs/architecture.svg)

---

## 中文

还在嫌各家白嫖配额用得提心吊胆、到处手动切“毒鸡蛋”太心累？还在担心本地代码被云端看了个一清二楚？**All-in-One Agent Hub**（`all-in-one-agent-hub`）替你一站式解决！本项目源于日常薅各家 AI 额度时，受够了“额度一光满盘皆输、切号切环境切到怀疑人生”的糟心体验，索性把 Trae、Antigravity、Copilot 等多路 Agent 全接到一条本地总线上，自动故障转移与配额调度，代码和任务全在局域网内跑。

### 架构与核心组件

架构与数据流图见本 README 顶部（双语标注）：任务总线统一接收派发，异步 worker 落到各 CLI / 桌面代理执行，结果回写后由控制台总览。

三个组件相互协同：

- **hub/** —— **核心任务总线**（Python 标准库，零第三方依赖）。提供统一 JSON-RPC MCP 接口、共享任务队列、代理邮箱、共享笔记、心跳注册表与通用 CLI 派活；`async_worker.py` 负责异步任务执行与空闲回收（配合 `reap_idle.sh`），`vnc-watchdog.sh` 守护桌面会话。状态以文件形式保存在 `state/`，多进程可共享。
- **console/** —— **一体化 Web 控制台**。`server.mjs` 为 Node 后端（内置模块，零 npm 依赖），`client/index.html` 为轻量单页前端（CodeBuddy 风格三栏 UI），支持全平台会话记录流、实时模型配额、思维链折叠与手机端竖屏全自适应。
- **drivers/** —— **桌面驱动套件**（CDP 驱动脚本）。通过 Chrome DevTools Protocol (CDP) 驱动 VNC 中运行的 ZCode / TraeCode 桌面版客户端，让没有公开 API 的桌面 AI 也能自动接收任务并回传增量结果。

### 目录结构

```
all-in-one-agent-hub/
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
└── docs/                     # 架构设计图与品牌资产
    ├── architecture.svg
    └── logo.png
```

### ⚡ 快速开始（一键启动）

#### 依赖环境
- **Python 3.8+**（标准库，无需 pip 安装）
- **Node.js 20+**（内置模块，需原生 WebSocket，无需 npm install）
- （可选）VNC + Chromium 系桌面 AI（仅使用 `drivers/` 驱动桌面客户端时需要）

#### Linux / macOS
```bash
# 1. 克隆仓库
git clone https://github.com/Johhny-Xu/all-in-one-agent-hub.git
cd all-in-one-agent-hub

# 2. 准备配置（本地回环可直接使用默认值）
cp .env.example .env

# 3. 一键启动！
./start.sh
```
启动成功后，浏览器打开 **`http://localhost:8890/dashboard`** 即可进入一体化控制台！
停止服务随时运行：`./stop.sh`

#### Windows
1. 将 `.env.example` 复制一份并重命名为 `.env`；
2. 双击运行 **`start.bat`** 即可一键拉起！
3. 停止服务双击运行 **`stop.bat`**。

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

---

## English

Tired of tiptoeing around quota limits and constantly swapping "free-tier tokens" by hand? Worried about your local codebase being laid completely bare to third-party clouds? **All-in-One Agent Hub** (`all-in-one-agent-hub`) has got you covered! Born out of pure frustration with juggling disposable free-tier AI accounts—getting cut off mid-task and having to reset everything—this project wires multiple AI agents (Trae, Antigravity, Copilot, and more) into a single self-hosted bus. It auto-fails over when quotas run dry and keeps your sessions and code strictly within your LAN.

### Architecture & Components

See the bilingual architecture & data-flow diagram at the top of this README.

- **hub/** — **Core Task Bus** (Python standard library only, zero third-party dependencies). Provides unified JSON-RPC MCP endpoints, shared task queue, agent mailboxes, shared notes, heartbeat registry, and generic CLI dispatch; `async_worker.py` handles background async execution, and `reap_idle.sh` cleans up idle processes.
- **console/** — **All-in-One Web Console**. Built with lightweight Node.js (zero npm install required) and a single-page frontend. Features real-time multi-agent conversation streams, live quota tracking, collapsible reasoning chains, and full responsive vertical mobile support.
- **drivers/** — **Desktop CDP Drivers** (5 standalone JS scripts). Automates official ZCode and TraeCode desktop applications in VNC environments via Chrome DevTools Protocol, bridging desktop-only AIs into the task bus.

### Directory Layout

```
all-in-one-agent-hub/
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
└── docs/                     # Architecture diagrams and assets
```

### ⚡ Quickstart (One-Command)

#### Prerequisites
- **Python 3.8+** (standard library only, no pip needed)
- **Node.js 20+** (native WebSocket required, built-in modules only, no npm install needed)
- Optional: VNC + Chromium-based desktop AI clients (only needed for desktop drivers)

#### Linux / macOS
```bash
# 1. Clone the repository
git clone https://github.com/Johhny-Xu/all-in-one-agent-hub.git
cd all-in-one-agent-hub

# 2. Copy environment template
cp .env.example .env

# 3. Launch everything!
chmod +x start.sh stop.sh
./start.sh
```
Once launched, open **`http://localhost:8890/dashboard`** in your browser!
To stop the services: `./stop.sh`

#### Windows
1. Copy `.env.example` to `.env`.
2. Double-click **`start.bat`** to start both the Task Bus and Web Console.
3. Double-click **`stop.bat`** to stop the services.

---

### Security Notes

- **Set a secure `HUB_TOKEN` before exposing externally**: Communication between the console, agents, and bus is authenticated via token. An empty token is only permitted for localhost (`127.0.0.1`). If binding to `0.0.0.0` or a LAN interface, a strong token is strictly required.
- Do not expose unauthenticated instances to the public internet.

### 🛡️ Reverse Proxies Get You Banned — This Project Doesn't

- ❌ **Reverse proxies / unofficial API wrappers**: Re-engineering web applications into unofficial API endpoints bypasses provider rate limits and risk controls, which violates terms of service and is the leading cause of account bans.
- ✅ **This project**: Uses only each vendor's **official CLI in headless mode** (`codebuddy -p`, `copilot -p`, `mmx text chat`, `antigravity`, etc.) and official desktop clients that you have logged into personally. It operates in the exact same legitimate manner as running commands in your own terminal.

---

## 致谢 / Acknowledgements

- [TraeClaw](https://github.com/firerlAGI/TraeClaw) — MIT License, © 2026 firerlAGI. The Trae channel gateway depends on this project.
- [lobehub icons](https://github.com/lobehub/lobe-icons) — MIT License. Brand icons used in the web console are from this project.

## License / 许可证

[MIT](./LICENSE) © agenthub contributors
