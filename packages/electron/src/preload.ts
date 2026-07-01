/**
 * Electron preload：在隔离上下文里向渲染进程暴露最小能力。
 *
 * 当前只暴露一个「桌面端标记 + 版本」，供前端将来区分 desktop / web 形态
 * （例如桌面端才显示「配置本地工程」入口）。刻意保持极小面：真正的能力都在
 * 后端 HTTP API，前端一律走相对路径 fetch，无需 IPC。
 */

import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('__KINGSDK_DESKTOP__', {
  isDesktop: true,
  version: process.env.KINGSDK_VERSION ?? 'unknown',
});
