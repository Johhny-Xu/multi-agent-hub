---
name: hub-consult
description: 使用 multi-agent-hub 多 worker 独立会诊、提出诊断假设或交叉求解；适用于复杂故障、算法分歧和需要独立观点的任务。
---

# 多路会诊

把同一份事实、故障现象或题目发给两路或按用户要求数量的 worker，让它们独立提出假设、证据、反例和可执行验证。会诊阶段收集意见，不安排竞争性的文件修改。对代码问题提供相同版本的材料，对事实问题要求来源及适用范围。

首次连接或 Hub 连接失败时，先调用当前工具目录中的 hub_discover 只读扫描，展示候选地址供用户选择；扫描不发送凭据、不写连接配置、不静默切换。用安装目录的 connect.cmd 或 ./connect.sh 完成所选目标的配对；未发现目标时引导手动填写地址。已有 ref 仍属于原 Hub，连接故障不能触发重新派发。

使用当前工具目录里 agenthub MCP 的 hub_dispatch / hub_fetch（名称可能带宿主生成的前缀）。对每个独立任务仅调用一次 hub_dispatch，保存返回的 worker、ref 和 status。后续只对原 ref 调用 hub_fetch，在任务总预算内继续查询直到 completed/failed。任务未完成时先调用 hub_task_status 查看 verdict：working/alive_waiting/gui_working 表示仍有存活证据，继续等待；worker_exited_result_missing 表示进程已退出但结果未回传；只有终态或该异常才停止跟踪，不要按墙钟截断。单次 running/unknown 不是停止跟踪的理由；预算耗尽时把原 ref 与未确认状态交回父代理，父代理继续查同一任务，不能重新派发。网络超时、ref 丢失、running、unknown 或空回答都不能触发自动重复派发。只有 status=completed 且有实际 answer 才把回答作为成果；completed 但 answer 为空时，报告该事实并保留 ref。failed / error / timeout 如实报告，不把本地代理的文字或进度当作外部 worker 的答案。

任务文本需自包含：说明目标、上下文、允许修改的文件及验收条件。派发前用 hub_capabilities 查询目标 worker 与所选 model 的能力；只派发返回结果支持的选项。按父任务原样传递 model、thinking（default/on/off）、stream（布尔值）、files（插件所在机器的绝对路径数组，最多 8 个、合计 1 MiB）与 cwd（Hub 所在机器的工作目录）。files 由桥编码并传送内容，不能把调用方本地路径写进任务后假定远端可以读取；只发送任务明确授权的附件，禁止发送凭据。Hub 会在执行前拒绝不支持的选项。stream=true 仅请求流式生成；没有 MCP progressToken 时 delivery=buffered_no_progress_token，不能宣称用户界面实时显示。 MiniMax 可接收已声明支持的 UTF-8 文本和图片附件并返回文本；没有本地文件编辑工具。若工具不可用或 worker 未配置，报告阻塞，不冒充该 worker 自行完成。登录需要时可查询 hub_login(status)；用户要求登录时才 start 并展示官方链接，不把链接、验证码或凭据写入文件。

原生 Codex 代理仍使用调用方模型与工具；它们可分别回收外部 worker 的意见。主代理记录每路 ref 和实际状态，区分推测、已知事实和经过验证的结论。失败或 unknown 通道不计入达成共识的数量。

比较分歧并选择能区分假设的最小测试或计算。由主代理执行获授权的验证、解释结果，提出有证据的结论或保留不确定性；不要用多数票替代验证，也不要因意见为空重新派发原任务。

