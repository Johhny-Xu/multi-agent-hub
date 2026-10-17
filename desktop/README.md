# 桌面客户端（Electron + electron-builder）

把 `console/` 那套 WebUI 包成 Windows 独立窗口应用：双击出窗口，**不经过浏览器**，终端用户机器上也不需要装 Node.js。

## 产物

| 文件 | 说明 |
|---|---|
| `dist/MultiAgentHub-Setup-1.0.0.exe` | NSIS 安装包（约 76 MB），可选安装目录、建桌面/开始菜单快捷方式 |
| `dist/MultiAgentHub-Portable-1.0.0.exe` | 免安装单文件（约 75 MB），双击即用 |
| `dist/win-unpacked/` | 未压缩目录，调试用 |

安装后磁盘占用约 180–220 MB，主要是 Chromium 内核。

## 构建（Windows）

```powershell
cd desktop
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm install
npm run dist          # = electron-builder --win，出 nsis + portable
npm run pack          # 只出 win-unpacked，调试快
```

首次构建会下载 Electron 31.7.7（约 111 MB）与 NSIS 工具链；两个镜像变量是国内网络下必备，否则会卡在 GitHub。

> 如果是在带 `ELECTRON_RUN_AS_NODE=1` 的终端里调试（某些 IDE / 自动化环境会注入），必须先去掉它，否则 Electron 会当纯 Node 跑，`require('electron').app` 是 `undefined`：
> `env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron.cmd .`

## 运行时架构

```
MultiAgentHub.exe (Electron 主进程)
  └─ utilityProcess.fork(server-runner.mjs)   ← Electron 自带 Node，用户无需装 Node
       └─ import console/server.mjs 的 start(context)
            └─ HTTP 127.0.0.1:<port>  ← BrowserWindow.loadURL(/dashboard)
```

- **端口自适应**：从 8890 起探测，被占用就往上找（最多 100 个）。
- **就绪后才开窗**：主进程轮询 `/dashboard`，200 才 `show()`，避免白屏。
  注意 `/health` 只存在于**子代理端口**（默认 8790），主端口是 404——早期版本按 `/health` 探活会一直等不到。
- **单实例锁**：重复双击会唤醒并置顶已有窗口，不会起第二个后端。
- **崩溃自愈**：后端子进程异常退出自动重启 1 次，仍失败则弹窗并退出。
- **退出清理**：`before-quit` / `will-quit` 发 IPC 通知后端优雅退出，超时再 `kill`。
- **数据目录**：`%APPDATA%\multi-agent-hub-desktop\data`，升级重装不丢。

## 两个坑（已处理）

1. **`console/` 不在本目录**。`build.extraResources` 从 `../console` 拷贝到 `resources/console`，打包后主进程按 `process.resourcesPath` 定位。别在 `desktop/` 里再放一份副本，否则两处会漂移。
2. **GPU 兜底**。部分环境（虚拟机、远程桌面、无独显的服务器会话、个别驱动）会让 GPU 进程反复崩溃（`0xC0000005`），Electron 随后以 `GPU process isn't usable. Goodbye.` 直接退出。主进程默认关掉硬件加速并追加 `--disable-gpu`；需要硬件加速时设 `HUBCONSOLE_GPU=1`。

## 图标

`assets/icon.png` 是 256×256 源图，`assets/icon.ico` 由它生成（单条目 256×256 PNG 载荷）。electron-builder 要求 ico 至少 256×256，换图标时两个文件都要更新：

```python
import struct
png = open('icon.png','rb').read()
hdr = struct.pack('<HHH', 0, 1, 1)
entry = struct.pack('<BBBBHHII', 0,0,0,0, 1, 32, len(png), 22)
open('icon.ico','wb').write(hdr + entry + png)
```

## 实测记录（2026-10-18）

- 打包产物：`Setup` 76 MB / `Portable` 75 MB，`resources/console` 1.1 MB。
- 启动：后端 732 ms 就绪，`/dashboard` 200（619,926 B），窗口标题 `multi-agent-hub`。
- 关闭窗口后 8890 端口立即释放，无残留子进程。
