import type {
  Analyzer,
  AnalyzerContext,
  HapFileEntry,
  HapReport,
} from '../../shared/schema.js';

import { classifySizeCategory } from './size.js';

/**
 * Files analyzer：输出 HapReport.files 全量精简清单。
 *
 * 这份数据是给 differ 做逐文件 diff 用的，viewer 默认不渲染（避免主页面被几千行
 * 路径占满）。entry 顺序保持 zip 内自然顺序，便于人眼对照。
 */
export const filesAnalyzer: Analyzer = {
  id: 'files',
  name: 'Files',
  enabledByDefault: true,
  async run(ctx: AnalyzerContext): Promise<Partial<HapReport>> {
    const files: HapFileEntry[] = ctx.hap.entries
      .filter((e) => !e.isDirectory)
      .map((e) => ({
        path: e.path,
        bytes: e.uncompressedSize,
        compressed: e.compressedSize,
        category: classifySizeCategory(e.path),
        crc: e.crc32,
      }));
    return { files };
  },
};
