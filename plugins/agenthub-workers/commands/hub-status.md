---
description: 只读查询当前 Hub 的 worker 状态与用户提供的任务 ref
argument-hint: [已有任务 ref]
---

# /hub-status

调用当前工具目录中的插件 `hub_status {}`；名称可能带宿主生成的命名空间。汇总返回的 worker、状态及阻塞原因，不推断尚未验证的模型能力。

只有用户提供已有 ref 时才用 `hub_fetch` 查询该任务，保留原始 worker/ref/status 和答案摘要。running/unknown 表示未确认，有 ref 时继续查同一任务；failed 如实报告，不重新派发。

首次连接或连接失败时，先调用 `hub_discover {}` 只读扫描，展示候选地址让用户选择，再引导运行安装目录的 `connect.cmd` 或 `./connect.sh` 完成配对；查不到时手动填写地址。扫描不发送凭据、不写配置、不静默切换。已有 ref 属于原 Hub，不能拿到其他 Hub 查询。

此命令只查询状态，不派发、不登录、不写文件。不使用 SSH、固定服务器目录或未提供的最近任务工具。
