# Agent Hub

Agent Hub 是一个自托管的多智能体协作枢纽：局域网内的多个 CLI / 桌面 AI 代理（如 ZCode、TraeCode 等）通过统一的 JSON-RPC 任务总线互相派活，并可用网页控制台总览各智能体的会话记录与实时配额。

## 架构

```
                 ┌────────────────────────────┐
                 │      console/  Web 控制台   │
                 │  server.mjs (Node 后端)     │
                 │  client/index.html (SPA)   │
                 └───────────┬────────────────┘
                             │ HTTP / 轮询
                             ▼
┌──────────────┐   ┌────────────────────────────┐
│ drivers/ 脚本│──▶│        hub/  任务总线       │
│ CDP 驱动 VNC │   │  agent_hub.py (JSON-RPC     │
│ 中的桌面 AI   │   │  MCP over HTTP, 默认        │
│ (ZCode 等)   │   │  127.0.0.1:8765/mcp)        │
└──────────────┘   │  async_worker.py 异步 worker│
                   │  state/ 共享状态(文件)       │
                   └───────────┬────────────────┘
                               │ 派活 / 收结果
                       ┌───────┴───────┐
                       ▼               ▼
                  CLI 代理 A        CLI 代理 B
```

三个组件的关系：

- **hub/** —— 核心任务总线（Python 标准库，零第三方依赖）。提供共享任务队列、代理邮箱、共享笔记、心跳注册表与通用 CLI 派活；`async_worker.py` 负责异步任务执行与空闲回收（配合 `reap_idle.sh`），`vnc-watchdog.sh` 守护桌面会话。状态以文件形式存放在 `state/`，多个 hub 进程可共享。
- **console/** —— Web 控制台。`server.mjs` 为 Node 后端（同样只用 Node 内置模块），`client/index.html` 为单页前端（CodeBuddy 风格三栏 UI），可查看各智能体会话记录与实时配额。
- **drivers/** —— 桌面驱动脚本（5 个 js）。通过 CDP 驱动 VNC 中运行的 ZCode / TraeCode 桌面版，把 hub 里的任务落到真实桌面 AI 上执行。

## 目录结构

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

## 快速开始

### 依赖

- Python 3.8+（仅标准库，无需 pip 安装）
- Node.js 18+（仅内置模块，无需 npm install）
- 可选：VNC + Chromium 系桌面 AI（仅使用 drivers/ 时需要）

### 1. 配置

```bash
cd hub
cp .env.example .env          # 按需修改环境变量
cp agents.example.json agents.json   # 编辑智能体清单
```

`.env` 中包含服务地址、认证 token 等配置，**首次部署务必修改默认 token**（见下方安全提示）。`agents.json` 定义接入总线的智能体（名称、接入方式、命令等）。

### 2. 启动 hub

```bash
cd hub
python3 agent_hub.py --http            # Streamable HTTP，默认 127.0.0.1:8765/mcp
# 或 stdio 模式（供 CLI 类智能体接入）：
python3 agent_hub.py --stdio
# 需要异步任务执行时另开：
python3 async_worker.py
```

### 3. 启动 Web 控制台

```bash
cd console
./run.sh
# 或直接：node server.mjs
```

控制台默认监听 `8890`，可用 `HUBCONSOLE_HOST` / `HUBCONSOLE_PORT` / `HUBCONSOLE_DATA_DIR` 环境变量覆盖（`run.sh` 内含示例默认值）。浏览器打开 `http://<主机>:8890/dashboard` 即可查看各智能体会话与配额。

## 安全提示

- **首次部署务必修改默认 token**：hub 与 console 之间、以及各智能体接入总线时使用 token 认证，示例配置中的 token 仅供本地测试，公网 / 多人环境部署前必须全部更换。
- hub 默认只绑定 `127.0.0.1`。若需局域网访问，请置于可信网络并配合防火墙规则；不要把未改 token 的实例直接暴露到公网。
- `state/`、会话记录等数据目录包含智能体对话内容，注意备份与访问权限。

## License

[MIT](./LICENSE) © agenthub contributors
