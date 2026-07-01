/**
 * Loader 入口：按平台 dispatch 到具体 loader 实现。
 *
 * 一期所有平台（HarmonyOS / Android）都走通用 zipPackage；保留 platform 参数是为了：
 *  - 让 caller 显式声明意图，便于日志 / 错误信息
 *  - iOS .ipa 真正落地时（一外层 zip 套一个 .app 目录）可在此分支不影响其它平台
 */

import type { Platform, VirtualPackage } from '@kingsdk/shared/schema.js';
import { DEFAULT_PLATFORM } from '@kingsdk/shared/schema.js';

import { openApk } from './apkLoader.js';
import { openZipPackage } from './zipPackage.js';

export { openHap } from './hapLoader.js';
export { openApk } from './apkLoader.js';
export { openZipPackage } from './zipPackage.js';

export async function openPackage(
  filePath: string,
  platform: Platform = DEFAULT_PLATFORM,
): Promise<VirtualPackage> {
  switch (platform) {
    case 'android':
      return openApk(filePath);
    case 'harmony':
    case 'ios':
    default:
      return openZipPackage(filePath);
  }
}
