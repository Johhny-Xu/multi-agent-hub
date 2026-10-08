# Multi-Agent Hub for DeepSeek Harness (DSH)

[中文](#中文) | [English](#english)

> 💡 **适配状态公告 / Adaptation Status**：
> 本模块目前处于 **积极适配与优化阶段 (Under Active Adaptation)**。核心工作流与预设原型代码均已就绪（详见下文），团队正在全面测试适配 DSH 官方桌面端的 Cordis 微内核多环境隔离机制，以确保生产环境的绝对稳定与平滑体验。欢迎关注主仓库路线图获取最新进展！
>
> This module is currently **under active adaptation & testing**. The native presets, workflows, and bridge definitions are available below, while we finalize smooth integration with DSH's Cordis microkernel layer.

---

## 中文

本项目为 **DeepSeek Harness (DSH)** 官方桌面客户端提供全能插件与扩展集成。
不仅支持 MCP 工具面直通，还完整支持 **DSH 原生工作流 (Workflow)** 与 **DSH 原生子代理预设 (Agent Presets)**！
安装后，DeepSeek 助手可直接协同调用 Multi-Agent Hub 背后 **8 大 AI 代理**（CodeBuddy、Antigravity、GitHub Copilot、MiniMax、TraeCode、ZCode 等）。

### 核心能力体系

1. **DSH 原生子代理 (Native Presets 全量 8 通道)**：
   - 基于 `@deepseek-ai/dsh-agent-preset` 标准，注入全套子代理预设：
     - `agenthub-all`：AgentHub 全能协同总线
     - `agenthub-antigravity`：专精复杂算法推演与长思维链 (Gemini 3.8 Flash / Claude 思维链)
     - `agenthub-codebuddy`：专精工业全栈代码实现与 Bug 修复 (DeepSeek-V4.1-Flash 国际版)
     - `agenthub-codebuddy-cn`：专精国内全栈工程代码编写 (DeepSeek-V4.1-Flash 国内版)
     - `agenthub-zcode`：专精 Linux 远端运维排查与系统脚本 (GLM-5.3-Flash)
     - `agenthub-traecode`：专精极速并发代码审查与轻量生成 (GLM-5.3-FlashX)
     - `agenthub-copilot`：专精 GitHub Copilot 自动选型编程代理 (Auto 模式)
     - `agenthub-minimaxcode`：专精长文本问答与创作 (MiniMax-M3.1-Flash-Preview)
     - `agenthub-mimocode`：专精小米 MiMo 架构编程代理 (Baseline Pure 模式)
   - 在 DSH 顶部预设下拉中可直接切换，或在会话中通过 `@` 引用。

2. **DSH 原生工作流 (Native Workflows)**：
   - 适配 DSH 官方 `@deepseek-ai/dsh-workflow` 规范（纯 JavaScript 编排脚本）；
   - 支持 DSH 原生全局钩子：`agent()`、`parallel()`、`pipeline()`、`phase()`、`log()`；
   - 随包提供 3 个开箱即用的工作流模板（位于 [`workflows/`](workflows/)）：
     - [`hub-fanout.dsh.js`](workflows/hub-fanout.dsh.js)：多智能体并发扇出与结果汇流
     - [`code-audit.dsh.js`](workflows/code-audit.dsh.js)：双代理流水线代码架构与安全审查
     - [`competitive-solve.dsh.js`](workflows/competitive-solve.dsh.js)：多模型交叉竞速解题与一致性验证

3. **MCP 原生工具面**：
   - `mcp__agenthub__hub_ask`：单调用直派任意 Agent 并阻塞带回最终结果；
   - `mcp__agenthub__hub_dispatch` / `hub_fetch`：异步派发与状态轮询；
   - `mcp__agenthub__hub_status`：查看各代理实时在线情况。

---

### ⚡ 一键安装与网址输入安装

#### 方式 1：Windows 双击一键安装（最推荐）
直接双击运行本目录下的 **`install.bat`**：
- 自动将 `dsh-plugin-multi-agent-hub` 注册进 DSH 当前 profile 的 `package.json`（插件设置面板立即可见！）；
- 自动注入 MCP 任务总线与全量 8 大子代理预设；
- 写入前自动生成带时间戳的安全备份。

#### 方式 2：在 DSH 客户端“安装插件”输入框中输入安装
如果你希望在 DSH 图形界面的“插件”设置面板输入框里安装：
- **输入本地路径**：
  ```
  file:<USER_HOME>/Desktop/agenthub/integrations/dsh
  ```
- **输入 Git 仓库网址**（在仓库公开后）：
  ```
  https://github.com/Johhny-Xu/multi-agent-hub.git
  ```
DSH 底层 pnpm 即可自动读取本目录的 `package.json` 与 `cordis.patch.yml` 并完成安装！

#### 方式 3：Linux / macOS
```bash
chmod +x install.sh
./install.sh
```

#### 高级参数（Python 命令行）
```bash
# 默认安装（自动注入 MCP 与 8 大原生子代理预设）
python3 install-dsh.py

# 远程总线 (指定 URL 与 Token)
python3 install-dsh.py --url http://127.0.0.1:8765/mcp --token your_token_here

# 检查当前集成状态
python3 install-dsh.py --check

# 一键卸载与配置还原
python3 install-dsh.py --uninstall
```

---

### 如何在 DSH 中调用原生工作流？

在 DeepSeek Harness 客户端中，直接向 AI 助手发送以下指令即可启动原生工作流：

#### 场景 1：全代理并发扇出 (hub-fanout)
> “请使用 workflow 工具运行 `hub-fanout.dsh.js` 工作流，参数 task='写一个高效的 LRU Cache 实现'，workers='antigravity,codebuddy,traecode'”

#### 场景 2：双代理流水线代码审查 (code-audit)
> “请使用 workflow 工具运行 `code-audit.dsh.js` 工作流，审查当前工作区的核心业务代码”

---

## English

This integration connects **Multi-Agent Hub** natively into the official **DeepSeek Harness (DSH)** desktop application.
It provides full native support for **DSH Workflows** and **DSH Subagent Presets**!

### Core Capabilities

1. **DSH Native Subagent Presets (All 8 Channels)**:
   - Built on `@deepseek-ai/dsh-agent-preset`, injecting native presets:
     - `agenthub-all`: General orchestration hub
     - `agenthub-antigravity`: Complex algorithm proof & deep reasoning (Gemini/Claude)
     - `agenthub-codebuddy`: Production full-stack code implementation (DeepSeek-V4.1-Flash Intl)
     - `agenthub-codebuddy-cn`: Domestic full-stack code implementation (DeepSeek-V4.1-Flash CN)
     - `agenthub-zcode`: Remote Linux operations & desktop AI tasks (GLM-5.3-Flash)
     - `agenthub-traecode`: High-speed code review & lightweight generation (GLM-5.3-FlashX)
     - `agenthub-copilot`: GitHub Copilot auto-routing agent
     - `agenthub-minimaxcode`: Long-text generation & Q&A (MiniMax-M3.1-Flash-Preview)
     - `agenthub-mimocode`: MiMoCode architecture programming agent
2. **DSH Native Workflows**:
   - Built for DSH's `@deepseek-ai/dsh-workflow` engine (pure JS orchestration scripts with `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`).
   - Includes 3 ready-to-run workflows in [`workflows/`](workflows/):
     - `hub-fanout.dsh.js`: Multi-agent parallel fan-out & result aggregation
     - `code-audit.dsh.js`: Pipeline multi-agent architecture and security audit
     - `competitive-solve.dsh.js`: Multi-model competitive problem solving
3. **MCP Tool Suite**:
   - `mcp__agenthub__hub_ask`, `hub_dispatch`, `hub_fetch`, `hub_status`.

### ⚡ One-Click Installation

#### Windows
Double-click **`install.bat`** to install automatically.

#### Linux / macOS
```bash
chmod +x install.sh
./install.sh
```
