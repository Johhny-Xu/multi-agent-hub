# Agent Hub

[中文](#中文) | [English](#english)

![Agent Hub 架构与数据流 / Architecture & Data Flow](docs/architecture.svg)

## 中文

还在嫌各家白嫖配额用得提心吊胆、到处手动切“毒鸡蛋”太心累？还在担心本地代码被云端看了个一清二楚？**Agent Hub**（`better-free-agent-teams`）替你一站式解决！本项目源于日常薅各家 AI 额度时，受够了“额度一光满盘皆输、切号切环境切到怀疑人生”的糟心体验，索性把 Trae、Antigravity、Copilot 等多路 Agent 全接到一条本地总线上，自动故障转移与配额调度，代码和任务全在局域网内跑。

### 架构

架构与数据流图见本 README 顶部（双语标注）：任务总线统一接收派发，异步 worker 落到各 CLI / 桌面代理执行，结果回写后由控制台总览。

三个组件的关系：

- **hub/** —— 核心任务总线（Python 标准库，零第三方依赖）。提供共享任务队列、代理邮箱、共享笔记、心跳注册表与通用 CLI 派活；`async_worker.py` 负责异步任务执行与空闲回收（配合 `reap_idle.sh`），`vnc-watchdog.sh` 守护桌面会话。状态以文件形式存放在 `state/`，多个 hub 进程可共享。
- **console/** —— Web 控制台。`server.mjs` 为 Node 后端（同样只用 Node 内置模块），`client/index.html` 为单页前端（CodeBuddy 风格三栏 UI），可查看各智能体会话记录与实时配额。
- **drivers/** —— 桌面驱动脚本（5 个 js）。通过 CDP 驱动 VNC 中运行的 ZCode / TraeCode 桌面版，把 hub 里的任务落到真实桌面 AI 上执行。

### 目录结构

```
agenthub/
├── hub/                      # 任务总线（MCP over HTTP / stdio）
│   ├── agent_hub.py          # 主服务：四工具联动枢纽 MCP Server
│   ├── async_worker.py       # 异步任务 worker
│   ├── trae_mcp_server.py    # Trae 侧 MCP 接入
│   ├── reap_idle.sh          # 空闲代理回收
│   ├── vnc-watchdog.sh       # VNC 桌面会话守护
│   ├── agents.example.json   # 智能体清单示例（复制为 agents.json 使用）
│   └── .env.example          # 环境变量示例（复制为 .env / hub.env 使用）
├── console/                  # Web 控制台
│   ├── server.mjs            # Node 后端
│   ├── client/index.html     # 单页前端（三栏 UI）
│   ├── run.sh                # 启动脚本
│   └── miniapp-api.ts        # 前端 API 类型定义
└── drivers/                  # 桌面驱动（CDP → VNC 桌面 AI）
    ├── zcode_dom.js
    ├── zcode_read.js
    ├── dom_probe.js
    ├── dom_probe_zcode.js
    └── dom_read.js
```

### 安装教程

#### 依赖

- Python 3.8+（仅标准库，无需 pip 安装）
- Node.js 22+（需原生 WebSocket，仅内置模块，无需 npm install）
- 可选：VNC + Chromium 系桌面 AI（仅使用 drivers/ 时需要）

#### 1. 配置

```bash
cd hub
cp .env.example .env          # 按需修改环境变量
cp agents.example.json agents.json   # 编辑智能体清单
```

`.env` 中包含服务地址、认证 token 等配置，**首次部署务必修改默认 token**（见下方安全提示）。`agents.json` 定义接入总线的智能体（名称、接入方式、命令等）。

#### 2. 启动 hub

```bash
cd hub
python3 agent_hub.py --http            # Streamable HTTP，默认 127.0.0.1:8765/mcp
# 或 stdio 模式（供 CLI 类智能体接入）：
python3 agent_hub.py --stdio
# 需要异步任务执行时另开：
python3 async_worker.py
```

#### 3. 启动 Web 控制台

```bash
cd console
./run.sh
# 或直接：node server.mjs
```

控制台默认监听 `8890`，可用 `HUBCONSOLE_HOST` / `HUBCONSOLE_PORT` / `HUBCONSOLE_DATA_DIR` 环境变量覆盖（`run.sh` 内含示例默认值）。浏览器打开 `http://<主机>:8890/dashboard` 即可查看各智能体会话与配额。

### 安全提示

- **首次部署务必修改默认 token**：hub 与 console 之间、以及各智能体接入总线时使用 token 认证，示例配置中的 token 仅供本地测试，公网 / 多人环境部署前必须全部更换。
- hub 默认只绑定 `127.0.0.1`。若需局域网访问，请置于可信网络并配合防火墙规则；不要把未改 token 的实例直接暴露到公网。
- `state/`、会话记录等数据目录包含智能体对话内容，注意备份与访问权限。

### 反代会封号，本项目绝不封号

- ❌ **逆向反代 / API 转发**：把网页端逆向成非官方 API 接口、绕过官方客户端调用——这是典型的违反服务条款滥用，也是封号重灾区。
- ✅ **本项目**：只用各家**官方 CLI 的无头模式**（`codebuddy -p`、`copilot -p`、`mmx text chat`、`agy` 等）与你自己登录的官方桌面客户端（CDP 仅驱动你已登录的桌面应用）——和你在终端里手动敲命令是同一种合规使用方式，只是把"手动敲"交给了调度器。

## English

Tired of tiptoeing around quota limits and constantly swapping "free-tier tokens" by hand? Worried about your local codebase being laid completely bare to third-party clouds? **Agent Hub** (`better-free-agent-teams`) has got you covered! Born out of pure frustration with juggling disposable free-tier AI accounts—getting cut off mid-task and having to reset everything—this project wires multiple AI agents (Trae, Antigravity, Copilot, and more) into a single self-hosted bus. It auto-fails over when quotas run dry and keeps your sessions and code strictly within your LAN.

### Architecture

See the architecture & data-flow diagram at the top of this README (bilingual labels): the task bus receives every dispatch, async workers fan tasks out to CLI / desktop agents, and results are written back and surfaced by the console.

Three components:

- **hub/** — the core task bus (Python standard library only, zero third-party dependencies). Provides a shared task queue, agent mailboxes, shared notes, a heartbeat registry and generic CLI dispatch; `async_worker.py` runs async tasks and idle reaping (with `reap_idle.sh`), and `vnc-watchdog.sh` guards desktop sessions. State lives in plain files under `state/` and can be shared by multiple hub processes.
- **console/** — the web console. `server.mjs` is the Node backend (built-in Node modules only) and `client/index.html` is a single-page frontend (CodeBuddy-style three-column UI) showing every agent's conversation threads and live model quotas.
- **drivers/** — desktop driver scripts (5 js files). They drive the ZCode / TraeCode desktop apps running inside a VNC display over CDP, so hub tasks execute on real desktop AIs.

### Directory layout

```
agenthub/
├── hub/                      # Task bus (MCP over HTTP / stdio)
│   ├── agent_hub.py          # Main service: the four-tool hub MCP server
│   ├── async_worker.py       # Async task worker
│   ├── trae_mcp_server.py    # Trae-side MCP integration
│   ├── reap_idle.sh          # Idle agent reaper
│   ├── vnc-watchdog.sh       # VNC desktop session watchdog
│   ├── agents.example.json   # Example agent registry (copy to agents.json)
│   └── .env.example          # Environment variable example (copy to .env / hub.env)
├── console/                  # Web console
│   ├── server.mjs            # Node backend
│   ├── client/index.html     # Single-page frontend (three-column UI)
│   ├── run.sh                # Launch script
│   └── miniapp-api.ts        # Frontend API type definitions
└── drivers/                  # Desktop drivers (CDP → desktop AIs in VNC)
    ├── zcode_dom.js
    ├── zcode_read.js
    ├── dom_probe.js
    ├── dom_probe_zcode.js
    └── dom_read.js
```

### Installation

#### Prerequisites

- Python 3.8+ (standard library only, no pip install needed)
- Node.js 22+ (native WebSocket required; built-in modules only, no npm install needed)
- Optional: VNC + a Chromium-based desktop AI (only required when using drivers/)

#### 1. Configure

```bash
cd hub
cp .env.example .env          # edit environment variables as needed
cp agents.example.json agents.json   # edit the agent registry
```

`.env` holds the service addresses and auth tokens — **change the default token on first deployment** (see Security Notes). `agents.json` defines the agents attached to the bus (name, transport, command, etc.).

#### 2. Start the hub

```bash
cd hub
python3 agent_hub.py --http            # Streamable HTTP, defaults to 127.0.0.1:8765/mcp
# or stdio mode (for CLI-type agents):
python3 agent_hub.py --stdio
# additionally, when you need async task execution:
python3 async_worker.py
```

#### 3. Start the web console

```bash
cd console
./run.sh
# or directly: node server.mjs
```

The console listens on `8890` by default; override with the `HUBCONSOLE_HOST` / `HUBCONSOLE_PORT` / `HUBCONSOLE_DATA_DIR` environment variables (sample defaults live in `run.sh`). Open `http://<host>:8890/dashboard` to browse agent conversations and quotas.

### Security Notes

- **Change the default token on first deployment**: hub↔console and agent↔bus communication is token-authenticated. Tokens in the example config are for local testing only — replace all of them before exposing the deployment to a LAN / the public internet.
- The hub binds to `127.0.0.1` by default. For LAN access, keep it on a trusted network with firewall rules; never expose an instance with default tokens to the public internet.
- `state/`, conversation records and other data directories contain agent conversations — mind backups and access permissions.

### Reverse proxies get you banned — this project doesn't

- ❌ **Reverse proxies / unofficial API shims**: re-engineering web clients into unofficial API endpoints and bypassing the official clients — a classic Terms-of-Service violation and the #1 cause of account bans.
- ✅ **This project**: only uses each vendor's **official CLI headless mode** (`codebuddy -p`, `copilot -p`, `mmx text chat`, `agy`, ...) and your own logged-in official desktop apps (CDP merely drives the desktop apps you are already signed into) — exactly the same legitimate usage as typing the commands yourself in a terminal, just scheduled.

## 致谢 / Acknowledgements

- [TraeClaw](https://github.com/firerlAGI/TraeClaw) — MIT License, © 2026 firerlAGI。`trae` 通道网关依赖该项目。/ The Trae channel gateway depends on this project.
- [lobehub icons](https://github.com/lobehub/lobe-icons) — MIT License。控制台品牌图标（Antigravity / MiniMax / CodeBuddy / Copilot / Trae 等）来自该项目。/ Brand icons used in the web console are from this project.

## License / 许可证

[MIT](./LICENSE) © agenthub contributors
