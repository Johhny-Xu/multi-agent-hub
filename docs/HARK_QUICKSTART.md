# Multi-Agent Hub 云端开发指南 (Hark Environment)

> 目录源：`C:\Users\Johhny\Desktop\agenthub\hark`  
> 同步时间：2026-10-18 10:38  
> 基准提交：`bb9bbf3` (`fix(chat,checkin): remove bubble bhead for minimal dialogue, eliminate third-party project references, and enhance check-in logic with CDP and refined UI`)  
> 版本：v1.0.12

---

## 1. 目录结构概览

```text
hark/
├── .git/               # 完整 Git 版本控制历史（main 分支最新提交）
├── console/            # 控制台服务与 WebUI
│   ├── client/         # 前端静态单页应用 (index.html, CSS, JS)
│   ├── server.mjs      # 控制台轻量 HTTP/WebSocket 服务
│   ├── checkin.mjs     # 每日自动签到中枢 (WorkBuddy / Trae / CodeArts)
│   └── accounts.mjs    # 凭证与账号路由管理
├── hub/                # 核心路由与子代理调度中枢 (Python / JSON-RPC)
├── desktop/            # Electron 桌面客户端源码（依赖需 npm install 安装）
├── drivers/            # 平台通信驱动适配器
├── integrations/       # 各第三方 IDE / CLI 适配集成层
├── packaging/          # Linux / Windows 服务安装与自启动包装脚本
├── scripts/            # 辅助构建与打包脚本
├── tests/              # 自动化单元测试与回归套件
├── install.sh          # Linux 一键安装脚本
├── start.sh            # Linux 一键启动服务
├── stop.sh             # Linux 一键停止服务
└── RUN_ON_LINUX.md     # Linux 云端运行专属说明文档
```

---

## 2. 云端 Hark 常用开发与运行命令

### 2.1 安装与启动
```bash
# 给予运行权限（如有需要）
chmod +x *.sh console/*.sh packaging/*.sh

# 本地一键安装核心依赖与虚拟环境
./install.sh

# 一键启动 Agent Hub 与 WebUI 控制台
./start.sh

# 查看服务状态 / 停止服务
./stop.sh
```

### 2.2 运行核心测试验证
```bash
# 验证控制台客户端语法与主题约束（零 Emoji 规范）
node tests/console_client_syntax.mjs
node tests/console_layout_theme_dom.mjs

# 验证签到与福利服务能力
node tests/console_checkin_service.mjs

# 运行完整 Python 回归测试套件（29 项用例）
python3 tests/run_regressions.py
```

### 2.3 端口与服务映射
| 服务 | 端口 | 路径 / 功能 |
|---|---|---|
| **WebUI 控制台** | `8890` | `/dashboard` 仪表盘与会话流 |
| **子代理接入端点** | `8790` | JSON-RPC 核心通信网关 |
| **Trae CDP 调试端口** | `9222` | Trae 客户端远程调试与自动化打卡 |
| **TraeClaw Gateway** | `8787` | Trae 自动化操控网关 |

---

## 3. 本次迁移包含的最新功能增强

1. **极致极简对话流**：移除了用户与智能体气泡头部的红框行（身份标签与冗余时间），元信息自然嵌入气泡 `title` 悬停展示，界面紧凑清爽。
2. **纯原生签到与福利中枢**：彻底去除所有第三方开源项目引用与外链，原生内置 WorkBuddy 加油站打卡、Trae 免客户端/CDP 打卡、CodeArts 华为云算力包激活。
3. **Trae 双轨自愈打卡**：支持通过 CDP 端口（9222）直控桌面客户端打卡，抗 Token 失效；同时支持 WebUI 一键填入自定义 Token 云端直签。
4. **玻璃拟态 UI 升级**：打卡卡片带呼吸指示灯、高对比度渐变按钮与时间线日志列表。
