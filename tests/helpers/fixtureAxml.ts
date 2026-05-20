/**
 * AXML fixture builder：用 TS 直接拼一个最小的 Android Binary XML buffer，
 * 给 AXML parser 单测用。不追求功能完整（不支持 CDATA / style），只够覆盖
 * AndroidManifest.xml 抽取所需的：StringPool / Namespace / StartElement /
 * EndElement / 三种 ResValue 类型（string / int / boolean）。
 *
 * 注意：构造时所有 attribute name 都直接存在 string pool 里（aapt2 的"空名字 +
 * ResourceMap 反查"路径需要另外测试）；这种方式生成的 AXML 仍然是标准合规
 * 的，被 Android framework 和 aapt 都接受。
 */

import { Buffer } from 'node:buffer';

const RES_XML_TYPE = 0x0003;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_START_NAMESPACE_TYPE = 0x0100;
const RES_XML_END_NAMESPACE_TYPE = 0x0101;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;

const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_BOOLEAN = 0x12;

export type AxmlValue =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean };

export interface AttrSpec {
  /** 属性 namespace uri；不写表示无 namespace（如 manifest 上的 package） */
  ns?: string;
  name: string;
  value: AxmlValue;
}

export interface ElementSpec {
  ns?: string;
  name: string;
  attributes?: AttrSpec[];
  children?: ElementSpec[];
}

export interface BuildAxmlOptions {
  /** 文件级 namespace 声明，会写在最外层 element 之前；通常是 android 命名空间 */
  namespaces?: Array<{ prefix: string; uri: string }>;
  root: ElementSpec;
}

/**
 * 用 spec 构造一个 AXML buffer。
 *
 * 处理流程：
 *  1) 先把 spec 全部走一遍，把出现的所有字符串收进 string pool（去重）。
 *     注意：value.kind='string' 的值也要进 pool，因为 AXML 的 ResValue/STRING 是
 *     一个指向 pool 的索引。
 *  2) 再渲染 element chunks（拿到 pool 索引后才能写 nsRef / nameRef）。
 *  3) 最后拼成总 buffer，回填文件头 size。
 */
export function buildAxml(opts: BuildAxmlOptions): Buffer {
  const pool = new StringPoolBuilder();

  for (const ns of opts.namespaces ?? []) {
    pool.add(ns.prefix);
    pool.add(ns.uri);
  }
  collectStrings(opts.root, pool);

  const elementChunks: Buffer[] = [];
  for (const ns of opts.namespaces ?? []) {
    elementChunks.push(buildNamespaceChunk(RES_XML_START_NAMESPACE_TYPE, pool.indexOf(ns.prefix), pool.indexOf(ns.uri)));
  }
  renderElement(opts.root, pool, elementChunks);
  for (const ns of [...(opts.namespaces ?? [])].reverse()) {
    elementChunks.push(buildNamespaceChunk(RES_XML_END_NAMESPACE_TYPE, pool.indexOf(ns.prefix), pool.indexOf(ns.uri)));
  }

  const stringPoolChunk = pool.build();
  const bodySize = stringPoolChunk.length + sumLen(elementChunks);
  const fileHeaderSize = 8;

  const fileHeader = Buffer.alloc(fileHeaderSize);
  fileHeader.writeUInt16LE(RES_XML_TYPE, 0);
  fileHeader.writeUInt16LE(fileHeaderSize, 2);
  fileHeader.writeUInt32LE(fileHeaderSize + bodySize, 4);

  return Buffer.concat([fileHeader, stringPoolChunk, ...elementChunks]);
}

/* ============================================================ */
/* StringPool                                                    */
/* ============================================================ */

class StringPoolBuilder {
  private strings: string[] = [];
  private map = new Map<string, number>();

  /** 加字符串到池，返回索引。重复字符串去重（aapt 默认行为）。 */
  add(s: string): number {
    const cached = this.map.get(s);
    if (cached !== undefined) return cached;
    const idx = this.strings.length;
    this.map.set(s, idx);
    this.strings.push(s);
    return idx;
  }

  /** 取已添加字符串的索引；不存在抛错（调用方应保证先 add） */
  indexOf(s: string): number {
    const idx = this.map.get(s);
    if (idx === undefined) throw new Error(`string not in pool: ${JSON.stringify(s)}`);
    return idx;
  }

  build(): Buffer {
    const count = this.strings.length;
    const headerSize = 28;
    const offsetTableSize = count * 4;

    // 每个字符串：u16 len + len * 2 bytes UTF-16 + u16 null terminator
    const stringBytes: Buffer[] = this.strings.map((s) => {
      const buf = Buffer.alloc(2 + s.length * 2 + 2);
      buf.writeUInt16LE(s.length, 0);
      buf.write(s, 2, 'utf16le');
      // 最后 2 bytes 是 0（Buffer.alloc 已经 0 初始化）
      return buf;
    });

    const offsets = Buffer.alloc(offsetTableSize);
    let cursor = 0;
    for (let i = 0; i < count; i++) {
      offsets.writeUInt32LE(cursor, i * 4);
      cursor += stringBytes[i].length;
    }
    // chunk 4-byte 对齐：AXML 解析器对 chunk size 不要求 4 字节对齐，但 aapt
    // 写出的真实文件会 pad。padding 这里也加上以接近真实环境。
    const stringsLen = cursor;
    const padding = (4 - (stringsLen % 4)) % 4;
    const padBuf = Buffer.alloc(padding);

    const stringsStart = headerSize + offsetTableSize;
    const totalSize = stringsStart + stringsLen + padding;

    const header = Buffer.alloc(headerSize);
    header.writeUInt16LE(RES_STRING_POOL_TYPE, 0);
    header.writeUInt16LE(headerSize, 2);
    header.writeUInt32LE(totalSize, 4);
    header.writeUInt32LE(count, 8);
    header.writeUInt32LE(0, 12); // styleCount
    header.writeUInt32LE(0, 16); // flags（UTF-16，未置 UTF8 bit）
    header.writeUInt32LE(stringsStart, 20);
    header.writeUInt32LE(0, 24); // stylesStart

    return Buffer.concat([header, offsets, ...stringBytes, padBuf]);
  }
}

/* ============================================================ */
/* spec → string pool                                            */
/* ============================================================ */

function collectStrings(el: ElementSpec, pool: StringPoolBuilder): void {
  if (el.ns) pool.add(el.ns);
  pool.add(el.name);
  for (const a of el.attributes ?? []) {
    if (a.ns) pool.add(a.ns);
    pool.add(a.name);
    if (a.value.kind === 'string') {
      pool.add(a.value.value);
    }
  }
  for (const c of el.children ?? []) collectStrings(c, pool);
}

/* ============================================================ */
/* element chunks                                                */
/* ============================================================ */

function renderElement(
  el: ElementSpec,
  pool: StringPoolBuilder,
  out: Buffer[],
): void {
  out.push(buildStartElementChunk(el, pool));
  for (const c of el.children ?? []) renderElement(c, pool, out);
  out.push(buildEndElementChunk(el, pool));
}

/**
 * StartElement chunk 布局：
 *   header(8) + lineNumber(u32) + commentRef(u32) = 16 字节 headerSize
 *   body:
 *     nsRef(u32) + nameRef(u32)
 *     attrStart(u16) + attrSize(u16) + attrCount(u16)
 *     idIndex(u16) + classIndex(u16) + styleIndex(u16)
 *   attributes: attrCount * 20 字节
 */
function buildStartElementChunk(el: ElementSpec, pool: StringPoolBuilder): Buffer {
  const headerSize = 16;
  const bodySize = 20;
  const attrSize = 20;
  const attrs = el.attributes ?? [];

  const chunkSize = headerSize + bodySize + attrs.length * attrSize;
  const buf = Buffer.alloc(chunkSize);

  // header
  buf.writeUInt16LE(RES_XML_START_ELEMENT_TYPE, 0);
  buf.writeUInt16LE(headerSize, 2);
  buf.writeUInt32LE(chunkSize, 4);
  buf.writeUInt32LE(0, 8); // lineNumber
  buf.writeInt32LE(-1, 12); // commentRef

  // body
  buf.writeInt32LE(el.ns ? pool.indexOf(el.ns) : -1, 16);
  buf.writeInt32LE(pool.indexOf(el.name), 20);
  buf.writeUInt16LE(bodySize, 24); // attrStart：相对 body 起点偏移
  buf.writeUInt16LE(attrSize, 26);
  buf.writeUInt16LE(attrs.length, 28);
  buf.writeUInt16LE(0, 30); // idIndex (1-based; 0 = none)
  buf.writeUInt16LE(0, 32);
  buf.writeUInt16LE(0, 34);

  // attributes
  let off = headerSize + bodySize;
  for (const a of attrs) {
    writeAttribute(buf, off, a, pool);
    off += attrSize;
  }
  return buf;
}

/**
 * Attribute 布局：
 *   nsRef(u32) + nameRef(u32) + rawValueRef(u32)
 *   ResValue: size(u16) + res0(u8) + dataType(u8) + data(u32)
 */
function writeAttribute(buf: Buffer, off: number, a: AttrSpec, pool: StringPoolBuilder): void {
  buf.writeInt32LE(a.ns ? pool.indexOf(a.ns) : -1, off);
  buf.writeInt32LE(pool.indexOf(a.name), off + 4);

  let rawRef = -1;
  let dataType: number;
  let data: number;

  switch (a.value.kind) {
    case 'string': {
      const idx = pool.indexOf(a.value.value);
      rawRef = idx;
      dataType = TYPE_STRING;
      data = idx;
      break;
    }
    case 'int': {
      dataType = TYPE_INT_DEC;
      data = a.value.value | 0;
      break;
    }
    case 'boolean': {
      dataType = TYPE_INT_BOOLEAN;
      data = a.value.value ? 0xffffffff : 0;
      break;
    }
  }

  buf.writeInt32LE(rawRef, off + 8);
  buf.writeUInt16LE(8, off + 12); // ResValue size
  buf.writeUInt8(0, off + 14); // res0
  buf.writeUInt8(dataType, off + 15);
  buf.writeUInt32LE(data >>> 0, off + 16);
}

function buildEndElementChunk(el: ElementSpec, pool: StringPoolBuilder): Buffer {
  const headerSize = 16;
  const bodySize = 8;
  const chunkSize = headerSize + bodySize;
  const buf = Buffer.alloc(chunkSize);
  buf.writeUInt16LE(RES_XML_END_ELEMENT_TYPE, 0);
  buf.writeUInt16LE(headerSize, 2);
  buf.writeUInt32LE(chunkSize, 4);
  buf.writeUInt32LE(0, 8); // lineNumber
  buf.writeInt32LE(-1, 12); // commentRef
  buf.writeInt32LE(el.ns ? pool.indexOf(el.ns) : -1, 16);
  buf.writeInt32LE(pool.indexOf(el.name), 20);
  return buf;
}

function buildNamespaceChunk(type: number, prefixIdx: number, uriIdx: number): Buffer {
  const headerSize = 16;
  const bodySize = 8;
  const chunkSize = headerSize + bodySize;
  const buf = Buffer.alloc(chunkSize);
  buf.writeUInt16LE(type, 0);
  buf.writeUInt16LE(headerSize, 2);
  buf.writeUInt32LE(chunkSize, 4);
  buf.writeUInt32LE(0, 8); // lineNumber
  buf.writeInt32LE(-1, 12); // commentRef
  buf.writeInt32LE(prefixIdx, 16);
  buf.writeInt32LE(uriIdx, 20);
  return buf;
}

function sumLen(bufs: Buffer[]): number {
  let n = 0;
  for (const b of bufs) n += b.length;
  return n;
}
