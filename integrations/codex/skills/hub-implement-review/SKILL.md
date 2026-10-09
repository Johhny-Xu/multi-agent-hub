---
name: hub-implement-review
description: 使用 AgentHub 完成实现后再独立审查的两阶段工作流；适用于用户要求外部 worker 编码并复核实际改动的任务。
---

# 实施与审查

先确定一个实施者、允许修改的文件和验收条件。保持同一文件只有一个实施者；worker 的 Hub 路径与当前项目不一致时，提供必要上下文并要求返回补丁，由主代理在获授权的工作区应用。minimaxcode 可给出文本补丁，不能直接修改文件。

使用当前工具目录里 agenthub MCP 的 hub_dispatch / hub_fetch（名称可能带宿主生成的前缀）。对每个独立任务仅调用一次 hub_dispatch，保存返回的 worker、ref 和 status。后续只对原 ref 调用 hub_fetch，在任务总预算内继续查询直到 completed/failed。单次 running/unknown 不是停止跟踪的理由；预算耗尽时把原 ref 与未确认状态交回父代理，父代理继续查同一任务，不能重新派发。网络超时、ref 丢失、running、unknown 或空回答都不能触发自动重复派发。只有 status=completed 且有实际 answer 才把回答作为成果；completed 但 answer 为空时，报告该事实并保留 ref。failed / error / timeout 如实报告，不把本地代理的文字或进度当作外部 worker 的答案。

任务文本需自包含：说明目标、上下文、允许修改的文件及验收条件。派发前用 hub_capabilities 查询目标 worker 与所选 model 的能力；只派发返回结果支持的选项。按父任务原样传递 model、thinking（default/on/off）、stream（布尔值）、files（插件所在机器的绝对路径数组，最多 8 个、合计 1 MiB）与 cwd（Hub 所在机器的工作目录）。files 由桥编码并传送内容，不能把调用方本地路径写进任务后假定远端可以读取；只发送任务明确授权的附件，禁止发送凭据。Hub 会在执行前拒绝不支持的选项。stream=true 仅请求流式生成；没有 MCP progressToken 时 delivery=buffered_no_progress_token，不能宣称用户界面实时显示。 MiniMax 可接收已声明支持的 UTF-8 文本和图片附件并返回文本；没有本地文件编辑工具。若工具不可用或 worker 未配置，报告阻塞，不冒充该 worker 自行完成。登录需要时可查询 hub_login(status)；用户要求登录时才 start 并展示官方链接，不把链接、验证码或凭据写入文件。

实施任务明确 completed 后，由主代理取得实际 diff、产物和验证结果，再把这一快照交给另一 worker 审查。审查任务只返回具体缺陷、触发条件、代码位置和建议验证，不同时修改实施者的文件，也不继续外包审查。实施状态不明时保留原 ref，暂停依赖该结果的审查阶段。

主代理复现必要问题并决定修复范围，检查最终 diff 和与改动相符的测试。只把真实通过的验证作为证据，说明哪些内容仅由外部 worker 陈述、哪些已在当前项目验证。

