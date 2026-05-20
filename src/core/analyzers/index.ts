/**
 * Analyzer 注册表 - 按平台组装。
 *
 * 对外职责：
 *  1. 按 platform 返回该平台对应的"默认 analyzer 集合"（pipeline 跑哪些）
 *  2. 按 platform 返回该平台对应的"可选深度 analyzer 元信息"（UI 渲染多选项 / CLI --extras 帮助）
 *  3. 向后兼容：保留 `builtinAnalyzers` 与 `EXTRA_ANALYZERS` 两个老导出，
 *     语义按 HarmonyOS 行为不变，npm 包的现有调用方零迁移。
 *
 * 一期约定：
 *  - HarmonyOS = harmony/* + common/*（所有跨平台 analyzer 在 hap 上原本就跑）
 *  - Android   = android/* + common/*（android/* 一期为空，等 todo #7 落地）
 *  - iOS       = （暂未支持，目前返回空）
 */

import type { Analyzer, Platform } from '../../shared/schema.js';
import { DEFAULT_PLATFORM } from '../../shared/schema.js';

import {
  androidApkSignatureAnalyzer,
  androidDefaultAnalyzers,
  androidDexAnalyzer,
  androidDexDetailsAnalyzer,
  androidExtraAnalyzerMeta,
  androidExtraAnalyzers,
  androidManifestAnalyzer,
  androidPermissionAnalyzer,
} from './android/index.js';
import {
  commonDefaultAnalyzers,
  commonExtraAnalyzerMeta,
  commonExtraAnalyzers,
  filesAnalyzer,
  il2cppMetadataAnalyzer,
  nativeLibAnalyzer,
  nativeSymbolsAnalyzer,
  sizeAnalyzer,
} from './common/index.js';
import {
  abcAnalyzer,
  abcDetailsAnalyzer,
  basicInfoAnalyzer,
  dependencyAnalyzer,
  harmonyDefaultAnalyzers,
  harmonyExtraAnalyzerMeta,
  harmonyExtraAnalyzers,
  permissionAnalyzer,
  rawfileAnalyzer,
  resourceAnalyzer,
  signatureAnalyzer,
} from './harmony/index.js';
import type { ExtraAnalyzerMeta } from './meta.js';

/**
 * 按平台返回完整的 analyzer 注册表（默认 + 可选）。
 * pipeline 还会根据 options.only / options.extras 进一步筛选。
 */
export function getAllAnalyzers(platform: Platform = DEFAULT_PLATFORM): Analyzer[] {
  switch (platform) {
    case 'harmony':
      return [...harmonyDefaultAnalyzers, ...commonDefaultAnalyzers, ...harmonyExtraAnalyzers, ...commonExtraAnalyzers];
    case 'android':
      return [...androidDefaultAnalyzers, ...commonDefaultAnalyzers, ...androidExtraAnalyzers, ...commonExtraAnalyzers];
    case 'ios':
      return [];
    default:
      return [];
  }
}

/** 按平台返回可选深度 analyzer 的元信息（UI 渲染多选用） */
export function getExtraAnalyzerMeta(platform: Platform = DEFAULT_PLATFORM): ExtraAnalyzerMeta[] {
  switch (platform) {
    case 'harmony':
      return [...commonExtraAnalyzerMeta, ...harmonyExtraAnalyzerMeta];
    case 'android':
      return [...commonExtraAnalyzerMeta, ...androidExtraAnalyzerMeta];
    case 'ios':
      return [];
    default:
      return [];
  }
}

/* ------------------------------------------------------------------ */
/* 向后兼容导出：保持老 API 形态，行为按 HarmonyOS                       */
/* ------------------------------------------------------------------ */

/**
 * @deprecated 旧入口，行为等价于 getAllAnalyzers('harmony')。新代码请改用 getAllAnalyzers(platform)。
 */
export const builtinAnalyzers: Analyzer[] = getAllAnalyzers('harmony');

/**
 * @deprecated 旧入口，行为等价于 getExtraAnalyzerMeta('harmony')。
 * 老 CLI / 老 workbench 直接 import 它能继续工作。
 */
export const EXTRA_ANALYZERS: ExtraAnalyzerMeta[] = getExtraAnalyzerMeta('harmony');

export type { ExtraAnalyzerMeta } from './meta.js';

export {
  // harmony
  abcAnalyzer,
  abcDetailsAnalyzer,
  basicInfoAnalyzer,
  dependencyAnalyzer,
  permissionAnalyzer,
  rawfileAnalyzer,
  resourceAnalyzer,
  signatureAnalyzer,
  // common
  filesAnalyzer,
  il2cppMetadataAnalyzer,
  nativeLibAnalyzer,
  nativeSymbolsAnalyzer,
  sizeAnalyzer,
  // android
  androidApkSignatureAnalyzer,
  androidDexAnalyzer,
  androidDexDetailsAnalyzer,
  androidManifestAnalyzer,
  androidPermissionAnalyzer,
};
