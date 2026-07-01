/**
 * Analyzer 基础工具：把 schema 里的 Analyzer/AnalyzerContext 接口在 core 内部
 * 做一个明确的 re-export 入口，便于后续每个 analyzer 文件只 import 一处。
 */
export type {
  Analyzer,
  AnalyzerContext,
  AnalyzeOptions,
  PackageReport,
  ReportWarning,
  WarningLevel,
} from '@kingsdk/shared/schema.js';
