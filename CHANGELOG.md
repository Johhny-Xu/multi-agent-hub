# 更新日志 / Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.3.0] - 2026-11-07

**这是一次重构而不是增量更新**：仓库主干从自建的 agenthub WebUI 换成 OpenMausBot 的多引擎工作台，hub 原有的 MCP 任务池、签到与配额作为附属模块留下。

### 变更

- **主干替换**：以 OpenMausBot `0.1.145` 为底座迁入 `server/`、`src/`、`shared/`、`electron/` 等，仓库从 26 MB 增长到约 110 MB（已剔除上游 `docs/` 下约 147 MB 的验证截图）。
- **版本跳跃说明**：从 `1.0.21` 直接到 `1.3.0`，而不是 1.1 / 1.2。1.1 与 1.2 从未发布，跳号是为了和旧 WebUI 的 1.0.x 血统明确分界。
- **签到与配额模块拆出**：`console/` 里 `checkin.mjs`、`minimax-checkin.mjs`、`vendor-quota.mjs`、`quota-deep.mjs`、`qoder.mjs`、`qoder-device.mjs`、`accounts.mjs`、`auth.mjs`、`trae-checkin.mjs` 九个文件迁到 `checkin/`， import 路径不变（同目录兄弟引用），API 未改。
- **以线上版本为准回灌三个模块**：`checkin.mjs`（158,764 → 163,883 字节）、`qoder.mjs`（21,180 → 22,026）、`qoder-device.mjs`（24,843 → 25,605）。此前仓库版本落后于 8890 上实际在跑的那份，回灌后以线上为准。
- **`scripts/` 归属调整**：hub 原有运维脚本移到 `ops/`，`scripts/` 让给 OpenMausBot 的构建链（`install-git-hooks.mjs`、`bundle-server.mjs` 等）。

### 新增能力（相对旧 WebUI）

- **五个国产编码 CLI**：CodeBuddy（国际 + 国内）、Qoder（国际 + 国内）、CodeArts、MiniMax Code、Meoo。其中 CodeArts、MiniMax Code、Meoo 不原生支持 ACP，各带一个 stdio 桥；Meoo 是 Agent Run 接口的 ACP 回放适配。
- **Antigravity 免下载官方运行时**：`agy 1.5+` 自带 `acp` 子命令，本地 CLI 可直接作为运行时，并复用 `~/.gemini/antigravity-cli` 里已有的 Google 登录态。
- **CodeBuddy 思考程度**：`--effort` 六档（minimal / low / medium / high / xhigh / max），走 argv，附 10 个单测。
- **模型列表补全**：CodeBuddy 从 3 个到 18 个；Qoder 补上 QoDuck 与 Sonus（两者由服务端目录下发，ACP 探测拿不到）。

### 移除

- `console/`（WebUI 服务端与前端，约 7.3 MB）、`desktop/`（Electron 壳）、`demo/` 与 `demo.html`（单文件离线预览）。
- 完整副本保留在标签 **`webui-final-20261107`**，可随时取回。

### 已知问题

- 自动签到原先由 WebUI 服务端每 30 分钟触发（`startAutoCheckinScheduler`），弃用后这层触发缺失，需要新的宿主来调用 `runCheckin('all')`。
- 签到相关的 HTTP 路由（`/checkin`、`/checkin/run`、`/vendor-quota`）随 WebUI 一起消失，暂无替代接口。
- `ops/remote_linux_services.py` 仍指向已删除的 `console/server.mjs`，仅作历史参考，不要直接执行。

## [1.0.21] - 2026-11-05

旧 WebUI 的最后一个版本。移动端滑轨常驻克隆与零刷新更新、MiniMaxCode 附件直传、对话流去卡片、子代理实时配额、Qoder 设备身份、CodeArts 写权限、探针上界面。

## [1.0.20] - 2026-11-03

子代理实时配额、Qoder 设备身份、CodeArts 写权限、探针上界面。

## [1.0.19] 及更早

见标签 `webui-final-20261107` 中的历史记录。
