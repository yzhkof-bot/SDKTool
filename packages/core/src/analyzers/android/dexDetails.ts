import { createHash } from 'node:crypto';

import type {
  Analyzer,
  AnalyzerContext,
  DexDetailEntry,
  DexDetailsInfo,
  DexMethodEntry,
  DexStrings,
  PackageReport,
} from '@kingsdk/shared/schema.js';

import { extractDexMethods, extractDexStringList, parseDexHeader } from './_dex.js';

/**
 * 可选深度分析：解析每个 classes*.dex 的 string_ids 表，抽出全量字符串后按用途分桶。
 *
 * 与 HarmonyOS abcDetails 对称：
 *  - HarmonyOS：abc 字符串池 → classDescriptors / moduleRecords / sourceFiles / identifiers / other
 *  - Android：dex 字符串池 → classDescriptors / methodSignatures / sourceFiles / identifiers / other
 *
 * 价值：diff 时直接看到"新增了哪些类 / 哪些 java 文件 / 哪些方法签名"，
 * 远比"dex 文件大了 200 KB"信息密度高。
 *
 * 性能：需读全文 + 顺扫 string_ids 表 + 解码 MUTF-8。对 5 MB 单 dex 实测 < 100ms；
 * 多 dex 串行（与 abcDetails 同步）。
 *
 * 默认关闭（enabledByDefault: false），通过 `--extras androidDexDetails` 或 workbench
 * 多选启用。
 */
export const androidDexDetailsAnalyzer: Analyzer = {
  id: 'androidDexDetails',
  name: 'Android DEX Details',
  enabledByDefault: false,
  async run(ctx: AnalyzerContext): Promise<Partial<PackageReport>> {
    const targets = ctx.hap.entries.filter(
      (e) => !e.isDirectory && CLASSES_DEX_RE.test(e.path),
    );
    const stringLimit = clampLimit(ctx.options.dexStringExtractLimit, 0);
    const methodLimit = clampLimit(ctx.options.dexMethodExtractLimit, 0);
    const hashBodies = !!ctx.options.dexHashMethodBodies;

    const entries: DexDetailEntry[] = [];

    for (const e of targets) {
      try {
        const buf = await ctx.hap.readFile(e.path);
        const sha256 = createHash('sha256').update(buf).digest('hex');
        const header = parseDexHeader(buf);
        const entry: DexDetailEntry = { path: e.path, bytes: buf.length, sha256 };
        if (header.magic === 'DEX' && header.stringIds) {
          const raw = extractDexStringList(
            buf,
            header.stringIds.size,
            header.stringIds.off,
          );
          entry.strings = classifyDexStrings(raw, stringLimit);

          // 方法表抽取：单 dex 失败不影响 strings；warnings 透传给 pipeline
          const { methods, truncated, warnings } = extractDexMethods(buf, header, {
            hashBodies,
            methodLimit,
          });
          for (const w of warnings) {
            ctx.addWarning({ code: 'DEX_METHOD_PARSE_WARN', level: 'warn', message: `${e.path}: ${w}` });
          }
          entry.methods = methods.map(
            (m): DexMethodEntry => ({
              classDescriptor: m.classDescriptor,
              name: m.name,
              proto: m.proto,
              fullName: m.fullName,
              accessFlags: m.accessFlags,
              hasCode: m.hasCode,
              insnsSize: m.insnsSize,
              registers: m.registers,
              insnsSha256: m.insnsBytes
                ? createHash('sha256').update(m.insnsBytes).digest('hex')
                : null,
            }),
          );
          if (truncated) entry.methodsTruncated = true;
        }
        entries.push(entry);
      } catch (err) {
        entries.push({
          path: e.path,
          bytes: e.uncompressedSize,
          sha256: '',
          error: (err as Error).message ?? String(err),
        });
        ctx.addWarning({
          code: 'DEX_DETAIL_PARSE_FAILED',
          level: 'warn',
          message: `解析 ${e.path} 字符串表失败: ${(err as Error).message ?? String(err)}`,
        });
      }
    }

    entries.sort((a, b) => a.path.localeCompare(b.path));

    const info: DexDetailsInfo = { entries, scanned: entries.length };
    return { dexDetails: info };
  },
};

const CLASSES_DEX_RE = /^classes\d*\.dex$/;

function clampLimit(input: number | undefined, fallback: number): number {
  if (input === undefined) return fallback;
  if (!Number.isFinite(input) || input < 0) return fallback;
  return Math.floor(input);
}

/* ------------------------------------------------------------------ */
/* 分桶规则（与 HarmonyAbcStrings 同思路）                              */
/* ------------------------------------------------------------------ */

const CLASS_DESC_RE = /^L[A-Za-z0-9_$./-]+;$/;
const METHOD_SIG_RE = /^\([^)]*\).+$/; // (Ljava/lang/String;I)V
const SOURCE_FILE_RE = /\.(java|kt|aidl|ets|ts|js|json)$/i;
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]{2,80}$/;

function classifyDexStrings(raw: string[], limit: number): DexStrings {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const s of raw) {
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    unique.push(s);
  }

  const classDescriptors: string[] = [];
  const methodSignatures: string[] = [];
  const sourceFiles: string[] = [];
  const identifiers: string[] = [];
  const other: string[] = [];

  for (const s of unique) {
    if (CLASS_DESC_RE.test(s)) classDescriptors.push(s);
    else if (METHOD_SIG_RE.test(s)) methodSignatures.push(s);
    else if (SOURCE_FILE_RE.test(s)) sourceFiles.push(s);
    else if (IDENTIFIER_RE.test(s)) identifiers.push(s);
    else other.push(s);
  }

  classDescriptors.sort();
  methodSignatures.sort();
  sourceFiles.sort();
  identifiers.sort();
  other.sort();

  const apply = (arr: string[], cap: number): { kept: string[]; truncated: boolean } => {
    if (cap <= 0 || arr.length <= cap) return { kept: arr, truncated: false };
    return { kept: arr.slice(0, cap), truncated: true };
  };

  const r1 = apply(classDescriptors, limit);
  const r2 = apply(methodSignatures, limit);
  const r3 = apply(sourceFiles, limit);
  const r4 = apply(identifiers, limit);
  const r5 = apply(other, limit);

  return {
    totalDistinct: unique.length,
    classDescriptors: r1.kept,
    methodSignatures: r2.kept,
    sourceFiles: r3.kept,
    identifiers: r4.kept,
    other: r5.kept,
    extractLimit: limit,
    truncated: r1.truncated || r2.truncated || r3.truncated || r4.truncated || r5.truncated,
  };
}
