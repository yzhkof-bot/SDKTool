import type {
  Analyzer,
  AnalyzerContext,
  PackageEntry,
  HarmonyRawfileInfo,
  RawfileCategory,
  RawfileCategorySummary,
  RawfileExtensionSummary,
  RawfileFileSummary,
  RawfileGroupSummary,
  RawfilePackageSummary,
} from '../../../shared/schema.js';
import {
  DEFAULT_TOP_FILES_LIMIT,
  RAWFILE_PREFIX,
  RAWFILE_RULES,
  extractRawfilePackageId,
  rawfileTopLevelGroup,
} from '../../../shared/constants.js';
import { extname, safeRatio } from '../../../shared/utils.js';

/**
 * Rawfile 细分分析（QTS / 游戏美术资源专用）。
 *
 * 通用 resourceAnalyzer 只能告诉你"有多少 png / 多少 mp3"；
 * 但游戏 hap 90%+ 体积都压在 resources/rawfile/ 下，是 Unity / il2cpp / QTS 的资源系统。
 * 这个 analyzer 提供：
 *   - 顶层分组（Data/Package、Data/StreamingAssets、Data/Managed、images...）
 *   - 扩展名分布
 *   - 启发式类别（il2cpp-metadata / asset-bundle / qts-vfs / texture / script ...）
 *   - 范围内 Top N 大文件
 *   - Data/Package/(builtin|external|patch)/<id>/* 这类 QTS VFS 资源包聚合
 *
 * 仅依赖 entry 元数据，零 I/O。
 */
export const rawfileAnalyzer: Analyzer = {
  id: 'rawfile',
  name: 'Rawfile (QTS)',
  enabledByDefault: true,
  async run(ctx: AnalyzerContext) {
    const limit = ctx.options.topFilesLimit ?? DEFAULT_TOP_FILES_LIMIT;
    const info = computeRawfile(ctx, limit);
    if (!info) return {};
    return { rawfile: info };
  },
};

/* ------------------------------------------------------------------ */

function computeRawfile(ctx: AnalyzerContext, topLimit: number): HarmonyRawfileInfo | undefined {
  const entries = ctx.hap.entries.filter(
    (e) => !e.isDirectory && e.path.startsWith(RAWFILE_PREFIX) && e.path.length > RAWFILE_PREFIX.length,
  );
  if (entries.length === 0) return undefined;

  let totalBytes = 0;
  const groups = new Map<string, { bytes: number; fileCount: number }>();
  const exts = new Map<string, { bytes: number; fileCount: number }>();
  const cats = new Map<RawfileCategory, { bytes: number; fileCount: number }>();
  const packages = new Map<string, { bytes: number; fileCount: number }>();
  const allFiles: RawfileFileSummary[] = [];

  for (const entry of entries) {
    const relPath = entry.path.slice(RAWFILE_PREFIX.length);
    const ext = (extname(relPath) || '').toLowerCase() || '(none)';
    const category = classifyRawfile(relPath, ext);
    const group = rawfileTopLevelGroup(relPath);
    const pkgId = extractRawfilePackageId(relPath);

    totalBytes += entry.uncompressedSize;
    addToBucket(groups, group, entry);
    addToBucket(exts, ext, entry);
    addToBucket(cats, category, entry);
    if (pkgId !== null) addToBucket(packages, pkgId, entry);

    allFiles.push({
      path: relPath,
      bytes: entry.uncompressedSize,
      ratio: 0,
      ext,
      category,
    });
  }

  const topLevelGroups: RawfileGroupSummary[] = [...groups.entries()]
    .map(([path, v]) => ({
      path,
      bytes: v.bytes,
      fileCount: v.fileCount,
      ratio: safeRatio(v.bytes, totalBytes),
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const byExtension: RawfileExtensionSummary[] = [...exts.entries()]
    .map(([ext, v]) => ({
      ext,
      bytes: v.bytes,
      fileCount: v.fileCount,
      ratio: safeRatio(v.bytes, totalBytes),
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const categories: RawfileCategorySummary[] = [...cats.entries()]
    .map(([category, v]) => ({
      category,
      bytes: v.bytes,
      fileCount: v.fileCount,
      ratio: safeRatio(v.bytes, totalBytes),
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const topFiles = allFiles
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, topLimit)
    .map((f) => ({ ...f, ratio: safeRatio(f.bytes, totalBytes) }));

  // 包聚合：仅当至少存在 1 个 package 命中时才暴露字段
  let pkgList: RawfilePackageSummary[] | undefined;
  if (packages.size > 0) {
    pkgList = [...packages.entries()]
      .map(([packageId, v]) => ({
        packageId,
        bytes: v.bytes,
        fileCount: v.fileCount,
      }))
      .sort((a, b) => b.bytes - a.bytes)
      // 限制最多 50 项，避免某些包数（pkg id 上千）的 hap 把报告撑爆
      .slice(0, 50);
  }

  return {
    fileCount: entries.length,
    totalBytes,
    topLevelGroups,
    byExtension,
    categories,
    topFiles,
    ...(pkgList ? { packages: pkgList } : {}),
  };
}

function addToBucket<K>(
  map: Map<K, { bytes: number; fileCount: number }>,
  key: K,
  entry: PackageEntry,
): void {
  const bucket = map.get(key) ?? { bytes: 0, fileCount: 0 };
  bucket.bytes += entry.uncompressedSize;
  bucket.fileCount += 1;
  map.set(key, bucket);
}

function classifyRawfile(relPath: string, ext: string): RawfileCategory {
  for (const rule of RAWFILE_RULES) {
    if (rule.test(relPath, ext)) return rule.category;
  }
  return 'other';
}
