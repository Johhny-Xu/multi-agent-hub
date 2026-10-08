---
name: dispatch-hub
description: Agent Hub 多 worker 并发调度与编排技能。当用户要求"多 agent 并发/并行"、"把活分出去"、"协同多个 agent/worker 完成任务"或需要并发调度多个 Hub 代理时加载。
---

# Agent Hub 多 Worker 并发调度方法论

本技能指导主智能体如何高效、安全地并发调度 Agent Hub 上的多个 worker（`zcode` / `antigravity` / `codebuddy`）。

## 一、与 agents/ 子智能体的分工定位

- **单任务直派**：单点独立任务优先使用 `agents/` 定义的原生子智能体类型（`agenthub:zcode`、`agenthub:antigravity`、`agenthub:codebuddy`、`agenthub:codebuddy-cn`、`agenthub:mimocode`、`agenthub:github-copilot`、`agenthub:minimaxcode`、`agenthub:traecode`；简称 agy/cb/cbcn/mimo/gcp/mmx/trae 由枢纽自动归一，任务文本写规范名）。
- **多任务编排与并发**：当需要分解任务、多路并行推进或交叉比对时，由主智能体加载本技能，直接调用 MCP 工具（`mcp__agent-hub-subagent__*`）进行并发派发、独立跟踪与结果聚合。

## 二、派发通道规范与接口事实

派发前请确认本机已加载 `agent-hub-subagent` MCP 服务。

### 1. 任务派发与异步受理
- **派发工具**：`mcp__agent-hub-subagent__subagent_run`
- **调用参数**：`{agent, task, timeout_s}`
  - `agent`：目标代理规范名。可选 `zcode`（Linux 桌面版 GLM-5.3-Flash）、`antigravity`（服务端 CLI 路径 /home/user/.local/bin/agy；旧注册名 agy 已于 2026-10-05 停用）、`codebuddy`（国际版）、`codebuddy-cn`（国内版）、`mimocode`、`github-copilot`、`minimaxcode`（均 CLI 直通）；`traecode` 例外——无 CLI，走 `mcp__agent-hub__trae_delegate`（wait:false 异步受理，hub_wait_result/trae_result 回收）。
  - `task`：发送给 worker 的完整提示词（须包含绝对路径及下述约束）。
  - `timeout_s`：默认 240，按任务复杂度设定（常用 600~900，上限 1800；zcode 侧单任务上限 1000 秒）。
- **30秒超时机制**：客户端在约 30 秒时若报超时错误，**不代表任务失败**；服务端已异步受理并在后台运行，**切勿判定失败并重复提交相同任务**。
- **任务标识（ref）**：受理成功后生成形如 `<agent>-<hex>` 的任务 ref（例如 `zcode-a1b2c3d4`）。
- **ref 丢失兜底**：若客户端异常未拿到 ref，在 Bash 中执行：
  ```bash
  ssh n5095-server 'ls -t ~/agent-hub/results/ | head -3'
  ```
  取最新生成的 `<agent>-<hex>.json` 文件名对应 ref 进行追溯。

### 2. 状态查询与结果读取
- **服务端结果路径**：`/home/user/agent-hub/results/<ref>.json`，关键字段：
  - `status`：`running`（运行中）、`completed`（已完成）、`failed`（失败）。
  - `text`：结果摘要文本（≤500 字）。
  - `artifactPath`：落盘在服务器上的全文文件路径。
- **轮询控制**：检查状态前使用 Bash `sleep 60` 至 `sleep 120` 缓冲，**严禁低延迟密集轮询轰炸服务端**。
- **状态检查**：调用 `mcp__agent-hub-subagent__subagent_result` 传入 `{ref}` 查进度。
- **全文读取**：若摘要不足以支撑结论，调用 `mcp__agent-hub-subagent__subagent_artifact` 传入 `{path: artifactPath}` 提取完整产出。

## 三、并发调度方法论

1. **正交任务拆分**：将大任务拆分为互不依赖的子模块。**严禁向不同 worker 派发重复、竞争性的任务**，各 worker 权责必须互斥。
2. **同批并行触发**：在单轮对话中，并行发起多个 `subagent_run` 工具调用，一次性分发全部子任务，各自拿到对应的 `ref`。
3. **独立轮询跟踪**：维护各个 `ref` 的状态清单，每隔 60~120 秒统查一次进度；个别长耗时任务不阻碍已完成任务的前期整理。
4. **归纳合成**：待全部 worker 完成后，由主智能体通读所有摘要与产出，比对一致性、验证可行性，输出最终统揽方案。

## 四、失败路由与异常降级策略

- **codebuddy 403 / 权限错误**：若 codebuddy 返回 403、Token 权限错误或鉴权失效，**立刻改派 `zcode` 或 `antigravity`，严禁原地重试 codebuddy**。
- **额度耗尽（Quota/Rate Limit）**：
  - `zcode`：走体验套餐，额度每日重置。耗尽时切换到 `antigravity` 或推迟至次日。
  - `antigravity`：走个人 Antigravity 账号额度。
- **通道整体不可用**：若 `n5095-server` 失联或 MCP 工具报错提示离线，应停止盲目重试，如实向用户上报故障并等待人工排查。

## 五、防循环与 Worker 约束铁律

1. **审查与决策绝不外包**：主智能体是调度者与最终责任人。任务划分、成果审查、方案裁决必须在主会话中完成，**严禁将"审查/验证其他 worker 结果"作为任务外包出去，防止死循环**。
2. **硬性注入任务约束**：每次拼接 `task` 文本时，必须将以下系统级约束作为前置提示显式写入：
   - 严禁重启 `zcode-desktop`、`traecode-desktop` 等系统服务。
   - 严禁修改任何任务范围外的无关文件或环境配置。
   - 文件操作必须使用绝对路径（`/home/user/...`）。

## 六、工作流集成：让枢纽 worker 当工作流的执行者

zcode 工作流（CreateWorkflow）的 agent() 节点本体永远跑本地会话模型——这一点插件与枢纽都改不了。
让"枢纽 worker 实际执行任务"的写法（2026-10-06 实测：工作流子代理具备 MCP 工具面，可直调插件桥接工具）：

1. **子代理转手（推荐）**：给 agent() 节点的 persona/ask 写明——
   "你是 Agent Hub 派发通道：调用 mcp__hub-bridge__hub_ask，参数 worker=\"<规范名>\"、task=<任务原文>、timeout_s=120；
   该调用会阻塞到枢纽 worker 出最终结果，把返回 JSON 的 answer 交给主流程；
   若工具不存在如实上报，不要改用其他方式完成任务。"——
   这样该节点的实际执行者就是枢纽 worker，工作流只负责编排与汇流。
2. **脚本级直调**：`world.run("node", ["<插件缓存目录>/mcp/ask.mjs", "<worker>", task])`，阻塞出答案（exit 0/1）。
3. **同任务多 worker 并行对比**：直接运行已保存的全局工作流 **hub-fanout**（args：task / workers / timeout_s / max_rounds / wait_s）。

**铁律：当用户要求"用工作流测试/使用 hub worker"时，必须写出包含上述模式的工作流脚本并创建运行；
禁止绕过工作流改为主对话直派（MCP 直派只适用于用户没点名工作流的场合）。**
