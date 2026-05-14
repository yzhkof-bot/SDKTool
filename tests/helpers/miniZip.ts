import { writeFile } from 'node:fs/promises';

/**
 * 测试用最小 ZIP 写入器（只支持 store 模式，不压缩）。
 *
 * 仅用于在 vitest 里动态构造 fixture hap，避免在仓库中提交二进制文件。
 * 不要在生产代码里使用。
 *
 * 格式参考：APPNOTE.TXT v6.3.10 §4
 * 这里只实现：本地文件头 + 中央目录 + EOCD，足够 yauzl 解析。
 */

export interface ZipEntry {
  /** 在 zip 内的相对路径（使用正斜杠） */
  path: string;
  /** 文件内容；目录传 undefined */
  content?: Buffer | string;
}

/** 写一个 zip 到指定路径 */
export async function writeMiniZip(filePath: string, entries: ZipEntry[]): Promise<void> {
  const buf = buildMiniZip(entries);
  await writeFile(filePath, buf);
}

export function buildMiniZip(entries: ZipEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const isDir = entry.content === undefined || entry.path.endsWith('/');
    const data = isDir
      ? Buffer.alloc(0)
      : Buffer.isBuffer(entry.content)
        ? entry.content
        : Buffer.from(entry.content as string, 'utf8');

    const nameBuf = Buffer.from(entry.path, 'utf8');
    const crc = crc32(data);
    const size = data.length;
    const externalAttrs = isDir ? 0x10 : 0; // dir bit

    // Local File Header
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4);          // version needed
    localHeader.writeUInt16LE(0, 6);           // flags
    localHeader.writeUInt16LE(0, 8);           // compression: store
    localHeader.writeUInt16LE(0, 10);          // mod time
    localHeader.writeUInt16LE(0, 12);          // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);       // compressed
    localHeader.writeUInt32LE(size, 22);       // uncompressed
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);          // extra length

    localChunks.push(localHeader, nameBuf, data);

    // Central Directory File Header
    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0);
    cdHeader.writeUInt16LE(20, 4);             // version made by
    cdHeader.writeUInt16LE(20, 6);             // version needed
    cdHeader.writeUInt16LE(0, 8);              // flags
    cdHeader.writeUInt16LE(0, 10);             // compression
    cdHeader.writeUInt16LE(0, 12);             // mod time
    cdHeader.writeUInt16LE(0, 14);             // mod date
    cdHeader.writeUInt32LE(crc, 16);
    cdHeader.writeUInt32LE(size, 20);
    cdHeader.writeUInt32LE(size, 24);
    cdHeader.writeUInt16LE(nameBuf.length, 28);
    cdHeader.writeUInt16LE(0, 30);             // extra
    cdHeader.writeUInt16LE(0, 32);             // comment
    cdHeader.writeUInt16LE(0, 34);             // disk
    cdHeader.writeUInt16LE(0, 36);             // internal attrs
    cdHeader.writeUInt32LE(externalAttrs, 38);
    cdHeader.writeUInt32LE(offset, 42);        // local header offset
    centralChunks.push(cdHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + data.length;
  }

  const centralBuffer = Buffer.concat(centralChunks);
  const localBuffer = Buffer.concat(localChunks);

  // EOCD
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                    // disk no
  eocd.writeUInt16LE(0, 6);                    // disk start
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(localBuffer.length, 16);
  eocd.writeUInt16LE(0, 20);                   // comment len

  return Buffer.concat([localBuffer, centralBuffer, eocd]);
}

/* CRC-32 (IEEE 802.3) */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i] ?? 0;
    const tableValue = CRC_TABLE[(c ^ byte) & 0xff] ?? 0;
    c = tableValue ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
