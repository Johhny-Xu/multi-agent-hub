---
name: dispatch-hub
description: 使用 multi-agent-hub 的八个 worker 进行独立任务分派、并行协作和原始 ref 结果回收；适用于用户要求把任务分给多个外部代理。
---

# multi-agent-hub 调度

主代理划分任务、决定允许修改的文件并验收结果。原生子代理只是 Hub 的路由通道，外部 worker 才是任务执行者。

单路任务可使用 Agent 的 `agenthub-workers:zcode`、`agenthub-workers:antigravity`、`agenthub-workers:codebuddy`、`agenthub-workers:codebuddy-cn`、`agenthub-workers:github-copilot`、`agenthub-workers:minimaxcode`、`agenthub-workers:mimocode`、`agenthub-workers:traecode` 类型。多路协作由主代理分配互不冲突的责任、并发调用插件工具，并记录每路 ref。审查阶段可提供同一份材料；文件修改阶段不得让多个 worker 竞争写同一文件。

## 自包含工具与任务选项 原生 Agent 的登记 ID 也可能带插件前缀；以当前 Agent 工具实际列出的类型为准。已实测的 profileId 为 agenthub-workers:mimocode 和 codebuddy-cn，其定义路径均来自本插件 agents/；不要硬编码旧的 agenthub: 前缀或绕到其他代理。

首次连接或 Hub 连接失败时，先调用当前工具目录中的 hub_discover 只读扫描，展示候选地址供用户选择；扫描不发送凭据、不写连接配置、不静默切换。用安装目录的 connect.cmd 或 ./connect.sh 完成所选目标的配对；未发现目标时引导手动填写地址。已有 ref 仍属于原 Hub，连接故障不能触发重新派发。

使用当前工具目录中的 `hub_ask`、`hub_dispatch`、`hub_fetch`、`hub_status`、`hub_capabilities`、`hub_login`、`hub_discover` 七个插件工具，名称可能带宿主生成的前缀。不依赖额外 SSH、外部 MCP 服务或固定服务器路径。

`hub_ask` 接受 `{worker,task,timeout_s,model,thinking,stream,files,cwd}`，派发一次并在总等待预算内回收。需要独立控制等待时，对每个任务调用一次 `hub_dispatch`，保存 ref，然后只对该 ref 使用 `hub_fetch`。timeout_s 默认 300 秒，必须是大于 0 且不超过 86400 的有限数字。

任务文本要自包含：目标、上下文、允许读写的范围、验收条件和输出要求。派发前可查询 `hub_capabilities(worker)`；`model` 是 Hub 的模型别名或实际 ID，`thinking` 是 default/on/off，`stream` 是布尔值，不支持的能力会在执行前拒绝。按用户要求传递这些选项，不把母会话的模型选项误认为 worker 设置。

`files` 是插件机器上的绝对路径数组，最多 8 个、合计 1 MiB。桥读取授权附件、编码内容并送到 Hub 暂存，支持 Windows/Linux 跨系统传送；不能只把本地路径写入任务后假定远端可见。`cwd` 是 Hub 所在机器的工作目录，必须使用 Hub 的系统路径。只发送任务明确允许的输入，禁止上传凭据文件。

`stream=true` 请求 worker 流式生成。MCP 客户端提供 `_meta.progressToken` 才能收到进度通知；没有 token 时 `delivery=buffered_no_progress_token`，不能宣称用户界面已实时显示。

## 完成与异常

只将 `ok=true`、`status=completed` 且含真实 answer 的结果作为成果，保留 worker/ref/status 和验证证据。completed 的文本也可能报告模型无法执行，要结合验收条件判断任务是否成功。

running/unknown 表示任务可能仍在执行。有 ref 时续查原任务；无 ref 的 unknown、网络超时、空输出或协议错误也不能自动重新派发。不要把本地代理的进度叙述当成 worker 答案。确定失败时报告错误并停止依赖阶段，是否改派由主代理结合任务副作用与授权判断。

登录时先查询 `hub_login(worker,action="status")`。用户要求登录或获取链接时才 start，展示返回的官方链接、验证码和指引；只有 authenticated 表示授权完成。不要索取密码、API Key 或 Token，不将授权链接或凭据写入仓库。

## 原生工作流节点

ZCode 的工作流 `agent()` 节点使用宿主模型负责编排；要让外部 worker 执行，节点提示需明确调用当前工具目录中的插件 hub_ask 一次，把原始 worker/ref/status/answer 返回。包含 model/thinking/stream/files/cwd 的请求也应原样传入。

用户明确要求工作流时，应创建并运行包含该节点的原生工作流，按实际节点输出验收；不能把主对话直接派发称为工作流执行。插件技能提供配方，不自动注册全局保存的工作流名称。没有原生工作流或工具能力时如实报告。
