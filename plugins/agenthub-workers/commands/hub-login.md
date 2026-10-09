---
description: 获取 worker 官方授权链接并查询登录状态
argument-hint: <worker 名或简称> [start|status|cancel]
---

# /hub-login

使用当前工具目录中的插件 `hub_login`，工具名可能带宿主生成的命名空间；`worker` 取用户指定的 worker 名或简称。

首次连接或 Hub 连接失败时，先调用 `hub_discover {}` 只读扫描并展示候选，让用户选择后通过安装目录的 `connect.cmd` 或 `./connect.sh` 配对；查不到时手动填写地址。扫描不发送凭据、不改配置、不静默切换。连接确认后才在该 Hub 上启动 worker 登录。

- 用户要求登录或获取链接时，传 `action: "start"`。如同一 worker 已有等待中的流程，展示已有链接，避免重复启动。
- 将返回的 `login_url` 显示为可点击链接，同时展示 `user_code`（如有）、有效时间及操作指引。链接来自运行 worker 的枢纽宿主机。
- 用户完成授权后，传 `action: "status"`，只有返回 `status: "authenticated"` 才说明登录完成。
- Windows 宿主机上的 MiMo 支持自动获取官方登录链接，使用 `/hub-login mimo start`，授权等待上限为 300 秒；用户完成浏览器授权后用 `/hub-login mimo status` 查询。Linux 上的 MiMo 仍需按返回指引在宿主机终端登录。
- `preparing` 时稍后查询 `status`；`expired` 时重新 `start`；`manual_required` 或 `unavailable` 时如实展示官方操作指引，不编造登录链接。
- 只有用户要求取消当前登录时才传 `action: "cancel"`。

不索取密码、API Key 或 Token，不把授权链接和验证码写进仓库或报告。登录完成后再进行 worker 提示词实测。
