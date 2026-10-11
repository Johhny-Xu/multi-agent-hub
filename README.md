# multi-agent-hub

![multi-agent-hub 0.9.4 结构图：任意 MCP 客户端接入、5 款原生深度宿主与零客户端 WebUI 独立管理 · 9 种 Worker 统一调度](docs/architecture.svg)

**multi-agent-hub** 是一个面向多开发环境的 AI Agent 统一调度中枢。它基于标准 MCP 协议、原生插件与子代理体系，具备三层灵活接入形态：
1. **任意 MCP 客户端直连即用**：任何支持标准 MCP 协议的客户端（如 Cursor、Claude Desktop、Windsurf、VS Code Cline/Roo Code、Continue 等），仅需配置 Hub 的 MCP URL（或使用内置一键复制的 Prompt 指令），即可直接调度多端 Worker；
2. **5 款原生宿主深度适配（体验更顺畅、更舒服）**：针对 **Codex**、**ZCode**、**DeepSeek Harness (DSH)**、**华为 CodeArts** 与 **Antigravity** 提供了深度定制的原生插件、专用子代理体系（`hub-*.md`）、专属技能与斜杠命令，上下文自动隔离，免去手动配置参数的繁琐；
3. **零客户端独立使用**：即使没有外部 IDE 或 AI 客户端，Hub 内置的 **CodeBuddy 风格三栏式 WebUI 管理大盘** 也能独立完成平台多会话树管理、沉浸式对话、任务派发与监控、全量会话归档复原与彻底清理。

当前源码版本为 **0.9.4**，本阶段重点在于**MiniMaxCode 深度攻坚与 WebUI 全面交互优化**：引入 CodeBuddy 风格三栏式交互大盘、精细时段问候语与跨平台全局头像定制、全量会话聚合归档与一键复原/二次确认批量删除、原生 HTTP MCP 子代理直连端点与全自动 Agent 配置提示词复制、无缝剪贴板兼容、并发深度探活替代独立心跳、Worker 启停权威同步与模型目录精炼。

---

### ✨ 核心亮点

- 🔌 **5 种原生宿主客户端**：深度适配 Codex、ZCode、DeepSeek Harness、CodeArts、Antigravity，提供原生子代理、斜杠命令与工作流。
- 🤖 **9 种 Worker 统一适配**：标准契约调度 Antigravity、CodeBuddy（国际/国内版）、GitHub Copilot、MiMo、MiniMax、TraeCode、ZCode、CodeArts（Antigravity 原生客户端为新增宿主角色，不作为第十种 Worker）。
- 🎛️ **CodeBuddy 风格三栏式交互控制台**：内置 Web 管理大盘（`--with-console`，端口 `8890`，默认监听 `0.0.0.0` 开放局域网访问），提供 48px 极简活动栏、260px 平台会话管理树、单平台沉浸式对话与右侧可折叠扩展工作台；支持 7 大时段 35 句智能问候语、跨平台全局头像自由替换；全量会话归档支持跨平台集中筛选、搜索、排序、一键复原与**右上角一键删除（带二次确认防误触）**；刷新时自动并发检测全量子代理真实在线状态与延迟；全网络环境剪贴板支持（兼容局域网 HTTP 非安全上下文与 HTTPS）。
- 🚀 **子代理原生 HTTP MCP 直连端点**：提供轻量内置 HTTP MCP Server（默认端点 `http://127.0.0.1:8790/mcp`），向任意 AI 客户端（Cursor / Claude Desktop / Antigravity / Windsurf / Cline 等）开放 `subagent_run`（大产物本地落盘、只回摘要不占会话上下文）、`subagent_result`、`subagent_artifact`、`subagent_agents` 调度；控制台一键复制 MCP URL 与**【复制本文（发给Agent配置）】**，直接粘贴发给 Agent 即可全自动接入。
- ⚡ **子代理启用开关与全端双向同步**：在 WebUI 控制台对任意 Worker（如暂时无额度或调试中的子代理）一键启停；权威状态即时同步落盘并由 Hub 调度器、WebUI 与所有客户端插件实时感知；被禁用的 Worker 在 `hub_status` 显式呈现 `[已禁用]`，派发时零延迟前置拦截（`profile_disabled`），杜绝浪费计算与配额资源。
- 🎯 **精炼去重的生产模型目录**：为各 Worker 对齐官方真实模型与积分倍率体系，全面清理无法用于代码任务的生图模型、冗余平台别名与旧代模型，保留各服务商当季旗舰与高可用选型（如 MiniMax-M3.1-Flash-Preview、M3 1M 上下文等）。
- 🔄 **灵活多样的部署形态**：插件与 Hub 支持同机共存或分离部署；支持纯 Windows、纯 Linux 及 Windows ↔ Linux 跨机连接（局域网直连或 SSH 反向通道）。客户端连接特定 Hub 并非多 Hub 联邦，模型请求仍由官方 CLI 发送至服务商。
- 🛡️ **严格能力预检与终态判定**：根据模型能力约束思考、流式与附件；CodeArts 宿主环境强制执行 `tool_search → tool_describe → tool_call` 单一调用路径与单任务单次派发；拒绝空回答、已知异常退出及 agy 超时后的部分回答；保留原任务回执（ref），阻止 worker 向自身重复派发。
- 🔍 **智能发现与平滑切换**：局域网与本机 Hub 自动广播扫描与手动回退；连接配置与凭据独立于源码，平滑升级不丢失历史任务数据。

---

## 原生客户端接入与实测状态

各客户端通过专属原生插件接入调度中枢：

- **Antigravity 原生插件**：提供 `plugin.json`、9 个代理（`agents/*.md`）、4 个技能（`skills/*/SKILL.md`）及包含 7 个桥接工具的 `mcp_config.json`。可选 Python SDK 锁定 `google-antigravity==0.1.21`，提供强类型 `SubagentConfig` 与 Python 串并行编排能力；注意已安装 wheel 不包含 `beta.run_workflow` API，且 SDK API 鉴权独立于 IDE/CLI 登录（缺少 SDK 鉴权时 SDK 编排模型调用受阻）。
- **CodeArts 原生插件与驱动**：包含 9 个子代理、3 个斜杠命令、1 个调度技能、1 个 Hooks 插件和 7 个 MCP 工具。双向支持客户端调度与 Worker 被调度（`worker="codearts"`，别名 `ca`、`huawei-codearts`）。
  - **IDE 懒加载工具协议深度适配与单一路径约束**：支持 CodeArts IDE 动态工具注册体系；严格确立 `tool_search` 发现工具 → `tool_describe` 获取参数 Schema → `tool_call` 执行的**单一标准路径**；严禁在 Markdown 或纯文本推理中直出 XML 标签，杜绝引擎双重派发；任务单次派发后由客户端安全轮询。
  - **权限管控与终态轮询保障**：遇宿主权限拒绝（Permission Denied / auto-rejecting）时立即终止并返回 `blocked_permission` 与原始 ref，禁止换工具名或经父代理重试；在等待预算内以原 ref 持续轮询 `hub_fetch`，严格以符合验收条件的非空真实 worker 回答判定 `completed`，绝不以会话结束或工具调用成功冒充任务完成。
  - **Windows 官方 CLI 精准识别与环境隔离**：精准识别官方 `installers/bin/codearts.exe`，采用独立 `cli-data` 隔离目录与独立会话数据库，不再与 IDE GUI AgentKernel 混淆；继承外部认证并保持 TLS 校验；将“文件夹未被信任”准确归类为 `CODEARTS_PERMISSION_REQUIRED` 脱敏提示。
  - **Linux 进程生命周期与资源回收加固**：驱动与 Hub 统一进程组管理，确保任务取消与超时时彻底回收所有后代进程，杜绝孤立进程残留。

| 验证项目 | 实际结果 | 状态说明 |
| --- | --- | --- |
| Windows 回归测试 | ✅ 通过 (32组) | 2026-10-10 跟进修复后完整复测通过，包含真实 SDK 0.1.21 协议验证；非全量付费模型实测证明 |
| Linux 回归测试 | ✅ 通过 (29组) | 同一冻结源码完整复测通过，包含真实 SDK 0.1.21 协议验证；非全量付费模型实测证明 |
| Linux 生产 Hub 0.9.4 | ✅ 通过 | 暴露 24 个 Hub 工具与 9 种 worker，已有配置、任务历史与鉴权平滑保留 |
| Linux Antigravity CLI 1.3.1 | ✅ 真实调用通过 | gemini-3.8-flash-medium 精确标记通过，插件模式校验通过（4技能/9代理/1MCP）；真实模型调用 `hub_status` 成功返回 9 种 worker，完整原生子代理 `hub-mimocode` 派发成功（返回 `ref=mimocode-79e2416c91`，`completed`，`answer=95`） |
| Linux ZCode CLI 0.16.9 | ✅ 真实调用通过 | 原生 `agenthub-workers:mimocode` 子代理经插件派发，原 ref 续查返回 `73` |
| Windows Codex / ZCode | ✅ 真实调用通过 | 两种原生子代理分别返回 `2117`、`2077`；初轮长标记回答不完整的记录也保留 |
| Windows DSH | ⚠️ 账号余额受阻 | 10 个预设、7 个 MCP 工具及工作流注册通过；实际模型调用返回 `402 ACCOUNT_QUOTA` |
| Windows Antigravity | ✅ 真实调用通过 | 修复本地 client.json 缺失与 MCP 连接动态重试机制；实测通过 hub_status / hub_capabilities 实时返回 9 种 Worker 在线与能力状态 |
| Linux Codex & DSH CLI | ❌ 未安装 (not_installed) | Linux 实机未找到 CLI 可执行文件，未执行实测，不作通过宣称 |
| CodeArts 原生组件与通道 | ✅ 通过 | Windows 正式内核识别组件；Linux CLI 原生文件及 MCP 已安装校验通过；Windows ↔ Linux 局域网直连与 SSH 通道建立正常 |
| Windows CodeArts IDE | ⚠️ 原生派发通过，结果回收受权限限制 | DeepSeek v4.1 Flash 真实调用 `hub-mimocode`，唯一回执 `mimocode-d5f1337f8a`；Linux 实际答案为 `45`，但 IDE 后续 `hub_fetch` 被宿主拒绝，不计为完整验收 |
| Linux CodeArts 自身模型调用 | ✅ 官方模型真实任务秒级通过 | 自动加载凭据环境；显式 GLM-5.2 与 GLM-5.2-ArkTS-SPARK 派发秒级返回完成，回执真实有效，核验 driver 与 CLI 共用进程组，完成后所属进程全部安全退出 |
| Windows 独立 CodeArts CLI | ⚠️ 尚未通过模型验收 | 已修复官方 exe 发现及 CLI 专用配置；独立目录探针受到文件夹信任限制，不替代已登录 IDE 的使用状态 |

> **边界与差异说明**：
> 1. **回归测试 ≠ 全量付费实测**：Windows 32 组与 Linux 29 组回归通过为框架逻辑与离线回归，不能视为每个服务商、模型或原生宿主均已跑通真实付费任务。
> 2. **原生插件 vs 可选 Python SDK**：Antigravity 原生插件基于声明式配置直接接入 MCP 桥与子代理，已跑通真实模型调用与原生子代理派发；而可选 Python SDK 为外部编排库，当前 wheel 无 `beta.run_workflow`，且其 API 鉴权与宿主登录隔离。
> 3. **实机未安装环境如实报告**：Linux 实机未安装 Codex 与 DSH CLI，标记为 `not_installed`，不虚报通过。
> 4. **CodeArts 鉴权与调用边界**：IDE 登录不代表独立 CLI 具备调用条件，已有 9router 登录也不能替代华为账号权限。当前 worker 仅开放默认思考与非流式文本；未生效的配置不会替换用户原默认模型。
> 5. **本地与网络隐私**：客户端选定单个 Hub 并非跨 Hub 联邦；提示词与附件在调用对应 worker 时仍会发送至官方模型服务商。

完整任务回执、源码哈希、失败记录及修复后两端各 83 项增量检查见 [0.9.9 验收记录](docs/release-0.9.9.md)。

CodeArts 的 IDE 优先适配、官方认证修复及后续测试见 [2026-10-10 跟进记录](docs/codearts-ide-followup.md)。这些修复属于发布后跟进，原 `v0.9.9` 标签及已构建 ZIP 保留原内容。

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

### CodeArts 换工作区后连接 Hub

CodeArts IDE (26.9.501) 按当前工作区加载 `.codeartsdoer/mcp/mcp_settings.json`。切换新项目时，无需重新输入 Hub Token 或启动本机 Hub，直接复用外部 `client.json` 即可一键登记：

```powershell
# 针对当前新工作区登记 IDE MCP 设置
python integrations/codearts/install.py --config "$env:LOCALAPPDATA/AgentHub/client.json" --ide-settings "C:/Work/new-project/.codeartsdoer/mcp/mcp_settings.json" --target ide --apply
```

登记后在 IDE 中执行“开发人员：重新加载窗口”，即可通过 `/hub-status` 验证连接与 Worker 可用性。详见 [CodeArts 原生包文档](integrations/codearts/README.md#换工作区后连接-hub)。

---

## 🚀 快速上手与一键安装 (Quick Start)

为满足不同开发者的使用习惯，项目提供极简的场景化接入方案：

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        按需选择最适合你的安装方式                       │
├────────────────────────────────────────────────────────────────────────┤
│ 1. 最省心 · 本机一键安装   → 双击 install.cmd / bash install.sh (开箱即用)│
│ 2. 任意 AI 客户端直连     → 填入 http://127.0.0.1:8790/mcp (10 秒接入)   │
│ 3. 跨机部署 (服务器+个人端) → 服务端跑 Hub，客户端连过来 (局域网/SSH 均可)  │
│ 4. IDE 图形扩展一键导入   → 导入 CodeArts / VS Code .carts / .vsix 扩展 │
└────────────────────────────────────────────────────────────────────────┘
```

---

### 方案一：最省心 · 本机一键安装（开箱即用，推荐 ⭐⭐⭐⭐⭐）

> **适合场景**：在单台电脑（Windows 或 Linux）上进行开发，希望一键配齐 Hub 服务、WebUI 控制台及已有的 IDE 插件。

#### 步骤 1：获取项目代码
- **方式 A（Git 克隆，推荐）**：
  ```bash
  git clone https://github.com/Johhny-Xu/multi-agent-hub.git
  cd multi-agent-hub
  ```
- **方式 B（下载 Release 打包）**：
  从 [Releases](https://github.com/Johhny-Xu/multi-agent-hub/releases) 下载 `agenthub-0.9.4-both.zip` 并解压。

#### 步骤 2：一键执行安装并启动
- **Windows**：直接双击根目录 **`install.cmd`**（或在终端运行 `.\install.cmd`）；
- **Linux**：在终端执行 **`bash install.sh`**。

> 💡 **全自动诊断与注册**：安装器会自动检查环境、安装 Hub 服务与 Web 控制台，并自动探测注册当前机器上的 Codex、ZCode、DSH、CodeArts、Antigravity 原生插件与专属子代理。

#### 步骤 3：立即开始使用
- 浏览器访问 **`http://localhost:8890`**，即可直接进入三栏式 Web 控制大盘；
- 或在您已安装的 IDE 中，直接呼出子代理开始对话派发；
- **日常启停控制**：日常使用可直接双击或运行 `start.bat`（Linux：`bash start.sh`），停止运行 `stop.bat`（Linux：`bash stop.sh`）。

---

### 方案二：免装插件 · 任意 AI 客户端 10 秒接入（MCP 直连 ⭐⭐⭐⭐⭐）

> **适合场景**：使用 Cursor、Claude Desktop、Windsurf、VS Code (Cline / Roo Code / Continue) 等任意支持 MCP 的宿主，无需安装任何扩展或插件。

只需在本机启动 Hub 服务后，将标准 HTTP MCP 端点提供给客户端：

- **MCP 端点**：`http://127.0.0.1:8790/mcp`
- **更舒服的方式**：打开 Web 控制台（`http://localhost:8890`），在“子代理接入端点”卡片直接点击 **【复制本文（发给Agent配置）】**，把复制出的提示词直接发给 AI 助手，Agent 将自动帮你写入客户端的 MCP 配置文件！
- **手动 JSON 配置参考**：
  ```json
  {
    "mcpServers": {
      "multi-agent-hub": {
        "url": "http://127.0.0.1:8790/mcp"
      }
    }
  }
  ```

---

### 方案三：跨机器部署（服务端与客户端分离）

> **适合场景**：在家庭服务器、NAS 或云服务器（Linux / Windows）上集中运行 Hub 和 9 种 CLI Worker，在另一台个人电脑上编写代码。

#### 步骤 A：服务端安装并启动 Hub
```bash
# 在服务端执行，监听局域网地址并开启 Web 控制台
bash install.sh --component hub --bind 0.0.0.0 --port 8765 --with-console
```
*注：安装器会自动生成外部强随机连接安全令牌文件 `hub-token.txt`。*

#### 步骤 B：客户端安装原生插件并配对连接
```powershell
# Windows 客户端指定目标服务器与 Token 完成配对
.\install.cmd --component plugins --url http://SERVER_IP:8765/mcp --token-file C:\private\hub-token.txt
```
- **自动广播发现**：客户端初次安装若未指定 `--url`，会自动通过 UDP 广播扫描局域网内的候选 Hub，交互式选择即可完成配对；
- **随时重选 / 切换 Hub**：后续在客户端运行 `connect.cmd`（Linux: `./connect.sh`），即可重新发现或切换目标 Hub；
- **SSH 反向通道**：两台机器不在同一局域网时，可通过 SSH 反向映射端口（例如 `ssh -N -R 127.0.0.1:18765:127.0.0.1:8765 user@SERVER`）穿透内网。
- **Linux 常驻守护**：Linux Hub 服务可加 `--systemd-user` 参数注册为标准用户级 systemd 后台服务。

---

### 方案四：IDE 图形扩展 / MiniMax Plugin 一键导入

> **适合场景**：习惯使用 IDE 图形化扩展管理器或 MiniMax 插件中心导入的开发者。

- **华为 CodeArts / VS Code 桌面扩展**：
  1. 获取扩展安装包：`multi-agent-hub-0.9.4.carts`（CodeArts IDE 专属）或 `.vsix`（VS Code 及兼容编辑器）；
  2. 在编辑器的“扩展”管理面板选择“从 VSIX/CARTS 安装...”导入；
  3. 安装完成后自动注入侧边栏状态大盘面板、指示灯以及工作区 MCP 规则。
- **MiniMax Code / MiniMax Agent 官方插件包（MiniMax Plugin V1）**：
  - 直接导入 `agenthub-workers-0.9.4-minimax-plugin.zip`（ZIP 根目录直接包含 `.minimax-plugin/plugin.json`、`hub-bridge.mcp.json` 与 `skills/dispatch-hub/SKILL.md`），或指向仓库子目录 `plugins/agenthub-workers`（同时兼容 `.claude-plugin/plugin.json`、`.zcode-plugin/plugin.json` 与 Agent Plugins 1.0）。

---

### 📦 预打包文件与运行依赖

| 安装包 | 适用环境 | 包含内容 |
| --- | --- | --- |
| **agenthub-0.9.4-both.zip** | 客户端与 Hub 均在同一机器运行（最推荐） | 包含全部组件、安装向导、服务管理脚本 |
| **agenthub-0.9.4-plugins.zip** | 仅用于编写代码的客户端电脑 | 多宿主客户端原生插件、MCP 桥接器、子代理与工作流 |
| **agenthub-0.9.4-hub.zip** | 仅运行 Worker 与模型的服务端机器 | Python Hub 服务、9 种 Worker 适配驱动、可选 WebUI 控制台 |
| **agenthub-workers-0.9.4-minimax-plugin.zip** | MiniMax Code 桌面端 / MiniMax Agent 云端 / Marketplace | 符合 MiniMax Plugin V1 规范的零包裹层独立插件包 |
| **multi-agent-hub-0.9.4.carts / .vsix** | 华为 CodeArts IDE、VS Code 及兼容编辑器 | 桌面端图形扩展：一键导入、侧边栏面板、状态指示灯 |

- **运行依赖要求**：
  - **基础运行环境**：Python 3.8+（Codex 代理安装需 Python 3.11+）；Node.js 20+（用于 MCP 桥接与 Web 控制台）；
  - **Worker 模型环境**：依赖各对应服务商的官方 CLI（如 `agy`、`cb`、`trae`、`codearts` 等）及其官方登录态，安装器仅负责环境探针与指令调用，不包含账号注册与自动登录。
- 更多详细高级参数见 [安装包构建与完整参数说明](packaging/README.md)。

---

## Web 控制台与管理大盘 (Console & WebUI)

Hub 提供内置的轻量化现代 Web 管理大盘（在安装或启动时指定 `--with-console` 即可开启，默认运行在 Node.js 服务端口 `8890`，监听 `0.0.0.0` 开放局域网访问）：

- 🎛️ **CodeBuddy 风格三栏式交互大盘**：
  - **48px 极简活动栏**：支持对话、代理状态、任务队列、跨代理共享笔记一键切换，移动端自动下沉自适应；
  - **260px 平台会话管理树**：多平台展开/收起、快速搜索过滤、一键开启新对话、会话标题与消息量直观呈现；
  - **沉浸式中央交互区**：单平台独立会话、模型参数下沉状态栏，右侧支持一键折叠/展开多功能扩展工作台。
- 📦 **全量会话归档聚合与一键批量删除**：
  - 支持跨所有平台聚合历史归档，提供多平台按名称筛选、输入框实时模糊搜索、时间正倒序与消息量排序；
  - 支持会话一键复原至活跃对话树（自动定位并打开）、单条永久删除；
  - 右上角新增**【一键删除】与防误触内联二次确认**（点击切换为“确定全删？”【确认删除】【取消】），保障操作安全。
- 🚀 **子代理原生 HTTP MCP 直连端点与配置生成**：
  - 自带轻量内置 HTTP MCP Server（默认端点 `http://127.0.0.1:8790/mcp`），向任意 AI 宿主开放 `subagent_run`（服务端等待结果，超长产物落盘本地并只返回摘要，不占用会话上下文）、`subagent_result`、`subagent_artifact`、`subagent_agents` 四大核心工具；
  - 控制台提供**【复制 MCP URL】**与**【复制本文（发给Agent配置）】**，一键生成包含工具清单、JSON 接入配置模板与调用引导的完整提示词，直接发给任意 AI Agent（Cursor、Claude、Antigravity、Windsurf、Cline 等）即可全自动完成 MCP 登记。
- 📋 **全网络环境剪贴板健壮回退**：
  - 针对局域网 IP（非安全上下文 `window.isSecureContext=false`）下现代浏览器对 `navigator.clipboard` 的静默拦截，实现原生 Textarea 与 ExecCommand 多层回退保障，全端全环境复制 100% 成功。
- 🔘 **Worker 一键激活/禁用开关 (Subagent Toggle Switch)**：
  - 每个 Worker 卡片内置原生启用切换开关。当某个模型服务商无额度、账号欠费或处于维护调试期时，可随时一键关闭该子代理；状态即时持久化落盘至 `agents.json` 并通过 Hub 调度器向全端生效。
- ⚡ **权威状态双向同步与免派发拦截**：
  - 禁用的 Worker 在 `hub_status` 中明确显示为 `[已禁用]`，`hub_capabilities` 返回 `enabled: false`，在派发任务（`hub_dispatch` / `hub_ask`）时触发秒级前置快速拦截（`profile_disabled`），杜绝因误调用产生无谓等待与额度报警。
- 🌟 **智能时段问候、头像定制与社区互动**：
  - 内置 7 大精细时段共 35 句暖心关怀问候语，每次进入或切换平台自适应随机呈现；
  - 点击头像即可选择本地图片实现跨平台全局头像替换并持久化同步；
  - 底部优雅轻量页脚：左侧开源致意（“好好吃饭更重要哦”彩蛋）、中间 GitHub Star 一键直达、右侧当前版本号（`v0.9.4`）显式标注。
- 🎛️ **监控状态栏自定义面板与模型抽屉**：
  - 底部状态栏新增自定义指标控制面板，支持一键呼出多选面板，按需勾选或隐藏实时监控项（包括子代理、模型、网络延时、吞吐 TPS、会话 Token、平台额度等）；点击状态栏模型标签即可平滑呼出参数面板，支持分级思考强度（`low` / `medium` / `high` / `max`）调节。
- 🏷️ **官方积分倍率与福利标识**：
  - 深度适配 TraeCode、CodeBuddy-CN 等平台的积分倍率显示，直观呈现 `0.06x ~ 2.00x` 换算比率，以及 `[会员 5 折]`、`[限时 1 折]`、`[专属补贴]` 等专属视觉标签。
- 💳 **实时额度与通道余额监控**：
  - 支持自动解析并呈现 MiniMax、9router 等上游通道的剩余积分与调用配额。

---

## 统一工具与能力约束

宿主插件对外统一暴露 **7 个 MCP 核心工具**：
`hub_ask`、`hub_dispatch`、`hub_fetch`、`hub_status`、`hub_capabilities`、`hub_login`、`hub_discover`。

所有宿主（Codex 代理/技能、ZCode 代理、DSH 预设/工作流、CodeArts 子代理、Antigravity 技能/代理）遵循同一套任务契约：

| Worker | 默认配置模型 | 平台特性、目录收敛与倍率规则 |
| --- | --- | --- |
| **Antigravity** | gemini-3.8-flash-medium | 精简保留 3.8 Flash (High/Medium)、3.1 Pro High、Claude 4.6 (Sonnet/Opus) 等 6 款旗舰；支持多模态与标准工作流（作为 Worker 角色；Antigravity 原生客户端为宿主角色） |
| **CodeBuddy** (国内版) | deepseek-v4.1-flash (x0.11) | 剔除生图及老旧模型，精炼至 DeepSeek V4.1/Pro、MiniMax-M3、GLM-5.3/5.2/5.1、Kimi-K3/K2.8/K2.7、混元系列等 13 款代码模型，完整标注官方积分倍率（x0.06 ~ x2.00）与试用标 |
| **CodeBuddy** (国际版) | deepseek-v4.1-flash | 精简收敛至 18 款主流高可用模型；文件工具需实际权限，使用标准代理隔离上下文 |
| **GitHub Copilot** | auto | 沿用官方 CLI 选型 |
| **MiMo** | xiaomi/mimo-v2.6-flash (26f) | 精炼收敛为 MiMo-V2.6 Flash/Pro/UltraSpeed 及 9router/trae 通道共 4 款高效选型 |
| **MiniMax** | MiniMax-M3.1-Flash-Preview | 精简收敛为 M3.1 Flash（512K/1M）与 M3（1M 上下文）当季双旗舰；支持 9router 通道积分余额展示 |
| **TraeCode** | GLM-5.3-FlashX (0.31x) | 精简收敛至 20 款官方模型，精准标注 `0.06x ~ 1.50x` 官方积分倍率与 `[会员 5 折]`、`[限时 1 折]`、`[专属补贴]` 营销标识 |
| **ZCode** | GLM-5.3-Flash | 显式思考切换与未验证正文流式默认禁用 |
| **CodeArts** | GLM-5.2 (0.70x) | 完整保留 4 款企业级官方模型（`GLM-5.2`、`GLM-5.2-ArkTS-SPARK`、`OpenPangu-2.0-Pro`、`OpenPangu-2.0-Flash`）；支持 Linux CLI 自动加载 AK/SK、IDE 动态工具协议与独立数据隔离 |

上表是新安装的默认配置。已有服务器保留原模型；本轮 Linux MiMo 实测使用其既有 `9router/trae`，不代表 `26f` 已实测。

- **输入文件限制**：`files` 参数传输客户端本地文件内容并在 Hub 端暂存，限制最多 8 个文件、总量不超过 1 MiB。
- **工作目录说明**：`cwd` 指 **Hub 所在主机**的工作目录，不会静默映射客户端路径。
- **结果与任务跟踪**：任务受理后返回持久化 `ref`，客户端凭 `ref` 通过 `hub_fetch` 轮询结果，无需重复派发。Hub 拒绝空回答、已知超时及未完成的工具协议；`completed` 表示任务执行完成，答案是否正确仍需调用方按任务要求验收。
- 更多详细参数规范见 [任务选项说明文档](docs/task-options.md)。

---

## 数据流向与安全规范

- **真实数据链路**：`宿主客户端 → 本地 MCP 桥 → 目标 Hub → 官方 CLI / 内核 → 模型服务商 API`。
- **透明无隐瞒**：自托管 Hub 仅作为任务路由与执行代理，不代表离线私有模型；提示词与附件会随官方 CLI 调用发往各服务商。
- **安全凭据隔离**：客户端与服务端的认证 Token、各厂商 API Key、会话数据均存放在仓库源码之外的独立安全目录中，绝不签入 Git。
- **传输安全**：HTTP Bearer Token 仅负责身份鉴权；在跨公网或不可信网络通信时，务必配合 HTTPS 反向代理、VPN 或 SSH 隧道进行链路加密。

---

## 版本演进与开发调试

当前 0.9.4 版本重点攻坚 MiniMaxCode 深度适配与 WebUI 前端优化，平滑演进连接引导与全量会话归档管理：

![multi-agent-hub 0.9.4 进度图：当前重点攻坚 MiniMaxCode 适配与前端优化，展示已有基础、后续优化、版本演进和实际验证范围](docs/roadmap.svg)

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
- [CodeArts IDE 优先适配与实测跟进](docs/codearts-ide-followup.md)
- [CodeArts 接入已有模型路由](docs/codearts-custom-provider.md)
- [Antigravity 原生插件与可选 SDK](integrations/antigravity/README.md)
- [网络自动发现与配对验收报告 (v0.8)](docs/release-0.8.md)
- [独立安装包与分发说明](packaging/README.md)
- [统一任务选项与参数定义](docs/task-options.md)
- [版本历史与检查点记录](docs/version-history.md)
- [版本更新日志](CHANGELOG.md)
- [Codex 插件与子代理集成](integrations/codex/README.md)
- [ZCode 原生插件集成](plugins/agenthub-workers/README.md)
- [DSH 预设与工作流集成](integrations/dsh/README.md)
- [CodeArts 原生插件与命令集成](integrations/codearts/README.md)
- [CodeArts IDE & VS Code 桌面扩展 (CARTS / VSIX)](integrations/vscode/README.md)

---

## 致谢与鸣谢

- 🎨 **品牌矢量图标与头像规范**：特别感谢 [LobeHub / Lobe Icons](https://github.com/lobehub/lobe-icons) 开源项目提供的精致高品质科技与 AI 品牌 SVG 图标，为本项目 Web 控制台及各子代理的头像视觉体系提供了美观、规范的原生矢量支持；
- 🤖 **各平台官方内核与开发者生态**：感谢 Huawei CodeArts、Google Antigravity、Tencent CodeBuddy、GitHub Copilot、Xiaomi MiMo、MiniMax、ByteDance Trae、Z.ai 等官方提供的 CLI 内核与开放生态；
- 💖 **开源社区支持**：感谢所有在多模型融合调度、跨平台原生接入与 Web 控制台优化中提供反馈与建议的开发者们！

---

## 开源协议

本项目遵循 [Apache License 2.0](LICENSE) 开源协议（允许使用、修改与分发，衍生作品须保留原作者版权声明、许可证文本及修改说明，并包含专利授权与商标保护条款）。

