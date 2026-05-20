import type {
  Analyzer,
  AnalyzeOptions,
  AnalyzerContext,
  PackageReport,
  Platform,
  ReportWarning,
  VirtualPackage,
} from '../shared/schema.js';
import { DEFAULT_PLATFORM, SCHEMA_VERSION } from '../shared/schema.js';

export interface PipelineResult {
  report: PackageReport;
}

export interface PipelineInput {
  hap: VirtualPackage;
  analyzers: Analyzer[];
  options: AnalyzeOptions;
  /** 由调用方传入：工具版本字符串 */
  toolVersion: string;
  /** 包平台；不传时按 'harmony' 处理（兼容老调用方） */
  platform?: Platform;
}

/**
 * 编排 analyzer 流水线。
 *
 * 执行模型：根据 options.only 决定启用哪些 analyzer；并发执行（Promise.all）；
 * 每个 analyzer 的失败被收敛为一条 error 级 warning，不影响其他 analyzer。
 * 这样能保证即使某一维度解析失败，其余维度的数据仍能产出，AI/CI 拿到的 JSON 仍可用。
 */
export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const { hap, analyzers, options, toolVersion, platform } = input;

  const enabled = pickEnabledAnalyzers(analyzers, options);
  const warnings: ReportWarning[] = [];

  const resolvedPlatform: Platform = platform ?? DEFAULT_PLATFORM;
  const tasks = enabled.map((analyzer) =>
    runOne(analyzer, hap, options, resolvedPlatform, warnings),
  );
  const partials = await Promise.all(tasks);

  const merged: PackageReport = {
    schemaVersion: SCHEMA_VERSION,
    platform: resolvedPlatform,
    meta: {
      file: hap.filePath,
      fileSize: hap.fileSize,
      sha256: hap.sha256,
      analyzedAt: new Date().toISOString(),
      toolVersion,
    },
    warnings,
  };

  for (const partial of partials) {
    Object.assign(merged, stripMeta(partial));
  }

  // 把 partial 里的 warnings 合并进总 warnings
  for (const partial of partials) {
    if (partial.warnings && partial.warnings.length > 0) {
      warnings.push(...partial.warnings);
    }
  }

  // 若同一个 key 出现重复（理论上不会），后写入的覆盖前者
  return { report: merged };
}

/* ------------------------------------------------------------------ */

function pickEnabledAnalyzers(all: Analyzer[], options: AnalyzeOptions): Analyzer[] {
  if (options.only && options.only.length > 0) {
    const ids = new Set(options.only);
    const matched = all.filter((a) => ids.has(a.id));
    if (matched.length === 0) {
      throw new Error(
        `--only 指定的 analyzer 都不存在，可用 id: ${all.map((a) => a.id).join(', ')}`,
      );
    }
    return matched;
  }
  // 默认集合 ∪ extras（用 id 去重）
  const baseSet = new Set(all.filter((a) => a.enabledByDefault).map((a) => a.id));
  if (options.extras && options.extras.length > 0) {
    for (const id of options.extras) baseSet.add(id);
  }
  // 维持 all 数组的原顺序输出
  return all.filter((a) => baseSet.has(a.id));
}

async function runOne(
  analyzer: Analyzer,
  hap: VirtualPackage,
  options: AnalyzeOptions,
  platform: Platform,
  warningsSink: ReportWarning[],
): Promise<Partial<PackageReport>> {
  const ctx: AnalyzerContext = {
    hap,
    options,
    platform,
    addWarning: (w) => warningsSink.push({ ...w, source: analyzer.id }),
  };
  try {
    return await analyzer.run(ctx);
  } catch (err) {
    warningsSink.push({
      code: 'ANALYZER_FAILED',
      level: 'error',
      message: `analyzer ${analyzer.id} 执行失败: ${err instanceof Error ? err.message : String(err)}`,
      source: analyzer.id,
    });
    return {};
  }
}

/** 防止 analyzer 误覆盖 meta / warnings / schemaVersion / platform */
function stripMeta(partial: Partial<PackageReport>): Partial<PackageReport> {
  const {
    meta: _m,
    warnings: _w,
    schemaVersion: _s,
    platform: _p,
    ...rest
  } = partial;
  return rest;
}
