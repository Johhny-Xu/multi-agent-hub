# 上游同步手册：OpenMausBot → multi-agent-hub

上游每次发版后照本文做一次。脚本 `scripts/upstream-sync.sh <old-tag> <new-tag>` 覆盖
第 3–6 步，人工只需解冲突、跑失败用例、审查 diff。

## 1. 两仓关系

| 仓 | 路径 | 分支 / 版本 | 说明 |
| --- | --- | --- | --- |
| 产品仓 | `/home/johhny/multi-agent-hub` | `main`，`v1.3.0` | 对外交付的仓库。历史独立：`v1.3.0` 是把上游 v0.1.142 的工作台快照导入后重新提交的，**与上游没有共同 commit**。 |
| 上游运行仓 | `/home/johhny/openmausbot` | `port/20261107` | 有完整上游历史。`origin` = `milind-soni/OpenMausBot`，`fork` = `Johhny-Xu/OpenMausBot`。8801 当前跑的是它的工作区。 |
| 新版工作树 | `~/openmausbot-<tag>` | `port/<tag>` | 由脚本从上游 tag 新建，不覆盖 8801 正在用的工作区。 |

关键事实：**hub 的快照不是严格的 v0.1.142**。以 2026-11-07 的 v0.1.146 同步为例：

- 561 个上游改动文件里，377 个与 v0.1.142 完全一致，可直接套用；
- 52 个文件在 hub 里已经等于 v0.1.146（快照取自更晚的开发分支）；
- 30 个文件在 hub 里领先 v0.1.142（含本项目改动）；
- hub 完全不跟踪 `src/state/`（见 §2 的陷阱）。

所以不要用版本号推断内容，一律按「文件内容 + 三方合并」处理。

## 2. 路径与陷阱

### 2.1 hub 不跟踪 `src/state/`

`.gitignore` 里的 `state/` 没有前导斜杠，匹配到了 `src/state/`。该目录 56 个文件在磁盘上
存在、应用也在用，但 `git ls-files src/state` 为 0。后果：

- `git diff HEAD` 看不到 `src/state` 的改动，备份时也不会包含；
- 上游 `git apply --3way` 对这四个文件报 `does not exist in index`；
- **移植到 om 仓时必须单独复制 `src/state/`**（脚本默认做）。

修复这条忽略规则属于独立改动，未在本轮顺手改，避免把同步和仓库配置混在一起。

### 2.2 上游 patch 的排除清单

hub 仓没有上游的这些目录/文件（快照时剔除了），生成 patch 时排除，避免大量
`No such file or directory`：

```
docs/  .github/  deploy/  .tmpexp/  .oss-scanner/  .claude/  .well-known/
apps/  Dockerfile  .dockerignore  compose.yaml
```

**`build/` 必须随上游同步**（不在排除清单里）：hub 自 1.3.2 起携带上游的打包资源 `build/`（图标、entitlements、dmg 背景等），
electron-builder 打 Linux/Windows 包要用；1.3.2 首次发版就因缺 `build/` 失败（E67）。同步后检查
`git -C "$OM_REPO" diff --stat "$OLD" "$NEW" -- build/` 列出的文件都已进 hub。om 仓（0146 运行树）不需要 `build/`。

### 2.3 移植到 om 仓时的排除清单

按任务约定，以下内容不进 om 仓（它们是 hub 自己的任务书、桥接层和签到脚本）：

```
docs/  checkin/  tests/console_*
```

**`server/hub-compat/` 不在排除清单里**（E97，2026-11-13 更正）：om 树的 `server/hub-bridge.ts` 会 import 它，
缺了 8801 起不来。同步时整目录原样复制（两树 md5 一致），不做三方合并；它由 Hark 亲自维护，力工不碰。

另外**不要**移植这些（属于产品品牌与仓库配置，不是功能）：

```
README.md  README.en.md  LICENSE  CODE_OF_CONDUCT.md  CONTRIBUTING.md  SECURITY.md
CHANGELOG.md  RUN_ON_LINUX.md  package.json  .gitignore  apps/
```

`package.json` 只允许合并依赖变化；`name` / `version` / `description` 保持本项目
（版本号由人决定，当前仍是 `1.3.0`）。本轮 v0.1.142→v0.1.146 的依赖没有变化。

## 3. 一键脚本

```bash
scripts/upstream-sync.sh v0.1.146 v0.1.150          # 备份 → 打补丁 → 建工作树 → 移植 → 跑测试
SKIP_TESTS=1 scripts/upstream-sync.sh v0.1.146 v0.1.150
```

可覆盖的环境变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HUB_REPO` | `/home/johhny/multi-agent-hub` | 产品仓 |
| `OM_REPO` | `/home/johhny/openmausbot` | 有上游历史的主仓 |
| `OM_WORKTREE` | `$HOME/openmausbot-<new-tag>` | 新工作树路径 |
| `SKIP_TESTS` | 空 | 设为 1 时只做同步，不跑测试 |

脚本行为：

1. 校验 tag，备份两仓未提交改动到 `/tmp/{hub,om}-pre-<tag>.tgz`；
2. 生成过滤后的增量 patch，打印 `--stat`；
3. 先试 `git apply --3way`（仓库干净时最省事）；有未提交改动时它会报
   `does not match index`，脚本自动退回逐文件三方合并；
4. 把干净结果写回 hub 工作树，冲突文件保留 `<<<<<<<` 标记并列出，退出码 2；
5. 建 om 工作树（已存在则复用），按 §2.3 复制项目增量；
6. 跑 §5 的定向测试（`SKIP_TESTS=1` 可跳过）。

脚本**只做到待人工解冲突 / 待审查**：不 commit、不 push、不 tag、不重启服务、
不占 8765/8801/8890/18766。

退出码：`0` 全部完成；`2` 有冲突待手工解决；`3` 测试有失败；`1` 前置条件不满足。

## 4. 手工步骤（脚本失败时）

```bash
# 1. 备份
mkdir -p /tmp/hub-pre-XXXX && cd "$HUB_REPO"
git diff HEAD > /tmp/hub-pre-XXXX/tracked.patch
git status --porcelain > /tmp/hub-pre-XXXX/status.txt
git ls-files -o --exclude-standard > /tmp/hub-pre-XXXX/untracked-list.txt
tar czf /tmp/hub-pre-XXXX/untracked.tgz -T /tmp/hub-pre-XXXX/untracked-list.txt
tar czf /tmp/hub-pre-XXXX.tgz -C /tmp hub-pre-XXXX
# om 仓同理

# 2. 生成过滤后的 patch
cd "$OM_REPO"
git diff "$OLD" "$NEW" -- . \
  ':(exclude)docs/**' ':(exclude).github/**' ':(exclude)deploy/**' \
  ':(exclude).tmpexp/**' ':(exclude).oss-scanner/**' ':(exclude).claude/**' \
  ':(exclude).well-known/**' ':(exclude)apps/**' ':(exclude)Dockerfile' \
  ':(exclude).dockerignore' ':(exclude)compose.yaml' > /tmp/upstream.patch

# 3. 应用（干净工作树）
GIT_ALTERNATE_OBJECT_DIRECTORIES="$OM_REPO/.git/objects" \
  git -C "$HUB_REPO" apply --3way --whitespace=nowarn /tmp/upstream.patch
```

工作树有未提交改动时，`--3way` 需要索引与工作区一致，会对每个改过的文件报
`does not match index`。此时按文件做三方合并：

1. `git archive HEAD` 到临时目录，套用 `tracked.patch`，得到「应用前」树；
2. 对 patch 里每个文件：base = `git show $OLD:path`，theirs = `git show $NEW:path`，
   ours = 应用前树里的内容；
3. `git merge-file -p ours base theirs`，返回码 >0 即冲突；
4. 干净结果写回，冲突文件连同标记写回并人工处理；
5. 上游删除的文件：ours 等于 base 才删，否则保留（说明本项目改过）。

本轮（v0.1.142→v0.1.146）用这条路径，561 个文件里 379 个干净合并、97 个新增、
49 个已是新版、27 个上游删除、9 个冲突。

## 5. 本项目改动清单（按功能）

「易冲突点」是上游也经常改的地方；「本轮解法」可直接照抄。

### 5.1 国产 CLI 驱动

| 文件 | 作用 |
| --- | --- |
| `server/drivers/acp/codebuddy.ts` | CodeBuddy 国际 + CN 两个驱动（`CodeBuddyDriver` / `CodeBuddyCnDriver`），ACL 认证文件、effort 拆分 |
| `server/drivers/acp/qoder.ts` | Qoder 国际 + CN（`QoderDriver` / `QoderCnDriver`） |
| `server/drivers/acp/codearts.ts` | CodeArts Agent |
| `server/drivers/acp/mcode.ts` | mcode（MiniMax 系） |
| `server/drivers/acp/meoo.ts` | meoo |
| `server/drivers/acp/zcode.ts` | ZCode ACP 适配（启动参数、原生会话） |
| `server/drivers/zcode-acp.ts` | ZCode app-server 桥接：事件流、硬墙钟、GLM 套餐注入 |
| `server/drivers/meoo-acp.ts`、`codearts-acp.ts`、`mcode-acp.ts` | 各自独立进程的 ACP 适配 |
| `server/testing/fake-zcode-app-server.mjs` | ZCode 测试替身 |

注册点（每加一个驱动都要动）：

- `server/drivers/builtIn.ts` — `BUILT_IN_DRIVERS` 追加类；
- `server/instance-fleets.ts` — 实例 fleet 的 key → driverKind 映射（两处表）；
- `server/engine-memory.ts` — 每线程一进程的引擎集合；
- `shared/tool-scope-support.ts` — 工具范围支持表；
- `src/components/EngineLibrary.tsx` — 厂商显示名；
- `src/components/ProviderIcons.tsx` — 图标；
- `src/locales/*.json` — 引擎名与说明文案。

**易冲突点**：`builtIn.ts` 的 import 与数组尾部、`shared/tool-scope-support.ts` 与
`EngineLibrary.tsx` 的单行表。上游 0.1.146 在这三处加了 `commandCodeAgent`。
**本轮解法**：取并集（上游新增 + `zcodeAgent` 等本项目条目），不要整行取一侧。

### 5.2 集中 Key 注入

| 文件 | 作用 |
| --- | --- |
| `server/cli-keys.ts` | 唯一映射层：设置里的 key → 各 CLI 读的环境变量名；含 Zhipu 默认 base URL / 模型 |
| `server/credential-env.ts` | `ZHIPU_API_KEY` / `BIGMODEL_API_KEY` 等变量声明 |
| `server/config.ts` | `gemini`、`zhipu` 配置块 |
| `src/components/keys/key-catalog.ts` | 设置页 Key 目录（Gemini / Zhipu） |
| `server/drivers/acp/core.ts` | 启动子进程时只注入 `credentialEnv` 声明过的变量 |

**易冲突点**：`config.ts` 的 schema 列表、`credential-env.ts` 的常量表。
**本轮解法**：两边都是追加，取并集即可；注意 `config.ts` 里本项目的 `zhipu` 与上游
`opencodeGo` 等条目并存。

### 5.3 账号切换（服务账号）

| 文件 | 作用 |
| --- | --- |
| `server/service-accounts.ts` | 快照/切回 CLI 凭据文件；busy 时拒绝 |
| `server/routes/service-accounts.ts` | `/api/instances/:id/service-accounts` 路由 |
| `shared/service-accounts.ts` | 前后端共用的视图类型 |
| `src/components/ServiceAccounts.tsx` | 引擎设置里的账号列表 |
| `src/components/EnginesSettings.tsx` | 挂载点 `<ServiceAccounts instance={instance} />` |

**易冲突点**：`EnginesSettings.tsx`（上游也常改这个文件）、`server/index.ts` 的路由挂载。
**本轮解法**：`EnginesSettings.tsx` 只保留 `<ServiceAccounts>` 一行，其余取上游；
`server/index.ts` 的路由 `ROUTES.push(createServiceAccountRoutes(...))` 追加在上游路由之后。

### 5.4 hub bridge 与 hub-compat

| 文件 | 作用 |
| --- | --- |
| `server/hub-bridge.ts` | `/hub/*` 反代到本机 console :8890 / scheduler :8790；固定上游，防 SSRF；3s 超时 |
| `server/hub-compat/` | 独立进程：旧 AgentHub 契约（8765）→ 8801 工作台 |
| `src/components/HubSection.tsx` | 设置 → Hub 页（签到 + console iframe） |
| `src/components/DailySection.tsx` | 设置 → 日常页（各平台签到状态、worker 余额） |
| `src/components/SettingsModal.tsx` | 两个页面的注册点 |

**易冲突点**：`server/index.ts` 的 `ROUTES.push(createHubBridgeRoutes())` 与注释块；
`SettingsModal.tsx` 的 section 分支。
**本轮解法**：保留本项目的两行 import 与两个 `case`，其余取上游。

### 5.5 签到 / 日常

`checkin/*.mjs`（`checkin.mjs`、`qoder.mjs`、`qoder-device.mjs`、`minimax-checkin.mjs`、
`trae-checkin.mjs`、`vendor-quota.mjs`、`quota-deep.mjs`、`accounts.mjs`、`auth.mjs`）
与 `server/checkin.test.ts`。它们**不进 om 仓**，只留在 hub；hub 通过 `hub-bridge.ts`
访问 console，不直接 import 这些脚本。

### 5.6 禁用 worker / 隐藏模型

| 文件 | 作用 |
| --- | --- |
| `server/config.ts` | `disabled`、`hiddenModels` 字段 |
| `server/claude-accounts.ts` | 账号配置 schema 同步这两个字段 |
| `server/routes/instances.ts` | `PATCH /api/instances/:id` 写入/清除 |
| `server/index.ts` | `describeInstances` 把 `hidden: true` 合并进模型列表，`disabled` 透出 |
| `src/lib/model-choices.ts` | `pickableModels`：隐藏模型不进选择器，但当前选中项仍显示 |
| `src/lib/engine-rail.ts` | 禁用的实例不算可用 |
| `src/components/EnginesSettings.tsx` | `ModelVisibility` 模型开关 |

**易冲突点**：`server/index.ts` 的 `describeInstances` 展开顺序（本轮唯一一处
`...instance` 合并冲突），`config.ts` 的 instance schema。
**本轮解法**：保留本项目的三个展开（`hiddenModels`、`disabled`、`testedAi`），再追加
上游新增的 `...engineUpdates.shown(instance.driverKind)`。

### 5.7 调试区

`src/lib/debug-zone.ts`（`isDebugBot`：`hub·` 前缀 / `debug === true` / `source === "hub"`）、
`src/components/SidebarDebugSection.tsx`、`Sidebar.tsx`（高级模式下的独立分区）、
`CommandPalette.tsx`、`SearchResults.tsx`（搜索排除调试 bot）。

**易冲突点**：`Sidebar.tsx` 的 bot 过滤与分组（上游改动频繁）。
**本轮解法**：上游的 `everydayBots` 管线保留，把本项目的 `debugBots`、`matchesBot`
条件与 `SidebarDebugSection` 插回去；搜索类文件只做配合。

### 5.8 Jev 代理（decider）

| 文件 | 作用 |
| --- | --- |
| `server/decider/proxy.ts` | Jev 代理 URL、`withJevProxy`、脱敏 |
| `server/decider/index.ts` | 代理失败回退 OpenRouter / 自有 key |
| `server/config.ts` | `decider` 的 `jev` 配置 |
| `server/routes/decider.ts` | 设置页的测试/保存 |
| `src/components/DecisionModelSettings.tsx` | Jev 设置 UI |

**易冲突点**：`server/decider/index.ts`（上游 0.1.143 起改了 relay 与 included token 顺序）。
**本轮解法**：decider 四个文件在 0.1.142→0.1.146 没有上游 diff，保持原样；若下次上游
改到这里，先读 `server/decider/proxy.ts` 的 `withJevProxy` 语义再合并。

### 5.9 模型缓存指纹

`server/startup-model-catalog.ts`：`driverFingerprint()` 对 `server/drivers/**/*.ts|js`
做内容哈希，缓存条目带 `fingerprint`；驱动代码一变，旧缓存自动失效。
缓存文件：`~/.openmausbot/providers/engine-models/<instanceId>.json`（`OMB_DATA_DIR` 可覆盖）。

**易冲突点**：该文件是上游 0.1.143 新增的，本项目在它之上加了指纹。
**本轮解法**：以上游版本为底，把 `driverFingerprint` / `driverSourceFiles` 整段加回，
`readStartupModelCacheEntry` / `writeStartupModelCache` 保留 `fingerprint` 字段。

### 5.10 图标与其他 UI

- `src/components/ProviderIcons.tsx`：`CodeBuddyMark`（官方 CLI 包里的 app icon 路径）、
  `QoderMark`，以及 CodeArts / MiniMax / Meoo / ZCode 的单色标记；
- `src/styles.css`：本项目追加的样式；
- `src/components/{ChatView,Composer,GroupView,ModelPicker,SettingsModal,CommandPalette}.tsx`：
  中文引擎名、模型菜单、搜索等配合改动；
- `src/locales/*.json`：新增文案（本轮 16 个语言文件都改过）。

**易冲突点**：locales 几乎每次上游都会改。本轮 16 个 locale 文件都同时有上游与本项目
改动，三方合并全部干净通过；合并后仍需跑 `pnpm i18n:check` 确认 key 对齐。

### 5.11 仓库外围（不参与 app 运行时）

`hub/`（旧 AgentHub MCP 任务池）、`integrations/`（各 IDE/CLI 插件）、`plugins/`、
`mcp/`、`ops/`、`packaging/`、`drivers/`（Python/JS 探测脚本）、`tests/console_*`（旧
console 回归脚本）。移植到 om 仓时原样复制，不做改写。

## 6. 定向测试清单

在 hub 仓与 om 工作树各跑一遍（`nice node_modules/.bin/vitest run <files>`）：

```bash
# 驱动与配置
server/drivers/acp/acp.test.ts
server/drivers/acp/deepseek.test.ts
server/drivers/acp/central-keys.test.ts
server/drivers/zcode-acp.test.ts
server/drivers/zcode-acp-bridge.test.ts
server/drivers/antigravity-runtime.test.ts
server/drivers/antigravity-lifecycle.test.ts
server/drivers/antigravity.test.ts
server/startup-model-catalog.test.ts
server/config.test.ts
server/default-model-selection.test.ts
server/engine-updates.test.ts

# 服务与页面
server/service-accounts.test.ts
server/routes/service-accounts.test.ts
server/hub-compat/{dispatch,main,store}.test.ts   # 仅 hub
src/lib/debug-zone.test.ts
src/components/inbox/inbox-view.test.ts
src/components/CompanionSection.reveal.test.ts
src/components/ServiceAccounts.test.ts
src/components/ProviderIcons.engines.test.ts
src/components/EnginesSettings.models.test.ts

# 上游新增能力（本轮新增文件）
server/bot-box/relay.test.ts
server/email/sending.test.ts
server/lent-mcp.test.ts
server/retired-apps.test.ts
server/sign-in-mail.test.ts
server/headless/token.test.ts
server/headless/host-doctor.test.ts
server/voice-notes-chat.e2e.test.ts
```

本轮结果（2026-11-07）：

| 范围 | 结果 |
| --- | --- |
| ACP / ZCode / central-keys 5 文件 | 274 passed |
| hub：startup/config/service-accounts/hub-compat | 全部通过 |
| om：startup/config/service-accounts/engine-updates/debug-zone/inbox | 314 passed |
| 上游新增 9 文件 | 87 passed、1 skipped；`engine-updates.test.ts` 1 个失败，修复后该文件 15 passed（见 §7） |
| antigravity + CompanionSection | 104 passed |

**已知既有失败**（与本次同步无关，基线同样失败）：

- `server/decider/decider.test.ts` + `server/decider/decider-config.test.ts`：共 40 个失败，
  `fetchImpl.mock.calls` 为空——本项目的 `server/decider/config.ts` 判定与上游测试的假设
  不一致。改动前在 `/tmp/hub-pre-tree` 上复现同样失败。
- `server/harness/registry.test.ts`：2 个失败，`/usr/bin/env: 'node': No such file or
  directory`（测试环境 npm 子进程的 PATH）。基线同样 2 个失败。
- 前端 happy-dom 套件在本机会因 `server/testing/setup.ts` 引入 `node:sqlite` 而挂；
  本轮运行的 `ServiceAccounts` / `ProviderIcons` / `inbox-view` 均通过，未复现。

## 7. 本轮新增的一处项目适配

上游 0.1.146 新增 `server/engine-updates.test.ts`：`BUILT_IN_DRIVERS` 里凡是会安装的
驱动，`ENGINE_VERSIONS` 必须有版本钉。本项目的 `codebuddyAgent` / `codebuddyCnAgent`
因此失败。解法：在 `server/engine-versions.ts` 加两条 `{ target: LATEST, minimum: "0.0.0" }`，
不钉版本（该包的 npm registry 在公开源查不到，无法验证版本）。下次上游再加同类断言时，
优先检查本项目新增驱动是否都被覆盖。

## 8. 8801 切换步骤（由审查者执行）

同步与测试完成后，**脚本不碰 8801**。切换前确认：

1. 新工作树 `~/openmausbot-<tag>` 的 `port/<tag>` 分支内容已审查；
2. 旧工作区 `/home/johhny/openmausbot` 仍在 `port/20261107`，随时可回滚；
3. 备份 `~/.openmausbot/config.json`（不在仓库里）。

构建前端（本机 11G 内存，必须限堆）：

```bash
cd ~/openmausbot-0146
NODE_OPTIONS=--max-old-space-size=3072 nice node_modules/.bin/vite build
```

模型缓存：`~/.openmausbot/providers/engine-models/*.json` 带 `fingerprint`，驱动代码变了
会自动重读，无需手工删除；若怀疑缓存异常，删这一个目录即可（不要删整个
`~/.openmausbot`）。

停止与启动（当前进程：`node --experimental-strip-types server/openmausbot.ts serve
--port 8801 --no-pair`，工作目录 `/home/johhny/openmausbot`）：

```bash
# 停：向 8801 的父进程发 TERM，等它自己退出（不要 kill -9）
kill -TERM <8801 的 openmausbot.ts 进程 pid>

# 起：在新工作树里用同一命令
cd ~/openmausbot-0146
/home/johhny/.local/opt/node24/bin/node --experimental-strip-types \
  server/openmausbot.ts serve --port 8801 --no-pair
```

验证：打开 8801 页面，确认引擎列表包含八个国产驱动、设置 → Hub / 日常两页可开、
模型选择器里隐藏模型不出现。**不要**用真实账号做签到或切号验证，按
`docs/verification/README.md` 用隔离 fixture。

回滚：

```bash
kill -TERM <新进程 pid>
cd /home/johhny/openmausbot && git switch port/20261107   # 工作区本来就未提交，先 git status 确认
/home/johhny/.local/opt/node24/bin/node --experimental-strip-types \
  server/openmausbot.ts serve --port 8801 --no-pair
```

两仓的未提交改动备份：`/tmp/hub-pre-0146.tgz`、`/tmp/om-pre-0146.tgz`（含
`tracked.patch`、`status.txt`、`untracked-list.txt`、`untracked.tgz`）。

## 9. 本轮：v0.1.150 → v0.1.154（2026-11-12 23:00 – 11-13 02:00）

上游 `v0.1.150..v0.1.154` 共 704 个提交（Team Cloud 共享/团队记忆、发布到 Netlify 与
Published apps 页、聊天流式显示、设置菜单重排、云电脑额度文案、MCP 名称精确匹配等）。
本轮新开工作树 `~/openmausbot-0154`（分支 `port/0154`），8801 由 0146 切过去（见 §9.5）。

### 9.1 om 树（`~/openmausbot-0154`）三方合并结果

脚本：`~/.cache/zrev/up154/port.py`，结果 `~/.cache/zrev/up154/port0154.json`
（base = v0.1.150，theirs = v0.1.154，ours = 0146 快照 `~/.cache/zrev/up154/snap-0146/`）。

| 类别 | 数量 | 说明 |
| --- | --- | --- |
| copy（本项目未改，直接取 0154） | 101 | |
| merged（git merge-file 干净合并） | 91 | |
| conflict（人工/力工解） | 51 | 解法原则见 `~/.cache/zrev/up154/COMMON.md`：上游全收、本项目功能全留、上游搬家则跟着搬 |
| new（0154 新增文件） | 631 | |
| up-deleted（上游删、本项目改过） | 4 | `SettingsModal.groups/simple.test.ts`、`SettingsSimplePages.member.test.ts`、`SettingsSimplePages.tsx`：上游已把设置拆成一个菜单，随上游删除 |

51 个冲突文件里重灾区：`server/index.ts`、`server/store.ts`、`server/config.ts`、
`server/drivers/acp/core.ts`、`server/drivers/antigravity.ts`、`src/state/store.tsx`、
`EngineSetup/EnginesSettings/EngineLibrary/ModelPickerFull/SimpleModelMenu`、
`analytics-allowlist`、10 个 locale + `source-hashes.json`（locale 用 `up154-jmerge.py` 按键取并集后重算哈希）。

0146 在升级期间新增的改动（豆包 doubao、Antigravity 账号、local-computer/E94 等）用
`port0146new.py` 二次带入 0154：new 2、copy 8、merge3 10、conflict 2（`routes/instances.test.ts`、
`analytics-allowlist.ts`，取并集）。DuMate（E99）随后由子代理直接在 0154 落地。

### 9.2 产品仓（`~/multi-agent-hub`）

脚本：`~/.cache/zrev/up154/hubapply.py`，结果 `hubapply.json`：copy154 1682、merge3 21、
delete 24、keep 1（`scripts/ci-workflow.test.ts`，本项目 CI 不同）、noop 717、**skip-never 11（`server/hub-compat/` 全目录）**。

上游删除、随之在 hub 删除的 24 个文件：escalations（含 `routes/internal-escalate.ts`）、
peer-approval 一组、starter-bot-limit、LoginsSettings、TeamOrgChart（含 `src/lib/team-org-chart.ts`）、
`SettingsSimplePages.tsx` 与三个旧设置测试、`external-runtime-busy.e2e.test.ts`。
**注意**：这些删除尚未提交，`git ls-files` 仍列出它们，所以在主仓跑
`scripts/testing/file-size-ratchet.test.ts` 会 ENOENT（`server/escalations.ts`）；提交后即恢复。0154 树（干净工作树）里同一测试通过。

依赖：`@trycua/cua-driver` 0.41.3 → 0.45.4（主仓已 `pnpm install`）；0154 树另装 `playwright-core`（harkWeb / web-chat 驱动用）。

### 9.3 E97：`server/hub-compat/` 必须整目录原样复制

§2.3 原先把 `server/hub-compat/` 列入「不进 om 仓」，**这是错的**：`server/hub-bridge.ts`
会 import 它，om 树缺这个目录 8801 起不来。规则改为：hub-compat 由 Hark 亲自维护，
两树整目录 md5 一致；同步脚本对它只做「整目录复制」，不做三方合并，力工不碰。

### 9.4 本轮测试与修正

- 0154 树测试清单 `/tmp/n2-0154-tests.txt`（77 个文件 = `/tmp/up154-tests.txt` 54 个 + doubao、dumate、
  antigravity 账号、instances、hub-compat 5 个、web-chat、plan-usage 等）。
- 测试期修正（两树同改，备份 `~/.cache/zrev/*.bak-night2`）：
  - `server/plan-usage.ts`：Meoo 的 `currentPeriodEnd` 不带时区（`2026-11-21T00:00:00`），按北京时间读（`beijingWallClock`），
    不再随宿主时区漂移；测试期望改为 `2026-11-20T16:00:00.000Z`（= 北京 11-21 00:00）。
  - `src/state/store.test.ts`「config status frames」：本项目的 vps 配置帧带多 VPS 列表 `instances` 与 `revision`，期望补上这两个字段。
  - `scripts/testing/file-size-ratchet.test.ts`：登记本项目增长——`server/index.ts` 15907、`server/plan-usage.ts` 1115、
    `server/vps-computer.ts` 1332，新增 `server/drivers/openai-chat.ts` 1003。
  - `server/drivers/acp/qoder.ts`：E89，qoderCn 静态模型表加 `qmodel_latest`（Qwen4-Max-Preview）。
  - `server/drivers/web-chat/{core,cdp-transport}.ts`：E100，harkWeb 默认 CDP 改连 mychrome（9333，可用 `OMB_WEBCHAT_CDP_URL` 改），拒绝 Electron 应用的调试口（开发机上 9222 被 Trae CN 占用）。
- 0154 全量结果：77 个文件 3219 过 / 1 败（file-size-ratchet，测试机无 `.git`，本机跑通过）。
- 只能在有 `.git` 的树里跑 file-size-ratchet（rtest/rt154 同步到测试机时排除了 `.git`，在测试机上必败，属环境）。

### 9.5 8801 切换（本轮实际做法）

- 前端：`cd ~/openmausbot-0154 && NODE_OPTIONS=--max-old-space-size=3072 nice node_modules/.bin/vite build`（约 1m45s，不与其他 build 并行）。
- drop-in：`~/.config/systemd/user/openmausbot-lan.service.d/0154.conf`（`WorkingDirectory=%h/openmausbot-0154`），
  原 `0146.conf` 移出（副本 `~/.cache/zrev/0146.conf.bak-night2`）。数据备份 `~/.cache/zrev/omdata-pre-0154-night2/`（config/bots/sessions + runtime.db、messages.db 在线备份）。
- 重启前确认所有 bot `busy=false`、hub 没有 running 派活（E96）。
- `XDG_RUNTIME_DIR=/run/user/$(id -u johhny) systemctl --user daemon-reload && systemctl --user restart openmausbot-lan`；
  同时重启 `multi-agent-hub-mcp`（跑主仓 `server/hub-compat/main.ts`）。
- 回滚：删 `0154.conf`、放回 `0146.conf`、daemon-reload、restart。

- 实测（2026-11-13 01:27 切换后）：首页与 /api/health 200（/hub/quota 首次 504、随后 200，属冷启动）；日常页 /hub/checkin/status 含豆包与 DuMate；引擎库可见 doubaoAgent（未登录）、dumate（未扫码）；E95 Antigravity 账号 5 个（含 henry），切 henry 再切回 ultra 后不丢号，monster 删除 dry 检查无阻挡（未实删）；qoderCn 13 个模型含 qmodel_latest；worker-smoke codebuddy-cn、minimaxcode 通过，zcode 额度用完（见 E101）。
