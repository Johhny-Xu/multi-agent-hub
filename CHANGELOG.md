# 更新日志 / Changelog

本项目的所有重要更改都将记录在此文件中。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

版本日期为 Git 发布日期；实现、测试和构建记录保留各自实际日期。源码标签与安装包附件分开管理，是否上传附件以各版交付记录为准。检查点来源见 [版本记录](docs/version-history.md)。

## [Unreleased]

### 修复：Qoder 国际版终于签到成功（真实设备指纹）
- **根因**：上游按**设备**下发活动，`Cosy-MachineToken/Code/Type` 是代码里合成的，不是真实客户端的 → 活动列表恒为空（token 有效、无 401，所以一直误判成"没活动"）。
- **做法**：按开源项目 `wallechfox/qoder-checkin` 的 `01_extract.py`，在装了 Qoder 客户端的 Windows 上提取真实指纹（`runtime-info.exe` + DPAPI），
  落到 `~/.config/agenthub-qoder/device.env`；`qoder-device.mjs` 新增 `loadQoderDeviceEnv()`：环境变量优先、文件兜底。
- **部署**：n5095 的 unit 加 `EnvironmentFile=-%h/.config/agenthub-qoder/device.env`，重启后生效。
- **结果**：`Henry Baker (henrybaker2689@gmail.com)` 领到 **+100 Credits**（随后幂等返回"今日已领取"）。另一个账号 `花凄` 仍为空列表（账号侧无活动）。

### 修复：Qoder CN「明明没签到却显示已签到」
- 根因：判定「今日已领」只看 `claimStatus == CLAIMED`，没校验活动有效期，把上一期 CLAIMED 的老活动当成了今天已领，于是直接返回 already、根本不去领。
- 修法（对齐开源项目 `wallechfox/qoder-checkin`）：新增 `qoderInWindow()`，CLAIMED 必须同时满足 `startAt <= now < endAt` 才算今日已领；过期 CLAIMED 单独计数，并在消息里输出 `[活动 N 个：状态/状态…]` 诊断串。
- 实测：两个账号各领到 +100 Credits。

### 修复：签到日志点开是空白
- 根因是 **HTML 少了一个 `</div>`**：`#checkin-tab-history` 被嵌进了 `#checkin-tab-grid` 里面，切到日志 tab 时外层 `hidden` 把它一起隐藏了（DOM 里 history 的 parentElement 是 grid）。
- 修法：补上闭合标签，让两个 tab content 成为兄弟节点；另加 `.settings-card-body > .checkin-tab-content { width:100% }` 兜底。
- 实测：切到日志 tab 后高度 454px，20 条记录正常显示。

### 新增：Meoo Agent OpenAPI 调用器 `scripts/meoo_agent_run.mjs`
- Meoo 有 Agent OpenAPI（`https://meoo.com/open/v1`）：`POST /projects/{id}/agent/runs` 起 Run + `GET .../events` 收 SSE，用**账号 AK** 直接鉴权，不需要部署应用。
- 脚本支持 `--project <url_id> --model --tier`，实测「只回复两个字：收到」→ 返回「收到」、status=completed。

### 修复：Meoo 头像
- 头像映射表加 `meoo`（薄荷绿渐变 + 「秒」），并补 `.platform-avatar[data-agent="meoo"]` 的深底+绿描边规则。

### 新增：Meoo（秒悟 / 阿里云）签到，第 7 个平台
- **判定依据**：Meoo 的每日积分是「每日登录赠送」（账号权益里 `typeCode = daily_login`，2000/天），官方 CLI `@aliyun-meoo/cli` 的 `meoo login` 就是一次登录，所以签到 = `meoo login --ak <AK>` + `meoo account --json` 读积分。
- **凭据**：AK 放 `~/.config/agenthub-meoo/meoo-auth.env`（`MEOO_AK=...`，不进仓库），也支持环境变量 `MEOO_AK` 或控制台「配置 AK」写进 `customTokens.meoo`。
- **实现**：`checkinMeoo()` 走 `execFile` 调 CLI；Windows 上 npm 全局是 `meoo.cmd`，必须 `shell: true`；服务由 systemd 拉起、PATH 里没有 `~/.npm-global/bin`，所以 `resolveMeooBin()` 会按常见安装路径兜底解析。
- **UI**：签到页新增「Meoo 秒悟」页签与卡片（账号 / 凭据来源 / 打卡状态 / 可用积分 / 立即签到 / 配置 AK），顶部统计胶囊从 6 平台变 7 平台。
- **服务端**：n5095 已 `npm i -g @aliyun-meoo/cli`（0.5.6），AK 写到 `~/.config/agenthub-meoo/meoo-auth.env`（600 权限）。实测返回 `Johhny 登录成功，Free 免费版，可用积分 12,000`。

## [1.0.16] - 2026-10-21

### 修复：华为云码道（CodeArts）签到
- `opengw` 的 `/api/v1/benefit/claim`（每日福利 Token）对这批 AK 稳定返回 `4000 invalid channel, group not found`，**benefit 通道按账号下线**；而发「每日 1000 积分」的 `GET /v1/ops/delivery` + `POST /v1/ops/claim`（snap-access）正常。原代码把福利通道失败当致命错误直接 return，导致整个签到判失败。现在福利通道降级为 best-effort，只在消息里注明「已跳过」，继续走积分签到。

### 改进：Qoder 国际版活动列表为空时自动换环境
- 参考开源项目 `wallechfox/qoder-checkin`，`qoderRequest` 支持 `baseUrl` 覆盖；国际版拿到空活动列表时用同一个 token 换 `openapi.qoder.com.cn` / `openapi.qoder.sh` 再问一次，有活动就在新环境领并标注；仍为空则提示「设备指纹 Cosy-MachineToken 可能过期」。

### 新增：看板娘可拖拽（拎起来 → 挣扎 → 松手坠落 → 落地擦汗）
- 三段素材 `mascot-hang` / `mascot-fall` / `mascot-wipe`（800×873 / 800×678 / 800×910），`#mascot-air` 独立 fixed 图层，`pointerdown` 拎起来播挣扎循环跟手、`pointerup` 用 rAF 加速坠落到**松手鼠标点的正下方**（1.1~2.4s），落地播擦汗后回常态。
- 尺寸跟设置联动（`--mascot-w` 提到 `:root`）；擦汗层按 69% 缩放 + 抬 0.1×宽，和待机同一个大小、桌面线压在输入框上沿。

### 新增：灰底抠像模式 `--key flat`
- 新视频不是绿幕（灰底 ~128 + 白色速度线 ~184），chroma key 会留线或吃白衬衫。`alpha_flat()` 挖「低饱和 + 亮度区间 + 与画面边缘连通」的连通域，白衬衫被描边包住所以安全。参数 `--flat-lo/-hi/-sat`。

### 修复：设置页也会触发看板娘
- 切到设置页时 `#panel-chat` 是 hidden、dock 的 rect 为 0，但 `dock.hidden` 仍是 false，掉落定时器照跑。加 `mascotOnScreen()`（rect 宽高 > 0）统一判断。

### 新增：对话看板娘（趴在输入框上沿，30fps × 8 秒循环动画）
- **位置**：`#chat-col` 里加一层 `.mascot-dock`，**素材里那条深红横线正好压在输入框卡片的上边框上**（`bottom: calc(var(--composer-h) - var(--mascot-w) * 0.105)`，红线在素材底边往上 84/800 处，必须按宽度比例换算）、右侧留 36px 躲开圆角；**红线以下她的袖子和桌沿灰带保留**，压在输入框上（`z-index: 60`）；`--composer-h` 由脚本用 `ResizeObserver` 实时量（输入框换行长高时她跟着上移），所以永远「趴」在框上，不会飘在背景里。
- **素材**：`console/client/mascot/mascot-loop.webm`（VP9 + alpha，800×771，**30fps×8s**，1.3 MB）+ `mascot-poster.webp`（静态封面，视频解不出来时兜底）。整段是**完整循环动画**：待机托腮 → 挥手 → 说话 → 眨眼吐舌 → 鼓脸 → 生气冒烟 → 砸桌子，首尾接得上。
- **抠图**：白底视频逐帧拆开抠成透明（`scripts/mascot_video_frames.py`，四边 flood fill + 边缘反预乘去白边），并单独清掉她手肘下面那层浅灰投影（被手臂围成口袋、边框 fill 进不去，按「与背景连通的 175~246 浅灰」再吃一遍，白色校服 ≥248 会挡住它）。**绿幕版**（当前用的）走 chroma key：四角取幕布色算 RGB 距离 `α = clamp((d-10)/(50-10))`（阈值要收紧，否则「白+绿」混色的桌沿会被判成背景淡出），再做 unspill（`G = min(G, (R+B)/2)`）压掉发梢上的绿边。**所有帧共用同一个固定裁切**，对齐靠裁切本身，不能逐帧算包围盒。
- **编码坑**：libvpx 的 alpha 和 alt-ref 帧不兼容，`-auto-alt-ref 0` 必须加，否则会被静默降级成 `yuv420p`、透明直接没了；`ffprobe` 看输出仍是 `yuv420p`，不代表没有 alpha（alpha 在 BlockAdditional 里，Chrome/Edge/Firefox 正常）。
- **交互**：点她随机跳到动画里的一个表情段落（`REACTIONS`：1.44 挥手 / 2.88 说话 / 4.0 眨眼 / 5.12 鼓脸 / 6.08 生气 / 7.04 惊讶，按 30fps 成片；**改帧率后必须按 24/新帧率 重算**）+ 随机播一段 CSS 动画（弹跳/摇头/放大/压扁/歪头）+ 说一句话；悬停轻微前倾、悬停 340ms 后说话；空闲 45s 自己嘀咕一句。派发成功时跳到挥手段落。
- **性能**：`IntersectionObserver` + `visibilitychange` 控制播放，切到设置页或她不在视口里就暂停解码；`drop-shadow` 只挂在静态封面上，不挂视频（弱机上逐帧重绘滤镜会卡）。
- **设置**：设置 → 外观与自定义背景新增「对话看板娘」开关 + 小/中/大尺寸 + 「让她说句话」，偏好写 `localStorage`（`agenthub.mascot.hidden` / `agenthub.mascot.size`）。**不在她身上放 ✕ 收起按钮**（曾经有，压在她脑袋上极易误点，一收起刷新也不回来）；手机上整块隐藏。
- **降透明度**：消息压到她身上时降到 85%（鼠标移上去复原），长会话里不挡字。
- **坑**：全局 `button:hover` / `button:active`（`index.html` 第 146-154 行）会给按钮加底色和整体缩放，`.mascot-figure` 必须用 `.mascot-dock .mascot-figure` 提特异性并 `background: transparent !important`，否则悬停时她背后会多一块灰色矩形。
- **素材必须内联进 index.html**：`scripts/inline_mascot.py` 把 `src="mascot/*.webm|*.webp"` 换成 data URI（幂等，`--check` 只检查）。原因是 `server.mjs` 只把 index.html 的字节吐给 `/`、没有静态资源路由，线上也是 `scp index.html` 单文件部署——相对路径会 404，表现为「看板娘不显示」。index.html 因此从 750 KB 涨到约 2.6 MB（素材改了要重跑，脚本能刷新已内联的 data URI）。
- 重叠态透明度从 `.38` 调到 `.85`：`.38` 太淡，长会话里会被误认为「她没显示」。
- **修「她下半截被输入框盖住」**：`.mascot-dock` 的 `z-index` 提到 60（确保压在输入框之上）、`bottom` 按红线比例定位；右侧内缩 26→36px 避开 22px 圆角；`--composer-h` 增加 load/300ms/1200ms/fonts.ready 四次重测，防止输入框长高后她没跟上。
- **修「动画播放后背后还有一个不动的她」**：视频是带 alpha 的，静态封面垫在底下时，视频透明的地方会把封面那一帧透出来。现在 `loadeddata` 后给封面加 `.is-hidden`（淡出到 0），解码失败再退回封面。
- **裁切范围**：`--crop 400,0,1520,1080` —— 上下左右都不切。早先按 `480` 起裁把左边生气/砸桌子的**烟雾、星星**切掉了，按 `y=40` 裁顶又把**呆毛**切了（她抬头时呆毛顶到 y=16）。所有帧的并集包围盒是 x 438~1445。
- **白底 GIF**：`ffmpeg -f lavfi -i color=white ... overlay,scale=400:-1,palettegen(160),paletteuse(bayer)` → 400×386 / 30fps / 8s / 7.5 MB。
- 素材生产流水线与提示词见 `console/client/mascot/PROMPTS.md`。
- **部署注意**：`server.mjs` 启动时把 `index.html` 读进内存（`clientEntry`），之后只吐这一份；部署机用的是 `miniapp/client/index.html` 拷贝。所以前端改完必须 `scp` 到 `miniapp/client/` 再 `systemctl --user restart agent-hub-console`，否则页面还是旧的（表现为「看板娘的 DOM 根本不存在」）。

### 改动：看板娘待机只播「托腮」，点击改成三步循环
- 待机：只循环 **0~1.2s** 的托腮小动作（就是那张待机图），其余段落不再自动播。
- 点击按序推进：**摇手（1.44~2.88s）→ 扮鬼脸/眨眼吐舌（4.0~5.12s）→ 生气锤（6.08~7.04s）**，播完自动回待机；第 4 次点击回到摇手。
- **10 秒内没有下一次点击就归零**，下次又是摇手（`lastPokeAt` 判断）。
- 实现：`video.loop` 不再靠属性，用一个常驻 `requestAnimationFrame` 卡 `currentTime`（`stepUntil` 播完回 `IDLE_FROM`，空闲超过 `IDLE_TO` 就跳回 0）；派发成功的挥手改走 `playStep(0)`。

### 新增：灰底抠像模式 `--key flat`
- 新视频不是绿幕：背景是**灰底（~128）带白色速度线（~184）**，还有渐变。用 chroma key 要么把速度线留下，要么把白衬衫吃掉。
- `alpha_flat()` 的思路：把「低饱和（max-min < 18）且亮度在 lo~hi」且**与画面边缘连通**的区域整块挖掉（`ndimage.label` + 边缘种子）。
  白衬衫/白袜子被深色描边包住，flood fill 进不去，所以安全；速度线虽然亮，但它连着边缘，一起被挖掉。
- 参数：`--flat-lo`（默认 100）、`--flat-hi`（默认 216，白底给 255）、`--flat-sat`（默认 18）。
- 三段各自不同背景：挣扎/俯冲 `--flat-hi 216`，擦汗 `--flat-hi 255`（那段底部是白色桌面）。
- 另外三段宽高比不同（1.09 / 0.85 / 1.31），`.mascot-air video` 改成 `width:100%; height:auto; bottom:0`（宽度铺满 + 底边对齐），不再用 `object-fit: contain`。

### 修复：设置页也会触发看板娘
- 切到设置页时 `#panel-chat` 是 `hidden`，`.mascot-dock` 的 rect 变成 0，但 `dock.hidden` 还是 false，自动掉落定时器照跑，于是她在设置页上凭空出现。
- 加 `mascotOnScreen()`（rect 宽高都 > 0）并在 `drop()` / `enterHold()` / 自动循环里用它判断。

### 修复：华为云码道（CodeArts）签到一直失败
- 线上报 `CodeArts 返回 [4000]：invalid channel, group not found`。实测：opengw 的 `GET /api/v1/benefit/claim`（每日福利 Token）对这批 AK 稳定返回 4000，**benefit 通道按账号下线了**；而真正发「每日 1000 积分」的 `GET /v1/ops/delivery` + `POST /v1/ops/claim`（snap-access 域名）是好的。
- 原代码把福利通道的失败当成致命错误直接 return，导致整个签到判失败。现在福利通道**降级为 best-effort**：失败只在消息里注明「福利 Token 通道不可用（4000），已跳过」，继续走积分签到；只有签名/凭证类错误才中止。
- 实测（线上）：`ok:true / 今日已领取「每日签到领1000积分」（1000积分）`。

### 改进：Qoder 国际版活动列表为空时自动换环境
- 参考开源项目 `wallechfox/qoder-checkin`：`baseUrls` 可在 `https://openapi.qoder.sh`（国际）与 `https://openapi.qoder.com.cn`（国内）之间切换。
- `qoderRequest` 支持 `baseUrl` 覆盖；`listQoderCampaigns` / `claimQoderCampaign` 多传一个 `baseUrl`。`checkinQoderOne` 在国际版拿到空活动列表时，用**同一个 token** 换另一套环境再问一次，有活动就在新环境上领，消息里标注「已切到 xxx」。
- 仍为空时给出可执行提示：窗口 10:00 开启 / 客户端已领过 / **设备指纹 Cosy-MachineToken 过期（回 Windows 跑 01_extract.py 重新提取，或在客户端重登）**。

### 新增：看板娘可拖拽（拎起来 → 挣扎 → 松手坠落 → 落地擦汗）
- **三段新素材（2026-10-21 换新视频重制）**：来源 `454639640969510_到擦汗为止.mp4`（2560×1440/24fps/11.58s）。挣扎 2.6~4.9s、俯冲 5.6~8.8s、擦汗 9.9~11.5s。**这版背景不是绿幕**（灰底 ~128 + 白色速度线 ~184），所以新加了 `--key flat` 模式。：`mascot-hang`（被拎着挣扎，1.83s loop，800×873）、`mascot-fall`（**头朝下俯冲**，2.53s loop，800×678，`--crop 440,0,2140,1440`）、`mascot-wipe`（落地擦汗，1.30s 播一次，800×1047，`--flat-hi 255` 因为这段背景是白的）。来源：`hanging` 视频 2.0~3.67s / 7.3~8.97s，`falling` 视频 3.3~4.67s。
- **交互**：`pointerdown` → 拎起来（播 hang 循环、跟手、常态层 `visibility:hidden`）；`pointermove` 位移 >5px 才算拖动；`pointerup` → rAF 加速坠落（**时长 1.1~2.4s，故意放慢**，`e=p²`）+ 播 fall；**落点是松手那个鼠标点的正下方**（`landXFor(e.clientX, w)` → `left = x - w*0.5`，再夹在输入框上方；自动彩蛋用她自己的中心），落地后把 `.mascot-dock` 的 `left` 挪到落点并存 `agenthub.mascot.x`，刷新后保持；到点播 wipe 一次 + 常态层 `anim-squish`，播完回 idle。没拖动就是「点了一下」，走 `react()` 换表情。
- **结构**：新增 `#mascot-air`（`position:fixed`，`<body>` 末尾、**必须放在看板娘脚本之前**），三个 `<video>` 叠着只显示一个；归位坐标 `restY = dock.bottom - airH`，resize 时重算。
- **自动彩蛋**：`drop()` 复用同一链路（先挣扎 0.7s、抬 70px 再坠落），每 45~75 秒一次，也可 `HubMascot.drop()`。
- **尺寸统一**：`--mascot-w` / `--mascot-h` 提到 `:root`，`html[data-mascot-size]` 直接改变量，常态层和空中层共用，设置里选「小」时掉下来也是小的。
- 四条视频全内联，index.html 到 4.7 MB。

### 变更：会话归档改为「直接执行 + 底部气泡撤销」
- **去掉二次确认**：点会话的归档图标不再弹 `confirm()`，直接归档并立刻从列表移除。
- **底部漂浮气泡**：一行提示「已归档「会话名」」+ 实心「撤销」按钮，8 秒倒计时条，浮在输入框上方（按 `#chat-composer` 实际位置算，避免盖住发送按钮）。超时自动消失，归档保留。
- **新增 `POST /api/chat/unarchive-session`**：把 `archives/<agent>-<sessionId>.json` 读回、删掉归档文件、把会话插回 `entry.sessions` 首位，返回新的 `sessions` / `thread`。老会话可能没有 `agent` 字段（归档名是 `unknown-<id>.json`），两种文件名都会尝试。
- 撤销后提示「已撤销归档」；失败走 `toast` 报错，不会静默。

### 变更：MiniMax worker 补上模型目录与 agent 模式
- **默认模型 `minimax/MiniMax-M3.1-Flash`，另留一档 `minimax/MiniMax-M3`**：控制台模型目录、三份 `agents*.example.json`、`packaging/install.py` 与线上 `agents.json` 同步。**实测发现 provider 前缀国内区也是 `minimax/*`**（`minimax-cn/MiniMax-M3.1-Flash` 会报 `not available for the "configured_provider" route (preset cn-prod)`），此前文档里写的「国内区用 minimax-cn」是错的，已一并纠正。
- **agent 模式**：`cli` 加 `--prompt-mode work`（mcode 的 `--prompt-mode` 有 `tui/coding/work`，默认 `tui`，work 才是干活模式）；`hub/capabilities.json` 新增 `permission.modes` —— `edit`（`--permission smart`，默认）与 `full`（`--permission full`）。控制台「模型与运行参数 → 文件编辑权限」现在对 minimaxcode 可选，实测 `full` 档经 `/api/dispatch` 派发能真实落盘。
- **`--permission off` 不是只读**：实测 off 与 smart 都能写文件（off 的语义是「关闭权限询问」= 全放开），所以**不声明 readonly 档**，避免给用户一个假的只读开关。
- **`merge_cli_arguments` 把 `--permission` / `--prompt-mode` / `--mode` 纳入标量替换**：否则 `cli` 里已有的 `--permission smart` 会和任务选项叠加成重复 flag（最后生效的才是用户所选，容易踩坑）。
- **子代理与配额中枢同步同一套滑轨**：卡片区改一行滑轨（`flex: 0 0 360px`，移动端 86%），支持鼠标拖动 + 松手惯性 + **无限循环**（首尾搬家 + `scrollLeft` 补偿）；头部新增 `#qa-agent-tabs` 快速跳转胶囊（带主题色圆点），点哪个就把那张卡**滑到视口正中**（越界时靠搬家补位，所以左右都能到）。选中卡片的**顶部配色条**取该子代理的 `AGENT_THEMES[color]`，与打卡卡片同一套视觉；滚动时高亮跟随「最靠近中心」的卡片，搜索过滤时胶囊同步隐藏。
- **修极光 / 自定义背景下的选中描边**：`body.has-custom-bg .card.uh-card` 用 `border: 1px solid rgba(255,255,255,.1) !important` 接管了毛玻璃卡片的边框，把选中态的 `border-color` 顶掉了 —— 表现就是「只有顶部配色条、没有整圈细线」。补一条同权重 `!important` 覆盖（`color-mix(accent 55%, transparent)`），现在和打卡卡片一样有整圈描边。**改这类卡片样式时注意 `has-custom-bg` 那批 `!important` 规则**。
- **打卡卡片顶部配色条**：跟随该子代理的对话主题色（`AGENT_THEMES[agent].color`），**只对被平台胶囊选中 / 滑到轨道中心的那张卡显示**；Trae 卡片不再常亮（原 `highlight-card` 固定靛蓝渐变已移除）。
- **修「选中一个却亮两个气泡」**：① 胶囊 hover 改为弱提示且不再作用于 `.active`（点完鼠标还停在上面，原样式和选中态一样亮）；② 程序化滚动期间（点胶囊后 800ms）滚动高亮不抢主，避免刚选中的气泡被邻近卡片顶掉。

### 新增：MiniMax Code 每日签到（链路由 `totorosir-minimax-checkin` 移植）
- **接入第 6 个签到平台 `minimaxcode`**：复用 mcode CLI 自己的 OAuth 登录态（`~/.minimax/auth/prod/<cn|en>/mcode-public/auth.json`），按桌面端同款参数与签名直调 `GET signin/status` → `POST signin/claim`，无需打开客户端、无需手工复制 token。[minimax-checkin.mjs](console/minimax-checkin.mjs)
- **签名照桌面端还原**：`x-signature = md5(秒级时间戳 + 盐 + body)`，`yy = md5(encodeURIComponent(签名路径) + "_" + body + md5(毫秒时间戳) + "ooui")`；参数键序固定、`unix` 对齐整秒、签名路径末尾拼 `&client=desktop`。这套签名已用真实账号跑通（面板返回 7 天数据、今日 `400 基础 + 0 奖励`、连签第 3 天）。
- **401 自愈**：`refresh_token` + `client_id=mcode-public` + `scope=agent.default` + `audience=agent-backend` 走 `POST {account}/oauth2/token` 续期，成功后**把新 token 回写 `auth.json` / `auth-state.json`**，CLI 与签到两边不会各持一份失效凭证。
- **状态语义**：日状态 `1`未开始 / `2`可领取 / `3`已领取 / `4`不可用；`claim_result` `1`成功 / `2`今日已领。已领取时**只查不领**，不会重复请求 claim。
- **额度卡片改走签到面板**：`vendor-quota.mjs` 原来拿 mcode 的 token 去打开放平台 `/token_plan/remains`，必然 401（Code 产品线的 token audience 是 `agent-backend`）。现在改为读签到面板，卡片显示「连续签到第 N 天」与今日基础/奖励积分。
- **控制台打卡面板**：新增 MiniMax Code 卡片（凭据来源、签到接口、打卡状态、累计奖励、账号行），顶部统计胶囊计入第 6 个平台，自动签到定时器与「一键全签」都包含它。
- **选项卡改成一行横向滑轨**：顶部 `.checkin-nav-tabs` 与平台胶囊条统一 `flex-wrap: nowrap` + `overflow-x: auto` + 隐藏滚动条 + `scroll-snap`，移动端不再把按钮压成等分小格（原 `flex: 1 1 0` 已去掉）。**打卡卡片区也从网格改成同一条滑轨**（`flex: 0 0 300px`，移动端 82% 露一角提示可滑），并支持按住鼠标左右拖动。
- **平台胶囊改成滑轨导航 + 无限循环**：点胶囊不再筛选卡片，而是把对应卡片**滑到「第二个位置」**（第一格留给上一张，形成滑轨感）——这是用户明确要的落点：点 Trae / CodeArts 时它必须真的动起来，而不是因为「居中需要负偏移」被 clamp 在原地不动。循环用「首尾卡片搬家 + `scrollLeft` 位置补偿」实现（不克隆节点，避免 id 重复导致 `renderOverview` 更新到假节点）；目标在更左边时从末尾搬卡补位、在更右边时把首卡搬到末尾腾位，所以左右两个方向都能滑过去。拖动时高亮跟随「落在第二格」的那张卡（不再用「最靠近轨道中心」，否则点了 A 会亮 B）。
- **开源参考**：签到链路以 SkillHub 的 `@user_3a370331/totorosir-minimax-checkin`（作者 龙猫科技说 longmaoit）为参考实现并已移植，控制台「开源参考」卡片与 README 致谢已列明；实现为本仓库原生代码，未引入第三方依赖。

### 新增：Qoder / Qoder CN 双区域接入
- **新增两个 worker**：`qoder`（国际版，`qodercli` / `~/.qoder`）与 `qoder-cn`（国内版，`qoderclicn` / `~/.qoder-cn`），控制台简称分别为 **`qd`** / **`qdcn`**。`agents.example.json`、`hub/capabilities.json`、登录/退出表、账号档案表、签到平台表与 UI 主题/头像表已同步。
- **默认模型 DeepSeek-Flash**：两区默认均为 `dfmodel`（0.1x，个人版限时免费），模型目录同时覆盖 DeepSeek-V4-Pro、Qwen3.8-Max/Flash、Qwen3.7-Max/Plus/Flash、GLM-5.3/5.3-Flash/5.2、Kimi-K3/K2.8-Preview、MiniMax-M2.7 与 Auto；模型切换走 `-m <key>`。
- **对话 / 流式 / 文件**：无头对话用 `-p`，流式输出 `--output-format stream-json`（assistant 消息为整段快照，声明为 `answer_snapshots`）；文件与图片走 `--attachment`；工作目录走 `--cwd`。只读模式使用官方内置 `Plan` 代理，编辑/完全控制映射到 `--permission-mode accept_edits` / `bypass_permissions`。
- **账号快速切换**：Qoder CLI 的登录态实际存放在 `~/.qoder/.auth/user`（AES-128-CBC，key=iv=`machine_id` 前 16 字节），keychain 文件（`qoder-cli-credentials.json` + `.keychain-salt`）只是无系统钥匙串时的回退。账号档案现归档 `.auth/user` + `.auth/machine_id`，切换时两份一起还原；同时保留 keychain 回退格式的读取与回写。桌面版 `auth.v1.dat`（Chromium v11）可用系统钥匙串解出 token，已支持导入 CLI 的 `.auth/user`。[qoder.mjs](console/qoder.mjs)
- **一键签到（链路由 `L0NE-6/Qoder-Daily` 移植）**：`GET /sash/api/v1/me/campaigns?forceRefresh=true` 拉实时活动列表，**只取 `actionType=CLAIM_BENEFIT` 的行**逐个 `POST .../{campaignId}/claim`；`CLAIMED` / `replayed` / `409` / 同人已领均按「今日已领」处理，不重复计数。以前把 `VIEW_DETAILS` 这类常驻活动也算进「已领取」，会把真正可领的每日活动盖掉，现已修正。请求带设备风控头 `Cosy-MachineToken / Cosy-MachineCode / Cosy-MachineType`（由本机 Qoder 客户端或 qodercli 的 `runtime-info` 组件生成，缓存 50 分钟）与 `Cosy-MachineOS / Cosy-MachineId / Cosy-MachineHostname / Cosy-Version`——国际版每日积分活动只对带这些头的请求下发，自行编造或用桌面端派生头都会被过滤。缺组件时国际版会从官方 qodercli npm 包提取（sha512 校验，`QODER_UMID_NO_INSTALL=1` 关闭），并在卡片上写明原因。token 临近过期时先用 `drt-` / `jrt-` 对应的 refresh 端点续期并写回加密凭据。[qoder.mjs](console/qoder.mjs) · [qoder-device.mjs](console/qoder-device.mjs)
- **品牌图标**：两区共用 LobeHub `qoder-color.svg`（品牌绿 `#2ADB5C`），已加入控制台品牌头像表与平台主题变量。
- **开源参考**：Qoder 签到链路（实时活动、`CLAIM_BENEFIT` 筛选、UMID 设备风控头、token 续期）明确以 `L0NE-6/Qoder-Daily` 为参考实现并已移植，README 致谢已列明；凭据与账号切换流程参考 `shuishuipingan/qoder2api-hub`（活动平台、token 刷新、CLI 文件回退）与 `70548887/Qoder-Switch`（多账号配置备份/还原），并索引 `wallechfox/qoder-checkin`、`techysy/CreditDaddy`；实现为本仓库原生代码，未引入第三方依赖。

### 重写：MiniMax worker 改用官方 `mcode` CLI（告别 `mmx`）
- **换引擎**：`minimaxcode` 从 `mmx text chat` 换成 **MiniMax Code 官方 CLI `mcode`** 的 headless 入口：`mcode exec --permission off --output-format text`，`--cwd` 走 `workdir_via`。`mcode` 与 MiniMax Code 桌面端同一账号体系，签到赠予积分在 Code 内可用；`mmx` 走的是开放平台 Token Plan / 付费余额，两条账互不相通。
- **不再预设模型 id**：`mcode` 的模型引用是 `provider/model`（如 `minimax/MiniMax-M3`），未验证的 id 不再写死；派发不传 `--model` 就用账号默认，控制台模型目录对该 worker 留空。
- **登录链路**：`mcode login --region cn --no-browser`（PTY 抓授权链接 + 设备码）。**mcode 的凭据既不在 `~/.minimax-code` 也不叫 `codex-auth.json`**，实测落在 `~/.minimax/auth/prod/<region>/mcode-public/`：`auth.json` 里是 `records["com.minimax.mcode.oauth.prod.cn <hash>"] = { accessToken, refreshToken, expiresAtMs }`，`auth-state.json` 里是 `{ status, region, expiresAtMs }`；控制台按这套路径登记凭据、判登录态与取配额。粘贴 `sk-` API Key 的旧分支改为提示正确做法（`mcode provider set-minimax-key`），不再往废弃的 `~/.mmx` 写数据。
- **Hub 侧登录也换过来了**：`hub/login_manager.py` 的命令表由 `mmx` 改 `mcode`，登录命令改 `login --region <region> --no-browser`；**mcode 没有 `auth status` 子命令**，登录态改判 `auth-state.json` 的 `status === "authenticated"`（登出后 `auth.json` 仍在，只有 status 会翻转，所以不能只看文件存在），`hub_login` 的 status/start 与成功判定全部走这条。新增 4 个单测覆盖「无目录 / signed-out / authenticated / 非 cn 区域」。
- **配额与账号身份**：`console/vendor-quota.mjs` 原来硬读 `~/.mmx/config.json`，`~/.mmx` 移走后配额必然报「凭据不可用」。改为从 mcode 的 `auth.json`（按 `expiresAtMs` 取最晚的一条 `accessToken`）+ `auth-state.json`（拿 region）取数，`~/.mmx/config.json` 只作历史兜底；`accounts.mjs` 的账号身份由 `mmx:<region>` 升级为 **`mcode:<region>`**，`isLiveCredValid` 改用 `auth-state.json` 的 status 判定，并让旧 `mmx:` / 文件指纹档案按 savedAt 原地复用，不会多裂一份历史档案。
- **安装器**：`packaging/install.py` 不再探测 `mmx-cli`，改为 `mcode`（`which` 或 `~/.minimax-code/bin/mcode`），注册的 cli 是 `exec --permission off --output-format text {task}`。
- **能力声明**：`hub/capabilities.json` 去掉 `--stream` / thinking 相关条目（mcode 用 `--output-format` 换值，不是布尔开关），保留 file/image 的 `messages_file` 附件注入。
- **Linux 侧清理**：`mmx-cli` 已从 n5095 卸载，旧 `~/.mmx` 移到 `~/.mmx.removed-20261020`（含 OAuth token，留档不删）；mcode 0.6.12 装在 `~/.minimax-code`（独立 prefix，未进 PATH，配置里用绝对路径）。
- 待办：授权完成后再补三件事：① 用 `mcode provider list` 确认区域 provider id（国内区是 `minimax-cn/*`，不是 `minimax/*`）并写回 `agents.json` 别名；② 跑通一次 `mcode exec` 真调用，把「待验证」的模型目录补回来；③ 用控制台「登录」按钮再走一遍，确认沙箱 → 账号档案 → 切换生效这条链路（`auth.json` / `auth-state.json` 两个文件的归档路径已按实测结构修好）。

### 重写：Trae 每日签到（链路由 `L0NE-6/Trae-AutoCheckin` 移植）
- **换掉整套旧实现**：原实现是「CLI 落盘 JWT + CDP 点客户端按钮」双轨，JWT 一旦被服务端注销（1001）就只剩找按钮这条路，失败时只能报「找不到签到按钮」。新实现按 `L0NE-6/Trae-AutoCheckin` 的做法直签：[trae-checkin.mjs](console/trae-checkin.mjs)
- **设备号必须用客户端真实号**：从 `storage.json` 的 `iCubeAuthInfo://icube-dc:<号>` 取真实注册号（兼容「号写在值里」的写法），一个真号一天只签一个账号，多账号时其余账号才退回派生号；自己生成的号会被拒成 `9074`。
- **判定链改成状态 → 领取 → 同设备号回查**：先 `POST /trae/api/v2/ug/checkin_credits/status`（body 固定 `{"req_source":1}`），已签直接返回；`enable=false` 判「未开放」不再发 claim；claim 返回 `0` 也要用同一设备号回查 `checked_in` 是否翻转，没翻转就判「未确认」——上游对已签过的账号、对任何设备号都回 `0`，不回查会亮假绿灯。
- **错误码语义**：`9095` 今日已签、`9074` 排队限流（并提示多半是设备号不对）、`1001/1002/401/403` 鉴权失效；积分余额改从 `user_current_entitlement_list` 取真实数值（先 `usage_summary`，再按权益包求和）。
- **凭据失效自动续期**：用 `refreshToken` + 设备证明（ECDSA P-256 对 `POST\\n路径\\nClientID\\nrefreshToken\\n时间戳\\nnonce` 签名）走新版 `POST /trae/api/v3/oauth/ExchangeToken`，三组 ClientID×产品线依次尝试；缺设备证明退回旧端点（实测报 `10101`）。轮换后的 `refreshToken` 落盘到 `~/.agenthub/trae-token-cache.json`，避免轮换链断掉。设备密钥同样从 `storage.json` 的 `iCubeAuthInfo://icube-dc:<号>` 解出（tc 头 + AES-128-CBC + sha512 校验）。
- **控制台移除 Trae「重新登录」按钮**：不再需要跳 OAuth 授权窗口——JWT 失效会先用桌面端 refreshToken 自动续期，续不动才提示去客户端重新登录。
- **开源参考**：上述链路明确以 `L0NE-6/Trae-AutoCheckin` 为参考实现并已移植，README 致谢已列明；实现为本仓库原生代码，未引入第三方依赖。

### 修复
- **Trae 每日签到跟随桌面客户端账号**：CLI JWT 被服务端注销（1001）后，原 CDP 兜底只会在主界面找「签到」按钮，找不到就直接判 `failed`；实际签到入口在「积分/权益」面板的「每日签到」分组里。现在 CDP 会先打开积分面板、展开每日签到分组：有「签到/去签到/签到领取」按钮就点击；没有按钮时根据最近一条「签到奖励」的到期时间判断今天是否已领，已领返回 `already` 而不是失败。已用 n5095 上正在运行的 Trae 1.107.1 实测，桌面账号今日已签时卡片显示「客户端账号今日已签到」。
- **Trae 1.107 更新后派发只返回「思考中」**：bridge 的 `/v1/chat` 会在约 5 秒内返回 `TRAE\n思考中` 并标记 `completed`，而真实回答此时还没渲染。hub 原来只在文本为空时才读 DOM，于是上层拿到的是占位文本。现在识别占位回复（空 / ≤24 字且含「思考中」「thinking」「生成中」）后统一走 `drivers/dom_read.js` 兜底读取（实测该脚本的选择器仍有效，能取到真实答案）。
- **签到凭据回退**：Trae 重新登录后新写入的 token 可能被服务端判 `1001 / enable:false`，而账号档案里的旧 token 仍然有效。现在同一身份保留 `alternates` 候选，首选返回 1001 时按序回退（WorkBuddy 返回 401 时同样处理）；CLI 当前凭据未过期时优先于档案快照，不再只按 `exp` 挑选（重登后新 token 的 exp 往往比旧 token 短）。

## [1.0.15] - 2026-10-19

**签到改成「复用已安装 CLI 的凭据」**，并补上一键清空日志。

### 签到
- **日志一键清除**：签到日志页签新增「清空日志」，对应 `POST /api/checkin/history/clear`。只清历史记录，不动今日打卡状态与凭据——清完卡片照样显示今日已签。
- **凭据直接复用 CLI 的**：签到不再依赖账号档案里的历史快照。每次打卡都实时读 CLI 自己的凭据位置（`~/.codebuddy-cn/auth.info`、`~/.trae-cn/trae-jwt-token`、`~/.config/agenthub-codearts/codearts-auth.env`、`~/.codeartsdoer/codearts_cli.json`、WorkBuddy 桌面版共享会话），零配置、不额外保存副本。
- **同一账号多处凭据取最优**：按 JWT `exp` 优先、文件 mtime 次之挑一份，再按身份去重。既不会拿档案里的过期快照去签，也不会把同一账号签两次。
- **WorkBuddy 自动续期**：accessToken 有效期 30 天、refreshToken 60 天。签到前若距过期不足 2 小时（或接口返回 401），用 refreshToken 调 CLI 同款端点 `POST /v2/plugin/auth/token/refresh` 续期，**并写回 CLI 的 `auth.info`**——签到与 CLI 共用同一份凭据，谁刷新都生效，不存在「控制台签到把 CLI 顶下线」。手工配置的 Token 只在 CLI 完全没有凭据时兜底，且与 CLI 账号同身份时不重复签。
- **只取国内站凭据**：WorkBuddy 签到打的是 `www.codebuddy.cn`，国际版 `~/.codebuddy/auth.info` 的 token 不参与——之前「按 exp 统一挑选」会把有效期更长的国际版挑进来，签到时必然 401。
- 凭据行显示「CLI 实时凭据 · 自动续期」，账号行悬停可看到每个账号各自的凭据来源。

### Trae 签到链路（1.0.14 之后陆续修复，随本版发布）
- **1001 不是「过期」**：JWT 的 `exp` 往往还没到，是服务端注销了这个会话（单端登录顶号 / 在别处重登）。提示改为可点的「重新登录」，用控制台自带 OAuth 重新授权，不再让人去装客户端。
- **AuthCode 兑换不再被最后一个域名的 404 盖住原因**：三个 origin 逐个尝试时收集全部错误，优先展示非 404 的真实业务错误；登录会话兜底超时 10 分钟 → 20 分钟。
- **9074 不是限流**：文案「当前参与用户太多」实际是 `x-device-id` 没在客户端注册过。改为从 Trae 客户端日志 `[ICDRS] (constructor) did: <id>` 里取出注册设备号并缓存到 `~/.config/agenthub-codearts/trae-device-id`（可用 `TRAE_DEVICE_ID` 覆盖），请求头与客户端 `_applyUgDeviceHeaders` 对齐；9074 退避重试 3 次，定时器对当天失败的平台继续重试（每天最多 6 次）。
- **20405 设备证明**：Trae 给 AuthCode 兑换加了设备证明（客户端私钥/证书），浏览器 OAuth 这条路已不可用，单独提示「在 Trae 客户端登录或用配置 Token 粘贴 JWT」，不再让人对着 401 反复重试。

### 测试
- 新增 `tests/console_checkin_credentials.mjs`（4 项）：同身份多处凭据择优、不同账号不被合并、清空日志不动今日状态、清空幂等。
- 新增 `AGENTHUB_HOME` / `AGENTHUB_CHECKIN_STATE` 两个环境变量，可把凭据目录与签到状态指到临时目录——单测不再触碰真实凭据与线上历史。

## [1.0.14] - 2026-10-19

**84 个模型逐个实跑一遍**，把「界面上有、派下去必失败」的模型和「失败却说不清原因」的链路一起修掉；同时收口移动端布局。

### 移动端
- **设置卡片标题被压成竖排**：桌面是「标题 ←→ 两个按钮」的 `justify-content: space-between` 单行，390px 下标题只剩 51px 宽，「平台每日签到与福利中枢」逐字竖排。改为移动端 `display: block`，标题独占一行、按钮另起一行等宽铺满。
- **打卡卡片把数字劈开**：`.c-val` 是 `text-align: right` + `word-break: break-all`，长句右对齐成锯齿，还把「1000积分」断成「领100 / 0积分」。改为标签一行、值一行、左对齐，`word-break: normal`。
- **320px 宽下「发送」被挤到换行**：`.model-picker-wrap` 固定 `max-width: 320px`，按钮只剩 53px，两个字竖排并溢出容器。改为 `composer-bar-right` 整行独占、`max-width: none`，模型名超长走省略号。
- **自动签到开关挤成窄柱**：`.checkin-control-bar` 加 `flex-wrap`，开关与说明分两行。

### 模型链路（实测 84 个模型后修复）
- **CLI 真实报错被吞掉**：CLI 退出码为 0 但 stdout 为空时，诊断常常只写在 stderr（实测 `400 model [primary-model] is not allowed for user type [personal_free_user]`）。同步路径（`hub/agent_hub.py`）与异步路径（`hub/async_worker.py`）都把 stderr 丢掉，只回一句「CLI 已退出但没有可验证的回答」，上层无法判断原因，模型永远显示可用并反复失败。现在两条路径都保留 stderr 末行诊断。
- **新增失败归类 `plan_blocked`**：区分「这个 model id 不存在」（`model_unavailable`）与「id 存在但当前账号套餐无权使用」（`plan_blocked`），后者进 `BLOCKING`，控制台会把该模型置灰并给出「请升级套餐或改用其它模型」，而不是继续当可用模型派发。
- 补充 `model_unavailable` 识别：`not recognized as a known model`、`invalid model selection`、`reasoning effort value is not supported`；`region_restricted` 补 `not available in your country`。
- **模型目录纠错**（`MODEL_CATALOG`，`console/server.mjs` 与 `console/auth.mjs` 两份同源）：
  - antigravity：`gemini-3.1-pro-high` 在 `agy models` 中不存在，换成真实存在的 `gemini-3.8-flash-low`；`agents.json` 的 `pro` 别名同步改为 `low`。
  - mimocode：`mimo-v2.6-pro` / `mimo-v2.6-pro-ultraspeed` 漏了 provider 前缀（实测 `Model not found`），改为 `xiaomi/mimo-v2.6-pro` / `xiaomi/mimo-v2.6-pro-ultraspeed`；删掉 `mimo models` 里不存在的 `siliconflow-cn/deepseek-ai/DeepSeek-V4-Flash` 别名。
  - codebuddy：删掉服务端返回 `service info not found` 的 `deep-model`。
- **实测口径**：`hub_dispatch_cli` / `trae_delegate` 逐模型派发同一道可校验题（13×7 → 91），每模型独立超时 170s。

| 结果 | 数量 | 说明 |
| --- | --- | --- |
| 通过 | 55 | 真实返回 `91` |
| 不适用 | 19 | traecode 走 GUI 通道，`_check_gui_options` 明确拒绝非默认模型，属设计约束 |
| 失败 | 10 | 全部有明确根因，已在上文修复或归类（7 套餐限制 / 1 模型不存在 / 1 区域限制 / 1 超时） |

### 版本
- 版本号 1.0.13 → **1.0.14**，这次是全仓对齐（上一轮只改了运行时代码，构建与清单侧漏了）：运行时代码 `console/server.mjs`、`hub/agent_hub.py`、`console/client/index.html` 页脚；构建 `packaging/build.py`（决定产物文件名）、`integrations/codearts/install.py`；桥接 7 份 `mcp/server.mjs` 的 `serverInfo.version`；清单 `marketplace.json`、`.zcode-plugin/marketplace.json`、`plugins/agenthub-workers/{plugin,.claude-plugin,.minimax-plugin,.zcode-plugin}/plugin.json`、`integrations/{antigravity,codex,.codex-plugin}/plugin.json`；`integrations/vscode/package.json`、`desktop/package.json` 与 `package-lock.json`；文档 README 中英双份、`RUN_ON_LINUX.md`、`plugins/agenthub-workers/README.md`，以及重新生成的 `demo.html` / `demo/index.html`。
- 两处回归测试此前硬编码 `1.0.12`，每次发版都会变红，改为从源码派生：`tests/extension_packaging_regressions.py` 从 `integrations/vscode/package.json` 读版本，`tests/discovery_regressions.py` 直接比对 `hub.SERVER_VERSION`。

## [1.0.13] - 2026-10-19

**签到从「看起来成功」变成「真的成功」**，同时修掉账号档案与多 Key 场景下的一批数据问题。

### 签到（三个平台全部重写）
- **WorkBuddy**：原来只签「当前生效」的那一个账号，另一个号永远签不到。现在遍历 `~/.agenthub/accounts/codebuddy-cn/*` 的**所有**档案逐个打卡并按身份去重；响应字段改用真实字段 `data.credit` / `data.streak_days`（此前读 `points`/`credits` 取不到值，界面上的「10积分」其实是硬编码兜底文案）；`code=10001`（今天已签到）识别为「已签」而不是失败。
- **CodeArts**：原实现只要 `codearts-auth.env` 里有 AK/SK 就直接返回「GLM-5.3 算力包已激活」，**一个请求都没发过**。现在按华为云 SDK-HMAC-SHA256 真实签名（复刻两处坑：CanonicalURI 强制补尾斜杠、CanonicalHeaders 自带尾 `\n` 后不再补），依次调 `GET /api/v1/benefit/claim`（福利通道 + 验签）→ `GET /v1/ops/delivery?channel=IDE`（找 `USER_LOGIN` 活动）→ `POST /v1/ops/claim`（`campaignId` + `channel=IDE` + `idempotentKey`）；把 `APIG.0602`（STS 过期）、`APIG.0301/0303`（签名失败）、`40001`（今日已领）、`4006`（名额领完）翻成人话。
- **Trae**：删掉了「localStorage 里存在 `trae-cn-credits-billing-status` 就判今日已签到」——那个 key 一旦写入就永久存在，等于每天都谎报成功。改为先查 `POST /trae/api/v2/ug/checkin_credits/status` 判断真实状态、未签才 `claim`；认证头改成真实格式 `Authorization: Cloud-IDE-JWT <jwt>`（此前用的是 `Bearer`）。API 全失败时再退回 CDP 点客户端按钮，并且只认文案含「签到」或落在权益面板内的按钮，避免误点活动横幅的「立即领取」。
- 三张签到卡片新增**按账号逐行展示**：`无名氏 ·当前 今日已签` / `Johhny_Xu +100`，失败账号直接显示原因（hover 看全文）。

### 账号档案
- opencode 第二把 Key 覆盖第一把：写入前以线上 `auth.json` 为底合并，沙箱与线上一并写回，同 provider 覆盖时日志明确提示改成 `provider:api_key`。
- 可变异身份（`providers:` 集合 / `mmx:<region>` 单槽位 / 12 位文件指纹）的显示名改为**读取时按 identity 现算**，不再信任 `meta.json` 里固化的旧字符串；与线上身份不一致的历史快照标记 `stale` 并收进「历史 N」胶囊，不再伪装成第二个账号。
- minimaxcode 一个号裂成两个：identity 从整文件指纹改为 `mmx:<region>` 单槽位，并加迁移规则按 `savedAt` 原地复用。

### 子代理
- 「思考程度」旁新增**按子代理适配的文件编辑权限**开关，数据源在 `hub/capabilities.json` 的 `permission.modes`，经 `task_contract.prepare_task` 落成各家 CLI 的真实开关（`--permission-mode` / `--allow-all-tools` / `--mode` / `--agent plan` / `--plan|--yolo`）；`POST /api/dispatch` 与 `/api/chat/send` 都会透传 `permission`。
- 华为（codearts）模型列表重复：同一 id 挂多个别名时按 id 归并并择优选显示名，GLM-5.3 不再出现 5 次。

## [1.0.12] - 2026-10-18

**控制台从网页变成可安装的桌面应用**，同时补齐「每日签到与福利中枢」，并收口一轮 WebUI 视觉与交互。侧栏、工作台、签到三块的手感在本版对齐。

### 新增

- **桌面端外壳（Electron）**：Windows 安装包、托盘常驻、随包启动本地控制台，安装后无需再手工起服务。
- **每日签到与福利中枢**：WorkBuddy / Trae（免客户端，CDP 直连）/ CodeArts 码道三端，支持 08:30 定时静默打卡、一键全签与签到日志。
- **子代理卡片拖动排序**：拖到目标卡片上/下半区决定插入位置，顺序记在本地，刷新后保持。

### 改进

- **工作台单条移除**：产物、图片、附件卡片右上角悬停出现 ×，只把该条移出列表，不删服务器原文件；空态保留「恢复已清理的 N 项」。
- **头部按钮组重新排布**：删除类操作归到一组，浮层按钮组钉在窗口最右并与头部垂直居中，展开/收起不再跳动。
- **侧栏头部工具按钮统一 24×24、等间距**；移除多余的手动收起按钮，收展统一交给悬浮自动收展。
- **计数徽标收口**：工作台角标与子代理未读数统一为低对比胶囊，去掉渐变、发光与脉冲动画。
- **opencode / cline 补上主题色**，卡片底色与其它子代理一致。
- **签到卡头像复用平台头像**：自定义上传 > 品牌 logo > 首字母，三处同一套渲染。

### 修复

- **侧栏自动收起失效**：此前只要在侧栏内点过任何按钮，焦点残留会让收展逻辑永远判定「有焦点」而不收起；现在仅「正在输入」或键盘焦点才保持展开。
- **锁按钮图标与文案语义相反**：开锁 = 智能悬浮收展，闭锁 = 常驻展开，文案同步重写。
- 去除对话气泡上残留的「待回复」指示。

## [1.0.11] - 2026-10-17

**工作台能打开会话里“说到”的文件**：worker 常在回复里直接写「已生成 /path/to/file.svg」，这类文件不进结构化 artifact，以前在工作台里看不到。本版把「本会话消息中确实出现过、且当前存在」的路径纳入只读白名单，工作台可直接预览图片、打开文本、定位附件。同时收口一轮 WebUI 视觉与交互。

- **新增 `GET /api/artifact/raw`**：二进制/图片直出端点，20MB 上限，按扩展名映射 MIME（`svg` / `png` / `jpg` / `jpeg` / `gif` / `webp` / `bmp` / `ico` / `pdf`），`cache-control: private, max-age=60`。此前 `/api/artifact` 只回文本，图片只能看到路径。
- **新增 `POST /api/artifact/stat`**：批量确认会话里提到的路径是否真实存在（单次最多 60 条），只回可读普通文件，附 `size` / `mtime` / `raw` 标记，供工作台渲染图片缩略图与文件行。
- **白名单是收紧后的例外，不是放开**：`/api/artifact` 仍只允许控制台产物与枢纽 `results` 目录；新路径必须同时满足「本会话消息里出现过」「文件当前存在」「扩展名在文本/图片白名单内」三条，扫描结果缓存 3 秒，避免把任意文件读取暴露给 WebUI。
- **`/api/artifact` 回包补 `path` / `size`**：预览卡片能显示真实路径与体积，不再是只有正文。

工作台与侧栏：

- **「附件与图」补会话内文件**：产物 / 图片 / 附件三类卡片共用一套卡片结构，图片走 `raw` 直出缩略图，附件显示名称、大小与修改时间；点开即预览，不再需要自己去文件管理器找。
- **单条删除 ×**：20px 圆形半透明深底，hover 变实心红并微放大。删除只从列表移除，**不动服务器原文件**；空态保留「恢复已清理的 N 项」，误删可原地恢复。
- **子代理卡片拖动排序**：HTML5 拖放，拖动中卡片半透明，`dragover` 按上下半区显示 `drop-before` / `drop-after` 插入线，落下写入 `agent_hub_agent_order` 本地记忆，刷新后保持。`suppressAgentClickUntil` 做 400ms 防误触，拖完不会顺手点开会话。
- **`opencode` / `cline` 主题色补齐**：两者在 `AGENT_THEMES` 里有颜色，但缺 `.platform-item[data-agent=...]` 规则，卡片一直是默认色。补齐六项变量（`--agent-color` / `glow` / `surface` / `surface-hover` / `surface-active` / `border`）；浅色下 opencode 用深蓝黑徽章托白标（对比 ≈17.9:1）、cline 用浅青底配深青标（≈5.2:1），不刺眼也不糊。
- **计数徽标统一低对比胶囊**：工作台角标与子代理未读由「实心 accent 圆」「红橙渐变 + 发光 + 2.2s 脉冲」改为 `color-mix(in srgb, accent 15%, transparent)` 底 + accent 文字，去掉渐变、阴影与脉冲。
- **浮层按钮组钉在窗口最右**：`#chat-head-btns` 改常驻绝对定位，工作台展开时 `translateX(340px)` 抵消对话栏收窄，两态右缘零跳动，过渡曲线与工作台 `width` 同一条；右留白由 20px 收到 12px，顶栏 `.top-actions` 右内边距同步改 12px，于是「主题/连接点/服务器」与「⋯/工作台」两行按钮右缘齐平。
- **工作台头部三个按钮移除**：删除 / 刷新 / 关闭收进卡片与空态操作；`.wb-head` 固定 `min-height:54px`，浮层按钮组与工作台头部垂直居中（偏差 0），底边留白 11px。
- **侧栏自动收起不再被焦点卡死**：原判据 `hasFocus = activeEl && sb.contains(activeEl)`，只要在侧栏点过任何按钮，焦点残留就会永久拦住收起。改为仅「正在输入（INPUT/TEXTAREA/SELECT/contenteditable）或键盘焦点（`:focus-visible`）」时保持展开，并在开启自动收起时立刻按当前位置判定一次。
- **锁图标与文案语义对调**：`.active`（自动收起已开启）原来显示闭锁却写「已开启」，自相矛盾。改为已开启显示开锁，文案统一为「智能悬浮收展 · 已开启」/「常驻展开 · 已锁定」，并补 `aria-label`。
- **侧栏收起按钮恢复**：此前重构侧栏头部时把 `#btn-toggle-sidebar-collapse` 连容器一起删了，JS 仍在绑空节点。恢复为动作组第一个图标按钮，图标改成「圆角矩形 + 右分割线」的侧边栏样式。

平台与能力：

- **Linux 模板补齐 GitHub Copilot worker**：`hub/agents.example.json` 的 `github-copilot` 原指向 `/usr/local/bin/github-copilot-placeholder`，照抄跑不起来。改为可直接使用的官方 `copilot` 路径（npm 全局安装后通常在 `~/.local/bin/copilot` 或 `/usr/local/bin/copilot`，注释说明按 `which copilot` 改），参数与 Windows 模板一致：`--silent -p {task}`、`--model auto`。安装器本就用 `shutil.which('copilot')` 跨平台探测，登录走 `copilot login --device-code` + GNOME Keyring，Linux 侧无需额外步骤。
- **`antigravity` / `traecode` 声明附件能力**：`hub/capabilities.json` 补 `attachments.file` / `attachments.image` = `prompt_path`，与两者实际「把路径写进提示词」的行为对齐。
- **CodeBuddy 图片附件开启方法写进能力说明**：`notes` 补 `--allowedTools Read --permission-mode acceptEdits` 的具体写法，避免只看到「未声明验证」却不知道开关在哪。

版本与一致性：

- **MCP 桥版本号对齐**：7 份 `mcp/server.mjs` 的 `serverInfo.version` 自 `1.0.0` 起就没再跟过项目版本，本版统一到 `1.0.11`，7 份副本仍逐字节一致。
- **机械对齐**：各清单（`marketplace.json`、各 `plugin.json`、`package.json`）、`console/server.mjs`、`hub/agent_hub.py`、`integrations/codearts/install.py`、`packaging/build.py`、扩展清单与 `extension.js` 兜底值、`RUN_ON_LINUX.md`、四张 SVG 的版本标注、以及测试里的期待值，全部由 `1.0.1` 改为 `1.0.11`。`demo.html` 与 `demo/index.html` 由 `scripts/build_demo.py` 重新生成。

## [1.0.1] - 2026-10-17

**Worker 池扩容**：新增 `opencode` 与 `cline` 两种官方 CLI Worker，总数由 9 种增至 11 种；README 两张图重绘以提升可读性。

- **新增 `opencode` worker（别名 `oc`）**：`opencode run --format json` 无头执行，模型参数 `-m provider/model`、工作目录 `--dir`、附件 `--file`。`--format json` 输出的是事件流（`text` / `tool_use` / `step_start` / `step_finish` 逐行 JSON），按 per-part 快照归并成最终答案；已声明 `answer_snapshots` 语义，不声明未经验证的 thinking 控制。
- **新增 `cline` worker**：`cline --json` 无头执行，模型参数 `-m`、超时 `--timeout`、工作目录 `--cwd`，附件以 `@路径` 写入提示词。输出为 NDJSON（`say` / `ask` / `agent_event` + 终结 `run_result`），`output_parser.py` 新增该形状的识别与 `run_result` 优先级；自动批准沿用 CLI 自身配置，Hub 不代传 `--yolo`。
- **能力与登录表扩展**：`hub/capabilities.json` 补两份声明；`hub/login_manager.py` 的 `WORKERS` / `COMMANDS` / `HOSTS` 加入两行。两者暂无 WebUI OAuth 流程，`hub_login` 按既有兜底返回官方登录指引（`opencode auth login` / `cline auth`），不在对话中索取密钥。
- **配置模板**：`agents.example.json`（Linux）、`agents.windows.example.json`、`agents.minimal.example.json` 同步加入两个条目；Windows 模板要求指向 npm 平台包里的原生 exe，避开 `.cmd` shim 差异。
- **原生插件与子代理**：三套 agents 目录（`plugins/agenthub-workers`、`integrations/antigravity`、`integrations/codearts`）各补 `opencode` / `cline` 路由代理；`integrations/antigravity/native.py`、`integrations/codearts/install.py` 的 `WORKERS` 清单与 Antigravity SDK 白名单同步；VS Code 扩展的 Worker 矩阵与模型树补齐两项。
- **SVG 重绘**：`docs/architecture.svg` / `.en.svg` 字号提亮（正文最小 14px，`.micro` 12→14、`.tiny` 13.5→15）、`muted` 对比度加深、子卡片加宽消除文案溢出、Workers 面板改 11 行；`roadmap.svg` / `.en.svg` 同步 1.0.1 焦点。四份图保持纯手写无外部依赖。
- **测试**：`worker_output_regressions.py` 新增 opencode 事件流与 cline NDJSON 用例；两个原生安装套件的 9→11 期待值对齐。

本版同批合入的控制台与 Worker 打磨：

- **WebUI 登录补齐两种 Worker**：`cline` 走官方 TUI 设备码流程（PTY 提取授权链接与 8 位验证码，浏览器授权后自动入账，也是 cline 免费模型的唯一入口）；`opencode` 用 `provider:api_key` 写入官方 `auth.json` 并以 `opencode auth list` 复核。cline 的 API Key 路径支持裸 Key 按前缀识别厂商，并在落盘后跑一次最小真实调用——官方 `cline auth` 只写配置不校验 Key，不做这步就会「假成功」。
- **账号档案不再越登越多**：cline / opencode 的身份改用邮箱或 provider 组合，而非凭据文件指纹；重新登录同一 provider 会原地更新，不再每次生出一个 `cline-<hex>` 档案。
- **失败不再静默**：异步任务失败/超时改为以代理消息展示 `⚠️ 任务未完成（status）`，此前写进默认隐藏的系统消息，界面上看起来像「没回复」。
- **模型目录按实测校准**：cline-free 旧免费推广已下线，替换为实测可答话的 `openrouter/free`、`nvidia/nemotron-3.5-lightning:free`、`cohere/north-mini-code:free`，以及与 Cline 账号目录一致的 `deepseek/deepseek-v4.1-flash`、`anthropic/claude-sonnet-5.5`。
- **CLI 缺失提示带路径**：`cli_missing` 现在给出配置的可执行文件路径，并提示「多为 CLI 自更新中断导致安装损坏，重装一次即可」。
- **cline 单 token 提示词兼容**：其 argv 解析会把无空格的提示词当成子命令，配置末项改为 `{task} `（尾随一个空格）后可正常派发中文短句。

> CLI 本体仍需各自安装并登录（`opencode auth login` / `cline auth`），Hub 只做环境探测与命令调用，不代管安装。

## [1.0.0] - 2026-10-16

**首个公开正式版**。把开源前的三段收口（`0.9.9.7` / `0.9.9.8` / `0.9.9.9`）正式转正，并完成最后一道清理：凭据与隐私面清零，社区文件补齐。

- **`scripts/audit_secrets.py` 移除已退役的 hub-token 规则**：该 token 已完成轮换、旧值失效，特定字面量留在面向公开的脚本里没有收益；通用规则（`literal_credential` / `provider_key`）继续覆盖新值被意外硬编码的风险。
- **两份 README 致谢 [TraeClaw](https://github.com/firerlAGI/TraeClaw)**：`trae_delegate` 通道由 TraeClaw 网关驱动，按开源惯例在「致谢与鸣谢」/「Acknowledgements」中补记。
- **`docs/HANDOVER_20261016.md` 凭据提示脱敏**：与 `fa48961` 对 20261015 的处理保持一致，发布流程改为通用表述（账号级凭据仅在使用时从本机既有配置读取，不写入仓库、不打印、不落日志）。
- **新增 `CODE_OF_CONDUCT.md`**：贡献者公约（改编自 Contributor Covenant 2.1），补齐 GitHub 社区健康文件。

首发合入的收口修复：

- **MCP 桥 serverInfo 版本对齐**：`mcp/server.mjs` 及 6 份宿主副本（antigravity / codearts / codex / dsh / vscode / agenthub-workers）在 `initialize` 中仍上报 `0.9.9`，与 Hub、控制台、各插件清单的 `1.0.0` 不一致；已统一为 `1.0.0`，7 份副本保持逐字节一致。
- **`packaging/package_extensions.py` 去掉过期兜底版本**：`package.json` 缺少 `version` 时不再静默打出 `0.9.9` 标签的扩展包，而是直接报错；文档字符串改为 `<version>` 占位。
- **`RUN_ON_LINUX.md`**：解压后的目录名是 `multi-agent-hub-1.0.0`，修正 `cd` 示例；交付 ZIP 重新写入 `.sh` 的 `0755` 权限位（原 ZIP 由 Windows 打包，全部为 `0600`，与文档描述不符）。
- **README 中英双语重排**：增加目录与三步快速开始；把端口 `8765`（Hub）/ `8890`（控制台）/ `8790`（控制台内置子代理 MCP）列表说明，修正“方案二只需启动 Hub”的描述（`8790` 端点随 `--with-console` 启动）；MCP 工具改为逐个列表（桥接共 8 个）；长段落与前端实现细节收进折叠区；架构图 alt 不再写旧版本号。

> 版本号只做机械对齐，无功能改动。

## [0.9.9.9] - 2026-10-16

收口文档。`v0.9.9.7` 与 `v0.9.9.8` 发版时两张 SVG 仍是标注 `0.9.9.6` 的旧版，本版一并补齐。

- **重画 `docs/architecture.svg` 与 `docs/roadmap.svg`**：版本号、标题、说明与时间线末节点全部更新到 `0.9.9.9`。
  architecture.svg 的 Hub 面板末行由「跨代理共享笔记记忆体系」换成本版真正改动的「回环请求强制直连 · 绕过代理」；
  roadmap.svg 的「当前重点」面板改写为本次收口的实际内容，并把时间线末节点由 `v0.9.9.6` 换成 `v0.9.9.8`。
- **新增 `docs/HANDOVER_20261016.md`**：本轮完整交接文档，含两路独立修复的评估结论、行尾与 A/B 判定回归的方法论、
  私有仓库 Release 附件的验证方式，以及 8 条本会话踩过的坑。
- 文字溢出按交接文档的方法论实测（Node 估算 + 逐条人工核对容器边界），修掉两处真实溢出：
  architecture.svg「回环请求强制直连（绕过环境代理）」854px 超容器 826px、
  roadmap.svg「CONTRIBUTING / SECURITY / README.en 补齐，docs/ 移出 66 个无人引用文件。」1430px 超外层 1216px。

> 版本号只做机械对齐，无功能改动。

---

## [0.9.9.8] - 2026-10-16

补齐 `0.9.9.7` 收口的另一半。本版来自对同一份源码包的另一路独立修复，与 `0.9.9.7` 的改动**完全不重叠**（各 14 个文件），合并后才是完整的修复。

### 运行时兼容 (`drivers` / `console`)

- **Node 20 下 DOM/ZCode 驱动直接崩溃**：`drivers/dom_probe.js`、`dom_probe_zcode.js`、`dom_read.js`、`zcode_dom.js`、`zcode_read.js` 直接调用 `new WebSocket(...)`，而全局 `WebSocket` 自 **Node 21.2 才加入、22 才默认启用**，本项目声明支持 Node.js 20+。五个驱动现各自带一段守卫式 polyfill（`if (typeof globalThis.WebSocket === "undefined")`），完成 upgrade 握手并按 RFC 6455 要求对出站帧做掩码。
- **进程组归属与信号回收**：`drivers/zcode_rpc.mjs` 与 `console/auth.mjs` 尊重 `AGENTHUB_OWNED_POSIX_GROUP`，仅在自己拥有进程组时才 detach，并在 SIGTERM/SIGKILL 时回收整个进程组；`auth.mjs` 另加 SIGTERM/SIGINT 处理器，回收子进程并清理其沙箱目录。
- **PTY 登录脚本重写**：`console/auth.mjs` 用显式的 `pty.fork()` 循环替换 `pty.spawn`，向子进程转发信号并以子进程真实退出码退出——旧写法两者都会吞掉。

### 非作者机器上的路径发现 (`console` / `packaging`)

- **`console/auth.mjs`**：`agents.json` 依次从 `HUB_AGENTS_FILE`、`hub/agents.json`、`~/.config/agenthub(-codearts)/agents.json` 解析，不再写死最后一个；CLI 可执行文件改为遍历 `PATH` 及 `~/.npm-global/bin`、`~/.local/bin`、`/usr/local/bin`、`/usr/bin`，不再假定装在 `~/.npm-global`。
- **`console/server.mjs`**：codebuddy 会话目录同时在 `.codebuddy` 与 `.codebuddy-cn`、以及 cwd 与 home 两种 slug 下探测；结果目录从 `HUB_RESULTS_DIR`、`HUB_STATE_DIR/results`、`hub/state/results`、`~/.config/agenthub/state/results`、`~/agent-hub/results` 中择一。
- **`packaging/install.py`**：node 模块查找额外覆盖 node 可执行文件旁的 prefix 目录（nvm、`/usr/local`）；codebuddy / mimo / mmx 增加 `shutil.which()` 兜底；探测 `traecli` 并注册 `traecode` worker。

### 安装链路 (`packaging`)

- **`install.py` 新增 `_prepare_source_bundle()`**：传入源码目录而非发行包时，先在临时目录构建 `both` 包、解压、把 `.sh` 补回 `0755`，并在 `finally` 中删除临时目录。这与 `0.9.9.7` 放进 `packaging/launch.sh` 的能力是同一件事，两者不冲突——`launch.sh` 传入的包已带 `manifest.json`，`install.py` 的守卫因此短路。`launch.sh` 仍是 `./install.sh` 的入口，本项覆盖直接调用 `python packaging/install.py --bundle .` 的场景。
- **`packaging/runtime.py`**：写入 `.sh` 时即补回 `0755`，安装出的目录不再依赖源码是怎么解压的。

### 测试 (`tests`)

- **`login_manager_smoke` 与宿主解耦**：patch `shutil.which` 返回 `None`，用例不再取决于宿主机是否装了 `zcode` CLI。复现方式：把假 `zcode` 放进 `PATH`，未打补丁时该用例失败，打上后通过。这正是交接文档列为待办的缺陷。
- **`extension_packaging_regressions`**：产物缺失时在 `setUpClass` 中自动构建，不再要求先跑过一次打包。

> 未采纳该路修复的 `RUN_ON_LINUX.md` 与 `.gitattributes` 措辞（前者称 `unzip` 会保留权限位——属实，但未提醒 Python 的 `zipfile.extractall()` 会丢），仓库保留自己的版本。

---

## [0.9.9.7] - 2026-10-16

源码检出在 Linux 上的安装链路修复，以及开源前的仓库收口。本版不含新功能，改动集中在「陌生人 clone 下来能不能装上、能不能看懂」。

### 安装链路 (`packaging` / `hub`)

- **执行位丢失不再阻断安装**：根目录与 `packaging/` 下的启动包装脚本由 `exec "$dir/launch.sh"` 改为 `exec sh "$dir/launch.sh"`。Python 的 `zipfile.extractall()`、Windows 资源管理器与部分 JS 解压库会丢掉 Unix 权限位，原写法下 `sh install.sh` 直接报 `Permission denied`。15 个 `.sh` 同时在 git 索引中标记为 `100755`。
- **源码目录可直接安装**：`install.py` 只接受带 `manifest.json` 的发行包，源码目录过去报 `Invalid or unreadable configuration: manifest.json`。`packaging/launch.sh` 现在检测到源码目录时先用 `build.py` 在临时目录构建 `both` 包再安装，并在退出时清理该临时目录（原先每次源码安装都会在 `/tmp` 残留一个完整 bundle）。
- **回环请求不再被环境代理劫持**：健康检查、Trae 网关与回调都走 `127.0.0.1`，而 `urllib` 遵循 `http_proxy`。在设了代理但未设 `NO_PROXY` 的机器上，这些探针被发给代理并拿回 404/502，安装报 `Health timeout`。`hub/agent_hub.py`、`hub/async_worker.py` 与 `packaging/service.py` 现对回环地址强制直连，其余地址仍走代理。
- **测试适配**：`tests/run_regressions.py` 为其子套件导出 `NO_PROXY`；`codex_adapter_smoke` 的工具数断言由 7 更正为 8（`hub_discover` 加入后未同步，且该用例仅在设置 `CODEX_TEST_BINARY` 时执行，此前一直静默跳过）。

### 开源前收口 (`docs` / 仓库)

- **补齐三个标准文件**：新增 [`CONTRIBUTING.md`](CONTRIBUTING.md)（开发约定、提交信息规范、套件超时与审计规则）、[`SECURITY.md`](SECURITY.md)（漏洞私密上报渠道与攻击面清单）、[`README.en.md`](README.en.md)（README 英文对应版）；`README.md` 增加语言切换入口。
- **移除凭据路径提示**：[`docs/HANDOVER_20261015.md`](docs/HANDOVER_20261015.md) 中记录了发布所用凭据的文件路径、前缀与实测 scopes。`audit_secrets.py` 匹配的是密钥值而非路径，抓不到这一类，只能手工清理。
- **行尾规则补齐**：[`.gitattributes`](.gitattributes) 由只有 `*.sh text eol=lf` 扩展为同时声明 `*.cmd` / `*.bat` / `*.ps1` 为 CRLF —— 原先从 Linux 检出再打包时，12 个 Windows 脚本会全部变成 LF。
- **示例配置去掉本地私有别名**：[`hub/agents.example.json`](hub/agents.example.json) 的模型别名表删除了 `"trae": "custom-local:trae"`。同一张表其它别名都指向官方模型 ID，只有它指向作者本机才存在的自定义 provider；生产代码里的 `custom-local:trae` 路由入口保留。
- **移出 66 个无人引用的测试证据**：`docs/` 由 172 个文件降至 106 个，移出的包括 `-before-fixture` / `-raw` / `-targeted` 类中间快照、两份已被取代的旧交接记录、未被引用的 `logo.png` 与 codebuddy 探针日志目录。仓库内所有 markdown 链接仍可解析。

> 两点说明：
> 1. 移出只作用于树的末端，这些文件仍在 Git 历史中；彻底移除需重写全部 SHA 并重发标签与 Release。
> 2. `docs/architecture.svg` 与 `docs/roadmap.svg` 是带日期的视觉产物，仍标注 `0.9.9.6`，未随本次版本号调整。

---

## [0.9.9.6] - 2026-10-15

WebUI 交互精修与全链路视觉体系贯通。`0.9.9.3` → `0.9.9.6` 为 WebUI 单线的连续增量迭代，本次统一收口为 `v0.9.9.6` 标签发布；逐步明细见 [版本记录](docs/version-history.md)。

### 品牌锚点与界面智能收展 (`console`)

- **品牌锚点常驻 ([`console/client/index.html`](console/client/index.html))**：新增左上角 `#brand-logo-pin` 常驻 Logo（`fixed / top:10px / left:18px / 32×32 / z-index:120`），JS 复用顶栏内那张 Logo（`cloneNode`）挂载以免在 HTML 里重复一份 base64；顶栏原 `.brand-logo` 转为 `visibility: hidden` 的 32px 间距占位，锚点正好落位；`body.has-custom-bg` 下适配毛玻璃。**锚点永不隐藏**（固定定位 + `pointer-events` 独立，不受顶栏 `collapsed-row` 的 `pointer-events:none` 影响）。
- **顶栏 / 活动栏智能收展引擎**：新增 `setupChromeAutoHideEngine()` —— 光标 Y ≤ 38px 展开顶栏、X ≤ 42px 展开活动栏（90ms 命中延时防过路误触），离开后 650ms 舒适防抖收起；下拉菜单 / `<dialog>` 弹窗打开、或顶栏内有输入焦点时禁止收起；点击 Logo 在「自动收展 / 常驻」间切换并持久化到 `localStorage.agent_hub_chrome_autohide`，常驻态加主题色描边提示；手机端（≤859px）不启用。配套新增 `body.header-collapsed .cb-activity-bar { padding-top: 50px }`（含过渡），避免活动栏首项与 Logo 锚点重叠。
- **活动栏随侧栏常驻**：修掉「会话侧栏展开着、`对话 / 设置` 活动栏却被自动收起」的错位 —— 侧栏热区是 `x ≤ 324`、活动栏热区只有 `x ≤ 42`，光标停在侧栏上时活动栏会 650ms 后收起、被回收 56px 布局宽度导致侧栏突兀左移且用户点不到标签页。现 `chromeCanCollapse('actbar')` 增加判断：`#chat-threads` 未处于 `collapsed` 时活动栏一律不收起；并新增 `chromeSyncActbarWithSidebar()` 在展开侧栏的瞬间（不等 650ms 防抖）把活动栏拉回，初始化时同步一次。
- **移除会话头「展开侧栏」按钮并修正两处布局缺陷**：删除 `#btn-expand-sidebar` 及其全部 JS 引用（`togglePlatformsSidebar` / `setupSidebarHoverEngine` / `selectPlatform` / 点击绑定），展开侧栏改为只靠光标进入左侧区域自动展开与移动端「← 平台」按钮。顺带修掉两个一直存在但未被发现的 CSS 特异性 bug：① `nav.tabs.cb-activity-bar { margin: 0 }`(0,2,1) 压掉了 `.cb-activity-bar.collapsed-col { margin-left: -56px }`(0,2,0)，活动栏视觉上滑走了却仍占 56px 布局宽度，右侧内容无法左移；② `body.header-collapsed.actbar-collapsed .chat-threads.collapsed .chat-head-left` 永远匹配不到，因为 `.chat-head` 在 `.chat-main` 里、是 `#chat-threads` 的**兄弟节点**而非子节点，避让 Logo 的 46px 边距从未生效，改用兄弟选择器 `.chat-threads.collapsed ~ .chat-main .chat-head-left`。实测：活动栏收起后内容起点由 x=57 → x=1，会话头左侧胶囊由 x=77 → x=67（Logo 锚点右边缘 50，留 17px 间隙）。
- **侧栏展开触发范围对齐**：`setupSidebarHoverEngine` 原来在侧栏收起时只在 `actBar.right + 14px` 内才触发展开（鼠标必须贴到最左侧活动栏那一条窄带），而展开后的保持范围却是 `actBar.right + 280px`，两者不对称、手感割裂。现统一按「活动栏 + 侧边栏自身展开宽度」计算（新增 `getSidebarRevealWidth()` / `isPointerInRevealZone()`，宽度实时量取并缓存、收起时回退 268px）；展开与收起的防抖定时器在触发前都会用 `lastPointer` 重新核对实际光标位置，避免 `mouseleave` 早于最后一次 `mousemove` 导致误收起。

### 主题与视觉体系 (`console`)

- **色系预设由 2 个扩充为 6 个**：`v0.9.9.4` 曾把预设精简到只剩 Mocha / Shell，本版补回 Aurora 极光微光（`#0B0F19`）、Dusk 暮霭流金（`#18121D`）、Cyber 赛博深空（`#070913`）、Grid 科技网格（`#0A0F1E`）。与旧版的关键差别：每个预设都给出**完整的深 / 浅双模式调色板**（`[data-preset="x"]` + `html[data-preset="x"][data-theme="light"]`），并把渐变底图收敛成 CSS 变量 `--preset-bg` / `--preset-bg-size` / `--preset-bg-repeat` / `--preset-bg-position`，由 JS 以 `backgroundImage = 'var(--preset-bg)'` 引用 —— 切换深浅主题时底图自动跟随，无需 JS 重算。选中这四个预设自动进入 `body.has-custom-bg` 毛玻璃模式。Grid 预设额外声明 `--preset-bg-repeat: no-repeat, repeat, repeat`，否则 32px 网格线只会画一格。
- **修复浅色主题下「状态栏显示项」面板白底白字**：`.sb-config-title` / `.sb-config-label` / `.sb-config-close:hover` 三处引用 `var(--mcode-text-bright, #fff|#eee)`，但 `--mcode-text-bright` **在全站从未被定义过** —— 深色主题下近白色恰好看着正常，浅色主题（Mocha Latte / Shell Paper / Aurora / Dusk / Cyber / Grid 浅色）就是白底白字、可读性为 0。现按既有别名机制在四个主题块补上 `--mcode-text-bright: var(--gem-text);`（`var()` 在 `<html>` 上按当前预设解析，六个预设的深浅共 12 种组合自动跟随）。实测对比度：Aurora 浅色 14.27:1、Mocha 浅色 7.99:1、Grid 浅色 15.27:1、Aurora 深色 13.4:1（WCAG AA 要求 4.5:1）。
- **自定义背景中性灰面统一**：在 `body.has-custom-bg` 作用域内把基础中性灰面色号整体并入「卡片」色号 `--gem-bg-card`：`--gem-bg-canvas`、`--gem-bg-sidebar`、`--gem-bg-card-inner`、`--gem-surface-low`、`--gem-surface-highest`，以及它们在预设主题块里写成 `var(--gem-*)` 别名的 `--mcode-bg` / `--mcode-bg-primary` / `--mcode-bg-secondary` / `--mcode-surface` / `--mcode-surface-muted` / `--mcode-surface-raised` / `--mcode-code-bg` / `--studio-*` 全族。**注意这些别名在 `<html>` 上就完成了变量替换并逐层继承，因此必须在 `body` 上显式重映射，只改 `--gem-*` 不生效**。实测设置页残留灰面元素由 96 个降至 0。**`--gem-surface-high`（及别名 `--mcode-surface-hover`）刻意保持原样不动** —— 这一层灰是交互态 / 配额进度条轨道 / 列表选中行底色的载体。
- **子代理主题色贯通**：新增 `getAgentAccent()` / `applyAgentAccent()`，把当前所选子代理主题色（`AGENT_THEMES.color`，如 CodeArts 华为红 `#ef4444`、TRAE `#34d399`、Copilot `#c084fc`）写入 `<html>` 的 `--agent-accent` / `--agent-accent-glow`；**发送按钮背景**（`color-mix` 生成的深色渐变，保持白字可读）与**上下文进度条内条**跟随，切换即时联动，未知代理按名称哈希生成稳定色。把 `#panel-chat` 作用域内的主题强调色令牌整体改指向 `--agent-accent`（`--gem-primary` / `--gem-primary-container` / `--mcode-accent` / `--mcode-accent-gradient` / `--mcode-primary-action-bg` / `--mcode-accent-glow` / `--mcode-focus-ring`），于是「模型与运行参数」弹窗、「状态栏显示项」弹窗、会话头二级菜单、输入台聚焦描边、引用块左边线、行内代码、空状态卡片 hover 全部一次贯通。承载白字的实心块（Max 档位、完成、`button.primary`）统一改用 `--mcode-accent-gradient`；文字 / 边框 / 图标则用可读强调色 `color-mix(in srgb, var(--agent-accent) 72%, var(--gem-text))`，避免 Antigravity `#8ab4f8` 这类亮色在浅底上看不清。**模型名文字不参与着色**（统一取对话窗问候语字体色 `var(--gem-text)`）；**列表行的灰色底刻意不改**。
- **移除所有搜索框的放大镜图标**：模型与运行参数弹窗的 `#mp-search-input` 与平台 / 会话侧栏的 `#platform-search` 都不再渲染图标。附带修掉根因：`.mp-search-input`(0,1,0) 的 `padding` / `border-radius` / `height` / `font-size` 一直**被基础表单规则 `input[type="text"]`(0,1,1) 压掉**，内边距实际回落到全局 `7px 12px`，于是文字从 12px 开始、图标在 8px 起 — 正好重叠；现把该规则连同 `:hover` / `:focus` 提到 `.mp-search-wrap .mp-search-input`(0,2,0) 与 `.mp-search-wrap .mp-search-input:focus`(0,3,0)。全量盘点确认应用中所有带「搜索」占位的输入框（`#platform-search`、`#mp-search-input`、`#agent-card-search`、`#custom-bg-input`）均已无图标残留。

### 对话区交互精修 (`console`)

- **第二批侧栏精简**：删除搜索框右侧 ⌘K 快捷键提示、卡片上的「余100% / 冷备」额度与缓存胶囊、以及「待机 · 点击开启对话」占位行。根因：徽标区三连胶囊内容宽 126px **> 可视 86px**，第三枚「N会话」被 `overflow: hidden` 静默裁切（元素一直在 DOM 中但看不见）；删去前两枚后 9/9 卡片 `clipped: false`。同步新增 `mountAgentSummaryRow()` / `mountAgentSummaryByName()`，采用**按需重建**策略 —— 占位态整行不渲染，真实智能总结到达后再插入，杜绝占位文案回潮。
- **底栏模型弹窗左右贴靠自适应**；思考档位标签精简为 `模型名 · 思考档位`；回到底部改为极简纯图标悬浮键；全局 Squircle R 角与 Logo 标准统一（消除 ZCode 插件图标缺失）；卡片去框化与冗余信息净化；会话折叠改为平滑 CSS 渐变过渡动画；消息气泡操作重塑为底角独立复制图标并伴随反馈动效；彻底消除顶栏头像纵向拉伸。

### 工程与发布

- **零依赖交互 Demo**：新增 [`scripts/build_demo.py`](scripts/build_demo.py) + [`scripts/demo_engine.js`](scripts/demo_engine.js)，把控制台打包为含内存虚拟驱动引擎的单文件纯前端 Demo，支持脱机运行与全功能免后端体验；同步产出 `demo/index.html`、根目录 `demo.html` 与桌面副本。
- **版本号全链路统一**：[`packaging/build.py`](packaging/build.py)、`integrations/*`（vscode / codearts / codex / antigravity）、`plugins/agenthub-workers`（`.zcode-plugin` / `.minimax-plugin` / `.claude-plugin`）、`marketplace.json`、`hub/agent_hub.py`（`SERVER_VERSION`）、`console/server.mjs`、`console/client/index.html`、扩展打包回归测试全部对齐到 **0.9.9.6**，结束版本号分叉。历史条目（本文件的 `[0.9.9.2]` 段、`docs/version-history.md`、`docs/roadmap.svg` 的时间线节点）按记录性质保留原版本号。
- **README 与架构图重写**：[`README.md`](README.md)、[`docs/architecture.svg`](docs/architecture.svg)、[`docs/roadmap.svg`](docs/roadmap.svg) 全面重写，产物表与源码头像同步到 `v0.9.9.6`。
- **静态隐私审计**：[`scripts/audit_secrets.py`](scripts/audit_secrets.py) 工作区扫描归零；全套隔离回归测试全绿。

---

## [0.9.9.2] - 2026-10-12

### 登录链路全量重构：状态检测收口、CodeBuddy 共享会话存储对齐、Trae PKCE 修复、ZCode 双区切换 (`console`)

- **统一登录入口与「状态检测式」授权收口 ([`console/client/index.html`](console/client/index.html) / [`console/auth.mjs`](console/auth.mjs))**：
  - 卡片上并列的「🔐 OAuth 登录」与「+添加新账号」合并为单一「🔐 登录 / 添加账号」入口（后端本就同走沙箱隔离流程，并列按钮纯属逻辑冲突）；
  - 「✓ 我已完成授权」从"按按钮即报成功"改为**真实状态检测**：核验凭据落盘，未检测到明确报错并继续自动轮询，彻底杜绝假成功；所有回调提交分支在账号归档失败时如实返回错误；
  - 修复 CodeBuddy 粘贴 `/started` 完成页链接被误当 accessToken 反复写入、并杀死进行中登录进程导致"卡死"的缺陷：网页 URL 一律拒绝充当凭据，started 链接自动提取 `state` 走官方协议完成兑换。
- **CodeBuddy（国际版/国内版）登录修复与官方协议对齐 ([`console/auth.mjs`](console/auth.mjs) / [`console/accounts.mjs`](console/accounts.mjs))**：
  - 实证新版 CLI（≥2.164）会话真实落盘位置为 XDG 共享存储 `~/.local/share/CodeBuddyExtension/Data/Public/auth/<authentication-id>.info`（随 HOME 而非 `CODEBUDDY_CONFIG_DIR`，且 CN/国际版共用同一文件）：ACP 成功回包后同时轮询 legacy 路径与共享存储并自动镜像归档，修复"授权成功但检测不到凭据"；
  - 补齐官方 `GET /v2/plugin/auth/token?state=` 与 `GET /v2/plugin/account` 兑换链路（国际 `www.codebuddy.ai` / 国内 `copilot.tencent.com`，prefixPath `/plugin`），授权链接到达即启动后台看门狗并行轮询，CLI 自身轮询卡死时由 Hub 直接完成落盘；
  - 账户身份识别覆盖 `account` / `accounts[0]` / `allAccounts[0]` 三份副本与 JWT payload（CN 版 email 恒为空，按 uid/uin/手机号识别；ACP 结果自带 userinfo 作兜底）；未完成授权的半成品（accessToken 为 started 跳转 URL）一律判为未登录，不再被误归档；
  - 登录弹窗对 CodeBuddy 明示"重复授权会使同账号网页端会话下线"的单会话策略提醒，并提供不影响网页端的凭据导入通道。
- **Trae 官方 OAuth 修复（授权页报错"链接有误"）**：与 Trae IDE `loginUrlBuilder` 逐参数对齐——补齐强制 PKCE（`code_challenge` + `code_challenge_method=S256`）、回调路径改用官方 `/authorize`、登录主机改由 `GetLoginGuidance` 动态探测（国内/国际双区）；回调解析新增 `userJwt` 直通与 `authCodeInfo→AuthCode+CodeVerifier` 走 IDE 原生 `/trae/api/v3/oauth/ExchangeToken` 兑换。
- **ZCode 国际/国内切换**：登录弹窗新增区域选择（国内版 BigModel / 国际版 Z.ai），后端按区域走官方 `provider: bigmodel|zai` 初始化、轮询与 `enc:v1:` 加密落盘，初始化失败按区域回退对应 API Key 获取页。
- **MiMo API Key 不再误当账号**：粘贴 `sk-` Key 直接合并进线上 `auth.json` 立即生效、不入账号列表；仅 API Key 的凭据（无小米 OAuth uid 且无其他通道）永不自动归档为账号。
- **MiniMax 账户名识别**：实证官方 CLI 不落盘账户名且无 userinfo API；登录/导入时把用户备注名注入官方保留字段 `oauth.account`（与 `mmx auth status` 的 Account 行同源），账号列表、卡片头标与配额信息同步展示。
- MiniMax 默认模型改为 `MiniMax-M3`（1M 上下文），512K 的 M3.1-Flash-Preview 可通过上下文胶囊一键切换（同步对齐 `console/server.mjs` 内置 `MODEL_CATALOG.minimaxcode` 与 `console/auth.mjs`）。
- **头部右侧收敛为两控件**：删除「刷新」按钮（自动轮询已覆盖），整体右移；枢纽端点下拉只显示「本机/服务器」（主机详情进悬停提示）；四个色系胶囊替换为太阳/月亮单按钮，仅保留深（默认）/浅两套主题，按一下互切，悬停提示显示"切换为浅/深色系"（指向非当前的另一侧）。
- **对话头一体胶囊重构**：代理名文本删除，新结构为「头像（点击切换子代理，弹出 9 子代理选择菜单）｜当前会话名（点击切换对话）」的一体胶囊；胶囊内会话名实时跟随当前会话标题。
- 状态栏配置面板改为在点击位置上方弹出（以点击点水平居中并做容器边界钳制），不再固定左对齐。
- 状态栏收尾：移除右端独立齿轮图标，整条状态栏即为可点整体（点击任何位置打开显示项配置，Esc/点外关闭）；配置面板移除已不存在的"子代理平台"死选项。
- **对话页七项视觉与体验改造 ([`console/client/index.html`](console/client/index.html))**：
  - 移除对话头代理胶囊上的状态徽章（"可直通"类）；平台树一键展开/收起图标改为对角双向箭头；
  - 归档查看器的平台筛选与排序两个下拉合并为单漏斗图标菜单（视图：按项目/时间线；排序方式：更新时间/创建时间，按项目视图带分组标题）；
  - 发送旁模型胶囊改为 `agent名/模型名`（如 `antigravity/Gemini 3.8 Flash Medium`），原始模型 id（如 `huaweicloud-maas/*`）不再外露并移除四角星图标；底部动作行下移至卡片底边，圆角与卡片对齐；
  - 状态栏内容相对输入框居中，模型块只显示目录展示名（agent 名不再与模型胶囊重复）；
  - 修复 `modelsData is not defined` 跨闭包引用导致快照加载崩溃、页面降级的缺陷（模型名解析改用对话块本地 `state.snap.modelCatalog`）。
- **对话页头部信息密度优化 ([`console/client/index.html`](console/client/index.html))**：「+ 新建对话」「清空」「导出」三个按钮统一收进「⋯」溢出菜单（导出的三种格式同步拍平为一层菜单项），头部右侧仅保留「工作台」独立按钮；桌面与手机端实测菜单开合、布局与全部菜单项功能正常。
- **修复账号切换劫持 WorkBuddy 桌面会话的事故 ([`console/accounts.mjs`](console/accounts.mjs))**：回退"切换账号时同步写入 CodeBuddy XDG 共享会话存储"的逻辑——该文件是 WorkBuddy 桌面版的会话，hub 写入会把桌面版顶成其他账号。CodeBuddy 派发侧的账号隔离本由 wrapper 的独立 HOME 机制（`~/.codebuddy-cn-home` / `~/.codebuddy-intl-home`）承担，hub 只做沙箱内登录捕获（只读），永不写真实共享存储。
- **修复会话未读红点老 bug ([`console/client/index.html`](console/client/index.html))**：打开某 agent 对话时此前只把"当前活跃会话"标为已读，同一 agent 的旧会话攒下的未读永远清不掉、每次刷新红点都重现；现改为整 agent 级标读（服务端清空其全部会话未读），底部导航与线程列表徽标同步清零。
- **隐私与开源前清洗**：全仓（工作区 + 全部 git 历史）清除内网 IP、用户主目录路径、个人邮箱、手机号与账号 UID（`git filter-repo` 全量重写）；账号展示层不再暴露手机号——CodeBuddy CN 等卡片与配额区只显示账户名称/邮箱，档案命名也优先名称而非手机号；`scripts/audit_secrets.py` 新增个人邮箱、国内手机号（排除哈希子串误报）与长数字 ID 规则，工作区与历史扫描均归零。
- **账号/上下文切换乐观 UI 提速 ([`console/client/index.html`](console/client/index.html))**：账号胶囊与 MiniMax 上下文档位胶囊点击立即变绿（实测 44ms），真实切换与配额刷新改后台执行、失败自动回滚重绘；砍掉切换后同步等待全 9 厂商配额强刷的阻塞链路（服务端本就对被切 worker 单独清缓存，其余走 60s 缓存）。
- **账号区切换入口去重（全 9 卡片生效）**：移除与账号胶囊芯片完全重复的"已存账号下拉框 + 切换按钮"，「存别名」收为芯片行尾的虚线小胶囊；套餐徽章剥离规则升级为同时识别括号式与 `· UID:xxx` 分隔式账号片段（修复 mimocode 等卡片头部 UID 重复显示），9 张卡片的套餐徽章现在只展示纯套餐/档位信息。
- **手机端对话页修复 ([`console/client/index.html`](console/client/index.html))**：修复窄屏（≤640px）下工作台因 auto 模式"有产物即自动展开"而全宽覆盖对话区、导致手机上永远看不到对话的问题——窄屏时 auto 不再自动弹出，产物通过边缘把手徽标提示、手动展开；底部「对话 / 代理」导航栏与代理页在 390px 视口实测可正常进入与渲染。
- **账号显示去重与 Unicode/中文账号名全链路打通 ([`console/client/index.html`](console/client/index.html) / [`console/accounts.mjs`](console/accounts.mjs) / [`console/server.mjs`](console/server.mjs))**：
  - 账号档案名清洗 `cleanProfileLabel`、前端登录弹窗备注名输入过滤与后端 `safeProfileName` 参数校验全部统一为 `/^[\p{L}\p{N}._-]{1,64}$/u`（保留中文/Unicode 字母数字，拒绝 `.` 与 `..`），彻底修复 CJK 账号名（如 Z.ai「旅行者****」）在归档、切换、删除或自定义备注时被吞字或报 400 `name 含非法字符` 的问题；同时清理 `console/accounts.mjs` 残留的字面量 UTF-8 BOM 字符，统一使用 `\uFEFF` 转义；
  - 卡片头部移除与"点头像"重复的「头像」按钮，启停开关独占右侧；套餐徽章不再重复括号内的账号身份（与 worker 同名时彻底隐藏），徽章文字不再截断；
  - 「账号与登录」状态徽章只表达"已登录/未登录"，当前账号统一由绿色高亮胶囊展示，消除同一账号信息在同一卡片上三处重复的问题；角色描述行改为完整换行显示。
- **登录会话取消回收与服务秒级优雅退出 ([`console/auth.mjs`](console/auth.mjs) / [`console/server.mjs`](console/server.mjs) / [`console/client/index.html`](console/client/index.html))**：
  - 新增 `POST /api/auth/cancel`、`cancelLogin(loginId)` 与 `cancelAllLogins()`：关闭登录弹窗或切换 ZCode 区域时立即终止未完成的 PTY/ACP 子进程（`SIGTERM` + 300ms `SIGKILL` 兜底）、关闭本地 OAuth 回调监听连接、中断 CodeBuddy state 看门狗轮询并清理 `~/.agenthub/sandbox/` 临时沙箱目录；
  - 所有后台轮询/超时定时器标记 `.unref()`，并在 `server.mjs` `dispose()` 中调用 `authMod.cancelAllLogins()` 与 `closeAllConnections()`，根治 `systemctl --user restart agent-hub-console.service` 因活跃连接或残留子进程阻塞 90 秒超时的问题。
- **MiniMax 上下文档位选择器 ([`console/client/index.html`](console/client/index.html) / [`console/auth.mjs`](console/auth.mjs))**：minimaxcode 卡片新增「上下文 512K | 1M」分段胶囊——实证 mmx CLI 的上下文窗口由模型内置表决定（`text chat` 无上下文参数），512K=`MiniMax-M3.1-Flash-Preview`（524288）、1M=`MiniMax-M3`（1e6），点击档位即切换默认模型，Hub 每次派发实时读取无需重启；同时将 M3.1 原先含糊的 `512K/1M` 标签修正为真实的 `512K 上下文`。
- **模型别名可删除 ([`console/auth.mjs`](console/auth.mjs) / [`console/client/index.html`](console/client/index.html))**：内置模型行暴露 agents.json 中的别名徽章并可单个删除（修复"指向内置模型 id 的自定义别名永远无法删除"），删除当前 default 别名时自动回退内置默认模型。
- **版本号与发布产物全面统一**：将 Hub 核心、console/WebUI、README/SVG 架构图、VS Code / CodeArts / CloudIDE 扩展包（`multi-agent-hub-0.9.9.2.{vsix,carts,cloudide}`）及全套 32 项回归测试一律对齐到 **0.9.9.2**，结束双线并存。

---

## [0.9.4] - 2026-10-12

### 全接口高并发压测、大负载加固、原生配额/多账号面板重塑与跨平台兼容 (`hub` / `console` / `drivers` / `mcp`)

- **原生 9 厂商配额监控、全 WebUI OAuth 登录/登出、多账号切换与「配额与账号」面板重塑 (`console`)**：
  - 新增纯标准库零依赖模块 [`console/vendor-quota.mjs`](console/vendor-quota.mjs)（9 Worker 原生配额实时抓取与 60s TTL 缓存，内置 ZCode `enc:v1:` AES-256-GCM 凭据加解密与 GNOME Keyring 读写）、[`console/accounts.mjs`](console/accounts.mjs)（9 Worker 全覆盖的多账号档案保存、一键切换、隔离沙盒添加与删除）与 [`console/auth.mjs`](console/auth.mjs)（9 Worker 原生 OAuth 授权链接生成、TUI 设备码/ACP 协议流提取、远程回调 URL / 授权码交换与一键退出登录），彻底移除外部 9router 依赖及 `server.mjs` 中 336 行残留 `token_monitor` 死代码。
  - **9 Worker 全量 WebUI OAuth 免终端登录与账号切换 ([`console/auth.mjs`](console/auth.mjs) / [`console/secret-get.py`](console/secret-get.py))**：彻底告别丑陋的 `about:blank` 空白弹窗与 `window.prompt` 阻塞对话框，升级为页内暗色毛玻璃 **OAuth 授权与账号切换模态窗 (`#uhAuthModalBackdrop`)**，逐一打通全部 9 个 Worker 的官方 OAuth 链路：
    - `minimaxcode`：通过 Python PTY 驱动 `mmx auth login --recommend --region=cn`，自动提取 OAuth 授权链接（`https://platform.minimaxi.com/oauth-authorize?user_code=...`）与设备码并后台自动轮询落盘，同时支持直接粘贴 `sk-...` API Key；
    - `codebuddy` / `codebuddy-cn`：通过官方 `codebuddy --acp`（`external` / `internal`）JSON-RPC `initialize` + `authenticate` 协议流，1 秒内捕获 `_codebuddy.ai/authUrl` 官方登录链接并在浏览器授权完成后自动写入 `auth.info`；
    - `github-copilot`：通过 Python PTY 驱动 `copilot login --device-code` 提取 `https://github.com/login/device` 与 8 位设备码，扩展 [`console/secret-get.py`](console/secret-get.py) 支持 `--set` / `--delete` 同步读写 GNOME Keyring 与 `.config/github-copilot/copilot-token` 镜像，支持 WebUI 一键登出与多账号切换；
    - `antigravity`：内置官方 Google OAuth 2.0 授权流（`1071006060591-tmhssin2h21lcre235vtolojh4g403ep`）+ 本地 `127.0.0.1:20128/oauth-callback` 监听，支持跨机远程浏览器登录并粘贴 `http://localhost:20128/oauth-callback?code=...` 回调 URL（自动经本地代理交换 `access_token` / `refresh_token` 写入 `antigravity-oauth-token`）；
    - `mimocode`：内置官方小米 MiMo X25519 + AES-256-GCM 端到端加密 OAuth 授权流（`https://platform.xiaomimimo.com/authorize?pk=...`），支持在 WebUI 粘贴授权回调 Code 自动解密落盘至 `.local/share/mimocode/auth.json`；
    - `traecode`：内置官方 Trae 双区（国内 `trae.cn` / 国际 `trae.ai`）OAuth 授权链接生成与 `/cloudide/api/v3/trae/oauth/ExchangeToken` Token 交换，支持粘贴回调 URL 或 JWT Token；
    - `zcode`：内置官方 ZCode CLI 轮询式 OAuth（`POST /api/v1/oauth/cli/init` → `bigmodel.cn/login` + 3s 节流轮询 `/api/v1/oauth/cli/poll/<flow_id>`），获取 API Key 后自动以 `enc:v1:` AES-256-GCM 加密写入 `.zcode/v2/credentials.json`；
    - `codearts`：提供华为云 IAM 访问密钥控制台直达链接与页内 AK/SK 双字段安全落盘（`.config/agenthub-codearts/codearts-auth.env`，权限 `0600`）。
  - **对话输入栏与三态合一模型配置面板重塑 ([`console/client/index.html`](console/client/index.html))**：将原先分离的输入框与底栏整合为一体化暗色毛玻璃 `.chat-composer-shell`；重构模型选择器为无原生下拉框的精致 Popover 面板，按厂商真实能力自适应展示模型卡片、深度思考两段式分段胶囊（`默认 / 开启 / 关闭`）与流式输出实时开关，彻底移除不可点击的灰置废项。
  - 重构 [`console/client/index.html`](console/client/index.html) 配额与账号面板布局：`.qa-grid` 采用自适应网格 `repeat(auto-fill, minmax(310px, 1fr))` 配合 `.qa-card { min-width: 0; overflow: hidden }`，根治多列卡片下 `<select>` 与按钮跨卡溢出重叠；每张卡片实时展示 `● 已登录` / `○ 未登录` 状态徽章、内联「存当前」档案抽屉、一键「🔐 OAuth 登录 / 换号」、「+添加账号」隔离沙盒授权与「退出」按钮；消除手动刷新时的整页坍缩闪烁，并用控制台原生 Toast（`window.__ahToast`）全面替代阻塞弹窗。
- **高强度阶梯压力测试与并发锁加固（阶段三 ~ 阶段五，累计 >4,500 次压测请求 0 报错）**：
  - **Singleflight 配额请求合并 ([`console/vendor-quota.mjs`](console/vendor-quota.mjs))**：引入 `inFlightAll` 与 `inFlightWorker` Promise 复用锁，60 并发刷新风暴下外部厂商 API 调用从 **540 次降至 9 次**，`/api/quotas` P95 延迟从 **12,041ms 降至 850.5ms（快 14.1 倍）**，`/api/quota` P95 从 **10,593ms 降至 1,612.5ms（快 6.5 倍）**（详见 [`docs/stage3-stress-report.json`](docs/stage3-stress-report.json)）。
  - **配置文件写互斥锁与备份自动轮转 ([`console/auth.mjs`](console/auth.mjs) / [`console/accounts.mjs`](console/accounts.mjs))**：引入进程内 `withLock` 串行队列锁，修复并发修改 `agents.json` / `accounts.json` 的 Read-Modify-Write 竞态，10 路并发 `POST /api/models/custom` 落盘成功率从 **1/10（丢失 9 个）提升至 10/10（0 丢失）**，并自动轮转 `.bak-model-*` 仅保留最新 5 份。
  - **Hub 360 并发洪峰与 `hub_capabilities` 缓存加固 ([`hub/agent_hub.py`](hub/agent_hub.py))**：将 `HubHTTPServer.request_queue_size` 从 Python 默认 `5` 提升至 `256`（消除高并发 SYN 队列溢出导致的 28.5s 尾延迟），并为 `tool_hub_capabilities` 增加路径与 `mtime_ns` 感知的 5s 内存缓存（文件变更或启停子代理秒级失效）；360 同波瞬时并发 × 3 波（1,080 请求）100% 成功，`GET /health` P95 从 **28,525ms 降至 1,252ms（快 22.8 倍）**，稳态 `hub_capabilities` 从 **170ms 降至 15ms（快 11.3 倍）**（详见 [`docs/stage4-5-load-report.json`](docs/stage4-5-load-report.json)）。
  - **大任务负载、上传安全边界与 30 并发状态机验证**：100KB 任务提示词 + 18KB 结果全链路 **91ms** 字节级 100% 精确落盘；收紧 `console/server.mjs` `saveUpload` 单文件上限至 `1 MiB` 并将 `client.json` / `agents.json` / `accounts.json` 纳入凭据上传拦截名单；30 路并发状态机读写（10 任务 + 10 消息 + 10 笔记）验证 `StateFileLock` 零损坏、零丢失。
- **ZCode 桌面驱动参数解析修复与跨平台 UTF-8 BOM 兼容加固（阶段六 & 七）**：
  - 修复 [`drivers/zcode_dom.js`](drivers/zcode_dom.js) `process.argv` 解析器未识别 `--stream` 值参数导致 `--stream off` 的 `"off"` 覆盖真实提示词的阻塞性缺陷，将轮询上限提升至 `1800s`，并在新建会话（New Chat）点击完成后再采集 DOM 基线快照。
  - 全链路 UTF-8 BOM（`\uFEFF`）容错加固：[`hub/agent_hub.py`](hub/agent_hub.py) `_read_json` 统一切换为 `encoding="utf-8-sig"`，Node 侧 `auth.mjs` / `accounts.mjs` / `server.mjs` / `vendor-quota.mjs` 统一剥离 `^\uFEFF`，兼容 Windows PowerShell / 记事本生成的带 BOM JSON 配置（详见 [`docs/stage6-compat-report.json`](docs/stage6-compat-report.json)）。
  - 字节级同步全部 7 处 MCP 桥接副本（统一暴露 8 个 MCP 工具，含 `hub_set_status`），全量跑通 [`tests/run_regressions.py`](tests/run_regressions.py) **32/32 组回归测试套件**并重新构建全套分发 ZIP 与 IDE 扩展包。

### WebUI 控制台全景交互架构与会话管理升级 (`console`)

- **CodeBuddy 风格三栏式交互布局**：
  - 栏 1（48px 极窄活动栏）：沉浸式对话、代理监控、任务队列、共享笔记一键切换，移动端自适应下沉底部导航栏；
  - 栏 2（260px 平台会话树）：支持各 Worker 展开独立多会话树、会话快速切换与搜索、一键新建会话、折叠展开；
  - 栏 3（中央交互工作区）：单平台沉浸式对话、输入框下沉式状态条（模型/状态/耗时实时监控与自定义勾选项）、右侧可折叠扩展工作台。
- **智能时段问候语与跨平台全局头像定制**：
  - 7 大精细时段（清晨 05:00-09:00、上午 09:00-12:00、中午 12:00-14:00、下午 14:00-17:00、傍晚收工 17:00-20:00、晚上 20:00-23:00、深夜 23:00-05:00），共 35 句暖心关怀问候语，每次进入或切换平台即时随机构造与刷新；
  - 支持点击头像选择本地图片自定义头像，全局多视图（侧边栏、对话头、气泡等）实时响应并持久化至服务端配置。
- **全量会话归档管理与快速复原/删除**：
  - 会话树项归档交互双模优化：单击弹窗二次确认防误触，双击秒速直接归档；
  - 全部归档会话多维弹窗：支持跨所有 Worker 集中聚合查看、多平台筛选、关键词实时搜索、多维度排序；
  - 已归档会话支持**一键复原**（自动恢复至活跃会话列表并跳转打开）、单条彻底删除，以及右上角**【一键删除】与防误触内联二次确认**；
  - 子代理接入端点新增**【复制本文（发给Agent配置）】**，并实现全局剪贴板原生降级回退（无缝适配局域网 HTTP 非安全上下文与 HTTPS）。
- **状态感知右移与自动探活替代独立心跳**：
  - 移除顶部独立的心跳检测按钮，操作区自然贴紧右侧；
  - “刷新”按钮升级为快照获取与在线子代理并发深度探活，Toast 即时反馈网络延迟与各 Worker 在线状态。
- **轻量页脚与社区互动彩蛋**：
  - 底部增加优雅轻量页脚栏，右下角展示版本号 `v0.9.4`；
  - 左侧提供【捐献】按钮，点击弹出“好好吃饭更重要哦”，选择【仍要捐献】触发温馨感谢爱心彩蛋；
  - 中间展示 GitHub 图标与仓库给 Star 标语，点击直达项目官方仓库。

### WebUI 子代理激活开关与全端双向同步机制 (`console` / `hub` / `mcp`)

- **WebUI 控制台一键启用/禁用子代理**：
  - 在 Web 管理大盘（端口 `8890`）的 Worker 卡片增加原生 Toggle Switch 切换开关，支持按需激活或临时禁用任意 Worker（如无额度账户、调试中子代理）。
  - 新增 REST 控制端点 `POST /api/agents/toggle`（接收 `{ agent_id, disabled: boolean }`），权威状态持久化落盘至 `agents.json` 的 `disabled` 属性，并即时触发 `availability_store` 内存缓存热刷新。
  - 新增 Hub 管理 MCP 工具 `hub_set_agent_status`，支持客户端及脚本编排程序远程启停子代理状态。
- **全端权威状态双向感知与前置熔断**：
  - 调度器与客户端同步状态联动：`hub_status` / `hub_list_agents` 将被禁用的 Worker 显式标注为 `[已禁用]`（并输出原因，如 `由管理员在控制台或 API 禁用`）；`hub_capabilities` 接口返回 `enabled: false, code: "disabled"`。
  - 任务调度零延迟保护：`hub_dispatch` 针对被禁用的 Worker 触发秒级前置拦截，直接返回 `UNAVAILABLE: profile_disabled`，绝不启动真实驱动进程，杜绝频繁调用空额度子代理造成的计算与 API 资源浪费。
- **MiniMax Code / MiniMax Plugin V1 与多规范插件一包四吃适配 (`plugins/agenthub-workers` / `packaging/build.py`)**：
  - 严格对照《MiniMax Plugin 开发与上架指南（MiniMax Plugin V1）》补齐 `.minimax-plugin/plugin.json`（`schemaVersion: 1`、分类 `Code`、零外泄凭据）与独立 `hub-bridge.mcp.json`（标准 `stdio` 解释器命令 `node` + 包内相对参数 `./mcp/server.mjs`）；
  - 同步补齐 `.claude-plugin/plugin.json`（兼容 MiniMax Code CLI `mcode 0.4.0+` 与 Claude Code）及根目录 `plugin.json`（兼容 Agent Plugins Specification v1.0.0），与原有 `.zcode-plugin/plugin.json` 零冲突共存；
  - `packaging/build.py` 新增 `--component minimax` 构建能力，自动生成符合官方上架与导入规范、根目录直接包含 `.minimax-plugin/plugin.json`（无外层包裹目录）的独立插件包 `agenthub-workers-0.9.4-minimax-plugin.zip`。
- **架构图/路线图 SVG、一键安装链路与 Apache-2.0 开源协议升级 (`docs/*.svg` / `README.md` / `LICENSE`)**：
  - 重构 `docs/architecture.svg` 与 `docs/roadmap.svg`：清晰呈现“①任意 MCP 客户端直连即用、②6 款原生深度宿主（Codex / ZCode / MiniMaxCode / DSH / CodeArts / Antigravity）、③零客户端 WebUI 独立管理”三层架构与 v0.9.4 攻坚成果；
  - 在仓库根目录补齐 `install.cmd`、`install.sh`、`connect.cmd`、`connect.sh` 快捷入口，重构 `README.md` 四大场景化安装指南，并增加对 [LobeHub / Lobe Icons](https://github.com/lobehub/lobe-icons) 品牌矢量头像来源的致谢；
  - 将项目开源协议切换为 **Apache License 2.0 (`Apache-2.0`)**，更新根目录 `LICENSE` 及各插件包清单，明确保留原作者版权声明、专利授权与修改说明要求。
- **Web 控制台服务化与局域网访问加固**：
  - 将控制台服务默认绑定监听地址由回环 `127.0.0.1` 调整为 `0.0.0.0:8890`，并补充 HTTP `HEAD` 预检方法处理，确保局域网多设备浏览器平滑访问。
  - 在 Linux 服务器上创建并启用标准 systemd 用户服务 `agent-hub-console.service`，实现断线守护自愈。

### CodeArts 宿主 MCP 强制调用路径规范与去重机制 (`codearts` / `mcp`)

- **强制单一调用路径（Single Invocation Path）**：
  - 针对 CodeArts 宿主在启用 MCP 工具时偶发的重复派发与标签直出问题，严格确立 `tool_search → tool_describe → tool_call` 单一规范调用路径。
  - 严禁在 Markdown 或纯文本推理中混用、直出 `<tool_call>` 等底层 XML 标记，杜绝被宿主调用解析引擎双重触发执行。
- **规约多层深度固化**：
  - **MCP Server 层**：在 `mcp/server.mjs` 的 `initialize` 握手响应 `instructions` 及 `hub_dispatch` / `hub_ask` 工具的 `description` 中显式固化调用路径约束与单次派发准则。
  - **IDE 扩展层**：在 `extension.js` 中自动为工作区注入 `.codeartsdoer/rule/multi-agent-hub.md` 强制规则；在 `SKILL.md` 与 9 个子代理 prompt（`agents/*.md`）中全面补充“单任务仅派发一次、凭 ref 安全异步轮询”规范。
- **TraeCode 网关回执解析与回填保底**：
  - 优化 `hub_dispatch` 对 TraeCode 异步受理结果的结构化解析，确保无论网关返回原生 ref 还是回执文本，均能精准提取并回填顶层 `ref` 与 `running` 状态，消除调用方因 ref 为空而重派任务的隐患。

### Antigravity 宿主插件连接与 MCP 桥接故障动态恢复修复 (`antigravity` / `mcp`)

- **MCP 桥接动态连接加载与自愈**：
  - 彻底解决 `mcp/hub.mjs` 模块顶层静态求值 `try { CONNECTION = await loadConnection(); }` 导致在配置文件缺失或未就绪时永久锁定 `SETUP_REQUIRED` 状态的缺陷。
  - 新增 `refreshConnection()` 与 `getConnection()` 动态重试机制：当连接配置在 MCP 进程启动后被创建或修正时，后续任意工具调用（`hub_status`、`hub_capabilities`、`hub_ask` 等）均能自动重新加载配置并与 Hub 恢复连接，无需重启 IDE 或杀死后台进程。
  - 将修复同步至全部集成目标（`mcp/`、`plugins/agenthub-workers/mcp/`、`integrations/dsh/mcp/`、`integrations/codex/mcp/`、`integrations/codearts/mcp/`、`integrations/antigravity/mcp/`、`integrations/vscode/mcp/`）。
- **Windows Antigravity 客户端配置就绪**：
  - 修复 `%LOCALAPPDATA%\AgentHub-Antigravity\client.json` 配置路径缺失问题，配置标准文件模式连接至局域网 Hub 节点（`http://<LAN_HUB_IP>:8765/mcp`）与凭据。
  - 实时热重载 Antigravity 宿主插件进程，实测通过原生 `call_mcp_tool` 执行 `hub_status` 与 `hub_capabilities`，成功返回远程 9 家 Worker 在线状态及 TraeCode 等通道能力。
- **单元测试与全量回归**：
  - 在 `tests/mcp_bridge.test.mjs` 中新增 `bridge recovers dynamically when connection configuration is restored` 单元测试，并将 `integrations/vscode/mcp` 纳入跨端桥接一致性自动化检验（117 项测试全量通过）。
  - 全量运行 `tests/run_regressions.py`，31 组回归套件全部通过（100% PASS）。


### TraeCode 网关状态与能力识别修复 (`traecode` / `hub`)

- **修复 Trae 网关终态校验误报**：解决 Trae 网关返回 `session.status="completed"` 与 `result.status="ok"` 时，因白名单缺少 `ok` / `success` 被误判定为“网关状态不确定”并抛出 `RuntimeError: Trae 网关状态不确定，继续查询原任务；请勿重新派发: completed,ok` 的根本问题。将 `ok` 和 `success` 纳入正常完成终态集合，确保任务结果顺利落盘并标记为 `completed`。
- **TraeCode 网关通道能力识别加固**：
  - `availability_store.py` 识别 `traecode`（及声明了 `gateway` 的 Worker）为专用网关/桌面通道，不再将其误判为 `cli_not_configured`（“此 worker 未配置无头 CLI”），正确置为 `enabled: true, code: "ready"`。
  - `agent_hub.py` 中 `hub_capabilities` 将 TraeCode 的 `configured` 字段正确置为 `true`。
  - `hub_status`（`hub_list_agents`）输出明确显示 `| 调度通道: TraeClaw 网关`，彻底消除模型在推理前误判该 Worker 无法使用的歧义。
- **回归测试覆盖**：在 `tests/runtime_regressions.py` 中新增 `test_gateway_accepts_completed_and_ok_status` 测试用例，在 `tests/capability_availability_regressions.py` 中增加 TraeCode 网关免 CLI 就绪断言。
- **远程服务热重载验证**：修改已同步并部署至远程 Linux 节点，经 `ask.mjs trae` 真实调用验证顺利通过。


### 子代理模型目录精简与去重 (Model Catalog Optimization)

- **不可用生图模型清理**：移除 `codebuddy-cn` 中无法用于代码/文本生成的非文本生图/图生图模型（`hunyuan-image-alpha`、`hunyuan-image-alpha-edit`）。
- **重复与冗余模型去重**：
  - `codebuddy-cn`：清理 `hy4-preview-x`、`hy3-x`、`deepseek-v4-flash` 等重复档位与别名。
  - `antigravity`：去除 `gemini-3.8-flash`、`gemini-3.1-pro` 冗余未分级项，统一保留 High/Medium 精确档位。
  - `mimocode`：清理未命名前缀的重复项 `mimo-v2.6-flash`，统一定位为官方 `xiaomi/mimo-v2.6-flash`。
  - `traecode`：去除大小写重复项 `glm-5.3-flashx`，剔除与平台主项重叠的 `DeepSeek-V4-Flash-Official`、`DeepSeek-V4-Pro-Official` 及 `Doubao-Seed-2.0-Code`。
- **清理 2026 年 6 月前旧代模型**：
  - `codebuddy-cn`：移除 `deepseek-v3-2-volc`、`minimax-m2.5/m2.7`、`glm-4.6/4.7` 全系列、`glm-5.0` 系列、`kimi-k2.5/k2.6/thinking`、`hy3`、`space-bunny`。
  - `codebuddy`：移除旧代及下线模型 `hy3`、`gpt-5.4`、`gemini-3.5-flash`、`kimi-k2.6`。
  - `antigravity`：移除官方标记即将下线的旧代 `gemini-3.6-flash` 与 `gemini-3.7-flash`。
  - `mimocode`：移除 `mimo-auto` 及老旧 `mimo-v2.5` 全系列。
  - `minimaxcode`：移除旧代 `MiniMax-M2.5`、`MiniMax-M2.7` 全系列，聚焦当季旗舰 `MiniMax-M3.1-Flash-Preview` 与 `MiniMax-M3`。
  - `traecode`：移除旧版本 `glm-5`、`glm-5.1`、`kimi-k2.7-code`。
- **华为 CodeArts 规则保留**：遵照用户要求保持 `codearts` 完整不变，维持 4 个已验证企业级官方模型（`GLM-5.2`、`GLM-5.2-ArkTS-SPARK`、`OpenPangu-2.0-Pro`、`OpenPangu-2.0-Flash`）。
- **测试与环境同步**：同步更新 `tests/console_smoke.mjs` 中的模型目录数量断言（全量 26 项 smoke + 5 项 DOM 测试 100% 通过），并同步部署至服务器热重载生效。

### CodeArts IDE & VS Code 桌面扩展升级 (`integrations/vscode`)

- **Workers 侧边栏支持展开模型树**：各 Worker 节点支持展开直接查看当季精选模型、官方积分倍率（如 CodeBuddy-CN `x0.06 ~ x2.00`、TraeCode `0.06x ~ 1.50x`）与官方营销福利标签（`[会员 5 折]`、`[限时 1 折]`、`[专属补贴]`）。
- **华为 CodeArts 官方模型对齐**：扩展内默认模型更新为 `GLM-5.2`（`0.70x`），对齐收敛后的 4 款企业级官方高可用模型。
- **Web 控制台直达修复**：修复 `multiAgentHub.openConsole` 命令地址，精准打开端口 `8890` 的 Web 控制台大盘，避免跳转至底层的 MCP 端口 `8765`。
- **安装包重构与本地就地更新**：重新打包生成 `.vsix`、`.carts`、`.cloudide` 三种发行格式并自动更新本地 CodeArts IDE 扩展实例。


## [0.9.9.1] - 2026-10-10

### 华为 CodeArts 官方模型与凭据自动加载修复 (`codearts`)

- **凭据环境自动载入**：底层驱动 `drivers/codearts_cli.py` 新增自动加载 `~/.config/agenthub-codearts/codearts-auth.env`（或 `CODEARTS_AUTH_ENV` 指定文件）中的 `CODEARTS_CLI_AK` 与 `CODEARTS_CLI_SK`，彻底解决无头模式下因缺少凭据被判定为 `CODEARTS_AUTH_REQUIRED` 或模型列表解析为空的根因。
- **Linux 官方 CLI 路径与 Profile 匹配**：适配 Linux 环境下名为 `codearts` 的官方可执行文件，建立与 Windows `codearts.exe` 一致的 TUI/配置隔离与目录加载规则。
- **模型可用性与目录收敛**：深入华为 MaaS 与 IDE 网关机制，理清无头 CLI（MaaS 官方 AK/SK 鉴权）与 IDE 桌面（临时云端 IAM 网关鉴权）的能力边界；在控制台与 `agents.json` 中将 CLI 真实支持的模型收敛为 4 款已完全验证可用的官方企业级模型（`GLM-5.2` 默认/`0.70x`、`GLM-5.2-ArkTS-SPARK`/`0.70x`、`OpenPangu-2.0-Pro`/`0.70x`、`OpenPangu-2.0-Flash`/`0.35x`）；清理 `availability.json` 中的误报阻断记录，彻底修复选择模型时弹出“找不到所选模型”报错的问题。
- **状态存储兼容 UTF-8 BOM**：`hub/availability_store.py` 读取 `availability.json` 改用 `utf-8-sig` 解码，彻底防止跨平台（如 PowerShell 输出）引入 BOM 字符导致 `capabilities` 接口崩溃并清空全量子代理模型目录的问题。
- **全链路异步调度验证**：实测并通过 Linux Hub 进程至 CodeArts CLI 的全链路任务派发与回答确认（`GLM-5.2`、`GLM-5.2-ArkTS-SPARK` 均秒级返回且状态置为 `completed`）。

### TraeCode 模型倍率与营销折扣对齐 (`traecode`)

- **官方倍率精准对齐**：根据 TraeCode 桌面版官方模型清单，全量更新 27 个可用模型的倍率与营销标签：
  - `GLM-5.3-FlashX`（`0.31x`，默认）、`GLM-5.3-Flash`（`0.06x`）。
  - GLM 智谱系列（`GLM-5.3` / `GLM-5.2` / `GLM-5.1` / `GLM-5`）：`0.78x`，带有浅绿 `[会员 5 折]` 标识。
  - 豆包 Seed 系列：`Seed-Evolving` / `Seed-2.1-Pro`（`0.08x`，`[限时 1 折]`）；`Seed-2.1-Turbo`（`0.20x`，`[专属补贴]`）；`Seed-Code` / `Seed-2.0-Code`（`0.06x`，`[专属补贴]`）。
  - MiMo 系列：新增 `MiMo-V2.6-Flash`（`0.06x`）、`MiMo-V2.6-Pro`（`0.15x`）内置选型。
  - DeepSeek 系列：`DeepSeek-V4-Flash` / `Flash-Official` / `deepseek-v4.1-flash`（`0.20x`，`[限时折扣]`）；`DeepSeek-V4-Pro` / `Pro-Official`（`0.72x`，`[限时折扣]`）。
  - 通义千问系列：`Qwen3.8-Flash`（`0.08x`）、`Qwen-3.7-Plus`（`0.25x`）、`Qwen3.8-Max`（`1.50x`）。

### Web 控制台 (Console & WebUI) 交互与样式优化

- **指标自定义勾选与记忆**：底部状态栏新增自定义指标开关面板，可实时勾选/取消勾选具体监控项（子代理、模型、速度、TPS、会话Token、平台配额等），并自动适配 `·` 分隔符，配置保存在本地存储。
- **状态栏与抽屉联动**：修复点击状态栏模型标签时误触发外部点击关闭面板的事件冲突，点击模型即可平滑呼出参数面板。
- **专属标签样式**：新增 `.mp-tag-promo`（紫色福利标）和 `.mp-tag-discount`（浅绿折扣标），与官方 UI 视觉无缝融合。
- **思考控制优化**：将子代理运行参数由单一开关优化为平滑的思考强度（`low / medium / high / max`）选项，取消阻断式校验，保证各 worker 下对话流程通畅。
- **MiniMax 积分配额展示**：支持解析 9router 通道返回的 MiniMax 剩余积分并统一渲染到额度条与悬浮提示。

### CodeArts / VS Code 扩展规范与安装包修复

- **SemVer 2.0.0 规范兼容**：修正 IDE 扩展 `package.json` 中的版本号为标准的语义化版本 `0.9.9`，解决 CodeArts IDE 核心扩展扫描器在遇到四段版本号（`0.9.9.1`）时抛出 `ScanningExtension: 无法从 ... 读取扩展` 的崩溃报错。
- **本地扩展热更新**：直接就地更新本地已安装的扩展脚本，并重新打包发布 `multi-agent-hub-0.9.9.carts`、`.vsix` 和 `.cloudide`。
- **回归测试验证**：全量 31 项回归测试组（包含控制台 DOM 测试、CodeArts 驱动、打包检查与 Windows/Linux 契约）全部 100% 通过。

### CodeArts IDE & VS Code 扩展包 (.carts / .vsix)

- 新增 CodeArts IDE 与 Visual Studio Code 通用桌面扩展 (`integrations/vscode`)，支持通过 IDE 图形界面“从 VSIX/CARTS 安装...”一键导入，免除命令行脚本配置。
- 提供侧边栏专属视图（Hub 连接与健康状态、9 种 Worker 适配大盘、快捷发现与管理）以及底部状态栏实时指示灯（在线/延时提示）。
- 插件随 IDE 启动自动检测当前工作区，无感为云码道（CodeArts Agent）注入/更新 `.codeartsdoer/mcp/mcp_settings.json`，彻底解决切换项目需手动登记的痛点。
- 新增 `packaging/package_extensions.py` 打包脚本，遵循 VSIX OPC 规范，一键构建并校验 `multi-agent-hub-0.9.9.vsix`、`multi-agent-hub-0.9.9.carts` 和 `multi-agent-hub-0.9.9.cloudide`，输出至 `integrations/vscode/dist/` 与桌面发布目录。

### CodeArts IDE 接入体验

- 修复 Windows 官方 CLI 的发现：驱动和一键安装器识别 `installers/bin/codearts.exe`，避免只发现 `.cmd` 后误选 IDE AgentKernel。直接运行官方 exe 时使用 CLI 专用配置及 `cli-data` 环境，保留外部认证和独立任务数据库，不关闭 TLS 校验。
- 安装结果展示稳定插件目录、版本及每个 MCP 配置路径；明确当前工作区登记、宿主重载与真实工具调用的区别。独立安装器使用默认 IDE 路径时提示尚未核实当前工作区，CLI-only 安装不会提示配置 IDE。
- 补充新工作区复用既有 Hub 连接的步骤，并将官方“文件夹未被信任”诊断识别为权限受阻，保留脱敏错误且不修改信任设置。
- CodeArts 原生代理明确区分直接注册与懒加载 MCP 的调用方式，等待原 ref 的终态并核对真实答案；权限拒绝后停止该动作，不再改工具名或重复请求。
- 修复 Linux CodeArts 驱动另建进程组导致外层取消无法回收后代的问题：仅在确认 Hub 进程组归属时继承外层组，独立运行仍隔离并清理自己的组。真实进程夹具覆盖取消、超时、父进程先退出和无关进程保护。
- 修复 Windows 服务归属查询失败被误判为停止的问题：元数据查询最多重试两次，持续失败报错并保留进程记录；身份不匹配仍拒绝接管或停止。新增服务身份确认失败时清理已持有的直接子进程。
- Windows 已登录 IDE 真实查询 Hub，并以 DeepSeek v4.1 Flash 原生子代理派发 MiMo；远端答案 `45`，IDE 后续结果查询受宿主权限限制。Linux CodeArts 显式 GLM-5.2 返回 `51`；部署修复后新单次任务返回 `52`，核验组归属与进程回收。此前超时保留为失败。详情见 [IDE 优先适配与实测](docs/codearts-ide-followup.md)。
- 最终 Windows 32/32 组、Linux 29/29 组回归通过，两端真实 SDK 0.1.21 协议验证通过。Linux 已同步 27 个源码文件和 CodeArts 原生组件；6 份受保护配置与 355 个旧任务结果逐字节校验未变。
- 本轮修改属于 v0.9.9 发布后的跟进，既有标签和安装包保持原版本内容。

## [0.9.9] - 2026-10-09

Hub、安装包、共享 MCP 和 Codex / ZCode / CodeArts / Antigravity 插件统一为 0.9.9；DSH 独立包为 1.4.0。Windows 32/32 组、Linux 29/29 组全量回归通过，后续修复通过对应增量验证并同步 Linux Hub；原生客户端实测及账号限制见 [0.9.9 交付记录](docs/release-0.9.9.md)。

### Antigravity 原生客户端与 SDK 子代理

- 新增第五种原生客户端 Antigravity：按桌面 2.21.1 的插件规范提供 manifest、SVG、九个 `agents/*.md` 路由子代理、四个 slash workflow skills 与独立 MCP 桥。沿用现有九种 worker，插件可连接独立的 Windows/Linux Hub。
- 新增原生目录安装器及一键安装包入口，支持自动发现、外部连接文件、幂等升级、归属哈希、冲突保留、备份及失败回滚；新目录需要重启宿主发现，文件安装不冒充宿主已加载。SDK 运行环境不会进入插件包。
- 增加可选 `google-antigravity==0.1.21` 适配，使用官方 `LocalAgentConfig`、`SubagentConfig`、MCP 与 Hooks，由 Python 有界编排 SDK 子代理。官方 Windows 轮子实测不含仓库示例中的 `beta.run_workflow`，按实际已发布能力实现；SDK 认证与桌面登录分开。
- Hub 为同步及异步 CLI 任务传入真实 worker 身份，六份 MCP 桥统一阻止 worker 派发给自身，同时保留普通客户端、跨 worker 派发和原 ref 查询。
- 修复 Windows venv Python 启动 Hub 时监听 PID 位于子解释器而被误判启动失败的问题；健康检查验证真实后代归属，停止按创建时间与固定进程实例筛选，不误停旧 PPID 外来进程，停止失败保留记录并返回失败。Linux 发现测试隔离已有 Hub，避免把正常发现的生产服务当成失败。
- 修复 Linux agy CLI 1.3.1 的 print 超时被误报成功：即使退出码为 0、JSON 为 `SUCCESS` 且已有部分文字，检测到官方明确的未完成诊断仍返回失败并保留原 ref。同步与异步均覆盖，异步有界扫描完整 stderr，避免后续长日志掩盖诊断；两端各 83 项增量检查通过，修复已同步 Linux 服务。
- Antigravity 接入阶段先保留当时的 README，独立说明和验收边界写入 `integrations/antigravity` 与 `docs/antigravity-compatibility.md`。0.9.9 的 README 更新和 Linux 原生验收另行记录，不改写这一阶段的报告。
- 接入阶段最终 Windows 32 组、Linux 29 组回归全部通过，两端测试源码哈希一致；保留初始失败及修复记录。Windows 原生组件已安装，新增桥跨机器真实 MiMo 默认任务返回 42；宿主模型自主调用和缺少独立 API 认证的 SDK 推理未验收。基础版本 0.9.0 的三种 ZIP 是未发布预览包；0.9.9 的回归与包校验使用新的独立报告。

### 发布与部署

- 安装包提供五种客户端与现有九种 worker；客户端、Hub 与可选 SDK 保持独立组件。SDK 源码随插件包分发，虚拟环境、认证文件、私有连接和模型会话不进入包。
- Windows Codex、ZCode 与 Linux ZCode、Antigravity 的真实原生子代理派发通过，宿主工具记录与 Hub 回执匹配。Windows DSH 受 402 额度限制，Linux 未安装 Codex / DSH，Windows Antigravity 桌面重启后的自主调用待验证，各项单独记录。
- Linux 生产 Hub 0.9.9 的 24 工具、9 worker、鉴权和历史结果检查通过，既有私有配置逐字节保持，每次切换前提供回滚备份。README 和两张 SVG 由 Linux agy 实际修改后核对事实与排版。
- 修复 CodeArts 官方两列模型列表及短模型 ID 的解析，两端各 22 项回归通过。9router 鉴权有效，但不能替代 CodeArts 独立身份及模型权限初始化；真实模型仍受认证阻止，尝试后的三份私有配置已恢复，未计为模型验收成功。

---

## [0.9.1] - 2026-10-09

### 文档与架构规范 / Documentation & Architecture

- **更新两张 README SVG 至 0.9**：结构图置于页面最前，完整展示多客户端、九种 worker、插件与 Hub 独立部署及跨机连接。进度图突出“优化体验”，展示已有能力、后续优化和真实验收边界。
- **统一项目正式展示名称为 `multi-agent-hub`**：README、两张 SVG、控制台标题、原生插件展示信息与相关说明保持一致。既有安装目录、连接配置位置及插件 ID 保留兼容。
- **历史路线补齐与说明规范**：更新 0.5–0.8 路线 SVG，清晰标注各阶段验收范围。

---

## [0.9.0] - 2026-10-09

### 华为 CodeArts 双向接入与第九种 Worker 适配 (`codearts`)

- **增加华为 CodeArts 第九种 worker**：支持 Windows IDE 内置 AgentKernel 与 Linux 官方 CLI 的自动发现、独立任务、模型目录校验和严格结果判定。
- **原生插件体系构建**：增加 CodeArts 原生 Hooks 插件、九个子代理、三个命令、调度技能与独立 MCP；分别适配 IDE `mcpServers` 和 CLI `mcp` 配置。
- **多端路由打通**：Codex、ZCode、DSH 增加 CodeArts 路由；四种客户端共用任务和结果协议，可连接另一台 Windows/Linux Hub。
- **全链路回归验证**：Windows 全量 26 组回归通过，Linux 六组增量和同步后的驱动测试通过。

---

## [0.8.0] - 2026-10-09

### 自动发现与连接选择

- 首次插件安装先扫描本机和局域网 Hub，展示候选让用户选择；没找到时提示手动地址。保留已有连接，非交互安装不会等待输入或静默选择服务器。
- 新增 connect.cmd / connect.sh，支持重新扫描、手动地址和切换；交互配对使用 token 文件或隐藏输入，健康检查与鉴权通过后原子保存外部连接文件。旧配置先私有备份，切换端点不复用另一端 token。
- 新增只读 hub_discover MCP 工具与 ZCode /hub-discover 命令；未配置或连接文件损坏时仍能加载发现工具，任务派发明确拒绝并提示设置连接。
- 修复配置只有 token、没有 URL 时可能回退本机的问题；读取私有配置必须有明确端点，空对象和 token-only 均拒绝派发。
- 实机发现并修复 Windows UDP 10054：本机没有响应导致的单个端口不可达不再结束整次扫描，仍接收其他机器的回复。Windows 两种客户端已通过默认广播自动找到 Linux Hub。
- Hub 新增有界 UDP 发现响应与公开健康元数据；扫描只发送随机查询标识，地址取自回复来源并验证 HTTP 健康，不发送凭据、不跟随重定向、不自动修改防火墙。不支持广播的网络与旧 Hub 保留手动连接。
- Codex/ZCode/MCP 和安装包升至 0.8.0，DSH 包升至 1.2.0；保留原 0.7.0 发布包与分阶段源码备份。
- 最终 Windows 21/21 组、Linux 19/19 组回归通过，测试期间与测试后源码哈希一致；真实默认广播及显式 IP 验证 8/8 通过，详细范围与安装包哈希见 docs/release-0.8.md。
- 正式三个 ZIP 在真实 Linux 安装与配对 54/54 项通过，覆盖非交互待配置、安装后 connect.sh 鉴权配对、三份原生 MCP 副本的 7 工具与只读发现；无新增模型调用。

### 交付记录

- 按 0.5 → 0.6 → 0.7 → 0.8 的独立源码检查点逐版提交与打标签；日期采用实际 Git 发布日，测试记录保留原日期。
- 记录测试 CLI 清理结果：Linux 临时 CodeBuddy 副本已卸载；Windows 8 个临时目标被自动审批拒绝，仍保留，不记作卸载成功。原有客户端和登录配置保持不变。

---

## [0.7.0] - 2026-10-09

### 能力约束与独立部署

- 分开提供 hub / plugins / both 三种可安装 ZIP，Windows / Linux 自动检测运行时与官方 CLI；应用、私有连接配置和运行数据分离。Hub 默认单独运行，控制台可选，客户端不会启动本地 Hub；重复安装保留配置并备份旧应用。
- 四份 MCP 桥统一读取外部 client.json；支持标准 Windows/XDG 路径和显式配置路径，保留 Codex PLUGIN_DATA 兼容。切换 Hub 端点不复用其他端点 token；DSH 不再以默认 localhost/空 token 覆盖配置文件。Codex/ZCode/MCP 版本 0.7.0，DSH 包从 1.0.0 升至 1.1.0。
- 能力查询升级到按 Hub 系统、worker、型号返回可用性。控制台删除没有对应官方参数的伪思考强度/上下文档位；动态禁用不支持的思考、流式和附件，Auto 与各派发入口使用相同服务端预检。
- 最近认证、区域、额度和型号错误使用有期限的结构化状态；手动清除状态不自动调用模型，偶发超时/空答不永久封禁 worker。
- 修复 worker 只存在于 profile 自定义 PATH 时预检误报缺失的问题；预检和派发统一继承环境与变量展开，Windows/Linux 真实临时入口均有回归覆盖。
- 修复 CodeBuddy 继承 lastUsed 代理模式后缺少 Read、只返回未执行 DSML 的根因；使用标准代理和明确的文件工具授权，Linux 图文任务已重新验证。思考与附件能力继续受所选型号限制。
- Windows Hub/Trae HTTP 使用独占端口绑定，避免同端口多个进程共监听导致健康检查误判；Linux 保留正常的地址复用行为。
- 修复原生安装的实际路径与缓存问题：创建隔离 Codex home，ZCode 使用安装副本的绝对目录 source，并通过官方保留数据重装刷新自有插件缓存；DSH 固定 Node 入口与外部连接文件。保留既有插件数据、禁用状态和其他插件。
- Linux 用户服务按安装目录派生独立 unit 并验证归属，启停与升级统一经过 systemctl；不支持的 systemd + console 组合提前拒绝。实机生命周期 18/18 检查通过。
- 支持插件跨 Windows/Linux 连接远端 Hub。新增实际双向网络探针：Windows→Linux 直连图文任务通过；当前 Linux→Windows 直连端口不可达，显式 SSH 反向转发后的图文任务通过。报告区分两种通道，没有把转发结果计成直连成功。
- 重写 README 的安装、服务端/客户端分工与数据流说明：请求和附件仍可能发送到模型服务商，自托管不等于模型离线或保证不泄露。详见 docs/release-0.7.md。
- 最终完整回归 Windows 19/19 组、Linux 17/17 组通过，期间源码哈希未变；正式三 ZIP 在真实 Linux 解压安装验收 43/43 通过。产物清单、SHA256、组件隔离和凭据模式审计均通过；账号授权、余额、区域、模型目录与直接网络不可达等外部限制保留为未通过。

---

## [0.6.0] - 2026-10-09

### 新增 / Added

- Codex 本地插件适配：共享 MCP 桥、8 个项目子代理 TOML 模板、并行调研/实施审查/多模型会诊技能，以及隔离安装预览。
- DSH 子代理与工作流适配：Cordis bundle、三个原生 `agent`/`parallel` 工作流和直接调用 Hub 的确定性 Node runner。
- 任务状态、文件锁、MCP、控制台、安装器与工作流的回归用例；测试采用隔离配置与 mock Hub，不重复消耗厂商模型额度。

### 修复 / Fixed

- MCP 桥正确识别同步 `exit=0` 成功和非零退出；空输出不再自动重复派发。派发断网返回 `unknown`，查询断网保留 ref，等待预算覆盖派发过程。
- 合并 MCP 多个文本块，检查 HTTP/JSON-RPC/tool `isError`，验证请求、参数及返回 ID；通知不触发工具执行。
- 任务仅允许认领者完成；统一 worker 别名并正确解析字符串 `false`。邮箱每次仅标记实际返回的 50 条消息，保留剩余未读。
- 状态锁改为有界的操作系统文件锁；Hub 与 worker 共享原子结果更新，避免并发丢失字段、旧快照回收新进度及进度覆盖终态。外部 ref/邮箱名称限制在状态目录内。
- Windows npm shim 使用子进程 PATH 并解析官方入口；相对脚本路径在切换工作目录前固定。进程组/Job Object、ConPTY、读流和登录取消统一回收。
- 异步 CLI 结果保留真正的 worker 名称与任务上下文；后台等待线程及时回收已结束的执行器。
- Trae HTTP 请求使用可终止的独立进程，GUI 与 CLI 使用有效的执行超时；ZCode 非零退出返回错误。Trae 非终态响应不再伪装为完成。
- Trae 独立 MCP 复用总线运行时与 HTTP 修复，通知返回明确空正文长度，支持异步 ref 查询及 Authorization 预检。
- 控制台预先占用正在发送的会话，拒绝无效显式会话 ID，按任务 ID 归属回信；重启后继续查询 pending ref，静态目录定位到实际 console/client。
- 控制台检查 Hub 返回的 JSON-RPC 与工具结果格式，仅从有效受理回执提取 ref；MCP 通知不执行工具，避免正文中的 ref 示例及无 ID 请求触发错误任务状态或派发。
- DSH patch 使用官方 `insert` 格式，避免 bundle/profile 双注册；安装器严格选择 profile，保留用户 persona、环境、URL 与 token。原生工作流校验结构化终态，子代理失败不再算成功。
- 控制台独立启动脚本改为当前仓库路径与环境配置；文档修正桌面驱动原生 WebSocket 需要 Node.js 22+（MCP 桥仍为 20+）。
- Windows 启停器加载 .env、使用 Windows worker 模板、检测可用 Python 和真实服务健康，只停止本目录记录且创建时间匹配的进程。Unix 停止脚本移除全局 pkill，改为核对本目录进程记录。

### 第二轮跨平台重构 / Cross-platform refactor (0.6.0)

- 统一任务契约：`model`、`thinking`、`stream`、附件；新增 `hub_capabilities` 和结构化 `hub_result_json`，四份 MCP 桥同步到 0.6.0。
- Windows 到 Linux 的附件按字节传输，Hub 在任务专属目录暂存并清理；最多 8 个文件、合计 1 MiB。拒绝路径穿越、无效 base64、凭据文件和不支持的组合。
- CodeBuddy / MiMo 使用实际 provider 思考开关；默认 Copilot auto 拒绝显式高思考，MiniMax M3.1 总是思考，明确区分不支持与成功。流式通过 MCP progress token 发送正文进度，非流式缓冲结果。
- 修复重复 `--format` 等标量参数使 MiMo 回退文本、思考混入答案的问题；保留已有 settings 权限字段，并支持 Antigravity 将选项放在提示词之前。
- 统一官方 CLI 输出解析，过滤推理与工具内容；识别 exit=0 的官方错误、401 登录失败和空回答，保留长答案和安全用量计数。失败不自动重派。
- 默认模型按指定表更新；MiMo 改为 `xiaomi/mimo-v2.6-flash`（`26f` / `v2.6f`）。控制台优先采用 Hub 配置默认值，修复旧目录将 9router/MiniMax M3 显示为默认及仅有模型目录就被自动派发的问题。
- Linux 启停器使用 `/proc` 进程身份和监听归属检查、原子记录和失败回收；修复 CRLF、旧 PID/端口误判及 `.env` 被当 shell 执行的问题。保留已有部署和账号配置。
- Hub 支持外部 `HUB_AGENTS_FILE` / `HUB_STATE_DIR` / `HUB_RESULTS_DIR`，Windows 启动器正确使用外部 worker 配置。移除结果目录自动串入历史部署的回退。
- 修复 Codex 原生插件环境过滤导致 Hub URL 丢失，支持外部 `PLUGIN_DATA/agenthub.json`；原生代理模板与 DSH 工作流传递思考、流式及附件选项。
- MiniMax 图片和文本文件转换为官方消息文件，替换原文本参数，避免重复发送；思考关闭与本地文件编辑仍明确不支持。
- Windows 结果读取对短暂共享冲突重试；损坏结果不能被当作不存在而覆盖，保护任务身份和上下文。
- 异步 CLI 分离 stdout / stderr，修复 MiniMax 流式答案和进度混入 spinner、`Response:` 状态提示；仅失败时附有界诊断。
- ZCode 新增官方 app-server 适配器，校验模型目录和会话实际型号后只发送一次任务；缺少指定 GLM 时拒绝，不静默回退。旧的无模型切换通道不能再用配置默认值伪装实际模型；隔离会话、正文流与超时回收有协议回归。
- 修复 Windows HTTP 拒绝请求后立即关闭未读正文造成 TCP 重置、客户端收不到 401 的竞态；先刷新错误响应，再有界丢弃请求体，不执行未授权工具。
- 控制台上传使用唯一文件名并读取实际上传字节；修复真实邮箱分页标题解析。消息/队列不再静默吞掉附件和思考选项。
- 新增源码阶段备份与 SHA-256 校验、当前树和 Git 历史密钥模式扫描。备份位于仓库外，排除运行数据和凭据文件；实际 Hub HTTP 请求使用 Authorization 头。

### 验证边界 / Validation scope

- Windows 隔离回归、真实 Ubuntu Linux 回归、Windows 控制 Linux 的实际任务，以及 Codex/ZCode/DSH 原生加载分别记录。详细结果见 `docs/compatibility-2026-10-08.md`，机器报告保留每次调用的实际通过、失败和前置阻塞。
- Codex、ZCode 已经由原生子代理派发真实任务，包含图片与文本附件。DSH 原生 MCP/预设被发现，实际子代理调用受官方账号余额限制；宿主退出码不代替 worker 结果验证。
- CodeBuddy 国内版和 MiMo 完成 Windows 16 组合实跑；MiMo 出现退出 0 空回答的失败，不能宣称全通过。国际版后续认证失败、Antigravity 地区限制、Trae SSO/网关、Linux MiMo26 凭据无效等均保留为明确限制。
- 未安装/未授权的 Linux 原生宿主、缺乏可验证模型开关的通道不记作通过。macOS 未实测，当前服务启动器只支持 Windows/Linux。
- 源码来自已验证的 stage06 检查点；验证没有替换用户日常客户端配置，源码不携带个人密钥。

---

## [0.5.0] - 2026-10-09

本标签恢复 2026-10-08 的 stage01 源码检查点。该备份已包含标为 0.6.0 的 Codex 适配初稿；保留原始代码与组件版本，不声称它是当时单独打包的正式 0.5.0 安装版。

### 新增 / Added

- `hub_login` 和 `/hub-login` 获取官方 CLI 授权链接、查询登录状态或取消等待；凭据由官方 CLI 留在 Hub 宿主机。
- Windows worker 配置模板及 8 worker 兼容性实测记录。CodeBuddy 国际/国内版账号目录隔离；MiniMax 使用实测模型，MiMo 默认 `xiaomi/mimo-v2.6-flash`（`v2.6f`）。
- Windows ConPTY 登录与 Job Object 子进程管理；MiMo 自动获取官方链接，未验证链接登录的通道返回人工操作指引。

### 此检查点包含的后续适配初稿


### 新增 / Added

- Codex 本地插件适配：共享 MCP 桥、8 个项目子代理 TOML 模板、并行调研/实施审查/多模型会诊技能，以及隔离安装预览。
- DSH 子代理与工作流适配：Cordis bundle、三个原生 `agent`/`parallel` 工作流和直接调用 Hub 的确定性 Node runner。
- 任务状态、文件锁、MCP、控制台、安装器与工作流的回归用例；测试采用隔离配置与 mock Hub，不重复消耗厂商模型额度。

### 修复 / Fixed

- MCP 桥正确识别同步 `exit=0` 成功和非零退出；空输出不再自动重复派发。派发断网返回 `unknown`，查询断网保留 ref，等待预算覆盖派发过程。
- 合并 MCP 多个文本块，检查 HTTP/JSON-RPC/tool `isError`，验证请求、参数及返回 ID；通知不触发工具执行。
- 任务仅允许认领者完成；统一 worker 别名并正确解析字符串 `false`。邮箱每次仅标记实际返回的 50 条消息，保留剩余未读。
- 状态锁改为有界的操作系统文件锁；Hub 与 worker 共享原子结果更新，避免并发丢失字段、旧快照回收新进度及进度覆盖终态。外部 ref/邮箱名称限制在状态目录内。
- Windows npm shim 使用子进程 PATH 并解析官方入口；相对脚本路径在切换工作目录前固定。进程组/Job Object、ConPTY、读流和登录取消统一回收。
- 异步 CLI 结果保留真正的 worker 名称与任务上下文；后台等待线程及时回收已结束的执行器。
- Trae HTTP 请求使用可终止的独立进程，GUI 与 CLI 使用有效的执行超时；ZCode 非零退出返回错误。Trae 非终态响应不再伪装为完成。
- Trae 独立 MCP 复用总线运行时与 HTTP 修复，通知返回明确空正文长度，支持异步 ref 查询及 Authorization 预检。
- 控制台预先占用正在发送的会话，拒绝无效显式会话 ID，按任务 ID 归属回信；重启后继续查询 pending ref，静态目录定位到实际 console/client。
- 控制台检查 Hub 返回的 JSON-RPC 与工具结果格式，仅从有效受理回执提取 ref；MCP 通知不执行工具，避免正文中的 ref 示例及无 ID 请求触发错误任务状态或派发。
- DSH patch 使用官方 `insert` 格式，避免 bundle/profile 双注册；安装器严格选择 profile，保留用户 persona、环境、URL 与 token。原生工作流校验结构化终态，子代理失败不再算成功。
- 控制台独立启动脚本改为当前仓库路径与环境配置；文档修正桌面驱动原生 WebSocket 需要 Node.js 22+（MCP 桥仍为 20+）。
- Windows 启停器加载 .env、使用 Windows worker 模板、检测可用 Python 和真实服务健康，只停止本目录记录且创建时间匹配的进程。Unix 停止脚本移除全局 pkill，改为核对本目录进程记录。

### 验证边界 / Validation scope

- Windows 隔离回归共 11 组通过，结果与源码 SHA-256 保存于 `docs/refactor-validation.json`；Codex 两种插件入口已用本机 CLI 在临时目录验证加载与 MCP 初始化。
- 本轮验证源码与隔离运行行为；Codex/DSH 适配尚未装入用户正在使用的客户端，未验证宿主内真实模型工作流。
- Windows 厂商兼容性结果保留于 `docs/windows-compatibility.md`：6 个 CLI 完成真实调用；Antigravity 受地区限制，Trae 桌面网关未就绪。此次未重新调用厂商模型。
- Unix 行为采用契约测试/语法检查，未作为 Linux 或 macOS 实机验证。

---

## [0.4.0] - 2026-10-07

### 发展路线图与生态规划 / Roadmap & Ecosystem
- **更新官方发展路线图矢量图 (`docs/roadmap.svg`)**：
  - 清晰标注系统演进 6 大阶段（Phase 1~3 已就绪、Phase 4 积极适配中、Phase 5 暂缓搁置·排在 DSH 后推进、Phase 6 规划中）；
  - 核心明确：优先做好 Windows 本地开箱即用体验（Windows-First），全力攻坚 DeepSeek Harness (DSH) 原生生态；Linux 复杂服务化启动暂时搁置，排在 DSH 适配之后、Codex 适配之前集中重构。
- **开源跨平台解耦与极简按需配置支持 / Cross-Platform Decoupling & Minimal Setup**：
  - 彻底清除历史硬编码路径与特定系统解释器路径（`/usr/bin/python3`、`/usr/bin/node`、`~/agent-hub`、`~/TraeClaw`），全面切换为动态自包含解析与 `sys.executable`；
  - 优化 Windows 与 Unix 跨平台异步进程组生命周期管理，避免僵尸进程；
  - 增强 TraeClaw 网关异常捕获与友好降级提示，杜绝未启动网关时崩溃抛错；
  - 提供 `hub/agents.minimal.example.json` 极简模板，支持仅配置 MiniMax 与 Trae 等任意 1~2 个 Agent 的轻量环境，未安装的 Agent 完全零干扰。
- **深度完善 ZCode 官方插件与工作流集成 (`agenthub-workers`)**：
  - 完善 8 大子智能体原生注册与自然语言缩写自动路由映射；
  - 借助 `hub-bridge` MCP（`hub_ask`、`hub_dispatch`、`hub_fetch`）彻底破除工作流 30 秒超时上限；
  - 坚决保障所有交付物免服务器单文件直接双击运行。
- **DeepSeek Harness (DSH) 原生生态积极适配推进中 / DSH Active Adaptation**：
  - 在 `integrations/dsh/` 提供 Cordis 微内核架构原生子代理预设（Presets）与工作流（Workflows）工程化源码；
  - 当前全面开展 Cordis 多 Profile 环境隔离与平滑注入测试。
- **规划 Codex 生态打通 (Phase 5 / Planned)**：
  - 规划跨平台双向智能体总线与流式上下文集成。

### 重构与升级 / Major Refactor & Upgrade
- **项目正式升级为 Multi-Agent Hub（`multi-agent-hub`）**：
  - 品牌与架构由分散组件全面进化为“一站式多智能体调度与协作总线”。
  - 提供根目录一键启动与停止工具（`start.sh` / `stop.sh`、`start.bat` / `stop.bat`），单命令并发拉起任务总线、Web 控制台并完成健康检查。
  - 统一根目录 `.env.example` 配置中心，集中管理总线端口、Web 控制台及认证 Token，告别多级子目录割裂配置。
  - Web 控制台全面更名与视觉升格为 `Multi-Agent Hub`。
  - 手机端竖屏排版重构：解决超窄屏下顶部 Header 与工具栏按钮被截断问题，全部操作项 100% 完整可见。

---

## [0.3.2] - 2026-10-07

### 新增 / Added
- **手机浏览器竖屏全响应式支持 / Mobile Vertical Responsive Layout**：
  - 活动栏自适应下沉为原生移动端底部导航栏（Bottom Navigation Bar），带大触控热区与全面屏安全区适配。
  - 顶部栏紧凑收纳（48px 单行），去除冗余副标题，防止小屏挤爆高度。
  - 对话视窗全面中置（860px 舒适阅读柱状区），己方对话右侧锚定、长度由右向左自适应收缩，最大宽度控制在 540px。
- **思维链自动折叠 / Auto-collapsible Reasoning & Thinking**：
  - 自动识别 `<think>` 标签、````thought```` 代码块及后端 `reasoning` 字段。
  - 默认暗调卡片折叠展示，支持一键展开/收起；无思考过程的消息不展示任何多余折叠按钮。
- **工作流 MCP 桥接（hub-bridge）/ Workflow MCP Bridge**：
  - 提供 `hub_ask`（阻塞式单调用出结果）、`hub_dispatch`（秒回 ref）和 `hub_fetch`（状态轮询），彻底解决工作流子代理 30s 框架调用上限问题。
  - 提供配套独立 CLI 脚本 `mcp/ask.mjs`，方便脚本与自动化管线直接调用。

### 修复 / Fixed
- **MiMoCode 非 AVX2 崩溃兼容 / MiMoCode Non-AVX2 Core Dump Fix**：
  - 自动回退至 baseline 版二进制，解决 Intel N5095（Jasper Lake）等老旧 x86 架构无 AVX2 指令集导致 SIGILL 静默无输出的问题。
  - 增加 `--pure` 选项解除外部插件循环递归，配合 9Router 解决上游 SSE 空轮次截断问题。
- **SVG 图标命名空间隔离 / SVG Unique ID Scoping**：
  - 为动态插入的品牌 SVG 注入实例唯一 ID 后缀（uid），根治多个相同 SVG 重复定义导致 `mask` / `linearGradient` 引用失效的渲染黑块问题。
- **界面排版去杂 / UI Clutter Cleanup**：
  - 子代理页面隐藏底层开发调试参数（CLI 路径、model_arg、心跳提示等），移除顶部冗余 KPI 空白卡片。
  - 右侧边栏多余的 `«` 浮动把手彻底移除，统一由常驻“工作台”按钮控制展开与收起。
  - 模态框增加“恢复默认”快捷按钮，方便一键重置自定义头像。

---

## [0.3.0] - 2026-10-06

### 新增 / Added
- **多通道并发调度工作流 / Multi-agent Fanout Workflow**：
  - 推出全局工作流 `hub-fanout`，支持跨多代理并发分发、结果阻塞汇总与统一报表输出。
- **无头模式防封体系 / Ban-free Headless Architecture**：
  - 采用各家官方 CLI 的无头参数（`-p` / `text chat`）与本地 CDP 桌面驱动，杜绝逆向反代与非官方 API 封号风险。

---

## [0.2.0] - 2026-10-06

### 变更 / Changed
- **8 大代理规范化命名体系 / Standardized 8-Agent Registry**：
  - 统一收敛为标准规范名：`zcode`、`antigravity`、`codebuddy`、`codebuddy-cn`、`mimocode`、`github-copilot`、`minimaxcode`、`traecode`。
  - 枢纽内置双向别名自动归一（支持 agy, cb, cbcn, mimo, gcp, mmx, trae 简写）。

---

## [0.1.0] - 2026-10-05

### 新增 / Added
- 初始版本发布：
  - `hub/agent_hub.py`：基于 JSON-RPC MCP over HTTP 的任务总线。
  - `console/server.mjs`：CodeBuddy 风格三栏 Web 控制台。
  - `drivers/*.js`：基于 CDP 驱动 VNC 桌面 AI（ZCode, TraeCode）执行管线。
