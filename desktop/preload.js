const { contextBridge, ipcRenderer } = require('electron');

/**
 * 安全预加载脚本 (Preload Script)
 * 遵循最小权限与上下文隔离原则 (Context Isolation)
 * 仅向渲染进程安全暴露必要的基础能力，禁止直接访问 Node.js / Electron 原生底层接口
 */
contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * 获取环境与应用版本信息
   */
  getVersions: () => ({
    app: '1.0.0',
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
  }),

  /**
   * 在系统默认外部浏览器中安全打开指定链接（仅允许 http/https 协议）
   * @param {string} url
   * @returns {Promise<boolean>}
   */
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  /**
   * 窗口控制接口
   */
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
});
