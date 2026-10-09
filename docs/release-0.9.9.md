# 0.9.9 发布与 Linux 原生验收

日期：2026-10-09。版本：Hub、分发包与 Codex / ZCode / CodeArts / Antigravity 插件 0.9.9；DSH 独立包 1.4.0。回归、实际宿主调用、服务部署与账号限制按下表分别记录。

## 交付范围

- 增加第五种客户端 Antigravity：九个原生路由子代理、四个 Agent Skills 工作流、独立七工具 MCP 桥，以及可选官方 Python SDK 控制器。
- 保持九种 worker，插件可以连接另一台 Windows / Linux Hub。现有 CodeArts 接入与保守能力限制继续保留。
- Hub 向同步与异步 CLI 传入真实 worker 身份；共享 MCP 阻止已标记 worker 再派发给自身。保护针对本包接口，不是跨主机循环检测。
- 修复 Windows 虚拟环境 Python 的监听子解释器归属、启动判断和停止记录；Linux UDP 测试隔离生产 Hub。
- 现场发现 agy CLI 1.3.1 在 print 超时后仍可能返回退出码 0 和 `SUCCESS`。Hub 现以官方 stderr 未完成诊断拒绝伪成功；同步/异步都保留原任务，不自动重派，长日志不会掩盖诊断。
- 分发包仍分为 `agenthub-0.9.9-hub.zip`、`agenthub-0.9.9-plugins.zip`、`agenthub-0.9.9-both.zip`。普通原生插件不安装 SDK，也不生成模型凭据。

实现细节与此前接入阶段的实际边界见 [Antigravity 接入说明](antigravity-compatibility.md)、[CodeArts 接入说明](codearts-compatibility.md)、[安装说明](../packaging/README.md)。上述历史报告保留实际日期与基础版本，不以新版本号覆盖。

## 本轮验收分层

| 层级 | 完成标准 | 当前记录 |
| --- | --- | --- |
| 0.9.9 Windows / Linux 回归 | 全量报告无失败，运行期间源码未变，测试与交付源码一致 | Windows 32/32、Linux 29/29 组通过，运行期间源码未变；之后的文档更新另行列明 |
| Linux Hub 同步 | 健康、鉴权、九种 worker、历史结果与原配置保留；部署有回滚备份 | 0.9.9 服务已运行，24 个 Hub 工具、9 种 worker；配置逐字节保持，历史结果和鉴权检查通过 |
| Codex 原生客户端 | 官方宿主加载插件和项目代理；真实原生子代理/工作流产生可核对的 Hub 回执 | Windows 原生子代理派发、续查通过，独立任务返回 2117；Linux 未安装官方宿主 |
| ZCode 原生客户端 | 官方插件发现与组件加载；真实原生子代理/技能产生可核对的 Hub 回执 | Windows 返回 2077，Linux 返回 73，均取得匹配任务的真实 Hub 回执 |
| DSH 原生客户端 | 官方 profile 加载 bundle 和预设；真实 agent/workflow 产生可核对的 Hub 回执 | Windows 加载 10 预设/7 MCP 工具与工作流；实际调用被 402 ACCOUNT_QUOTA 阻止。Linux 未安装官方宿主 |
| Antigravity 原生客户端 | 桌面或正式 CLI 加载原生插件；真实子代理/skill 产生可核对的 Hub 回执 | Linux CLI 1.3.1 的原生 hub-mimocode 调用返回 95；Windows 原生资产与桥通过，桌面需重启后另行验证 |
| 可选 Antigravity SDK | 区分实际类型/协议验证与 SDK 真实模型推理 | 此前实际 0.1.21 wheel 的类型、协议验证通过；两端缺独立 API 认证，模型推理未验收 |
| 分发包 | 三种包的 manifest、源码哈希、组件隔离及凭据/运行目录排除检查通过 | 见本版包校验报告；GitHub Release 安装包附件未上传 |
| Git 交付 | main 源码与 v0.9.9 标签 | 按 v0.9.9 源码标签交付，不将本地 ZIP 当成已上传附件 |

直接启动插件的 MCP 进程只能验证桥接协议。安装完成、列出组件、模型声称已执行、模拟工作流通过，都不能替代该宿主真实原生调用的证据。真实任务须保留一次派发的 worker、Hub 与 ref；失败、认证受阻、无回答和未知状态分别记录。

此前 Antigravity 接入阶段的 Windows 32 组、Linux 29 组报告属于基础版本源码，不能充当 0.9.9 修改后的全量结果。此前桥派发 MiMo 默认模型得到 `42`，而指定 `26f` 因服务器未配置被拒绝，两项继续保持独立。

## 保留现有 Linux CodeArts

Linux 已有 CodeArts 原生包、官方 CLI 认证目录与生产 Hub。此次四客户端安装选择 `codex,zcode,dsh,antigravity`，不使用自动选择去重新注册 CodeArts。官方 `.codeartsdoer` 配置、认证、会话数据和现有原生包保持原用途，后续 CodeArts 测试仍需单独完成。

现有服务源码位于 `~/.local/share/AgentHub-CodeArts/server`，私有配置位于 `~/.config/agenthub-codearts`，历史状态和结果位于 `~/agent-hub/state`、`~/agent-hub/results`。这些是既有部署位置。同步前检查运行中的任务并备份服务源、unit/drop-in 与配置；切换源码时保持原 worker、token、状态/结果路径和官方模型设置。只管理确认属于本次部署的服务与测试进程。

部署报告确认：0.9.9 服务正常，九种 worker、配置字节、历史结果与鉴权均保留；首次部署前备份为 `~/.agenthub-validation-backups/release-0.9.9-20261009-224203`，包含最终驱动修复的部署前备份为 `~/.agenthub-validation-backups/release-0.9.9-20261009-231020`。这不代表 CodeArts 官方认证已经修复或其模型已通过测试。认证缓存刷新不能替代 CodeArts 实际模型成功，也不能通过复制登录信息或猜测模型完成验收。

## 记录与交付状态

报告：[Windows 全量回归](release-0.9.9-windows-regressions.json)、[Linux 全量回归](release-0.9.9-linux-regressions.json)、[Linux Hub 部署](release-0.9.9-linux-deployment.json)、[Windows 原生](release-0.9.9-windows-native.json)、[Linux 原生](release-0.9.9-linux-native.json)、[安装包](release-0.9.9-packages.json)、[凭据审计](release-0.9.9-security.json)。初始失败与修复记录保留，未安装宿主、余额不足和认证受阻不计为端到端通过。

全量回归之后新增 agy 超时误报修复和对应真实进程回归；[Windows 增量检查](release-0.9.9-windows-fix-regressions.json)、[Linux 增量检查](release-0.9.9-linux-fix-regressions.json)分别通过 83 项，测试源码哈希一致，覆盖输出解析、任务契约、Hub 同步执行和进程运行时。其后 CodeArts 模型列表修复两端各通过 22 项检查，原生安装器提示更新两端各通过 13 项检查；[最终校验汇总](release-0.9.9-validation-summary.json)核对最终运行源码、六份 MCP 和安装包，历次部署报告也保留。

[Windows 原生实测](release-0.9.9-windows-native.json)保留每次真实任务。最初两个长标记任务的答案不完整；[上游记录核对](release-0.9.9-mimo-vendor-evidence.json)确认 MiMo 的原始回答与 Hub 结果完全一致，官方消息标为 stop，未将其记成内容验收成功。后续另开两项只返回整数的独立任务，Codex 返回 `2117`（ref `mimocode-d77b81632d`），ZCode 返回 `2077`（ref `mimocode-9cc619270d`），原 ref 续查一致。使用既有 `9router/trae` 默认模型，没有将它冒称为 `26f` 验收。

README、结构图和进度图由现有 Linux agy CLI 实际修改后，经维护者核对版本、任务结果、账号限制和视觉排版；原始修改哈希保存在 Linux 原生报告中。CLI 没有提供受支持的剩余额度查询，模型 token 用量不能当作剩余额度。`plugin list` 只列导入记录，不是本地目录插件的完整加载状态。

## CodeArts 与 9router 的修复边界

两端现有 9router 的鉴权和模型目录访问均成功，但这只能证明上游路由可用。Windows 独立 IDE 内核读取了自定义 provider 配置，却未完成官方身份/自定义模型权限初始化；不能据此推断用户 IDE 账号没有权限。Linux 26.9.12 的非交互 CLI 仍要求华为 AK/SK，官方当前发布清单也是此版本，ACP 不是可用替代。

尝试后的三份私有配置均已按备份逐字节恢复，原默认模型保持，备用候选只保留在机器私有目录。未导出账号凭据、未写入项目，也未将模型失败计成成功。

已修复可确定的驱动问题：官方 Linux CLI 输出两列 `model_id` / `model_name`，旧驱动只接受单列，可能错误拒绝已配置的模型。新解析同时支持正式两列与原单列，严格拒绝诊断文本伪装的模型；两端回归及最终源码哈希见 [CodeArts 修复报告](release-0.9.9-codearts-repair.json)。实际 CodeArts 模型调用仍须完成官方认证初始化后再次验收，步骤见 [CodeArts 私有模型配置](codearts-custom-provider.md)。

安装包留在本地发布目录，SHA256 见上述包报告。源码标签与安装包附件分别管理。
