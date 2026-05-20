/**
 * Android .apk / .aab loader。
 *
 * APK 与 AAB 都是 zip 容器，底层读取完全可以复用 zipPackage。Android 特有的字段
 * 解析（AndroidManifest.xml 是 binary AXML、resources.arsc 是 binary、DEX 字节码等）
 * 都放在 analyzer 层处理，不污染 loader。
 *
 * 后续若需要 APK 特化能力（例如 v2/v3 签名块在 zip Central Directory 前的偏移定位），
 * 再在此文件扩展。一期保持薄包装。
 */

import { openZipPackage } from './zipPackage.js';

export const openApk = openZipPackage;
