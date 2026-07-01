/**
 * APK Signing Block 二进制解析 helper（零依赖）。
 *
 * 规范来源：
 *   - APK Signature Scheme v2 / v3 / v3.1 官方文档（developer.android.com/about/versions/...）
 *   - apksig 源码：tools/apksig/src/main/java/com/android/apksig/ApkVerifier.java
 *
 * APK 文件末尾的结构（自底向上）：
 *   [ Local file entries ]              ← zip 标准
 *   [ APK Signing Block ]               ← 可选，位于 CD 之前
 *   [ Central Directory ]
 *   [ End of Central Directory (EOCD) ] ← 标志 zip 结束（含 cd_offset）
 *
 * APK Signing Block 的字节布局：
 *   8 bytes  size_of_block (LE u64, 不含本字段自己)
 *   N × pair:
 *     8 bytes  pair_length (LE u64, 含 4 字节 ID + value bytes)
 *     4 bytes  pair_id     (LE u32)
 *     value
 *   8 bytes  size_of_block (LE u64, 与第一个 size_of_block 相同)
 *  16 bytes  magic = "APK Sig Block 42" (固定 ASCII)
 *
 * 定位流程：
 *   1) 找 EOCD（从文件末尾向前扫 max 65557 字节找 0x06054b50）
 *   2) 读 EOCD 里的 cd_offset
 *   3) 在 cd_offset 前 24 字节读 magic，比对 "APK Sig Block 42"
 *   4) magic 前 8 字节读 size_of_block
 *   5) signing block 起点 = cd_offset - size_of_block - 8
 *
 * 失败处理：
 *   - 没有 EOCD / EOCD 损坏 / signing block magic 不匹配 → 返回 null
 *   - 不抛异常，让 analyzer 继续往下跑
 */

import type { ApkSignatureBlockEntry, ApkSigningBlock } from '@kingsdk/shared/schema.js';

/** APK Signing Block magic（小端字节序列即 ASCII "APK Sig Block 42"） */
const APK_SIG_MAGIC = Buffer.from('APK Sig Block 42', 'ascii');

/** EOCD 最小长度：22 字节 */
const EOCD_MIN_SIZE = 22;
/** EOCD 最大搜索范围：22 + 65535（max comment 长度） */
const EOCD_MAX_SEARCH = 22 + 0xffff;

const ZIP_EOCD_SIGNATURE = 0x06054b50;

/** 已知 Pair ID → 命名 */
export const APK_SIG_KNOWN_IDS: Readonly<Record<string, string>> = Object.freeze({
  '0x7109871a': 'V2 Signature',
  '0xf05368c0': 'V3 Signature',
  '0x1b93ad61': 'V3.1 Signature',
  '0x2b09189e': 'V4 Signature Description',
  '0x42726577': 'Source Stamp',
  '0x6dff800d': 'Source Stamp V2',
  '0x504b4453': 'Padding',
});

export interface ParseApkSignatureResult {
  /** APK Signing Block 的解析结果；不存在为 null */
  signingBlock: ApkSigningBlock | null;
  /** 解析时的非致命警告（损坏的 pair / magic 验证失败等） */
  warnings: string[];
}

/**
 * 从 APK 文件 buffer 解析 APK Signing Block。
 *
 * 性能注意：完整 APK buffer 可能很大；调用方应该只传入文件末尾几 MB 的窗口（足够
 * 覆盖 EOCD + signing block）。一般 signing block < 100 KB，1 MB 窗口绰绰有余。
 *
 * 返回 signingBlock=null 表示该 APK 没有 v2+ 签名（可能只有 v1 / 完全未签）。
 */
export function parseApkSigningBlock(apkBuf: Buffer): ParseApkSignatureResult {
  const warnings: string[] = [];

  const eocdOff = findEocd(apkBuf);
  if (eocdOff < 0) {
    warnings.push('EOCD 未找到（文件可能不是合法 ZIP）');
    return { signingBlock: null, warnings };
  }

  // EOCD: signature(4) + diskNo(2) + diskStart(2) + diskEntries(2) + totalEntries(2)
  //       + cdSize(4) + cdOffset(4) + commentLen(2)
  const cdOffset = apkBuf.readUInt32LE(eocdOff + 16);
  if (cdOffset < 32 || cdOffset > apkBuf.length) {
    warnings.push(`EOCD.cd_offset=${cdOffset} 越界`);
    return { signingBlock: null, warnings };
  }

  // 检查 magic：cdOffset 前 16 字节（位于 cdOffset - 24 + 8 ）
  // signing block 结尾结构是  [size(8)] [magic(16)]，紧接 CD
  const magicOff = cdOffset - 16;
  const sizeRepeatOff = cdOffset - 24;
  if (magicOff < 8) {
    return { signingBlock: null, warnings };
  }

  const magicSlice = apkBuf.subarray(magicOff, cdOffset);
  if (!magicSlice.equals(APK_SIG_MAGIC)) {
    // 没有 signing block，APK 可能只有 v1 签名（这不是错误，是正常情况）
    return { signingBlock: null, warnings };
  }

  const sizeOfBlock = readU64LeAsInt(apkBuf, sizeRepeatOff);
  if (sizeOfBlock <= 24 || sizeOfBlock > cdOffset) {
    warnings.push(`signing block size_of_block=${sizeOfBlock} 越界`);
    return { signingBlock: null, warnings };
  }

  // signing block 起点 = cdOffset - sizeOfBlock - 8（首 8 字节 size 头）
  const blockStart = cdOffset - sizeOfBlock - 8;
  if (blockStart < 0) {
    warnings.push(`signing block 起点 ${blockStart} 为负（size_of_block 字段损坏）`);
    return { signingBlock: null, warnings };
  }

  const sizeHead = readU64LeAsInt(apkBuf, blockStart);
  if (sizeHead !== sizeOfBlock) {
    warnings.push(`signing block 头尾 size 字段不一致 head=${sizeHead} tail=${sizeOfBlock}`);
    // 继续解析（容错）
  }

  // 解析 pairs：起点 = blockStart + 8，结束 = sizeRepeatOff（不含尾部 size + magic）
  const pairsStart = blockStart + 8;
  const pairsEnd = sizeRepeatOff;
  const entries = parsePairs(apkBuf, pairsStart, pairsEnd, warnings);

  return {
    signingBlock: {
      totalBytes: sizeOfBlock + 8,
      offset: blockStart,
      entries,
    },
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */

function findEocd(buf: Buffer): number {
  const minOff = Math.max(0, buf.length - EOCD_MAX_SEARCH);
  // EOCD 起始最早出现位置：buf.length - EOCD_MIN_SIZE
  for (let i = buf.length - EOCD_MIN_SIZE; i >= minOff; i -= 1) {
    if (buf.readUInt32LE(i) === ZIP_EOCD_SIGNATURE) {
      return i;
    }
  }
  return -1;
}

/**
 * 解析 signing block pair 段。
 *
 * pair：8B length（含 4B ID + value） + 4B ID + value bytes
 * value 长度 = length - 4
 */
function parsePairs(
  buf: Buffer,
  start: number,
  end: number,
  warnings: string[],
): ApkSignatureBlockEntry[] {
  const out: ApkSignatureBlockEntry[] = [];
  let cursor = start;
  while (cursor + 12 <= end) {
    const length = readU64LeAsInt(buf, cursor);
    if (length < 4 || cursor + 8 + length > end) {
      warnings.push(`signing block pair @${cursor} length=${length} 越界，剩余字节丢弃`);
      break;
    }
    const id = buf.readUInt32LE(cursor + 8);
    const valueSize = length - 4;
    const idHex = formatIdHex(id);
    out.push({
      idHex,
      name: APK_SIG_KNOWN_IDS[idHex] ?? 'unknown',
      sizeBytes: valueSize,
    });
    cursor += 8 + length;
  }
  return out;
}

function formatIdHex(id: number): string {
  return `0x${id.toString(16).padStart(8, '0')}`;
}

/**
 * 读 little-endian u64 并返回 number。
 * Node 22+ 有 readBigUInt64LE，但我们 cast 回 number（APK 文件最大 4 GB，安全在 Number.MAX_SAFE_INTEGER 内）。
 */
function readU64LeAsInt(buf: Buffer, off: number): number {
  const lo = buf.readUInt32LE(off);
  const hi = buf.readUInt32LE(off + 4);
  // 不用 BigInt：APK 单文件不会超 2^53；hi 一般为 0
  return hi * 0x1_0000_0000 + lo;
}
