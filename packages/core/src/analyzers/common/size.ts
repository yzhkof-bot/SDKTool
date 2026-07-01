import type {
  Analyzer,
  AnalyzerContext,
  PackageReport,
  PackageSizeBreakdownItem,
  PackageSizeInfo,
  PackageSizeTopFile,
  Platform,
  SizeCategory,
} from '@kingsdk/shared/schema.js';
import {
  ANDROID_SPECIAL_FILE_CATEGORY,
  DEFAULT_TOP_FILES_LIMIT,
  SIZE_CATEGORY_RULES_BY_PLATFORM,
  SIZE_CONFIG_FILES_BY_PLATFORM,
} from '@kingsdk/shared/constants.js';
import { safeRatio } from '@kingsdk/shared/utils.js';

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
  async run(ctx: AnalyzerContext): Promise<Partial<PackageReport>> {
    const limit = ctx.options.topFilesLimit ?? DEFAULT_TOP_FILES_LIMIT;
    const size = computeSize(ctx, limit);
    return { size };
  },
};

/* ------------------------------------------------------------------ */

function computeSize(ctx: AnalyzerContext, topLimit: number): PackageSizeInfo {
  const fileEntries = ctx.hap.entries.filter((e) => !e.isDirectory);

  let total = 0;
  const byCategory = new Map<SizeCategory, { bytes: number; fileCount: number }>();
  const allFiles: PackageSizeTopFile[] = [];

  for (const entry of fileEntries) {
    const category = classifySizeCategory(entry.path, ctx.platform);
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

  const breakdown: PackageSizeBreakdownItem[] = [...byCategory.entries()]
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
 *
 * 第二个参数为 platform：'harmony' 走 SIZE_CATEGORY_RULES_BY_PLATFORM.harmony，
 * 'android' 在前缀匹配前先看 ANDROID_SPECIAL_FILE_CATEGORY（classes*.dex 等）。
 * 不传 platform 时按 'harmony' 处理，兼容历史 caller（如 viewer 端的
 * post-processing）。
 */
export function classifySizeCategory(path: string, platform: Platform = 'harmony'): SizeCategory {
  if (platform === 'android') {
    for (const rule of ANDROID_SPECIAL_FILE_CATEGORY) {
      if (rule.test(path)) return rule.category;
    }
  }
  const rules = SIZE_CATEGORY_RULES_BY_PLATFORM[platform] ?? SIZE_CATEGORY_RULES_BY_PLATFORM.harmony;
  for (const rule of rules) {
    if (path.startsWith(rule.prefix)) return rule.category;
  }
  // 顶层配置文件 fallback
  const slash = path.indexOf('/');
  const top = slash < 0 ? path : path.slice(0, slash);
  const configSet = SIZE_CONFIG_FILES_BY_PLATFORM[platform] ?? SIZE_CONFIG_FILES_BY_PLATFORM.harmony;
  if (slash < 0 && configSet.has(path)) return 'config';
  if (slash < 0 && top.endsWith('.json') && platform === 'harmony') return 'config';
  return 'other';
}
