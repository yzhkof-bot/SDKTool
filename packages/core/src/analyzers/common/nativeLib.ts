import type {
  Analyzer,
  AnalyzerContext,
  NativeLib,
  NativeLibsInfo,
  PackageReport,
  Platform,
} from '@kingsdk/shared/schema.js';
import { basename } from '@kingsdk/shared/utils.js';

/**
 * Native 库分析：
 *  - 扫描各平台的 native lib 根目录（HarmonyOS=libs/<abi>/, Android=lib/<abi>/，
 *    iOS 走 Frameworks/... 但本期未实现）
 *  - 提取所有架构（arm64-v8a / armeabi-v7a / x86_64 / ...）
 *  - 输出 lib 列表 + 总体积，按 (arch, name) 排序
 *
 * 不读 so 内容；体积来自 zip entry 元数据。
 */
export const nativeLibAnalyzer: Analyzer = {
  id: 'nativeLib',
  name: 'Native Lib',
  enabledByDefault: true,
  async run(ctx: AnalyzerContext): Promise<Partial<PackageReport>> {
    const nativeLibs = computeNativeLibs(ctx);
    return { nativeLibs };
  },
};

/* ------------------------------------------------------------------ */
/* platform 路径规则                                                   */
/* ------------------------------------------------------------------ */

/**
 * 各平台 zip 内 native lib 根路径前缀（必须含末尾 '/'）。
 * 这是抽取 native lib analyzer 跨平台的唯一关键点：HarmonyOS 历史上用 'libs/'
 * （沿用 Android 早期约定的复数形式），Android Studio 打出的标准 APK 用 'lib/'
 * 单数形式。iOS 的 .ipa 走完全不同的 Frameworks/*.framework 结构，本期未实现。
 *
 * 抽到 export 给 nativeSymbols analyzer 复用，避免两个 analyzer 各维护一份。
 */
export const NATIVE_LIB_PATH_PREFIX: Readonly<Record<Platform, string>> = Object.freeze({
  harmony: 'libs/',
  android: 'lib/',
  ios: '', // 占位：iOS 本期不实现，空串会让正则永远不匹配
});

/**
 * 给定 path 与 platform，提取 (arch, subPath)；不是 native lib 则返回 null。
 *
 * 例：
 *   matchNativeLibPath('libs/arm64-v8a/libfoo.so', 'harmony')
 *     → { arch: 'arm64-v8a', subPath: 'libfoo.so' }
 *   matchNativeLibPath('lib/x86_64/libbar.so', 'android')
 *     → { arch: 'x86_64', subPath: 'libbar.so' }
 */
export function matchNativeLibPath(
  path: string,
  platform: Platform,
): { arch: string; subPath: string } | null {
  const prefix = NATIVE_LIB_PATH_PREFIX[platform];
  if (!prefix || !path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  const slashIdx = rest.indexOf('/');
  if (slashIdx <= 0 || slashIdx === rest.length - 1) return null;
  return { arch: rest.slice(0, slashIdx), subPath: rest.slice(slashIdx + 1) };
}

const NATIVE_EXT = /\.(so|a|dylib|dll)$/i;

function computeNativeLibs(ctx: AnalyzerContext): NativeLibsInfo {
  const libs: NativeLib[] = [];
  const archSet = new Set<string>();
  let totalBytes = 0;
  const prefix = NATIVE_LIB_PATH_PREFIX[ctx.platform];

  for (const entry of ctx.hap.entries) {
    if (entry.isDirectory) continue;
    const matched = matchNativeLibPath(entry.path, ctx.platform);
    if (!matched) continue;
    const { arch, subPath } = matched;

    if (!NATIVE_EXT.test(subPath)) {
      ctx.addWarning({
        code: 'UNEXPECTED_LIBS_FILE',
        level: 'info',
        message: `${prefix}${arch}/ 下出现非原生库文件: ${subPath}`,
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
