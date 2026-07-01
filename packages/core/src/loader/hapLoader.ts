/**
 * HarmonyOS .hap loader（向后兼容包装层）。
 *
 * 历史上 `openHap` 是核心层对外的 loader 入口。重组后真正的实现挪到了 zipPackage.ts，
 * 这里保留同名导出供老调用方继续使用；新代码请用 `openPackage(file, platform)` 或
 * `openZipPackage(file)`。
 */

import { openZipPackage } from './zipPackage.js';

export const openHap = openZipPackage;
