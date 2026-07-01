import type {
  Analyzer,
  AnalyzerContext,
  PackageEntry,
  PackageReport,
  PackageResources,
} from '@kingsdk/shared/schema.js';
import {
  IMAGE_EXTENSIONS,
  MEDIA_EXTENSIONS,
} from '@kingsdk/shared/constants.js';
import { extname } from '@kingsdk/shared/utils.js';

/**
 * 资源分析：
 *  - 扫描 resources/ 目录下的所有 entry，按类型归并
 *  - 图片：按扩展名识别（png/jpg/...），给 Top N 最大
 *  - 媒体：mp3/mp4 等
 *  - 字符串：element/string.json，并提取 locale 集合（resources/<locale>/element/string.json）
 *  - 顶层 resources.index 单独记录字节数
 *
 * HarmonyOS 资源典型路径：
 *   resources/base/element/string.json
 *   resources/base/media/icon.png
 *   resources/zh_CN/element/string.json
 *   resources/rawfile/manifest.txt
 *   resources.index               (顶层，资源索引文件)
 */
export const resourceAnalyzer: Analyzer = {
  id: 'resource',
  name: 'Resource',
  enabledByDefault: true,
  async run(ctx: AnalyzerContext): Promise<Partial<PackageReport>> {
    const topLimit = 10;
    const resources = computeResources(ctx, topLimit);
    return { resources };
  },
};

/* ------------------------------------------------------------------ */

function computeResources(ctx: AnalyzerContext, topLimit: number): PackageResources {
  const fileEntries = ctx.hap.entries.filter((e) => !e.isDirectory);

  let imagesCount = 0;
  let imagesBytes = 0;
  const imageList: Array<{ path: string; bytes: number }> = [];

  let mediaCount = 0;
  let mediaBytes = 0;

  let stringsCount = 0;
  const locales = new Set<string>();

  let rawResIndexBytes: number | undefined;

  for (const entry of fileEntries) {
    if (entry.path === 'resources.index') {
      rawResIndexBytes = entry.uncompressedSize;
      continue;
    }
    if (!entry.path.startsWith('resources/')) continue;

    const ext = extname(entry.path);

    if (IMAGE_EXTENSIONS.has(ext)) {
      imagesCount += 1;
      imagesBytes += entry.uncompressedSize;
      imageList.push({ path: entry.path, bytes: entry.uncompressedSize });
      continue;
    }

    if (MEDIA_EXTENSIONS.has(ext)) {
      mediaCount += 1;
      mediaBytes += entry.uncompressedSize;
      continue;
    }

    if (isStringJson(entry)) {
      stringsCount += 1;
      const locale = extractLocale(entry.path);
      if (locale) locales.add(locale);
      continue;
    }
  }

  const topLargest = imageList
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, topLimit);

  const out: PackageResources = {
    images: { count: imagesCount, bytes: imagesBytes, topLargest },
    strings: { count: stringsCount, locales: [...locales].sort() },
    media: { count: mediaCount, bytes: mediaBytes },
  };
  if (rawResIndexBytes !== undefined) {
    out.rawResIndex = { bytes: rawResIndexBytes };
  }
  return out;
}

function isStringJson(entry: PackageEntry): boolean {
  // resources/<locale>/element/string.json
  return /\/element\/string\.json$/.test(entry.path);
}

/** 从 resources/<locale>/... 路径提取 locale 段 */
function extractLocale(path: string): string | undefined {
  const m = /^resources\/([^/]+)\//.exec(path);
  if (!m) return undefined;
  return m[1];
}
