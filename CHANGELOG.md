# 更新日志 / Changelog

本项目的所有重要更改都将记录在此文件中。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

版本日期为 Git 发布日期；实现、测试和构建记录保留各自实际日期。源码标签与安装包附件分开管理，ZIP 尚未上传远程 Release。检查点来源见 [版本记录](docs/version-history.md)。

## [0.5.0] - 2026-10-09

本标签恢复 2026-10-08 的 stage01 源码检查点。该备份已包含标为 0.6.0 的 Codex 适配初稿；保留原始代码与组件版本，不声称它是当时单独打包的正式 0.5.0 安装版。

### 新增 / Added

- `hub_login` 和 `/hub-login` 获取官方 CLI 授权链接、查询登录状态或取消等待；凭据由官方 CLI 留在 Hub 宿主机。
- Windows worker 配置模板及 8 worker 兼容性实测记录。CodeBuddy 国际/国内版账号目录隔离；MiniMax 使用实测模型，MiMo 默认 `xiaomi/mimo-v2.6-flash`（`v2.6f`）。
- Windows ConPTY 登录与 Job Object 子进程管理；MiMo 自动获取官方链接，未验证链接登录的通道返回人工操作指引。

### 此检查点包含的后续适配初稿


### 新增 / Added

- Codex 本地插件适配：共享 MCP 桥、8 个项目子代理 TOML 模板、并行调研/实施审查/多模型会诊技能，以及隔离安装预览。
- DSH 子代理与工作流适配：Cordis bundle、三个原生 `agent`/`parallel` 工作流和直接调用 Hub 的确定性 Node runner。
- 任务状态、文件锁、MCP、控制台、安装器与工作流的回归用例；测试采用隔离配置与 mock Hub，不重复消耗厂商模型额度。

### 修复 / Fixed

- MCP 桥正确识别同步 `exit=0` 成功和非零退出；空输出不再自动重复派发。派发断网返回 `unknown`，查询断网保留 ref，等待预算覆盖派发过程。
- 合并 MCP 多个文本块，检查 HTTP/JSON-RPC/tool `isError`，验证请求、参数及返回 ID；通知不触发工具执行。
- 任务仅允许认领者完成；统一 worker 别名并正确解析字符串 `false`。邮箱每次仅标记实际返回的 50 条消息，保留剩余未读。
- 状态锁改为有界的操作系统文件锁；Hub 与 worker 共享原子结果更新，避免并发丢失字段、旧快照回收新进度及进度覆盖终态。外部 ref/邮箱名称限制在状态目录内。
- Windows npm shim 使用子进程 PATH 并解析官方入口；相对脚本路径在切换工作目录前固定。进程组/Job Object、ConPTY、读流和登录取消统一回收。
- 异步 CLI 结果保留真正的 worker 名称与任务上下文；后台等待线程及时回收已结束的执行器。
- Trae HTTP 请求使用可终止的独立进程，GUI 与 CLI 使用有效的执行超时；ZCode 非零退出返回错误。Trae 非终态响应不再伪装为完成。
- Trae 独立 MCP 复用总线运行时与 HTTP 修复，通知返回明确空正文长度，支持异步 ref 查询及 Authorization 预检。
- 控制台预先占用正在发送的会话，拒绝无效显式会话 ID，按任务 ID 归属回信；重启后继续查询 pending ref，静态目录定位到实际 console/client。
- 控制台检查 Hub 返回的 JSON-RPC 与工具结果格式，仅从有效受理回执提取 ref；MCP 通知不执行工具，避免正文中的 ref 示例及无 ID 请求触发错误任务状态或派发。
- DSH patch 使用官方 `insert` 格式，避免 bundle/profile 双注册；安装器严格选择 profile，保留用户 persona、环境、URL 与 token。原生工作流校验结构化终态，子代理失败不再算成功。
- 控制台独立启动脚本改为当前仓库路径与环境配置；文档修正桌面驱动原生 WebSocket 需要 Node.js 22+（MCP 桥仍为 20+）。
- Windows 启停器加载 .env、使用 Windows worker 模板、检测可用 Python 和真实服务健康，只停止本目录记录且创建时间匹配的进程。Unix 停止脚本移除全局 pkill，改为核对本目录进程记录。

### 验证边界 / Validation scope

- Windows 隔离回归共 11 组通过，结果与源码 SHA-256 保存于 `docs/refactor-validation.json`；Codex 两种插件入口已用本机 CLI 在临时目录验证加载与 MCP 初始化。
- 本轮验证源码与隔离运行行为；Codex/DSH 适配尚未装入用户正在使用的客户端，未验证宿主内真实模型工作流。
- Windows 厂商兼容性结果保留于 `docs/windows-compatibility.md`：6 个 CLI 完成真实调用；Antigravity 受地区限制，Trae 桌面网关未就绪。此次未重新调用厂商模型。
- Unix 行为采用契约测试/语法检查，未作为 Linux 或 macOS 实机验证。

---

## [0.4.0] - 2026-10-07

### 发展路线图与生态规划 / Roadmap & Ecosystem
- **更新官方发展路线图矢量图 (`docs/roadmap.svg`)**：
  - 清晰标注系统演进 6 大阶段（Phase 1~3 已就绪、Phase 4 积极适配中、Phase 5 暂缓搁置·排在 DSH 后推进、Phase 6 规划中）；
  - 核心明确：优先做好 Windows 本地开箱即用体验（Windows-First），全力攻坚 DeepSeek Harness (DSH) 原生生态；Linux 复杂服务化启动暂时搁置，排在 DSH 适配之后、Codex 适配之前集中重构。
- **开源跨平台解耦与极简按需配置支持 / Cross-Platform Decoupling & Minimal Setup**：
  - 彻底清除历史硬编码路径与特定系统解释器路径（`/usr/bin/python3`、`/usr/bin/node`、`~/agent-hub`、`~/TraeClaw`），全面切换为动态自包含解析与 `sys.executable`；
  - 优化 Windows 与 Unix 跨平台异步进程组生命周期管理，避免僵尸进程；
  - 增强 TraeClaw 网关异常捕获与友好降级提示，杜绝未启动网关时崩溃抛错；
  - 提供 `hub/agents.minimal.example.json` 极简模板，支持仅配置 MiniMax 与 Trae 等任意 1~2 个 Agent 的轻量环境，未安装的 Agent 完全零干扰。
- **深度完善 ZCode 官方插件与工作流集成 (`agenthub-workers`)**：
  - 完善 8 大子智能体原生注册与自然语言缩写自动路由映射；
  - 借助 `hub-bridge` MCP（`hub_ask`、`hub_dispatch`、`hub_fetch`）彻底破除工作流 30 秒超时上限；
  - 坚决保障所有交付物免服务器单文件直接双击运行。
- **DeepSeek Harness (DSH) 原生生态积极适配推进中 / DSH Active Adaptation**：
  - 在 `integrations/dsh/` 提供 Cordis 微内核架构原生子代理预设（Presets）与工作流（Workflows）工程化源码；
  - 当前全面开展 Cordis 多 Profile 环境隔离与平滑注入测试。
- **规划 Codex 生态打通 (Phase 5 / Planned)**：
  - 规划跨平台双向智能体总线与流式上下文集成。

### 重构与升级 / Major Refactor & Upgrade
- **项目正式升级为 Multi-Agent Hub（`multi-agent-hub`）**：
  - 品牌与架构由分散组件全面进化为“一站式多智能体调度与协作总线”。
  - 提供根目录一键启动与停止工具（`start.sh` / `stop.sh`、`start.bat` / `stop.bat`），单命令并发拉起任务总线、Web 控制台并完成健康检查。
  - 统一根目录 `.env.example` 配置中心，集中管理总线端口、Web 控制台及认证 Token，告别多级子目录割裂配置。
  - Web 控制台全面更名与视觉升格为 `Multi-Agent Hub`。
  - 手机端竖屏排版重构：解决超窄屏下顶部 Header 与工具栏按钮被截断问题，全部操作项 100% 完整可见。

---

## [0.3.2] - 2026-10-07

### 新增 / Added
- **手机浏览器竖屏全响应式支持 / Mobile Vertical Responsive Layout**：
  - 活动栏自适应下沉为原生移动端底部导航栏（Bottom Navigation Bar），带大触控热区与全面屏安全区适配。
  - 顶部栏紧凑收纳（48px 单行），去除冗余副标题，防止小屏挤爆高度。
  - 对话视窗全面中置（860px 舒适阅读柱状区），己方对话右侧锚定、长度由右向左自适应收缩，最大宽度控制在 540px。
- **思维链自动折叠 / Auto-collapsible Reasoning & Thinking**：
  - 自动识别 `<think>` 标签、````thought```` 代码块及后端 `reasoning` 字段。
  - 默认暗调卡片折叠展示，支持一键展开/收起；无思考过程的消息不展示任何多余折叠按钮。
- **工作流 MCP 桥接（hub-bridge）/ Workflow MCP Bridge**：
  - 提供 `hub_ask`（阻塞式单调用出结果）、`hub_dispatch`（秒回 ref）和 `hub_fetch`（状态轮询），彻底解决工作流子代理 30s 框架调用上限问题。
  - 提供配套独立 CLI 脚本 `mcp/ask.mjs`，方便脚本与自动化管线直接调用。

### 修复 / Fixed
- **MiMoCode 非 AVX2 崩溃兼容 / MiMoCode Non-AVX2 Core Dump Fix**：
  - 自动回退至 baseline 版二进制，解决 Intel N5095（Jasper Lake）等老旧 x86 架构无 AVX2 指令集导致 SIGILL 静默无输出的问题。
  - 增加 `--pure` 选项解除外部插件循环递归，配合 9Router 解决上游 SSE 空轮次截断问题。
- **SVG 图标命名空间隔离 / SVG Unique ID Scoping**：
  - 为动态插入的品牌 SVG 注入实例唯一 ID 后缀（uid），根治多个相同 SVG 重复定义导致 `mask` / `linearGradient` 引用失效的渲染黑块问题。
- **界面排版去杂 / UI Clutter Cleanup**：
  - 子代理页面隐藏底层开发调试参数（CLI 路径、model_arg、心跳提示等），移除顶部冗余 KPI 空白卡片。
  - 右侧边栏多余的 `«` 浮动把手彻底移除，统一由常驻“工作台”按钮控制展开与收起。
  - 模态框增加“恢复默认”快捷按钮，方便一键重置自定义头像。

---

## [0.3.0] - 2026-10-06

### 新增 / Added
- **多通道并发调度工作流 / Multi-agent Fanout Workflow**：
  - 推出全局工作流 `hub-fanout`，支持跨多代理并发分发、结果阻塞汇总与统一报表输出。
- **无头模式防封体系 / Ban-free Headless Architecture**：
  - 采用各家官方 CLI 的无头参数（`-p` / `text chat`）与本地 CDP 桌面驱动，杜绝逆向反代与非官方 API 封号风险。

---

## [0.2.0] - 2026-10-06

### 变更 / Changed
- **8 大代理规范化命名体系 / Standardized 8-Agent Registry**：
  - 统一收敛为标准规范名：`zcode`、`antigravity`、`codebuddy`、`codebuddy-cn`、`mimocode`、`github-copilot`、`minimaxcode`、`traecode`。
  - 枢纽内置双向别名自动归一（支持 agy, cb, cbcn, mimo, gcp, mmx, trae 简写）。

---

## [0.1.0] - 2026-10-05

### 新增 / Added
- 初始版本发布：
  - `hub/agent_hub.py`：基于 JSON-RPC MCP over HTTP 的任务总线。
  - `console/server.mjs`：CodeBuddy 风格三栏 Web 控制台。
  - `drivers/*.js`：基于 CDP 驱动 VNC 桌面 AI（ZCode, TraeCode）执行管线。
