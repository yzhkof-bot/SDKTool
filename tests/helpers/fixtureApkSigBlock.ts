/**
 * APK Signing Block 二进制构造器（fixture 用）。
 *
 * 输出与 Android 标准（developer.android.com/about/versions/nougat/android-7.0#apk_signature_scheme_v2）
 * 一致的 block：[size_of_block(8)] [pairs] [size_of_block(8)] [magic(16)]
 *
 * fixture 只需要让 androidApkSignature analyzer 能识别 ID（标记 versions.v2/v3/v3.1），
 * 所以 value bytes 直接用占位 buffer，不构造完整的 V2 SignerInfo / digests / certs 三层结构。
 */

export interface SigningBlockPair {
  /** Pair ID（u32），例如 0x7109871a 表示 V2 */
  id: number;
  /** value 字节（fixture 一般用占位 Buffer，长度任意） */
  value: Buffer;
}

export const APK_SIG_ID_V2 = 0x7109871a;
export const APK_SIG_ID_V3 = 0xf05368c0;
export const APK_SIG_ID_V31 = 0x1b93ad61;
export const APK_SIG_ID_PADDING = 0x504b4453;
export const APK_SIG_ID_SOURCE_STAMP = 0x42726577;

const APK_SIG_MAGIC = Buffer.from('APK Sig Block 42', 'ascii'); // 16 bytes

export function buildApkSigningBlock(pairs: SigningBlockPair[]): Buffer {
  const pairBufs: Buffer[] = [];
  for (const p of pairs) {
    const length = 4 + p.value.length; // 4 字节 ID + value
    const head = Buffer.alloc(12);
    writeU64Le(head, 0, length); // pair length（含 ID）
    head.writeUInt32LE(p.id >>> 0, 8); // pair ID（无符号写入）
    pairBufs.push(head, p.value);
  }
  const pairsBuf = Buffer.concat(pairBufs);

  // size_of_block 含尾部 size 重复(8) + magic(16) + 所有 pair 字节
  const sizeOfBlock = pairsBuf.length + 8 + APK_SIG_MAGIC.length;

  const sizeHead = Buffer.alloc(8);
  writeU64Le(sizeHead, 0, sizeOfBlock);
  const sizeTail = Buffer.alloc(8);
  writeU64Le(sizeTail, 0, sizeOfBlock);

  return Buffer.concat([sizeHead, pairsBuf, sizeTail, APK_SIG_MAGIC]);
}

function writeU64Le(buf: Buffer, off: number, value: number): void {
  if (value < 0 || !Number.isFinite(value)) throw new Error(`writeU64Le invalid value=${value}`);
  buf.writeUInt32LE(value >>> 0, off);
  buf.writeUInt32LE(Math.floor(value / 0x1_0000_0000), off + 4);
}

/**
 * 内置 demo signing block：包含 v2 + v3 + padding 三个 pair。
 *
 * 用 64 字节占位 buffer 作为 value（数字签名格式不验证），让 analyzer 能识别 ID
 * 并标 versions.v2 = versions.v3 = true。
 */
export function buildDemoApkSigningBlock(): Buffer {
  return buildApkSigningBlock([
    { id: APK_SIG_ID_V2, value: Buffer.alloc(64, 0x21) },
    { id: APK_SIG_ID_V3, value: Buffer.alloc(64, 0x33) },
    { id: APK_SIG_ID_PADDING, value: Buffer.alloc(32, 0x00) },
  ]);
}
