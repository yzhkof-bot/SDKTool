import { createHash } from 'node:crypto';

import type {
  Analyzer,
  AnalyzerContext,
  HarmonyAbcDetailEntry,
  HarmonyAbcDetailsInfo,
  HarmonyAbcStrings,
  PackageReport,
} from '../../../shared/schema.js';

/**
 * 可选深度分析：解析每个 .abc 文件（PANDA / Ark Bytecode）。
 *
 * 两步走：
 *  1. **固定头部**（保守，跨版本稳定）：
 *     0x00 magic[8]    "PANDA\0\0\0"
 *     0x08 checksum[4]
 *     0x0C version[4]  形如 [0,0,0,2] → "0.0.0.2"
 *     0x10 file_size[4]
 *     0x14 foreign_off[4]
 *     0x18 foreign_size[4]
 *     0x1C num_classes[4]
 *
 *  2. **字符串池启发式扫描**：abc 内字符串是 UTF-8 + null 终止，按"可打印序列 + null 边界"扫，
 *     再按 panda 命名约定分类成 类描述符 / 模块记录 / 源文件 / 标识符 / 其它 五类。
 *     这是个近似实现：会包含 panda 框架自带常量（cn/com/sun/...），但已足够把开发者写
 *     的类名、方法名、源文件名、模块路径都暴露出来，diff 时按集合差直接看到"新增了哪些类"。
 *
 *  全程 SHA-256 也算上，用于"size 相同但内容变化"的双检测。
 *
 *  默认关闭（enabledByDefault: false），需要 `--extras abcDetails` 或 workbench 多选启用。
 */
export const abcDetailsAnalyzer: Analyzer = {
  id: 'abcDetails',
  name: 'ABC Details',
  enabledByDefault: false,
  async run(ctx: AnalyzerContext): Promise<Partial<PackageReport>> {
    const targets = ctx.hap.entries.filter(
      (e) => !e.isDirectory && e.path.toLowerCase().endsWith('.abc'),
    );
    // 项目级硬约定（见 .cursor/rules/data-completeness.mdc）：所有限额默认 0 = 全量。
    // viewer 通过 paginated() 分页展示，不依赖 analyzer 截断。
    const stringLimit = clampLimit(ctx.options.abcStringExtractLimit, 0);

    const entries: HarmonyAbcDetailEntry[] = [];
    for (const e of targets) {
      try {
        const buf = await ctx.hap.readFile(e.path);
        const head = parsePandaHeader(buf);
        const entry: HarmonyAbcDetailEntry = { path: e.path, bytes: buf.length, ...head };
        if (head.magic === 'PANDA') {
          entry.strings = extractStrings(buf, stringLimit);
        }
        entries.push(entry);
      } catch (err) {
        entries.push({
          path: e.path,
          bytes: e.uncompressedSize,
          sha256: '',
          magic: null,
          version: null,
          headerFileSize: null,
          numClasses: null,
          error: (err as Error).message ?? String(err),
        });
        ctx.addWarning({
          code: 'ABC_DETAIL_PARSE_FAILED',
          level: 'warn',
          message: `解析 ${e.path} 头部失败: ${(err as Error).message ?? String(err)}`,
        });
      }
    }

    entries.sort((a, b) => a.path.localeCompare(b.path));

    const info: HarmonyAbcDetailsInfo = { entries, scanned: entries.length };
    return { abcDetails: info };
  },
};

function clampLimit(input: number | undefined, fallback: number): number {
  if (input === undefined) return fallback;
  if (!Number.isFinite(input) || input < 0) return fallback;
  return Math.floor(input);
}

interface PandaHeader {
  sha256: string;
  magic: string | null;
  version: string | null;
  headerFileSize: number | null;
  numClasses: number | null;
}

function parsePandaHeader(buf: Buffer): PandaHeader {
  const sha256 = createHash('sha256').update(buf).digest('hex');

  if (buf.length < 0x20) {
    return {
      sha256,
      magic: null,
      version: null,
      headerFileSize: null,
      numClasses: null,
    };
  }

  // PANDA magic: "PANDA\0\0\0"
  const magicStr = buf.toString('utf8', 0, 5);
  const trailingZeros = buf[5] === 0 && buf[6] === 0 && buf[7] === 0;
  const magic = magicStr === 'PANDA' && trailingZeros ? 'PANDA' : null;

  if (!magic) {
    return { sha256, magic: null, version: null, headerFileSize: null, numClasses: null };
  }

  // version[4]：通常按字节序读出形如 a.b.c.d
  const v0 = buf.readUInt8(0x0c);
  const v1 = buf.readUInt8(0x0d);
  const v2 = buf.readUInt8(0x0e);
  const v3 = buf.readUInt8(0x0f);
  const version = `${v0}.${v1}.${v2}.${v3}`;

  const headerFileSize = buf.readUInt32LE(0x10);
  const numClasses = buf.length >= 0x20 ? buf.readUInt32LE(0x1c) : null;

  return {
    sha256,
    magic,
    version,
    headerFileSize,
    numClasses,
  };
}

/* ------------------------------------------------------------------ */
/* 字符串池启发式抽取                                                   */
/* ------------------------------------------------------------------ */

const MIN_STR_LEN = 3;
const MAX_STR_LEN = 1024;

/**
 * 从 abc 字节中扫出所有 UTF-8 / 0 终止的可读字符串，按 panda 命名约定分类。
 *
 * 算法：
 *  1. 线性扫一遍 buffer，收集"由可打印 ASCII / UTF-8 多字节连续序列 + 0x00 边界"组成的子串；
 *  2. UTF-8 round-trip 校验过滤掉碰巧像字符串的二进制噪声；
 *  3. 按命名特征分桶；
 *  4. 每桶内字典序排序、去重、按 limit 截断。
 *
 * 复杂度：O(n)，对 8 MiB modules.abc 实测 < 100ms。
 */
function extractStrings(buf: Buffer, limit: number): HarmonyAbcStrings {
  const seen = new Set<string>();
  const all: string[] = [];

  let start = -1;
  const end = buf.length;
  for (let i = 0; i < end; i++) {
    const b = buf[i]!;
    if (isPrintableOrUtf8(b)) {
      if (start < 0) start = i;
      continue;
    }
    if (b === 0x00 && start >= 0) {
      const len = i - start;
      if (len >= MIN_STR_LEN && len <= MAX_STR_LEN) {
        const slice = buf.subarray(start, i);
        const str = decodeIfValidUtf8(slice);
        if (str && !seen.has(str)) {
          seen.add(str);
          all.push(str);
        }
      }
    }
    start = -1;
  }

  // 分类
  const classDescriptors: string[] = [];
  const moduleRecords: string[] = [];
  const sourceFiles: string[] = [];
  const identifiers: string[] = [];
  const other: string[] = [];

  for (const s of all) {
    if (CLASS_DESC_RE.test(s)) classDescriptors.push(s);
    else if (MODULE_RECORD_RE.test(s)) moduleRecords.push(s);
    else if (SOURCE_FILE_RE.test(s)) sourceFiles.push(s);
    else if (IDENTIFIER_RE.test(s)) identifiers.push(s);
    else other.push(s);
  }

  classDescriptors.sort();
  moduleRecords.sort();
  sourceFiles.sort();
  identifiers.sort();
  other.sort();

  const apply = (arr: string[], cap: number): { kept: string[]; truncated: boolean } => {
    if (cap <= 0 || arr.length <= cap) return { kept: arr, truncated: false };
    return { kept: arr.slice(0, cap), truncated: true };
  };

  // 全量输出：limit 透传到 apply()，"其它"分类不再单独压档（项目数据完整性约定）。
  const r1 = apply(classDescriptors, limit);
  const r2 = apply(moduleRecords, limit);
  const r3 = apply(sourceFiles, limit);
  const r4 = apply(identifiers, limit);
  const r5 = apply(other, limit);

  return {
    totalDistinct: all.length,
    classDescriptors: r1.kept,
    moduleRecords: r2.kept,
    sourceFiles: r3.kept,
    identifiers: r4.kept,
    other: r5.kept,
    extractLimit: limit,
    truncated: r1.truncated || r2.truncated || r3.truncated || r4.truncated || r5.truncated,
  };
}

const CLASS_DESC_RE = /^L[A-Za-z0-9_$./#-]+;$/;
const MODULE_RECORD_RE = /^(&[A-Za-z0-9_./-]+){1,4}$/;
const SOURCE_FILE_RE = /\.(ets|ts|js|json|d\.ts)(\?|$|#)/i;
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]{2,80}$/;

function isPrintableOrUtf8(b: number): boolean {
  // ASCII 可打印（不含 0x7F DEL）
  if (b >= 0x20 && b <= 0x7e) return true;
  // UTF-8 起始 / 续字节（0xC0-0xFD）。够宽松，下面 round-trip 会兜底
  if (b >= 0xc0 && b <= 0xfd) return true;
  if (b >= 0x80 && b <= 0xbf) return true;
  return false;
}

function decodeIfValidUtf8(slice: Buffer): string | null {
  // 用 TextDecoder 严格模式校验：碰到非法序列直接抛 → 返回 null
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const s = decoder.decode(slice);
    // 必须有可读字符（避免全是 0x80-0xbf 这种纯连续字节的串）
    if (!/[A-Za-z0-9_/.&;$-]/.test(s)) return null;
    return s;
  } catch {
    return null;
  }
}
