# All-in-One Agent Hub for DeepSeek Harness (DSH)

[中文](#中文) | [English](#english)

---

## 中文

本项目为 **DeepSeek Harness (DSH)** 官方桌面客户端提供一站式插件适配集成。
安装后，DeepSeek Harness 内的 AI 助手将直接获得调用 All-in-One Agent Hub 背后 **8 大 AI 代理**（CodeBuddy、Antigravity、GitHub Copilot、MiniMax、TraeCode、ZCode 等）的能力。

### 核心原理
DeepSeek Harness 采用基于 Cordis 的微内核插件系统，其内置了官方 `@deepseek-ai/dsh-mcp-client` 扩展。
本插件通过向 `~/.dsh/profiles/desktop/cordis.patch.yml` 注入标准化配置，将 Agent Hub 注册为原生工具提供方：
- `mcp__agenthub__hub_ask`：将任务单调用直派给任意子代理并阻塞带回结果；
- `mcp__agenthub__hub_dispatch`：异步秒级派发；
- `mcp__agenthub__hub_fetch`：结果与状态轮询；
- `mcp__agenthub__hub_status`：查看各代理实时在线情况。

### ⚡ 一键安装

#### Windows
双击运行当前目录下的 **`install.bat`** 即可自动完成安装！

#### Linux / macOS
```bash
chmod +x install.sh
./install.sh
```

#### 高级参数（Python 命令行）
```bash
# 默认安装（连接本机 127.0.0.1:8765）
python3 install-dsh.py

# 如果总线部署在局域网服务器且启用了 Token
python3 install-dsh.py --url http://127.0.0.1:8765/mcp --token your_token_here

# 检查当前安装状态
python3 install-dsh.py --check

# 卸载插件（自动恢复备份）
python3 install-dsh.py --uninstall
```

### 手动安装方式
若不想运行脚本，也可手动打开 `~/.dsh/profiles/desktop/cordis.patch.yml`，在末尾添加：

```yaml
- id: mcp-agenthub
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: agenthub
    transport: streamable-http
    url: http://127.0.0.1:8765/mcp
```

### 验证与使用
1. 完全重启 DeepSeek Harness 客户端；
2. 新开会话，在对话中直接发送：
   > `调用 agenthub 查一下当前在线的代理列表`
   或
   > `让 antigravity 帮我写一个快速排序算法`
3. 模型将自动调用 `mcp__agenthub__hub_ask` 完成任务并回传结果！

---

## English

This integration connects **All-in-One Agent Hub** natively into the official **DeepSeek Harness (DSH)** desktop application.
Once installed, your DeepSeek assistant can orchestrate all 8 AI agents (CodeBuddy, Antigravity, GitHub Copilot, MiniMax, TraeCode, ZCode, etc.) directly as first-class tools.

### Architecture
DeepSeek Harness runs a Cordis microkernel loader with built-in `@deepseek-ai/dsh-mcp-client`. This integration injects a streamable-http MCP client entry into `~/.dsh/profiles/desktop/cordis.patch.yml`:
- `mcp__agenthub__hub_ask`: One-call blocking execution on any agent;
- `mcp__agenthub__hub_dispatch`: Instant async dispatch;
- `mcp__agenthub__hub_fetch`: Status poll & result retrieval;
- `mcp__agenthub__hub_status`: Overview of registered agents.

### ⚡ One-Click Installation

#### Windows
Double-click **`install.bat`** to install automatically.

#### Linux / macOS
```bash
chmod +x install.sh
./install.sh
```

#### Custom CLI Options
```bash
# Standard local install (connects to 127.0.0.1:8765)
python3 install-dsh.py

# Remote bus with auth token
python3 install-dsh.py --url http://127.0.0.1:8765/mcp --token your_token_here

# Check status
python3 install-dsh.py --check

# Uninstall
python3 install-dsh.py --uninstall
```
