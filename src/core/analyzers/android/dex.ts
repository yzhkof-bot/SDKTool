import type {
  Analyzer,
  AnalyzerContext,
  DexFileSummary,
  DexInfo,
  PackageReport,
} from '../../../shared/schema.js';

import { parseDexHeader } from './_dex.js';

/**
 * Android：classes*.dex 头部分析（默认开）。
 *
 * 一期 default analyzer：只读每个 dex 前 0x70 字节的 header，输出 magic / version /
 * stringIds / typeIds / classDefs 等计数。轻量、不读全文，几 ms 完成。
 *
 * 即使 APK 不含任何 dex（极少见，比如 native-only apk）也会返回 fileCount=0 的
 * 空对象，让 viewer 的 dex section / differ 能稳定 join。
 *
 * 失败处理：单个 dex header 解析失败 → entry.error 填异常信息 + warning，
 * 其它 dex 继续解析；analyzer 本身不抛。
 *
 * 注意：dex.ts 不读全文，所以即便 dex 体积是 GB 级也不影响性能；
 * 全文字符串抽取由 dexDetails analyzer（extras）负责。
 */
export const androidDexAnalyzer: Analyzer = {
  id: 'androidDex',
  name: 'Android DEX',
  enabledByDefault: true,
  async run(ctx: AnalyzerContext): Promise<Partial<PackageReport>> {
    const targets = ctx.hap.entries.filter(
      (e) => !e.isDirectory && CLASSES_DEX_RE.test(e.path),
    );

    const files: DexFileSummary[] = [];
    let totalBytes = 0;

    for (const e of targets) {
      try {
        const buf = await ctx.hap.readFile(e.path);
        const header = parseDexHeader(buf);
        const entry: DexFileSummary = {
          path: e.path,
          bytes: buf.length,
          magic: header.magic,
          version: header.version,
          checksum: header.checksum,
          fileSize: header.fileSize,
          stringIds: header.stringIds?.size ?? null,
          typeIds: header.typeIds?.size ?? null,
          protoIds: header.protoIds?.size ?? null,
          fieldIds: header.fieldIds?.size ?? null,
          methodIds: header.methodIds?.size ?? null,
          classDefs: header.classDefs?.size ?? null,
        };
        if (header.magic === 'INVALID') {
          ctx.addWarning({
            code: 'DEX_HEADER_INVALID',
            level: 'warn',
            message: `${e.path} magic 不识别（不是合法的 DEX/CDEX）`,
          });
        }
        files.push(entry);
        totalBytes += buf.length;
      } catch (err) {
        files.push({
          path: e.path,
          bytes: e.uncompressedSize,
          magic: 'INVALID',
          version: null,
          checksum: null,
          fileSize: null,
          stringIds: null,
          typeIds: null,
          protoIds: null,
          fieldIds: null,
          methodIds: null,
          classDefs: null,
          error: (err as Error).message ?? String(err),
        });
        ctx.addWarning({
          code: 'DEX_HEADER_READ_FAILED',
          level: 'warn',
          message: `读取 ${e.path} 失败: ${(err as Error).message ?? String(err)}`,
        });
      }
    }

    files.sort((a, b) => a.path.localeCompare(b.path));

    const info: DexInfo = {
      fileCount: files.length,
      totalBytes,
      files,
    };
    return { dex: info };
  },
};

/** 匹配 classes.dex / classes2.dex / classes3.dex … （顶层；不匹配 META-INF/services 等） */
const CLASSES_DEX_RE = /^classes\d*\.dex$/;
