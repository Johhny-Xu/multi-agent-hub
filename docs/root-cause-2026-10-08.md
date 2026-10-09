# 未通过项的根因与 0.7.0 修正

本轮保留上一轮所有失败，不用新成功覆盖旧证据。真实新任务共三次，均在独立 Linux 临时目录中使用官方 `@tencent-ai/codebuddy-code@2.162.0` 的 Node 入口；未调用会改写共享认证的 wrapper，未复制 Windows 凭据或移动、读取账号文件内容。CLI 正常使用服务器已有官方认证。本轮没有再次调用 MiMo、Antigravity、CodeBuddy 国际版或 DSH 付费推理。

| 未通过项 | 证据与处理 |
| --- | --- |
| Linux CodeBuddy 返回 DSML 工具调用正文、声称 Read 不存在 | 旧默认代理会继承 PTC/REPL 模式。新任务显式选择 `--agent standard`，并窄范围配置 `--tools Read --allowedTools Read --permission-mode acceptEdits`，真实执行两次 Read，图片纯蓝、隐藏文本 nonce、任务 marker 全部正确。Hub 现在固定 standard；未预授权的图像不开放。 |
| Linux CodeBuddy wrapper 共用认证 | 只读脚本确认 wrapper 会复制各 profile 的 `auth.info` 到共享原生扩展认证文件；版本升级无法解决这种账户隔离问题。Hub 在执行前识别此已知副作用并返回 `shared_auth_wrapper`；安装应选择官方独立入口，不自动迁移账号。 |
| CodeBuddy 附件文本依赖 Read | [官方无头协议](https://www.codebuddy.cn/docs/cli/headless)支持 stdin JSON 用户消息和文本块。新文本 nonce 直接输入后验证正确；Hub 使用私有 JSONL 文件作为子进程 stdin，避免 Windows argv 长度和变参吞提示词。图片保留已实测 Read 路径。 |
| CodeBuddy stdin 直接图像未验证 | 首次独立图文 stdin 任务读对文本 nonce，但所选 deepseek 型号回答 `image=none`。不能把“CLI 接受图像块”算成模型理解图像；此型号默认不开放直接图像 stdin，后续 Read 通道已经成功。 |
| MiMo 两次退出 0 但空答 | 已有真实调用的 stdout/stderr 文件均为 0 字节，分别约 31 秒退出；不是 Hub 把最终答案解析丢失。后端已经将退出 0 无回答标为 error，不自动重派；近期空答不会永久禁用型号。 |
| MiMo Hub 超时 | 一例 stdout 0 字节，另一例只有 step/tool 事件、没有公开正文，预算内没有可恢复的最终答案。保持真正的绝对超时、回收子进程树，并保存安全 timeout 诊断；不把工具参数/思考当最终答案，也不推断所有后续任务永久失败。 |
| CodeBuddy 国际版 401、MiMo Linux 无效 key、Antigravity 区域、DSH 额度 | 账户或服务限制不能用代码绕过。明确 worker 调用失败保存为本机、对应型号、可过期的安全状态；手动 refresh 清除后不付费探测。DSH 属于原生 host 的额度条件，不能伪装成某个外部 worker 已通过。没有把历史机器错误硬编码到其他安装。 |
| Copilot auto 的思考控制与算术错误 | auto 路由型号会变化；参数接受并不证明所有路由均严格关闭思考。默认只开放 `default`，固定型号需另行验证。两次算术错误属于任务质量验证失败，未作为永久禁用型号的依据。[官方说明](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)强调推理控制取决于具体型号。 |
| ZCode 缺少要求的 GLM 型号、没有正文 chunk | RPC 仍按实际本机模型目录与会话型号核验，缺少型号明确失败，不回退冒名。旧通道在能力中公开不可验证型号选择；新通道根据本机配置和近期具体型号失败显示状态。当前实测 stream 请求有最终答案而 chunks=0，默认禁用 `stream:true`，标为 terminal_only；保留只读工具限制。 |

真实调用的新增证据：

- [官方 stdin 首次图文任务](root-cause-codebuddy-stdin-linux.json)：文件正确，图片未验证，完整保留失败部分。
- [显式 standard + Read 图文任务](root-cause-codebuddy-standard-linux.json)：最终三项验证通过，实际 Read 两次。
- [新版 Hub 的 stdin 文本 + Read 图片联测](root-cause-codebuddy-hub-linux.json)：ref `codebuddy-cn-6430059c2e`，单次派发，`completed` 且最终 marker/隐藏 nonce/蓝色全对，私有任务文件已清理。
- [MiMo 既有私有日志的安全形状统计](root-cause-mimo-existing-evidence.json)：仅输出字节数、事件类型、时间和公开文本长度，未导出推理正文或工具参数。

代码还修正了两处与上述失败相关的运行时边界：stream-off 会移除原配置中冲突的裸 `--stream` / `--include-partial-messages`；worker 的晚到结果不能重开已有终态，并在原任务已超时后停止剩余子进程。解析器只对官方终态中完整、独立、意图执行的未执行 DSML 调用返回 `TOOL_PROTOCOL_UNVERIFIED`，普通提及、引用和代码示例仍是合法回答。

能力 v2、型号/平台覆盖、可用性和无推理刷新接口见[任务选项](task-options.md)。本轮离线验证入口 `tests/capability_availability_regressions.py` 验证实际 stdin 子进程、模型/平台限制、状态隔离、手动刷新无进程调用、敏感文本不落状态、DSML 引用反例、冲突流式参数与终态取消；普通核心、任务、解析器和运行时回归均已通过。最终全平台回归由总验证报告记录。
