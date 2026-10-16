# 参与贡献

感谢你有兴趣参与。本文件说明这个项目的开发约定——其中一部分是从已有实践中总结出来的，遵守它们能让你的 PR 更快被合并。

## 环境要求

| 组件 | 版本 | 用途 |
| --- | --- | --- |
| Python | 3.8+ | Hub 服务与安装器；**Codex 代理安装需 3.11+** |
| Node.js | 20+ | MCP 桥接与 Web 控制台 |

**核心链路没有第三方依赖。** Hub、控制台、MCP 桥、驱动与打包脚本都只用 Python 标准库和 Node 内置模块。少数可选依赖（`google-antigravity` SDK、`dbus`、`yaml`、`PIL`）缺失时会降级或跳过，不是运行前提。

## 开始开发

```bash
git clone https://github.com/Johhny-Xu/multi-agent-hub.git
cd multi-agent-hub
```

没有构建步骤。想手动起服务：

```bash
python hub/agent_hub.py --http      # Hub MCP，默认 127.0.0.1:8765/mcp
node console/server.mjs             # Web 控制台，默认 127.0.0.1:8890
```

## 提交前必须跑的检查

```bash
# 1. 全量离线回归（不产生真实模型费用）
python tests/run_regressions.py --report /tmp/regr.json

# 2. 凭据 / 隐私泄漏扫描
python scripts/audit_secrets.py

# 3. 若改过 console/client/index.html，重建脱机 Demo
python scripts/build_demo.py

# 4. 若改过 WebUI 布局或主题，跑 DOM 断言
node --test tests/console_layout_theme_dom.mjs
```

### ⚠️ 硬性规则：改完 `docs/` 证据文件必须重跑审计

`tests/run_regressions.py` 默认把报告写进 `docs/refactor-validation.json`。**任何改写 `docs/*.json` 的操作之后，必须重新运行 `python scripts/audit_secrets.py` 再提交。**

这条不是形式主义。本项目历史上就因此提交过一次连自己审计都过不了的证据文件——失败套件的原始输出里带着解释器路径、临时目录与工作目录。审计脚本会清洗这些本地路径，但**只在你重新生成报告之后才会生效**；在改报告之前跑的审计，已经失效了。

### 关于回归套件超时

`run_regressions.py` 给 `packaging`、`packaging_audit`、`packaging_discovery` 三个套件设了 **180 秒**上限，其余套件 **90 秒**。这是按轻载机器调的。

**在慢机器或高负载机器上，这几个套件可能超时失败，而不是真的有 bug。** 请单独重跑确认：

```bash
python tests/packaging_smoke.py
```

单独重跑能过，就说明是机器速度问题，不是回归。

**请不要为了让测试变绿而放宽断言或提高超时阈值。** 如果你认为阈值本身不合理，请单独开 Issue 讨论，并在 PR 里说明理由——这类改动需要维护者确认。

## 提交信息规范

采用 [Conventional Commits](https://www.conventionalcommits.org/)，英文，type 与描述小写：

```
fix(install): make a source checkout installable on Linux
docs(svg): fix text that overflowed its container in both diagrams
chore: declare CRLF for Windows entry points in .gitattributes
refactor(console): drop the old 9router derivation notes
```

常用 type：`feat` / `fix` / `docs` / `chore` / `refactor` / `test`。

**正文请写「为什么」，不是「做了什么」。** 代码本身已经说明了改了什么。有价值的正文会回答：原来错在哪、为什么这样修、有没有刻意保留的东西、验证到什么程度。可以直接参考历史提交的正文风格。

## 改动的注意事项

### 1. 生成物不要手改

`demo.html` 与 `demo/index.html` 由 `scripts/build_demo.py` 从 `console/client/index.html` 生成。改前端请改源文件，然后重建：

```bash
python scripts/build_demo.py
```

直接手改生成物会在下次重建时被覆盖。

### 2. 行尾符由 `.gitattributes` 决定，不要手动统一

```
*.sh   → LF      （Linux / macOS 要能直接执行）
*.cmd  → CRLF    （cmd.exe 不认 LF）
*.bat  → CRLF
*.ps1  → CRLF
```

在 Windows 上 `core.autocrlf=true`，工作区看起来是 CRLF，**但 git 索引里统一是 LF**。

因此：**如果你的补丁是对 LF 内容做的，请用 `git apply --cached` 而不是 `git apply`**，否则会因为工作区是 CRLF 而应用失败。

### 3. 版本号散落在多处

当前版本号出现在 20 多个文件里（`hub/agent_hub.py` 的 `SERVER_VERSION`、`console/server.mjs`、各 `plugin.json` / `package.json` / `marketplace.json` 等）。发版时需要一起对齐。

**但不要改带日期的历史记录**：`CHANGELOG.md` 中已发布的段落、`docs/version-history.md` 的历史条目、`docs/HANDOVER_*.md`。

### 4. 控制台是单文件

`console/client/index.html` 内含全部 HTML / CSS / JS。改动时特别注意 CSS 自定义属性的一个陷阱：**别名在声明处就完成了替换**。

`--mcode-*` 这类别名声明在 `<html>` 上并写成 `var(--gem-*)`，替换发生在声明所在元素上。所以**在 `body` 作用域只改 `--gem-*` 对 `--mcode-*` 无效，必须把别名也显式重映射**。反过来，新增主题预设只需覆写 `--gem-*`，别名会自动跟随，不要重复声明。

### 5. 不要提交凭据

令牌、API Key、会话数据一律放在仓库之外。提交前跑一次：

```bash
python scripts/audit_secrets.py --history
```

`--history` 会连 Git 历史一起扫。

## 报 Bug / 提需求

请使用 GitHub Issues。**安全问题不要开公开 Issue**，流程见 [`SECURITY.md`](SECURITY.md)。

报 bug 时请附上：版本号、操作系统、复现步骤、期望行为与实际行为、相关日志。如果问题出在某个具体 Worker 上，请说明是哪一家，以及对应 CLI 的版本与登录状态。

## 许可

本项目遵循 [Apache License 2.0](LICENSE)。提交 PR 即表示你同意以同一协议授权你的贡献。
