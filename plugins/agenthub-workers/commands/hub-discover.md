---
description: 只读发现本机及局域网 Hub，列出候选供用户选择
argument-hint: 无参数
---

# /hub-discover

调用当前工具目录中的插件 `hub_discover {}`，工具名可能带宿主生成的命名空间。首次连接或当前 Hub 连接失败时使用此工具。

展示返回的候选地址、名称和来源；只使用结果实际提供的字段。扫描不发送凭据、不保存连接、不自动选择目标，`changed_connection=false` 与 `credentials_sent=false` 表示这些边界。若有 `configuration_error`，展示诊断而不读取或输出私有连接文件。

让用户选择候选，再引导运行安装目录的 `connect.cmd` 或 `./connect.sh`，由向导验证所选 Hub 并保存外部连接文件。没有候选时说明可能受防火墙、跨网段或 Hub 未启动影响，使用向导手动填写地址。保存后重启宿主或 MCP 连接。

本命令不启动 Hub、不登录 worker、不调用模型。已有任务 ref 仍属于原 Hub；扫描或切换连接不能触发再次派发。
