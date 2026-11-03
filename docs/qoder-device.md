# Qoder 设备身份（设备指纹）配置

上游按**设备**下发每日 Credentials 活动：设备身份不对，`campaigns` 会返回空数组，
控制台就显示「活动 0 个 / 未派发」，但同一台机器上的 Qoder 桌面端却能正常签到。

## 关键规则：设备身份按地区隔离

| 地区 | worker | 客户端 / 组件 | UMID `environment` |
|---|---|---|---|
| 国际版 | `qoder` | Qoder / `qodercli` | `4` |
| 中国版 | `qoder-cn` | Qoder CN / `qoderclicn` | `0` |

同一台 Windows 机器上两份指纹**前缀相同、正文不同**（2026-11-03 实测）：

```
国际版  machineToken P1gAGri9W-b1XmclwwhbhL…
        machineCode  3944a47200066faae3
        machineType  2cca32f49157e10942

中国版  machineToken P1gAxveT2ReN04OH1oNjQw…
        machineCode  6c6603d9006166ec9f
        machineType  64e527ea91460d13b4
```

> ⚠️ 2026-11-03 事故就是这里：`device.env` 里只放了一份（中国版）三件套，
> 而变量名是全局的 `QODER_MACHINE_*`，于是国际版账号被喂了中国版指纹 → 活动列表恒空。

## 配置方式

文件：`~/.config/agenthub-qoder/device.env`（权限 `600`，systemd `EnvironmentFile` 加载）

```bash
# 国际版
QODER_INTL_MACHINE_TOKEN=P1gAGri9W-…
QODER_INTL_MACHINE_CODE=3944a47200066faae3
QODER_INTL_MACHINE_TYPE=2cca32f49157e10942

# 中国版
QODER_CN_MACHINE_TOKEN=P1gAxveT2…
QODER_CN_MACHINE_CODE=6c6603d9006166ec9f
QODER_CN_MACHINE_TYPE=64e527ea91460d13b4

# 历史兜底（旧部署/单测用；两个地区都配了就不会命中）
QODER_MACHINE_TOKEN=…
QODER_MACHINE_CODE=…
QODER_MACHINE_TYPE=…
```

优先级：`QODER_INTL_*` / `QODER_CN_*`  >  `QODER_MACHINE_*`。

- 地区级**只填一半**会直接报「三件套不完整」，**不会**静默回落到通用变量
  （半套指纹比没有更难查）。
- 走通用兜底时 `source` 标为 `env:legacy` 并打一条 `console.warn`，
  **不写 note** —— `checkinQoderOne` 把非空 note 当成「设备身份缺失」会停掉补拉。
- 两者都没有时，才回落到本机 UMID 组件现场生成（需要 Qoder 客户端或 `qodercli`）。

## 怎么从本机取这三件套

本机客户端已经把结果缓存下来了，直接读，不用跑组件：

```bash
# Windows（Git Bash） / macOS / Linux
python - <<'PY'
import json, os
for p, label in [('.qoder/umid-cache.json', '国际版'), ('.qoder-cn/umid-cache.json', '中国版')]:
    d = json.load(open(os.path.expanduser('~/' + p), encoding='utf-8'))
    i = d.get('info', {})
    print(f"== {label} environment={d.get('environment')}")
    print('  TOKEN =', i.get('machineToken'))
    print('  CODE  =', i.get('machineCode'))
    print('  TYPE  =', i.get('machineType'))
PY
```

没有缓存时，用参考实现的组件路径参数生成：
`QODER_RUNTIME_INFO`（国际版）/ `QODERCN_RUNTIME_INFO`（中国版）/ `QODER_UMID_PATH`（通用）。

> 设备指纹是**机器级**的（不按账号区分），所以同一地区所有账号共用一份。

## 排查

```bash
cd ~/agent-hub-console
# 看两个地区各自解析到什么身份
node -e "Promise.all([import('./miniapp/node/qoder-device.mjs'), import('node:os')]).then(async ([m, os]) => {
  for (const w of ['qoder', 'qoder-cn']) {
    const d = await m.resolveQoderDevice(w, { home: os.homedir(), uid: '' });
    console.log(w, d.source, (d.risk?.machineToken || '-').slice(0, 12), d.note || '');
  }
})"
```

- `source = env:qoder` / `env:qoder-cn` → 正确，用了地区级三件套
- `source = env:legacy` → 正在用通用兜底，跨地区会出错，把 `QODER_INTL_*` / `QODER_CN_*` 补上
- `note` 非空 → 真的缺身份，签到会停在 `identity_missing`
- 都正常但活动仍为空 → 看诊断串「另有 N 个非领取类活动」：
  那说明上游只下发了升级/展示类（`VIEW_DETAILS`），这个账号本期确实没有每日 Credits
