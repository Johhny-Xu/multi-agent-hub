# 模型实测矩阵（1.0.14）

2026-10-19 在 n5095 上对控制台 `modelCatalog` 声明的每个模型逐个真实派发，验证的不只是「能不能连上」，而是「回的答案对不对」。

- 题目：`计算 13*7 的结果，只输出阿拉伯数字，不要任何汉字、标点或解释。`
- 判定：回答中出现 `91` 记为通过
- 超时：单模型 170s；一次派发失败不重试
- 方式：`hub_dispatch_cli`（traecode 走 `trae_delegate`）→ 轮询 `hub_result`

## 总计

| 结果 | 数量 |
| --- | --- |
| 通过 | 55 |
| 不适用 | 19 |
| 失败 | 10 |
| 合计 | 84 |

不适用全部来自 traecode：`_check_gui_options` 明确拒绝非默认模型，这是 GUI 通道的设计约束，不是缺陷。

## 逐模型明细

### codebuddy（10/17 通过）

| 模型 | 结果 | 耗时 | 说明 |
| --- | --- | --- | --- |
| `default-model` | 通过 | 12s | 返回 `91` |
| `fast-model` | 通过 | 12s | 返回 `91` |
| `balanced-model` | 通过 | 9s | 返回 `91` |
| `primary-model` | 失败 | 9s | 400 model [primary-model] is not allowed for user type [personal_free_user] (01a1502bce… |
| `hy4-preview` | 通过 | 12s | 返回 `91` |
| `deepseek-v4.1-flash` | 通过 | 12s | 返回 `91` |
| `gpt-6-astra` | 失败 | 12s | 400 model [gpt-6-astra] is not allowed for user type [personal_free_user] (01a1502c5c3e… |
| `gpt-5.6-sol` | 失败 | 9s | 400 model [gpt-5.6-sol] is not allowed for user type [personal_free_user] (01a1502c8277… |
| `gpt-5.6-terra` | 失败 | 9s | 400 model [gpt-5.6-terra] is not allowed for user type [personal_free_user] (01a1502ca8… |
| `gpt-5.6-luna` | 失败 | 9s | 400 model [gpt-5.6-luna] is not allowed for user type [personal_free_user] (01a1502ccf7… |
| `gpt-5.5` | 失败 | 9s | 400 model [gpt-5.5] is not allowed for user type [personal_free_user] (01a1502cef677c71… |
| `glm-5.3` | 通过 | 12s | 返回 `91` |
| `glm-5.2` | 通过 | 12s | 返回 `91` |
| `kimi-k3` | 通过 | 15s | 返回 `91` |
| `kimi-k2.8-preview` | 通过 | 12s | 返回 `91` |
| `grok-4.7` | 失败 | 9s | 400 model [grok-4.7] is not allowed for user type [personal_free_user] (01a1502de24b7cd… |
| `custom-local:trae` | 通过 | 12s | 返回 `91` |

### codebuddy-cn（12/13 通过）

| 模型 | 结果 | 耗时 | 说明 |
| --- | --- | --- | --- |
| `default` | 通过 | 12s | 返回 `91` |
| `deepseek-v4.1-flash` | 通过 | 15s | 返回 `91` |
| `deepseek-v4-pro` | 通过 | 12s | 返回 `91` |
| `minimax-m3` | 通过 | 12s | 返回 `91` |
| `glm-5.3` | 通过 | 15s | 返回 `91` |
| `glm-5.3-flash` | 通过 | 15s | 返回 `91` |
| `glm-5.2` | 通过 | 12s | 返回 `91` |
| `glm-5.1` | 失败 | 12s | 400 the reasoning effort value is not supported by the current model (01a1502cc29e7f29a… |
| `kimi-k3-1` | 通过 | 12s | 返回 `91` |
| `kimi-k2.8-preview` | 通过 | 15s | 返回 `91` |
| `kimi-k2.7` | 通过 | 12s | 返回 `91` |
| `hy4-preview` | 通过 | 15s | 返回 `91` |
| `hunyuan-chat` | 通过 | 12s | 返回 `91` |

### antigravity（6/6 通过）

| 模型 | 结果 | 耗时 | 说明 |
| --- | --- | --- | --- |
| `gemini-3.8-flash-medium` | 通过 | 9s | 返回 `91` |
| `gemini-3.8-flash-high` | 通过 | 9s | 返回 `91` |
| `gemini-3.8-flash-low` | 通过 | 9s | 返回 `91` |
| `claude-sonnet-4-6` | 通过 | 6s | 返回 `91` |
| `claude-opus-4-6-thinking` | 通过 | 9s | 返回 `91` |
| `gpt-oss-120b-medium` | 通过 | 6s | 返回 `91` |

### traecode（1/20 通过）

| 模型 | 结果 | 耗时 | 说明 |
| --- | --- | --- | --- |
| `GLM-5.3-FlashX` | 通过 | 21s | 返回 `91` |
| `glm-5.3-flash` | 不适用 | 0s | GUI 通道无法切换模型（设计约束） |
| `glm-5.3` | 不适用 | 0s | GUI 通道无法切换模型（设计约束） |
| `glm-5.2` | 不适用 | 0s | GUI 通道无法切换模型（设计约束） |
| `MiMo-V2.6-Flash` | 不适用 | 0s | GUI 通道无法切换模型（设计约束） |
| `MiMo-V2.6-Pro` | 不适用 | 0s | GUI 通道无法切换模型（设计约束） |
| `deepseek-v4.1-flash` | 不适用 | 0s | GUI 通道无法切换模型（设计约束） |
| `DeepSeek-V4-Flash` | 不适用 | 0s | GUI 通道无法切换模型（设计约束） |
| `DeepSeek-V4-Pro` | 不适用 | 0s | GUI 通道无法切换模型（设计约束） |
| `qwen3.8-flash` | 不适用 | 0s | GUI 通道无法切换模型（设计约束） |
| `qwen3.8-max` | 不适用 | 0s | GUI 通道无法切换模型（设计约束） |
| `qwen-3.7-plus` | 不适用 | 0s | GUI 通道无法切换模型（设计约束） |
| `Doubao-Seed-Evolving` | 不适用 | 0s | GUI 通道无法切换模型（设计约束） |
| `Doubao-Seed-2.1-Pro` | 不适用 | 0s | GUI 通道无法切换模型（设计约束） |
| `Doubao-Seed-2.1-Turbo` | 不适用 | 0s | GUI 通道无法切换模型（设计约束） |
| `Doubao-Seed-Code` | 不适用 | 0s | GUI 通道无法切换模型（设计约束） |
| `kimi-k3` | 不适用 | 0s | GUI 通道无法切换模型（设计约束） |
| `kimi-k2.8-preview` | 不适用 | 0s | GUI 通道无法切换模型（设计约束） |
| `minimax-m3` | 不适用 | 0s | GUI 通道无法切换模型（设计约束） |
| `step-5-preview` | 不适用 | 0s | GUI 通道无法切换模型（设计约束） |

### mimocode（5/5 通过）

| 模型 | 结果 | 耗时 | 说明 |
| --- | --- | --- | --- |
| `xiaomi/mimo-v2.6-flash` | 通过 | 15s | 返回 `91` |
| `xiaomi/mimo-v2.6-pro` | 通过 | 22s | 返回 `91` |
| `xiaomi/mimo-v2.6-pro-ultraspeed` | 通过 | 12s | 返回 `91` |
| `9router/trae` | 通过 | 18s | 返回 `91` |
| `26f` | 通过 | 18s | 返回 `91` |

### minimaxcode（2/2 通过）

| 模型 | 结果 | 耗时 | 说明 |
| --- | --- | --- | --- |
| `MiniMax-M3` | 通过 | 3s | 返回 `91` |
| `MiniMax-M3.1-Flash-Preview` | 通过 | 3s | 返回 `91` |

### github-copilot（1/1 通过）

| 模型 | 结果 | 耗时 | 说明 |
| --- | --- | --- | --- |
| `auto` | 通过 | 12s | 返回 `91` |

### codearts（5/5 通过）

| 模型 | 结果 | 耗时 | 说明 |
| --- | --- | --- | --- |
| `huaweicloud-maas/glm-5.3` | 通过 | 25s | 返回 `91` |
| `huaweicloud-maas/GLM-5.2` | 通过 | 25s | 返回 `91` |
| `huaweicloud-maas/glm-5.2-sft-harmony` | 通过 | 28s | 返回 `91` |
| `huaweicloud-maas/openpangu-2.0-pro` | 通过 | 28s | 返回 `91` |
| `huaweicloud-maas/openpangu-2.0-flash` | 通过 | 25s | 返回 `91` |

### opencode（9/10 通过）

| 模型 | 结果 | 耗时 | 说明 |
| --- | --- | --- | --- |
| `opencode/deepseek-v4.1-flash-free` | 通过 | 15s | 返回 `91` |
| `opencode/glm-5.3-flash-free` | 通过 | 12s | 返回 `91` |
| `opencode/mimo-v2.6-flash-free` | 通过 | 15s | 返回 `91` |
| `opencode/longcat-2.5-preview-free` | 通过 | 12s | 返回 `91` |
| `opencode/nemotron-3-ultra-free` | 通过 | 15s | 返回 `91` |
| `opencode/nemotron-3.5-lightning-free` | 通过 | 15s | 返回 `91` |
| `opencode/nemotron-3.5-super-vl-free` | 通过 | 9s | 返回 `91` |
| `opencode/space-bunny-free` | 通过 | 9s | 返回 `91` |
| `opencode/beam-free` | 失败 | 9s | This model is not available in your country |
| `opencode/big-pickle` | 通过 | 22s | 返回 `91` |

### cline（4/5 通过）

| 模型 | 结果 | 耗时 | 说明 |
| --- | --- | --- | --- |
| `deepseek/deepseek-v4.1-flash` | 通过 | 12s | 返回 `91` |
| `anthropic/claude-sonnet-5.5` | 通过 | 9s | 返回 `91` |
| `openrouter/free` | 通过 | 9s | 返回 `91` |
| `nvidia/nemotron-3.5-lightning:free` | 超时 | 123s | CLI 任务超时 (>120.0s), 已回收子进程树 |
| `cohere/north-mini-code:free` | 通过 | 9s | 返回 `91` |

## 失败根因与处置

1. **套餐分级限制**（`plan_blocked`）：CLI 认得 model id，但当前账号是 `personal_free_user`。
   `primary-model` / `gpt-6-astra` / `gpt-5.5` / `gpt-5.6-{sol,terra,luna}` / `grok-4.7` 均属此类。
   处置：控制台按 1 小时 TTL 置灰并提示升级套餐；换付费账号即恢复。
2. **模型不存在**（`model_unavailable`）：`codebuddy-cn/glm-5.1` 返回
   `the reasoning effort value is not supported by the current model`；`deep-model` 返回
   `service info not found`。后者已从目录删除，前者由运行时标记置灰。
3. **区域限制**（`region_restricted`）：`opencode/beam-free` 返回
   `This model is not available in your country`，插件不绕过区域限制。
4. **超时**：`cline/nvidia/nemotron-3.5-lightning:free` 本轮 120s 未回；首轮同一模型 15s 通过，
   属排队抖动。超时不进 `BLOCKING`，不会把模型永久判死。

## 本轮修掉的缺陷

| 缺陷 | 现象 | 修复 |
| --- | --- | --- |
| stderr 被丢弃 | 退码 0 + 空 stdout 时只回「CLI 已退出但没有可验证的回答」，14 个失败项里 10 个无法辨因 | 同步/异步两条路径都保留 stderr 末行诊断 |
| 套餐拒绝与模型不存在混为一谈 | 都被记成 `empty_answer`（非阻断），模型永远显示可用并反复失败 | 新增 `plan_blocked` 并进 `BLOCKING` |
| 别名表外的模型无法置灰 | 能力文档只枚举 agents.json 别名值，`primary-model` 等没有条目，只剩「恒可用」兜底 | capability 文档新增 `failures`，`capabilityCatalog` 与 `taskCapability` 都读它 |
| 派发前不拦已判死的模型 | 目录里有、能力文档里没有的模型被无条件 `allowed: true` | 先查 `failures.blocking` |
| 目录 id 写错 | `gemini-3.1-pro-high`（agy 无此模型）、`mimo-v2.6-pro*`（漏 provider 前缀） | 按 `agy models` / `mimo models` 的真实输出纠正 |
