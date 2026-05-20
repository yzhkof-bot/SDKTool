import type {
  Analyzer,
  AnalyzerContext,
  HapReport,
  HapSizeBreakdownItem,
  HapSizeInfo,
  HapSizeTopFile,
  SizeCategory,
} from '../../shared/schema.js';
import {
  DEFAULT_TOP_FILES_LIMIT,
  SIZE_CATEGORY_RULES,
  SIZE_CONFIG_FILES,
} from '../../shared/constants.js';
import { safeRatio } from '../../shared/utils.js';

/**
 * 体积分析：
 *  - 把每个文件按目录归类（ets/resources/libs/signature/config/other）
 *  - 汇总各类总字节、文件数、占比
 *  - 给出 Top N 的最大文件
 *
 * 仅基于 entry 元数据（uncompressedSize），不解压实际内容，零内存压力。
 */
export const sizeAnalyzer: Analyzer = {
  id: 'size',
  name: 'Size',
  enabledByDefault: true,
  async run(ctx: AnalyzerContext): Promise<Partial<HapReport>> {
    const limit = ctx.options.topFilesLimit ?? DEFAULT_TOP_FILES_LIMIT;
    const size = computeSize(ctx, limit);
    return { size };
  },
};

/* ------------------------------------------------------------------ */

function computeSize(ctx: AnalyzerContext, topLimit: number): HapSizeInfo {
  const fileEntries = ctx.hap.entries.filter((e) => !e.isDirectory);

  let total = 0;
  const byCategory = new Map<SizeCategory, { bytes: number; fileCount: number }>();
  const allFiles: HapSizeTopFile[] = [];

  for (const entry of fileEntries) {
    const category = classify(entry.path);
    total += entry.uncompressedSize;

    const bucket = byCategory.get(category) ?? { bytes: 0, fileCount: 0 };
    bucket.bytes += entry.uncompressedSize;
    bucket.fileCount += 1;
    byCategory.set(category, bucket);

    allFiles.push({
      path: entry.path,
      bytes: entry.uncompressedSize,
      ratio: 0,
      category,
    });
  }

  const breakdown: HapSizeBreakdownItem[] = [...byCategory.entries()]
    .map(([category, v]) => ({
      category,
      bytes: v.bytes,
      ratio: safeRatio(v.bytes, total),
      fileCount: v.fileCount,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const topFiles = allFiles
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, topLimit)
    .map((f) => ({ ...f, ratio: safeRatio(f.bytes, total) }));

  if (fileEntries.length === 0) {
    ctx.addWarning({
      code: 'EMPTY_HAP',
      level: 'warn',
      message: 'hap 内未发现任何文件 entry',
    });
  }

  return {
    total,
    compressed: ctx.hap.fileSize,
    breakdown,
    topFiles,
    fileCount: fileEntries.length,
  };
}

/**
 * 把 entry 路径分类到 SizeCategory。导出供其它 analyzer（如 files）复用，
 * 避免分类规则散落多处导致行为漂移。
 */
export function classifySizeCategory(path: string): SizeCategory {
  for (const rule of SIZE_CATEGORY_RULES) {
    if (path.startsWith(rule.prefix)) return rule.category;
  }
  const slash = path.indexOf('/');
  const top = slash < 0 ? path : path.slice(0, slash);
  if (slash < 0 && SIZE_CONFIG_FILES.has(path)) return 'config';
  if (slash < 0 && top.endsWith('.json')) return 'config';
  return 'other';
}

const classify = classifySizeCategory;
