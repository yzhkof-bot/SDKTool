/**
 * Android 平台专属 analyzer 集合。
 *
 * 已落地：
 *   - manifest        AndroidManifest.xml 的 AXML 二进制解析（含 basic 派生）
 *   - permission      AndroidManifest.xml 派生 permissions + 敏感清单标记 + level
 *   - dex             classes*.dex 头部摘要（轻量，默认开）
 *   - apkSignature    META-INF v1 + APK Signing Block v2/v3/v3.1（默认开）
 *
 * 可选深度（extras）：
 *   - dexDetails      classes*.dex 字符串表抽取（类比 abcDetails）
 */

import type { Analyzer } from '../../../shared/schema.js';
import type { ExtraAnalyzerMeta } from '../meta.js';

import { androidApkSignatureAnalyzer } from './apkSignature.js';
import { androidDexAnalyzer } from './dex.js';
import { androidDexDetailsAnalyzer } from './dexDetails.js';
import { androidManifestAnalyzer } from './manifest.js';
import { androidPermissionAnalyzer } from './permission.js';

export const androidDefaultAnalyzers: Analyzer[] = [
  androidManifestAnalyzer,
  androidPermissionAnalyzer,
  androidDexAnalyzer,
  androidApkSignatureAnalyzer,
];

export const androidExtraAnalyzers: Analyzer[] = [androidDexDetailsAnalyzer];

export const androidExtraAnalyzerMeta: ExtraAnalyzerMeta[] = [
  {
    id: 'androidDexDetails',
    name: 'DEX 深度分析 (.dex)',
    description:
      '解析每个 classes*.dex 的 string_ids 表，抽出全量字符串后按类描述符 / 方法签名 / 源文件 / 标识符分桶。可用于 diff 时定位"新增了哪些类/源文件"',
  },
];

export {
  androidApkSignatureAnalyzer,
  androidDexAnalyzer,
  androidDexDetailsAnalyzer,
  androidManifestAnalyzer,
  androidPermissionAnalyzer,
};
