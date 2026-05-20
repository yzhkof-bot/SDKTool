import type {
  Analyzer,
  AnalyzerContext,
  HapNativeLib,
  HapNativeLibsInfo,
  HapReport,
} from '../../shared/schema.js';
import { basename } from '../../shared/utils.js';

/**
 * Native 库分析：
 *  - 扫描 libs/<arch>/*.so（HarmonyOS 也可能放 .a/.dylib，但生产产物通常 .so）
 *  - 提取所有架构（arm64-v8a / armeabi-v7a / x86_64 / ...）
 *  - 输出 lib 列表 + 总体积，按 (arch, name) 排序
 *
 * 不读 so 内容；体积来自 zip entry 元数据。
 */
export const nativeLibAnalyzer: Analyzer = {
  id: 'nativeLib',
  name: 'Native Lib',
  enabledByDefault: true,
  async run(ctx: AnalyzerContext): Promise<Partial<HapReport>> {
    const nativeLibs = computeNativeLibs(ctx);
    return { nativeLibs };
  },
};

/* ------------------------------------------------------------------ */

const NATIVE_EXT = /\.(so|a|dylib|dll)$/i;

function computeNativeLibs(ctx: AnalyzerContext): HapNativeLibsInfo {
  const libs: HapNativeLib[] = [];
  const archSet = new Set<string>();
  let totalBytes = 0;

  for (const entry of ctx.hap.entries) {
    if (entry.isDirectory) continue;
    const m = /^libs\/([^/]+)\/(.+)$/.exec(entry.path);
    if (!m) continue;
    const arch = m[1] ?? '';
    const subPath = m[2] ?? '';
    if (!arch || !subPath) continue;

    if (!NATIVE_EXT.test(subPath)) {
      ctx.addWarning({
        code: 'UNEXPECTED_LIBS_FILE',
        level: 'info',
        message: `libs/${arch}/ 下出现非原生库文件: ${subPath}`,
      });
    }

    archSet.add(arch);
    libs.push({
      arch,
      name: basename(subPath),
      bytes: entry.uncompressedSize,
    });
    totalBytes += entry.uncompressedSize;
  }

  libs.sort((a, b) => {
    if (a.arch !== b.arch) return a.arch.localeCompare(b.arch);
    return a.name.localeCompare(b.name);
  });

  return {
    architectures: [...archSet].sort(),
    libs,
    totalBytes,
  };
}
