# 对话流去卡片（子代理回复不再有「背景窗」）

2026-11-03。参考实现：`http://192.168.2.29:7454`（CodeBuddy Code Remote Control）
的手机端，用 Playwright 在 iPhone 视口（390×844）读 computedStyle 得到的数字。

## 为什么要改

`styles.css` 历史上叠了三轮气泡样式，最后一轮（`styles.css:8703` 附近）把
`.bubble.agent` 又改回了卡片：

```css
.bubble.agent {
  background: rgba(255, 255, 255, .03) !important;
  border: 1px solid rgba(255, 255, 255, .06) !important;
  border-left: 2px solid <强调色> !important;
  border-radius: 0 12px 12px 0 !important;
}
```

再叠上基类 `.bubble` 的 `box-shadow` 与后置的 `padding: 10px 16px !important`，
每条子代理回复都是一张带左边条的卡片。参考站的做法相反：**只有用户说的话是气泡，
对面回话就是正文流**。

## 参考站实测数字

| 元素 | 参考站（浅色） |
|---|---|
| 页面底色 | `#fefefe` |
| 用户气泡 `.chat-user-bubble` | `#f2f2f2` 底、`1px #e8eaed` 边、圆角 `16px 16px 5px 5px`、`padding 10px 16px`、`15px/24px` |
| 子代理正文 | **零背景、零边框、零阴影、零内边距**，占满整条时间线 |
| 行内代码 | `rgba(243,243,243,.82)` 底、`rgba(232,234,237,.78)` 边、5px 圆角、`padding 2px 5px`、`13px/21px` |
| 回话底部 | 一行小号灰字：复制图标 / 时间 / 消耗 |
| 思考过程 | 透明背景的一行「已思考 · N 次操作」+ 箭头 |

## 落地方式

`console/client/styles.css` 末尾追加「对话流去卡片（2026-11-03 第三批）」覆盖块，
`console/client/app-main.js` 的 `bubbleFor()` 在 `.bfoot` 里补 `.bfoot-meta`。

覆盖块的权重算术（这是唯一容易踩的地方）：

| 规则 | 权重 | 处理 |
|---|---|---|
| `.bubble`（基类） | 0,1,0 | 被 `.bubble.agent` 压过 |
| `.bubble.agent`（8703 行那批，带 `!important`） | 0,2,0 | 末尾同权重 + 更靠后 → 胜 |
| `html[data-theme="light"] .bubble.agent` | 0,3,1 | 末尾另起一条同权重覆盖 |

所以浅色主题必须单独写一条，只压 `.bubble.agent` 是不够的。

## 没有动的东西

- 桌面端 `.bubble.agent` 的 `align-self: center`、`width: 100%`、`max-width: 860px`；
- 用户气泡 `.bubble.user` 的右靠、`max-width: min(70%, 540px)`、渐变底；
- `.bubble.system` 的胶囊；
- `pre` 代码块（含复制按钮）与附件图片/文件徽章。

## 排查命令

```bash
# 线上文件位置
ssh n5095 'ls -la ~/agent-hub-console/miniapp/client/{styles.css,app-main.js}'

# 看某条 agent 消息的计算样式（浏览器控制台）
[...document.querySelectorAll('.bubble.agent')].pop() |> getComputedStyle
# 期望：backgroundColor rgba(0,0,0,0) / borderTopWidth 0px / boxShadow none / borderRadius 0px / padding 0px

# 回滚
ssh n5095 'cp ~/agent-hub-console/backups/20261103-flatbubble/* ~/agent-hub-console/miniapp/client/ && systemctl --user restart agent-hub-console'
```

## 附：这一轮的分工

| 角色 | worker | 交付 |
|---|---|---|
| 大脑 | `codearts` / `k3.1pro` | 实现契约（选择器、权重比较、回归清单 8 条） |
| 力工 | `agy`（antigravity） | 牵连规则审计：「必须处理 / 可忽略」两栏 |
| 力工 | `codebuddy`（国际版） | DOM 锚点补偿清单（bfoot / thinking-box / artifact / 附件） |
| 力工 | `qoder`（国际版，`k31p`） | 深色主题等价映射 |
| 力工 | `traecode` | **无效**：只回「我先读这两个文件」的模板句，两次都没产出结论 |
