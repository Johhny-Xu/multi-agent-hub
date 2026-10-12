# Git 版本与检查点

Git 发布日期：2026-10-09。0.5–0.8 按下表顺序独立提交、打标签并逐次推送；提交日期没有回填成备份日期。这四个检查点之外的修改仅限发布说明、更新日志和测试报告中个人局域网代理地址脱敏，运行源码保持一致。

| 标签 | 备份 | 文件数 | 备份 SHA256 |
| --- | --- | ---: | --- |
| v0.5.0 | agenthub-stage01-before-20261008-175905.zip | 133 | `5f59cbde7113747d41797b58853c014d7fe37cb006c4755afc3e7a1b2ef79474` |
| v0.6.0 | agenthub-stage06-final-verified-20261008-192350.zip | 222 | `6e5cead3ad48d89b7dff6d1985686d0739394e94d386f43db2592d62cf1ed233` |
| v0.7.0 | agenthub-stage10-final-release-20261008-202551.zip | 272 | `cffd002dabe9ff05ebc22d9021c176f68422c2946f974f855b58931b251f8a57` |
| v0.8.0 | agenthub-stage14-before-version-push-20261009-081155.zip | 298 | `67b85a0d69b30de0b9327ee62dce777a198603a6465a2a0937711b1b4b423157` |

0.5.0 使用最早保存的 stage01：其中 ZCode/MCP 为 0.5.0，但已包含标为 0.6.0 的 Codex 初稿。该标签如实保存这一混合阶段，不改写组件版本，也不称为历史正式安装包。

0.6.0 和后续版本使用各阶段完成验收后的快照。

0.8.0 的 stage14 与 stage13 的源码一致，仅多两份 2026-10-09 测试 CLI 卸载记录。

所有备份均核对 ZIP CRC 与每个文件的 SHA256；各版推送前扫描源码和 Git 历史中的密钥模式。模式扫描存在覆盖边界，不代表对所有秘密形式的绝对保证。

安装包仍为本机产物，未上传 GitHub Release 附件。标签可用于获取对应源码；测试报告记载的模型、账号、网络和宿主限制继续有效。

## 后续版本

- `v0.9.0`：华为 CodeArts 双向接入与第九种 Worker 适配；四种客户端共用任务与结果协议。
- `v0.9.1`：包含 CodeArts 双向接入与 README / SVG 更新，统一项目名称与多端规范。
- `v0.9.9`：增加 Antigravity 原生插件及可选 SDK，完成五种原生客户端与九种 Worker 的生产发布与验收。（原 changelog 误记为 0.9.2，已更正）
- `v0.9.9.1`：CodeArts 官方凭据自动加载、TraeCode 网关终态校验与倍率对齐、子代理模型目录当季精简去重；修复 IDE 扩展四段版本号导致的扫描崩溃并恢复附件按钮。（原 changelog 误记为 0.9.3，已更正）
- `v0.9.4`（console/WebUI 线里程碑，编号保留）：WebUI 控制台升级为 CodeBuddy 三栏式布局，支持时段问候语、全局头像定制、全量会话聚合归档与二次确认一键删除、一键复制 Agent 接入配置及全环境剪贴板兼容；完成 MiniMaxCode 双向适配（Worker + MiniMax Plugin V1 / Claude Code / Agent Plugins 1.0 一包四吃）；切换为 Apache License 2.0 开源协议。
- `v0.9.9.2`：9 Worker 登录链路状态检测化重构（杜绝假成功）、CodeBuddy 新版 XDG 共享会话存储对齐与官方 state 兑换看门狗、Trae PKCE 授权链接修复、ZCode 国际/国内双区切换、MiMo API Key 通道与账号分离、MiniMax 账户名注入识别、模型别名逐个可删；全场组件版本统一，后续版本自 0.9.9.2 递增。

