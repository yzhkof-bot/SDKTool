import type {
  Analyzer,
  AnalyzerContext,
  HapAbcInfo,
  HapReport,
} from '../../shared/schema.js';

/**
 * ArkTS / JS 字节码分析。
 *
 * HarmonyOS 编译产物：
 *  - ets/modules.abc       主字节码（Ark Bytecode）
 *  - ets/sourceMaps.map    可选 sourceMap（与 abc 同目录）
 *  - 其它子模块：ets/<sub>/modules.abc 也算"额外 abc"
 *
 * 不解析 abc 二进制内容；只统计大小、是否带 sourceMap。
 * 后续可扩展：abc 文件版本号（前 8 字节）、模块数量等。
 */
export const abcAnalyzer: Analyzer = {
  id: 'abc',
  name: 'ABC',
  enabledByDefault: true,
  async run(ctx: AnalyzerContext): Promise<Partial<HapReport>> {
    const abc = computeAbc(ctx);
    return { abc };
  },
};

/* ------------------------------------------------------------------ */

const MAIN_ABC = 'ets/modules.abc';
const MAIN_SOURCEMAP = 'ets/sourceMaps.map';

function computeAbc(ctx: AnalyzerContext): HapAbcInfo {
  const fileEntries = ctx.hap.entries.filter((e) => !e.isDirectory);

  const main = fileEntries.find((e) => e.path === MAIN_ABC);
  const mainMap = fileEntries.find((e) => e.path === MAIN_SOURCEMAP);

  const out: HapAbcInfo = {
    extraAbcFiles: [],
  };

  if (main) {
    out.modulesAbc = {
      bytes: main.uncompressedSize,
      hasSourceMap: !!mainMap,
    };
  } else {
    ctx.addWarning({
      code: 'MAIN_ABC_MISSING',
      level: 'warn',
      message: `未找到 ${MAIN_ABC}（hap 是否完整？）`,
    });
  }

  for (const entry of fileEntries) {
    if (entry.path === MAIN_ABC) continue;
    if (!entry.path.endsWith('.abc')) continue;
    out.extraAbcFiles.push({
      path: entry.path,
      bytes: entry.uncompressedSize,
    });
  }

  out.extraAbcFiles.sort((a, b) => b.bytes - a.bytes);
  return out;
}
