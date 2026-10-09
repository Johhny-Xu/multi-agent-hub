# Windows 8 workers 实测（2026-10-08）

本机 Windows x64、PowerShell、Node.js 下，6 个官方 CLI 的真实模型调用返回了 `HUB_WINDOWS_OK`，exit 0。Antigravity 与 Trae 仍有外部阻塞，不能宣称 8/8 通过。测试提示词只要求返回标记，没有请求修改文件或执行工具。以下结论限定于表中版本、本机账号、所选模型与当前网络。

| Worker | 实测版本 / 模型 | 结果 | 证据 |
| --- | --- | --- | --- |
| CodeBuddy 国际版 | 2.162.0 / deepseek-v4.1-flash | 模型调用通过 | [CodeBuddy 报告](windows-probe-codebuddy.json) |
| CodeBuddy 国内版 | 2.162.0 / deepseek-v4.1-flash | 模型调用通过；与国际版分别授权、分别存配置 | [CodeBuddy 报告](windows-probe-codebuddy.json) |
| GitHub Copilot | 1.0.93 / auto | 官方设备授权成功，模型调用通过 | [Copilot / MiMo 报告](windows-probe-copilot-mimo.json) |
| MiMo Code | 0.1.9 / xiaomi/mimo-v2.6-flash（用户指定 v2.6f） | 官方小米浏览器回调授权成功，模型调用通过 | [Copilot / MiMo 报告](windows-probe-copilot-mimo.json) |
| MiniMax | mmx 1.0.27 / MiniMax-M3.1-Flash-Preview | 官方 OAuth 成功，文本模型调用通过 | [MiniMax / ZCode / Trae 报告](windows-probe-root.json) |
| ZCode | 内置 CLI 0.16.9 | 模型调用通过；使用桌面生成的 provider 配置路径 | [MiniMax / ZCode / Trae 报告](windows-probe-root.json) |
| Antigravity | 官方 agy 1.3.1 / gemini-3.8-flash-medium | CLI 能启动；服务端返回 HTTP 400 FAILED_PRECONDITION，地区不支持，模型未返回 | [Antigravity 报告](windows-probe-antigravity.json) |
| TraeCode | 桌面网关；另测官方 Windows CLI 0.208.1 | 本机默认网关 8787 未监听；公开下载的 CLI 能启动，但进入内部 SSO 流程且登录请求失败，模型未验证 | [MiniMax / ZCode / Trae 报告](windows-probe-root.json) |

桌面已登录不等于每个 CLI 已授权。MiMo 的未登录和错误事件可能仍返回 exit 0，因此模型通过同时要求出现正确文本标记。MiMo 使用官方 `xiaomi` provider；历史配置中的第三方代理没有参与本次成功调用。MiniMax 本轮是文本 API CLI，未验证文件编辑能力。

这些是直接官方 CLI 模型实测；真实 Hub HTTP 和 Node 插件桥已验证登录状态与模拟任务执行，未对全部 6 个模型重复进行完整插件推理。ZCode 的旧 CDP 桌面回退通道、本机 Trae 网关和 8 个 worker 同时推理均未通过本轮验证。

## 本地源码修复

- CodeBuddy 使用官方 `-p` 参数；`--print-mode` 在本次版本中无效。两版使用独立配置目录和网络环境。
- Windows npm `.cmd` 解析到真实 Node 入口；保留参数数组，传递 cwd、workdir_via、模型与环境配置。
- 异步执行保留调用方超时，非零退出和驱动错误回写为失败。Windows JSON 原子替换短暂冲突会有界重试。
- 本轮创建的 worker 子进程通过 JobObject 管理，退出和超时会回收子孙进程。
- ZCode 有已配置 CLI 时直接使用该 CLI；未配置时才进入原有桌面回退。

Windows 模板在 [agents.windows.example.json](../hub/agents.windows.example.json)。模板需要填写稳定安装路径以及 ZCode 当前 provider 文件路径；没有在当前账号中自动部署该模板，也没有更新已安装的插件副本。

## 插件登录功能 v0.5.0

本地插件与根目录 MCP 桥已同步增加 `hub_login` 和 `/hub-login`：

```text
/hub-login cb start
/hub-login cb status
/hub-login cb cancel
/hub-login cbcn start
/hub-login gcp start
/hub-login mmx start
/hub-login mimo start
```

`start` 发起官方授权，`status` 查询，`cancel` 取消等待。准备较慢时返回 `preparing`，继续用 `status` 取链接；`awaiting_user` 表示等待浏览器授权。链接、设备码只保存在当前 Hub 进程的内存中，官方 CLI 自行保存账号凭据。进程重启后当前等待会话需要重新开始。

| Worker | 自动登录行为 |
| --- | --- |
| CodeBuddy 两版 | 先查询已有账号；未登录时走官方 ACP 授权链接，等待最多 300 秒 |
| Copilot | 官方 `login --device-code`，返回链接和设备码；新 Hub 进程没有独立登录状态探测，返回 unknown 并给出指引 |
| MiniMax | 官方 OAuth，Windows 使用真实 ConPTY；已有凭据时返回 authenticated |
| MiMo（Windows） | 官方浏览器授权；从本次 JobObject 的唯一监听端口重建官方回调 URL，等待最多 300 秒；status 校验官方 Provider 标签 |
| Antigravity | manual_required：当前版本没有验证过的非交互登录链接接口 |
| ZCode / Trae | 默认给出人工指引；验证相应 CLI 接口后可在本地 profile 配置 login.command / login.status_command |

MiMo 的浏览器必须运行在 Hub 所在 Windows 主机，才能到达 `localhost` 回调。Linux 的 MiMo 自动回调链接提取尚未验证，保留宿主机终端指引。工具不接收密码、Token 或 API Key，也不返回账号对象。链接过期或取消后不会继续展示旧链接。

## 检查结果

- Windows 执行器集成：12/12，通过。使用模拟 CLI 和真实 HTTP / Node 桥；[修复前](windows-probe-bus-baseline.json)、[修复后](windows-probe-bus.json)。
- 登录状态、凭据字段过滤、取消与过期竞态：12 项 Python 检查通过，脚本 [login_manager_smoke.py](../tests/login_manager_smoke.py)。
- Windows 原生终端、UTF-8、所属监听端口、真实 MiniMax / MiMo 链接捕获与取消：4/4，通过；[报告](windows-probe-login.json)。独立配置目录里的临时授权均已取消。
- 真实 Hub HTTP → Node 登录桥 → 官方 CodeBuddy 两版 / MiniMax / MiMo 状态：4/4 authenticated；[报告](windows-probe-login-http.json)。
- Node MCP stdio 登录桥测试通过；包括工具注册、别名、输入校验、字段过滤、HTTP 错误与 ZCode 回退。

报告保留登录前失败历史和登录后成功证据，不含动态授权链接、设备验证码或凭据。本轮启动的测试服务器及登录进程均已退出。CodeBuddy、Antigravity 临时工具目录的递归清理由自动审批以“策略阻止”拒绝，目录保留；其他测试证据与便携工具也保留以便复核。

## 官方接口依据

MiMo 回调 URL 参数与五分钟等待来自 [官方授权实现](https://raw.githubusercontent.com/XiaomiMiMo/MiMo-Code/main/packages/opencode/src/plugin/mimo.ts)，登录状态标签来自 [官方命令实现](https://raw.githubusercontent.com/XiaomiMiMo/MiMo-Code/main/packages/opencode/src/cli/cmd/providers.ts)。ConPTY 关闭过程持续由独立线程读取输出，遵循 [Microsoft ClosePseudoConsole 说明](https://learn.microsoft.com/en-us/windows/console/closepseudoconsole)；标准句柄设置参考 [Microsoft Terminal 维护者说明](https://github.com/microsoft/terminal/discussions/15814)。
