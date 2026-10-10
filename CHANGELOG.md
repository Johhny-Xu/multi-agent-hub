# 更新日志 / Changelog

本项目的所有重要更改都将记录在此文件中。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

版本日期为 Git 发布日期；实现、测试和构建记录保留各自实际日期。源码标签与安装包附件分开管理，是否上传附件以各版交付记录为准。检查点来源见 [版本记录](docs/version-history.md)。

## [Unreleased]

### CodeArts IDE & VS Code 扩展包 (.carts / .vsix)

- 新增 CodeArts IDE 与 Visual Studio Code 通用桌面扩展 (`integrations/vscode`)，支持通过 IDE 图形界面“从 VSIX/CARTS 安装...”一键导入，免除命令行脚本配置。
- 提供侧边栏专属视图（Hub 连接与健康状态、9 种 Worker 适配大盘、快捷发现与管理）以及底部状态栏实时指示灯（在线/延时提示）。
- 插件随 IDE 启动自动检测当前工作区，无感为云码道（CodeArts Agent）注入/更新 `.codeartsdoer/mcp/mcp_settings.json`，彻底解决切换项目需手动登记的痛点。
- 新增 `packaging/package_extensions.py` 打包脚本，遵循 VSIX OPC 规范，一键构建并校验 `multi-agent-hub-0.9.9.vsix`、`multi-agent-hub-0.9.9.carts` 和 `multi-agent-hub-0.9.9.cloudide`，输出至 `integrations/vscode/dist/` 与桌面发布目录。

### CodeArts IDE 接入体验

- 修复 Windows 官方 CLI 的发现：驱动和一键安装器识别 `installers/bin/codearts.exe`，避免只发现 `.cmd` 后误选 IDE AgentKernel。直接运行官方 exe 时使用 CLI 专用配置及 `cli-data` 环境，保留外部认证和独立任务数据库，不关闭 TLS 校验。
- 安装结果展示稳定插件目录、版本及每个 MCP 配置路径；明确当前工作区登记、宿主重载与真实工具调用的区别。独立安装器使用默认 IDE 路径时提示尚未核实当前工作区，CLI-only 安装不会提示配置 IDE。
- 补充新工作区复用既有 Hub 连接的步骤，并将官方“文件夹未被信任”诊断识别为权限受阻，保留脱敏错误且不修改信任设置。
- CodeArts 原生代理明确区分直接注册与懒加载 MCP 的调用方式，等待原 ref 的终态并核对真实答案；权限拒绝后停止该动作，不再改工具名或重复请求。
- 修复 Linux CodeArts 驱动另建进程组导致外层取消无法回收后代的问题：仅在确认 Hub 进程组归属时继承外层组，独立运行仍隔离并清理自己的组。真实进程夹具覆盖取消、超时、父进程先退出和无关进程保护。
- 修复 Windows 服务归属查询失败被误判为停止的问题：元数据查询最多重试两次，持续失败报错并保留进程记录；身份不匹配仍拒绝接管或停止。新增服务身份确认失败时清理已持有的直接子进程。
- Windows 已登录 IDE 真实查询 Hub，并以 DeepSeek v4.1 Flash 原生子代理派发 MiMo；远端答案 `45`，IDE 后续结果查询受宿主权限限制。Linux CodeArts 显式 GLM-5.2 返回 `51`；部署修复后新单次任务返回 `52`，核验组归属与进程回收。此前超时保留为失败。详情见 [IDE 优先适配与实测](docs/codearts-ide-followup.md)。
- 最终 Windows 32/32 组、Linux 29/29 组回归通过，两端真实 SDK 0.1.21 协议验证通过。Linux 已同步 27 个源码文件和 CodeArts 原生组件；6 份受保护配置与 355 个旧任务结果逐字节校验未变。
- 本轮修改属于 v0.9.9 发布后的跟进，既有标签和安装包保持原版本内容。

## [0.9.9] - 2026-10-09

Hub、安装包、共享 MCP 和 Codex / ZCode / CodeArts / Antigravity 插件统一为 0.9.9；DSH 独立包为 1.4.0。Windows 32/32 组、Linux 29/29 组全量回归通过，后续修复通过对应增量验证并同步 Linux Hub；原生客户端实测及账号限制见 [0.9.9 交付记录](docs/release-0.9.9.md)。

### Antigravity 原生客户端与 SDK 子代理

- 新增第五种原生客户端 Antigravity：按桌面 2.21.1 的插件规范提供 manifest、SVG、九个 `agents/*.md` 路由子代理、四个 slash workflow skills 与独立 MCP 桥。沿用现有九种 worker，插件可连接独立的 Windows/Linux Hub。
- 新增原生目录安装器及一键安装包入口，支持自动发现、外部连接文件、幂等升级、归属哈希、冲突保留、备份及失败回滚；新目录需要重启宿主发现，文件安装不冒充宿主已加载。SDK 运行环境不会进入插件包。
- 增加可选 `google-antigravity==0.1.21` 适配，使用官方 `LocalAgentConfig`、`SubagentConfig`、MCP 与 Hooks，由 Python 有界编排 SDK 子代理。官方 Windows 轮子实测不含仓库示例中的 `beta.run_workflow`，按实际已发布能力实现；SDK 认证与桌面登录分开。
- Hub 为同步及异步 CLI 任务传入真实 worker 身份，六份 MCP 桥统一阻止 worker 派发给自身，同时保留普通客户端、跨 worker 派发和原 ref 查询。
- 修复 Windows venv Python 启动 Hub 时监听 PID 位于子解释器而被误判启动失败的问题；健康检查验证真实后代归属，停止按创建时间与固定进程实例筛选，不误停旧 PPID 外来进程，停止失败保留记录并返回失败。Linux 发现测试隔离已有 Hub，避免把正常发现的生产服务当成失败。
- 修复 Linux agy CLI 1.3.1 的 print 超时被误报成功：即使退出码为 0、JSON 为 `SUCCESS` 且已有部分文字，检测到官方明确的未完成诊断仍返回失败并保留原 ref。同步与异步均覆盖，异步有界扫描完整 stderr，避免后续长日志掩盖诊断；两端各 83 项增量检查通过，修复已同步 Linux 服务。
- Antigravity 接入阶段先保留当时的 README，独立说明和验收边界写入 `integrations/antigravity` 与 `docs/antigravity-compatibility.md`。0.9.9 的 README 更新和 Linux 原生验收另行记录，不改写这一阶段的报告。
- 接入阶段最终 Windows 32 组、Linux 29 组回归全部通过，两端测试源码哈希一致；保留初始失败及修复记录。Windows 原生组件已安装，新增桥跨机器真实 MiMo 默认任务返回 42；宿主模型自主调用和缺少独立 API 认证的 SDK 推理未验收。基础版本 0.9.0 的三种 ZIP 是未发布预览包；0.9.9 的回归与包校验使用新的独立报告。

### 发布与部署

- 安装包提供五种客户端与现有九种 worker；客户端、Hub 与可选 SDK 保持独立组件。SDK 源码随插件包分发，虚拟环境、认证文件、私有连接和模型会话不进入包。
- Windows Codex、ZCode 与 Linux ZCode、Antigravity 的真实原生子代理派发通过，宿主工具记录与 Hub 回执匹配。Windows DSH 受 402 额度限制，Linux 未安装 Codex / DSH，Windows Antigravity 桌面重启后的自主调用待验证，各项单独记录。
- Linux 生产 Hub 0.9.9 的 24 工具、9 worker、鉴权和历史结果检查通过，既有私有配置逐字节保持，每次切换前提供回滚备份。README 和两张 SVG 由 Linux agy 实际修改后核对事实与排版。
- 修复 CodeArts 官方两列模型列表及短模型 ID 的解析，两端各 22 项回归通过。9router 鉴权有效，但不能替代 CodeArts 独立身份及模型权限初始化；真实模型仍受认证阻止，尝试后的三份私有配置已恢复，未计为模型验收成功。

---

## [0.9.1] - 2026-10-09

`v0.9.1` 源码标签包括已推送的 CodeArts 实现与随后 README、SVG 的体验说明更新；该阶段运行组件仍为 0.9.0，未单独创建 `v0.9.0` 标签。

### CodeArts 双向接入（0.9.0 实现阶段）

- 增加华为 CodeArts 第九种 worker，支持 Windows IDE 内置 AgentKernel 与 Linux 官方 CLI 的自动发现、独立任务、模型目录校验和严格结果判定。退出码 0 但认证失败、无 provider、空回答或未确认完成均不会算成功。
- 增加 CodeArts 原生 Hooks 插件、九个子代理、三个命令、调度技能与独立 MCP；分别适配 IDE `mcpServers` 和 CLI `mcp` 配置，安装前备份并保护用户修改。
- Codex、ZCode、DSH 增加 CodeArts 路由；四种客户端共用任务和结果协议，可连接另一台 Windows/Linux Hub。安装器与三种分发包增加 CodeArts。
- 当前默认仅开放默认思考、非流式文本任务。CLI 的 `--thinking` 是显示开关，JSON 文本按完成块输出，图片 MIME 也未证明可用；相应选项关闭。模型默认沿用官方 CLI 配置，不猜测账号可用型号。
- 实测发现 Windows IDE 登录不能证明独立内核已配置 provider；Linux 26.9.12 非交互 CLI 要求独立认证。原生安装、通信验证与真实模型完成分开记录，详细边界见 `docs/codearts-compatibility.md`。此实现阶段没有独立 Git 标签，源码包含在后续 `v0.9.1` 标签中。
- 已在两端安装原生组件；Linux Hub 升级至 0.9.0，保留原 worker、历史任务、鉴权并提供回滚备份。Windows→Linux 局域网、Linux→Windows SSH 反向通信通过；CodeArts MCP 桥派发 MiMo 单次任务得到真实答案。CodeArts 自身模型调用仍因上述官方认证/provider 问题受阻。
- Windows 全量 26 组回归通过；Linux 首次全量的打包测试夹具错误已修复，最终六组增量和同步后的驱动测试通过，报告保留各轮覆盖范围与源码哈希。原生安装器支持工作区 IDE MCP 路径，未提供时明确标为待配置，不误报安装生效。
- README 增加当前四种宿主/九种 worker 架构、CodeArts 两端安装示例与实测表；明确源码推送、版本标签和 Release 附件的状态，并将 0.8 SVG 标为历史范围。

### 文档 / Documentation

- 更新两张 README SVG 至 0.9：结构图置于页面最前，完整展示四种客户端、九种 worker、插件与 Hub 独立部署及跨机连接。进度图突出当前“优化体验”，展示已有能力、后续优化和真实验收边界；使用固定排版与较大字体，避免 Mermaid 缩放裁切。
- 统一项目正式展示名称为 `multi-agent-hub`：README、两张 SVG、控制台标题、原生插件展示信息与相关说明保持一致。既有安装目录、连接配置位置及插件 ID 保留兼容。
- 补齐 0.8 架构 SVG：Codex / ZCode / DSH、hub / plugins / both 独立部署、扫描与配对、7 个工具、8 个默认模型，以及真实的数据流与连接边界；MiMo 标为 26f。
- 更新 0.5–0.8 路线 SVG，纠正 Linux 仍搁置、Codex 尚未适配等旧描述；分别显示回归、网络发现和正式安装包验收范围，并保留 DSH 额度、网络与账号模型限制。
- README 展示两张可缩放矢量图；完成实际浏览器渲染及文字重叠、边界检查。此为后续文档更新，既有版本标签保持原提交。

---

## [0.8.0] - 2026-10-09

### 自动发现与连接选择

- 首次插件安装先扫描本机和局域网 Hub，展示候选让用户选择；没找到时提示手动地址。保留已有连接，非交互安装不会等待输入或静默选择服务器。
- 新增 connect.cmd / connect.sh，支持重新扫描、手动地址和切换；交互配对使用 token 文件或隐藏输入，健康检查与鉴权通过后原子保存外部连接文件。旧配置先私有备份，切换端点不复用另一端 token。
- 新增只读 hub_discover MCP 工具与 ZCode /hub-discover 命令；未配置或连接文件损坏时仍能加载发现工具，任务派发明确拒绝并提示设置连接。
- 修复配置只有 token、没有 URL 时可能回退本机的问题；读取私有配置必须有明确端点，空对象和 token-only 均拒绝派发。
- 实机发现并修复 Windows UDP 10054：本机没有响应导致的单个端口不可达不再结束整次扫描，仍接收其他机器的回复。Windows 两种客户端已通过默认广播自动找到 Linux Hub。
- Hub 新增有界 UDP 发现响应与公开健康元数据；扫描只发送随机查询标识，地址取自回复来源并验证 HTTP 健康，不发送凭据、不跟随重定向、不自动修改防火墙。不支持广播的网络与旧 Hub 保留手动连接。
- Codex/ZCode/MCP 和安装包升至 0.8.0，DSH 包升至 1.2.0；保留原 0.7.0 发布包与分阶段源码备份。
- 最终 Windows 21/21 组、Linux 19/19 组回归通过，测试期间与测试后源码哈希一致；真实默认广播及显式 IP 验证 8/8 通过，详细范围与安装包哈希见 docs/release-0.8.md。
- 正式三个 ZIP 在真实 Linux 安装与配对 54/54 项通过，覆盖非交互待配置、安装后 connect.sh 鉴权配对、三份原生 MCP 副本的 7 工具与只读发现；无新增模型调用。

### 交付记录

- 按 0.5 → 0.6 → 0.7 → 0.8 的独立源码检查点逐版提交与打标签；日期采用实际 Git 发布日，测试记录保留原日期。
- 记录测试 CLI 清理结果：Linux 临时 CodeBuddy 副本已卸载；Windows 8 个临时目标被自动审批拒绝，仍保留，不记作卸载成功。原有客户端和登录配置保持不变。

---

## [0.7.0] - 2026-10-09

### 能力约束与独立部署

- 分开提供 hub / plugins / both 三种可安装 ZIP，Windows / Linux 自动检测运行时与官方 CLI；应用、私有连接配置和运行数据分离。Hub 默认单独运行，控制台可选，客户端不会启动本地 Hub；重复安装保留配置并备份旧应用。
- 四份 MCP 桥统一读取外部 client.json；支持标准 Windows/XDG 路径和显式配置路径，保留 Codex PLUGIN_DATA 兼容。切换 Hub 端点不复用其他端点 token；DSH 不再以默认 localhost/空 token 覆盖配置文件。Codex/ZCode/MCP 版本 0.7.0，DSH 包从 1.0.0 升至 1.1.0。
- 能力查询升级到按 Hub 系统、worker、型号返回可用性。控制台删除没有对应官方参数的伪思考强度/上下文档位；动态禁用不支持的思考、流式和附件，Auto 与各派发入口使用相同服务端预检。
- 最近认证、区域、额度和型号错误使用有期限的结构化状态；手动清除状态不自动调用模型，偶发超时/空答不永久封禁 worker。
- 修复 worker 只存在于 profile 自定义 PATH 时预检误报缺失的问题；预检和派发统一继承环境与变量展开，Windows/Linux 真实临时入口均有回归覆盖。
- 修复 CodeBuddy 继承 lastUsed 代理模式后缺少 Read、只返回未执行 DSML 的根因；使用标准代理和明确的文件工具授权，Linux 图文任务已重新验证。思考与附件能力继续受所选型号限制。
- Windows Hub/Trae HTTP 使用独占端口绑定，避免同端口多个进程共监听导致健康检查误判；Linux 保留正常的地址复用行为。
- 修复原生安装的实际路径与缓存问题：创建隔离 Codex home，ZCode 使用安装副本的绝对目录 source，并通过官方保留数据重装刷新自有插件缓存；DSH 固定 Node 入口与外部连接文件。保留既有插件数据、禁用状态和其他插件。
- Linux 用户服务按安装目录派生独立 unit 并验证归属，启停与升级统一经过 systemctl；不支持的 systemd + console 组合提前拒绝。实机生命周期 18/18 检查通过。
- 支持插件跨 Windows/Linux 连接远端 Hub。新增实际双向网络探针：Windows→Linux 直连图文任务通过；当前 Linux→Windows 直连端口不可达，显式 SSH 反向转发后的图文任务通过。报告区分两种通道，没有把转发结果计成直连成功。
- 重写 README 的安装、服务端/客户端分工与数据流说明：请求和附件仍可能发送到模型服务商，自托管不等于模型离线或保证不泄露。详见 docs/release-0.7.md。
- 最终完整回归 Windows 19/19 组、Linux 17/17 组通过，期间源码哈希未变；正式三 ZIP 在真实 Linux 解压安装验收 43/43 通过。产物清单、SHA256、组件隔离和凭据模式审计均通过；账号授权、余额、区域、模型目录与直接网络不可达等外部限制保留为未通过。

---

## [0.6.0] - 2026-10-09

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

### 第二轮跨平台重构 / Cross-platform refactor (0.6.0)

- 统一任务契约：`model`、`thinking`、`stream`、附件；新增 `hub_capabilities` 和结构化 `hub_result_json`，四份 MCP 桥同步到 0.6.0。
- Windows 到 Linux 的附件按字节传输，Hub 在任务专属目录暂存并清理；最多 8 个文件、合计 1 MiB。拒绝路径穿越、无效 base64、凭据文件和不支持的组合。
- CodeBuddy / MiMo 使用实际 provider 思考开关；默认 Copilot auto 拒绝显式高思考，MiniMax M3.1 总是思考，明确区分不支持与成功。流式通过 MCP progress token 发送正文进度，非流式缓冲结果。
- 修复重复 `--format` 等标量参数使 MiMo 回退文本、思考混入答案的问题；保留已有 settings 权限字段，并支持 Antigravity 将选项放在提示词之前。
- 统一官方 CLI 输出解析，过滤推理与工具内容；识别 exit=0 的官方错误、401 登录失败和空回答，保留长答案和安全用量计数。失败不自动重派。
- 默认模型按指定表更新；MiMo 改为 `xiaomi/mimo-v2.6-flash`（`26f` / `v2.6f`）。控制台优先采用 Hub 配置默认值，修复旧目录将 9router/MiniMax M3 显示为默认及仅有模型目录就被自动派发的问题。
- Linux 启停器使用 `/proc` 进程身份和监听归属检查、原子记录和失败回收；修复 CRLF、旧 PID/端口误判及 `.env` 被当 shell 执行的问题。保留已有部署和账号配置。
- Hub 支持外部 `HUB_AGENTS_FILE` / `HUB_STATE_DIR` / `HUB_RESULTS_DIR`，Windows 启动器正确使用外部 worker 配置。移除结果目录自动串入历史部署的回退。
- 修复 Codex 原生插件环境过滤导致 Hub URL 丢失，支持外部 `PLUGIN_DATA/agenthub.json`；原生代理模板与 DSH 工作流传递思考、流式及附件选项。
- MiniMax 图片和文本文件转换为官方消息文件，替换原文本参数，避免重复发送；思考关闭与本地文件编辑仍明确不支持。
- Windows 结果读取对短暂共享冲突重试；损坏结果不能被当作不存在而覆盖，保护任务身份和上下文。
- 异步 CLI 分离 stdout / stderr，修复 MiniMax 流式答案和进度混入 spinner、`Response:` 状态提示；仅失败时附有界诊断。
- ZCode 新增官方 app-server 适配器，校验模型目录和会话实际型号后只发送一次任务；缺少指定 GLM 时拒绝，不静默回退。旧的无模型切换通道不能再用配置默认值伪装实际模型；隔离会话、正文流与超时回收有协议回归。
- 修复 Windows HTTP 拒绝请求后立即关闭未读正文造成 TCP 重置、客户端收不到 401 的竞态；先刷新错误响应，再有界丢弃请求体，不执行未授权工具。
- 控制台上传使用唯一文件名并读取实际上传字节；修复真实邮箱分页标题解析。消息/队列不再静默吞掉附件和思考选项。
- 新增源码阶段备份与 SHA-256 校验、当前树和 Git 历史密钥模式扫描。备份位于仓库外，排除运行数据和凭据文件；实际 Hub HTTP 请求使用 Authorization 头。

### 验证边界 / Validation scope

- Windows 隔离回归、真实 Ubuntu Linux 回归、Windows 控制 Linux 的实际任务，以及 Codex/ZCode/DSH 原生加载分别记录。详细结果见 `docs/compatibility-2026-10-08.md`，机器报告保留每次调用的实际通过、失败和前置阻塞。
- Codex、ZCode 已经由原生子代理派发真实任务，包含图片与文本附件。DSH 原生 MCP/预设被发现，实际子代理调用受官方账号余额限制；宿主退出码不代替 worker 结果验证。
- CodeBuddy 国内版和 MiMo 完成 Windows 16 组合实跑；MiMo 出现退出 0 空回答的失败，不能宣称全通过。国际版后续认证失败、Antigravity 地区限制、Trae SSO/网关、Linux MiMo26 凭据无效等均保留为明确限制。
- 未安装/未授权的 Linux 原生宿主、缺乏可验证模型开关的通道不记作通过。macOS 未实测，当前服务启动器只支持 Windows/Linux。
- 源码来自已验证的 stage06 检查点；验证没有替换用户日常客户端配置，源码不携带个人密钥。

---

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
