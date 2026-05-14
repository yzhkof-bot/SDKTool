import { stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import yauzl, { type ZipFile, type Entry } from 'yauzl';

import type { HapEntry, VirtualHap } from '../../shared/schema.js';
import { sha256OfFile } from '../../shared/utils.js';

/**
 * 打开一个 .hap（本质是 zip）文件，返回 VirtualHap：
 *  - entries 元信息一次性读完（用于 size / 路径分析）
 *  - 文件内容按需读取，避免大 hap 全量解压
 *
 * 实现说明：yauzl 默认 lazyEntries=true，需要主动 readEntry() 触发下一条 entry 事件。
 * 我们先把所有 entry 元信息收集到数组，再按需通过 openReadStream 取内容。
 */
export async function openHap(filePath: string): Promise<VirtualHap> {
  const absPath = resolvePath(filePath);
  const fileStat = await stat(absPath);
  if (!fileStat.isFile()) {
    throw new Error(`Not a regular file: ${absPath}`);
  }

  const sha256 = await sha256OfFile(absPath);
  const zip = await openZip(absPath);
  const entries = await readAllEntries(zip);

  const entryByPath = new Map<string, Entry>();
  for (const e of entries.rawEntries) {
    entryByPath.set(normalizePath(e.fileName), e);
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((res) => {
      try {
        zip.close();
        res();
      } catch {
        res();
      }
    });
  };

  const readFile = async (path: string): Promise<Buffer> => {
    if (closed) throw new Error('VirtualHap already closed');
    const normalized = normalizePath(path);
    const entry = entryByPath.get(normalized);
    if (!entry) {
      throw new Error(`Entry not found in hap: ${path}`);
    }
    if (isDirectoryEntry(entry)) {
      throw new Error(`Entry is a directory, not a file: ${path}`);
    }
    return await readEntryBuffer(zip, entry);
  };

  const readText = async (path: string): Promise<string> => {
    const buf = await readFile(path);
    return buf.toString('utf8');
  };

  return {
    filePath: absPath,
    fileSize: fileStat.size,
    sha256,
    entries: entries.metas,
    readFile,
    readText,
    close,
  };
}

/* ------------------------------------------------------------------ */
/* internals                                                          */
/* ------------------------------------------------------------------ */

function openZip(filePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (err, zipFile) => {
      if (err || !zipFile) {
        reject(err ?? new Error('Failed to open zip'));
        return;
      }
      resolve(zipFile);
    });
  });
}

function readAllEntries(zip: ZipFile): Promise<{ metas: HapEntry[]; rawEntries: Entry[] }> {
  return new Promise((resolve, reject) => {
    const metas: HapEntry[] = [];
    const rawEntries: Entry[] = [];

    zip.on('entry', (entry: Entry) => {
      const isDir = isDirectoryEntry(entry);
      metas.push({
        path: normalizePath(entry.fileName),
        isDirectory: isDir,
        uncompressedSize: entry.uncompressedSize,
        compressedSize: entry.compressedSize,
        lastModified: entry.getLastModDate?.(),
        crc32: entry.crc32,
      });
      rawEntries.push(entry);
      zip.readEntry();
    });

    zip.on('end', () => resolve({ metas, rawEntries }));
    zip.on('error', reject);

    zip.readEntry();
  });
}

function readEntryBuffer(zip: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new Error('Failed to open read stream'));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

function isDirectoryEntry(entry: Entry): boolean {
  return /\/$/.test(entry.fileName);
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}
