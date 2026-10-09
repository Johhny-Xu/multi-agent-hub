---
name: hub-parallel-research
description: 使用 AgentHub 外部 worker 并行调研、比较方案或搜集互补证据；适用于用户要求多代理研究或跨来源比较的任务。
---

# 并行调研

把研究问题拆成互补的子问题，为每个 worker 给出范围和应返回的证据，例如版本依据、来源链接、代码位置和不确定性。按用户点名的 worker 分派；未指定时先用 hub_status 了解已配置通道，并选择足够完成任务的数量。研究阶段不安排文件修改。

使用当前工具目录里 agenthub MCP 的 hub_dispatch / hub_fetch（名称可能带宿主生成的前缀）。对每个独立任务仅调用一次 hub_dispatch，保存返回的 worker、ref 和 status。后续只对原 ref 调用 hub_fetch，在任务总预算内继续查询直到 completed/failed。单次 running/unknown 不是停止跟踪的理由；预算耗尽时把原 ref 与未确认状态交回父代理，父代理继续查同一任务，不能重新派发。网络超时、ref 丢失、running、unknown 或空回答都不能触发自动重复派发。只有 status=completed 且有实际 answer 才把回答作为成果；completed 但 answer 为空时，报告该事实并保留 ref。failed / error / timeout 如实报告，不把本地代理的文字或进度当作外部 worker 的答案。

任务文本需自包含：说明目标、上下文、允许修改的文件及验收条件。派发前用 hub_capabilities 查询目标 worker 与所选 model 的能力；只派发返回结果支持的选项。按父任务原样传递 model、thinking（default/on/off）、stream（布尔值）、files（插件所在机器的绝对路径数组，最多 8 个、合计 1 MiB）与 cwd（Hub 所在机器的工作目录）。files 由桥编码并传送内容，不能把调用方本地路径写进任务后假定远端可以读取；只发送任务明确授权的附件，禁止发送凭据。Hub 会在执行前拒绝不支持的选项。stream=true 仅请求流式生成；没有 MCP progressToken 时 delivery=buffered_no_progress_token，不能宣称用户界面实时显示。 MiniMax 可接收已声明支持的 UTF-8 文本和图片附件并返回文本；没有本地文件编辑工具。若工具不可用或 worker 未配置，报告阻塞，不冒充该 worker 自行完成。登录需要时可查询 hub_login(status)；用户要求登录时才 start 并展示官方链接，不把链接、验证码或凭据写入文件。

可直接并行调用多路 MCP，或在需要独立上下文时使用已安装的 agenthub_* 原生代理模板。原生代理负责派发和回收，真正执行者是 Hub 外部 worker；不得把原生代理数量当作外部调用成功数。

维护每路任务的 ref/状态/证据清单。已有回答先整理，未完成任务继续原 ref 查询。主代理核对来源和相互矛盾的结论，输出有依据的比较；标明未完成通道及其对结论的影响。

