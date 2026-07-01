import type { Analyzer, AnalyzeOptions, PackageReport } from '@kingsdk/shared/schema.js';
import { DEFAULT_PLATFORM } from '@kingsdk/shared/schema.js';

import { getAllAnalyzers } from './analyzers/index.js';
import { openPackage } from './loader/index.js';
import { runPipeline } from './pipeline.js';

export interface AnalyzePackageOptions extends AnalyzeOptions {
  /** 自定义 analyzer 列表；不传则按 platform 取默认全套（HarmonyOS / Android / ...） */
  analyzers?: Analyzer[];
}

/**
 * 分析单个应用包（HarmonyOS .hap / Android .apk 等），产出标准化 PackageReport。
 *
 * 这是核心层对外的唯一主入口，CLI / 第三方代码都通过它调用。
 * platform 通过 options.platform 指定，未指定时按 'harmony' 处理（向后兼容）。
 */
export async function analyzePackage(
  filePath: string,
  options: AnalyzePackageOptions = {},
): Promise<PackageReport> {
  const platform = options.platform ?? DEFAULT_PLATFORM;
  const pkg = await openPackage(filePath, platform);
  try {
    const { report } = await runPipeline({
      hap: pkg,
      analyzers: options.analyzers ?? getAllAnalyzers(platform),
      options,
      toolVersion: options.toolVersion ?? 'unknown',
      platform,
    });
    return report;
  } finally {
    await pkg.close();
  }
}

/**
 * @deprecated 用 {@link AnalyzePackageOptions}（更名以匹配 PackageReport）。
 * 历史上工具只跑 HarmonyOS .hap，所以叫 AnalyzeHapOptions；现在扩展到 Android/iOS，
 * 类型本身没变，只是改了名字。alias 保留给外部调用者一个迁移窗口。
 */
export type AnalyzeHapOptions = AnalyzePackageOptions;

/**
 * @deprecated 用 {@link analyzePackage}。同样的入参 / 同样的产出，只是名字更新。
 */
export const analyzeHap = analyzePackage;

export { openHap, openApk, openZipPackage, openPackage } from './loader/index.js';
export { runPipeline } from './pipeline.js';
export {
  builtinAnalyzers,
  EXTRA_ANALYZERS,
  abcAnalyzer,
  abcDetailsAnalyzer,
  basicInfoAnalyzer,
  dependencyAnalyzer,
  filesAnalyzer,
  il2cppMetadataAnalyzer,
  nativeLibAnalyzer,
  nativeSymbolsAnalyzer,
  permissionAnalyzer,
  rawfileAnalyzer,
  resourceAnalyzer,
  signatureAnalyzer,
  sizeAnalyzer,
} from './analyzers/index.js';
export type { ExtraAnalyzerMeta } from './analyzers/index.js';
export { diffPackageReports, diffHapReports } from './differ/index.js';
export type {
  Analyzer,
  AnalyzeOptions,
  PackageReport,
  PackageDiffReport,
  Platform,
} from '@kingsdk/shared/schema.js';
export { DEFAULT_PLATFORM } from '@kingsdk/shared/schema.js';
