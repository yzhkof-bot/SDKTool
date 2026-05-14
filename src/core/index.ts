import type { Analyzer, AnalyzeOptions, HapReport } from '../shared/schema.js';

import { builtinAnalyzers } from './analyzers/index.js';
import { openHap } from './loader/hapLoader.js';
import { runPipeline } from './pipeline.js';

export interface AnalyzeHapOptions extends AnalyzeOptions {
  /** 自定义 analyzer 列表；不传则使用内置全套 */
  analyzers?: Analyzer[];
}

/**
 * 分析单个 .hap 文件，产出标准化 HapReport。
 *
 * 这是核心层对外的唯一主入口，CLI / 第三方代码都通过它调用。
 */
export async function analyzeHap(
  filePath: string,
  options: AnalyzeHapOptions = {},
): Promise<HapReport> {
  const hap = await openHap(filePath);
  try {
    const { report } = await runPipeline({
      hap,
      analyzers: options.analyzers ?? builtinAnalyzers,
      options,
      toolVersion: options.toolVersion ?? 'unknown',
    });
    return report;
  } finally {
    await hap.close();
  }
}

export { openHap } from './loader/hapLoader.js';
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
export { diffHapReports } from './differ/index.js';
export type { Analyzer, AnalyzeOptions, HapReport, HapDiffReport } from '../shared/schema.js';
