# 第二轮重构与兼容性实测（2026-10-08）

代码与原生适配已更新到本地 0.6.0；**不能得出全部平台、宿主和选项都通过的结论**。本轮同时验证实际模型输出、附件内容、思考开关证据、流式通知与失败处理。账号授权、余额、地区、模型目录和模型本身的错误均单独保留，没有通过重复派发掩盖失败。

源码位于 `<USER_HOME>/Desktop/agenthub`。原生插件源码分别在 `integrations/codex`、`plugins/agenthub-workers`、`integrations/dsh`；这不是个人客户端插件缓存目录。临时安装使用隔离 profile，未发布新版本。

## 默认模型

| Worker | 配置默认值 |
| --- | --- |
| Antigravity | `gemini-3.8-flash-medium` |
| CodeBuddy 国际版 | `deepseek-v4.1-flash` |
| CodeBuddy 国内版 | `deepseek-v4.1-flash` |
| GitHub Copilot | `auto` |
| MiMo | `xiaomi/mimo-v2.6-flash`，别名 `26f` / `v2.6f` |
| MiniMax | `MiniMax-M3.1-Flash-Preview` |
| Trae | `GLM-5.3-FlashX` |
| ZCode | `GLM-5.3-Flash` |

配置默认值不代表该账号实际拥有型号。尤其 ZCode：本次账号目录没有指定 GLM，旧 headless 实际运行的是 `wx/Deepseek-v4-flash`。新 RPC 驱动先核验官方模型目录和会话型号，缺失时返回 `MODEL_UNAVAILABLE`，不静默回退，也不修改全局模型偏好。旧 profile 没有 `model_arg` 时不能继续伪装指定默认模型。

新驱动的真实验证：GLM 预检零任务发送；另一次明确选择 `wx/Deepseek-v4-flash` 的任务单次发送并返回正确算术标记。后一项只证明该已标明型号的通道可用，不能算 GLM 通过。此次没有确认实时正文增量，附件映射仅做协议回归，见 [RPC 实际报告](zcode-rpc-preflight.json) 与[驱动说明](zcode-rpc.md)。

## Windows 的 128 格

四位顺序为 `thinking / stream / image / file`，每项有开/关两种值，每个 worker 16 格。Windows 共 78 次直接 CLI 调用，覆盖 62 个不同格；128 格全部记录了通过、失败、不支持或阻塞状态。**状态覆盖不等于每格实际推理**，原生宿主也没有重复执行这一完整矩阵。

| Worker | 真实结果 |
| --- | --- |
| CodeBuddy 国内版 | 16/16 最终计算及输出文件正确；已观察到实际思考开关和正文增量 |
| MiMo 26f | 14/16 正确；`0100`、`1000` 退出 0 但空输出，记失败 |
| Copilot auto | thinking=off 的 8 格中 6 格正确；图与文件同时输入的两格算术错误；显式高思考被官方拒绝 |
| MiniMax | thinking=on 的 8 格输入计算正确，包括图与文本文件；CLI 不提供本地写文件工具，思考关闭不支持 |
| CodeBuddy 国际版 | 当前 401；CLI 退出 0 不再误记成功 |
| Antigravity | 当前地区被服务端拒绝；没有已验证的思考关闭接口 |
| Trae | 官方 CLI 的 Codebase/SSO 依赖失败，桌面网关未就绪 |
| ZCode | 指定 GLM 缺失；其他实际型号的旧测试不计指定模型通过 |

独立的 bridge → HTTP Hub → CLI 联测：国内 CodeBuddy 4/4 正确；MiMo 2/4，另两次运行超时；MiniMax 非流式通过，流式曾混入 stderr spinner，修复分流后新的图＋文件任务严格 JSON 与实际 progress 通知通过。CLI 直测和 Hub 联测使用不同任务，不能合并成一个成功率。

证据：[Windows 详细报告](live-workers-windows.md)、[128 格矩阵](live-workers-windows-capabilities.json)、[Hub 联测](live-workers-hub-integration.json)、[MiniMax 修复后联测](live-workers-hub-minimax-final.json)。

## Linux 与 Windows 控制 Linux

使用真实 Ubuntu 24.04.4 x64 主机，Python 3.12.3、Node 22.23.1。Windows 通过鉴权 HTTP/MCP 控制独立 Linux Hub；附件发送实际字节，在 Linux 任务目录暂存，未把 Windows 盘符路径交给 Linux worker。

两个拓扑分别记录 128 格，各有 34 个真实 Hub 执行 ref：20 格成果通过、12 格进程完成但成果未验证、2 格执行失败；另有 30 格因认证阻塞未执行、64 格前置拒绝。修正旧配置提示词位置后重新使用新 nonce 验证；之前的失败仍保留。MiniMax 新增的图输入四格在两个拓扑分别 4/4 正确。Linux MiMo 26f 返回 Invalid API Key，旧 `9router/trae` 的成功不能替代 26f。Antigravity 没有在时限内产生可验证回答。Trae 旧配置还存在型号不符，未计通过。

Linux 现有 CodeBuddy 国内/国际版自定义 wrapper 会将各自认证文件复制到同一 NativeExtension 认证位置。两套认证不是可靠并发隔离，观察到拓扑之间认证结果互换；不能宣称这两套账号已稳定兼容。未读取或复制密钥内容，也没有猜测原账号并覆盖恢复。已停止使用该 wrapper 做追加推理。

私有目录中直启官方 CodeBuddy 2.162.0 后，普通文字任务成功，但文件/图片任务仍出现“准备读取”或原始 DSML 工具调用，未执行读取。输出 0 和 Hub `completed` 只说明进程完成，不说明附件任务成功；这类结果记录为 `completed_unverified`。独立 MiniMax 附件成功证明跨系统字节传输链路可用，不能据此推断所有 worker 都支持附件。

证据与每格状态见 [Linux/跨系统最终平台报告](platform-compatibility.md)。初始矩阵、修正矩阵、版本对齐和追加图片实测分别保存，不覆盖历史失败。

## 三个原生宿主

| 宿主 | Windows 本地 | 纯 Linux | Windows 原生宿主 → Linux |
| --- | --- | --- | --- |
| Codex | 原生插件 MCP＋项目子代理实际派发；国内 CB 文字和图＋文件内容正确 | 本机没有 CLI/认证，未验证 | 实际派发和附件传输成立；Linux CB 最终未正确读取，成果未通过 |
| ZCode | 原生 Agent＋插件 MCP→MiMo，文字和图＋文件正确 | 官方插件 validate/list、原生 Agent→MiniMax 图＋文件成果通过 | 实际派发和附件传输成立；Linux CB 成果未通过 |
| DSH | 官方加载发现 9 个预设、6 个 MCP 工具和 workflow；主模型成功；原生子代理/工作流在 Hub 调用前遇到 402 余额不足 | 没有可用 CLI/认证，未验证 | 同一余额前置条件阻塞，未重复消费 |

Codex 子代理模板、三个工作流技能，以及 DSH 子代理/三份工作流配方已适配 model/thinking/stream/files/cwd。DSH 的离线脚本测试不等于原生模型执行。ZCode 原生宿主成功调用其他 worker，与 ZCode 自身作为 worker 缺少 GLM 是不同结论。

本轮使用原生 CLI/plugin/Agent 接口，没有验证三个桌面 GUI 的流式展示。ZCode 原生宿主未提供 MCP progressToken，结果标为 `buffered_no_progress_token`；不能称其 UI 已逐字流式显示。非流式表示桥接缓冲最终答案，未宣称关闭 MiMo 的供应商底层流。

证据：[Windows 原生宿主](native-plugins-windows.md)、[Linux 原生 ZCode→MiniMax](platform-linux-native-zcode-minimax.json)。

## 本轮关键修复与回归

- 统一任务能力、思考/流式选项和附件契约；MCP、控制台、Hub 都校验凭据文件与附件限制。
- 修复模型/format 参数重复、裸 prompt 被 variadic 权限参数吞掉、MiMo 思考配置覆盖、ZCode 默认模型误标。
- 统一官方正文解析，区分认证错误、空回答、推理、工具输出与答案；MiniMax stdout/stderr 分开，长答案和安全 usage 保留。
- Windows 文件共享冲突有界重试；损坏状态不再被当空记录覆盖；进度不覆盖终态；只清理自身任务和进程。
- Linux 启停器核对进程创建身份与监听归属；`.env` 按数据解析；Windows 外部 agents 配置正常生效。
- 修复 Codex 插件环境过滤，读取外部 PLUGIN_DATA 配置；DSH workflow 传递并验证完整选项。

最终离线回归报告：[Windows](refactor-validation.json)、[Linux](platform-final-regressions.json)。Windows 16/16 组通过，回归期间源码无变化；Linux 14/14 组基线通过，ZCode 最后修正的[专项 22/22 测试](platform-final-driver-regressions.json)通过，其他已测试源码哈希一致。这些回归使用隔离目录、合成 worker 或 mock Hub；真实厂商调用另存上述证据，不混入测试数。可用 Python 3.11+ 与 Node 运行 `python tests/run_regressions.py` 复现，真实推理入口均为 opt-in。

## 密钥、备份与剩余限制

[密钥模式扫描](security-audit.json)覆盖当前仓库文本及全部 Git 历史补丁；不记录匹配值。官方认证、Hub token、原始 CLI 日志与个人连接配置保留在项目外。扫描结果是模式检查，不能作为所有潜在秘密格式的数学证明。

阶段备份保存在 `<USER_HOME>/Desktop/agenthub-backups`，每包含逐文件 SHA-256 清单并重新读回验证；排除机器配置、凭据及运行目录。工具为 `scripts/checkpoint.py`。Windows 测试生成的 PowerShell ModuleAnalysisCache 删除被自动审批拦截，文件保留并已排除 Git/后续备份；其不参与运行。

外部条件仍需各官方账号/环境解决：授权与区域限制、DSH 余额、Linux MiMo 26f 凭据、ZCode 指定型号可用性、Linux CodeBuddy 工具行为及共享认证 wrapper。模型空回答、算术错误和超时都保留为真实失败。本轮未覆盖 macOS、GPU/长上下文压力、全部宿主×全部 worker×全部选项的笛卡尔积，也未替换用户日常部署配置。
