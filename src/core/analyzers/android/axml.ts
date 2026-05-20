/**
 * 零依赖的 Android Binary XML (AXML) 解析器。
 *
 * 用于解析 APK 内的 AndroidManifest.xml（以及 layout.xml 等其它 AXML），但本期
 * 只暴露 manifest 抽取所需的最小能力（StringPool / ResourceMap / 元素树）。
 *
 * 参考资料：
 *   - AOSP frameworks/base/libs/androidfw/include/androidfw/ResourceTypes.h
 *   - https://github.com/iBotPeaches/Apktool/blob/master/brut.apktool/apktool-lib/src/main/java/brut/androlib/res/decoder/AXmlResourceParser.java
 *
 * 设计取舍：
 *   - 输出一棵 DOM-like 的 AxmlNode 树，简单直观；manifest 信息量小，没有性能压力。
 *   - 不做完整 ResValue 格式化（只覆盖 manifest 常见类型：string / int / boolean / reference）。
 *   - chunk 解析失败时不抛异常，而是把异常累计到 warnings 数组里，尽量返回半截结果，
 *     这样上层 analyzer 可以根据 root != null 判断是否可用。
 */

/* ============================================================ */
/* 常量                                                          */
/* ============================================================ */

const RES_XML_TYPE = 0x0003;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const RES_XML_START_NAMESPACE_TYPE = 0x0100;
const RES_XML_END_NAMESPACE_TYPE = 0x0101;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;
const RES_XML_CDATA_TYPE = 0x0104;

const STRING_POOL_UTF8_FLAG = 1 << 8;

const TYPE_NULL = 0x00;
const TYPE_REFERENCE = 0x01;
const TYPE_ATTRIBUTE = 0x02;
const TYPE_STRING = 0x03;
const TYPE_FLOAT = 0x04;
const TYPE_DIMENSION = 0x05;
const TYPE_FRACTION = 0x06;
const TYPE_DYNAMIC_REFERENCE = 0x07;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_INT_BOOLEAN = 0x12;

/** 常见 system attribute resource id → 名字。  
 *  AXML 的 attribute name 在 string pool 里有时是空字符串（aapt2 优化），此时
 *  需要通过 XmlResourceMap 拿到 resource id，再反查这张表才能得到 attr 名。  
 *  下面只列 manifest 里用到的常见项；不在表里的会保持 rawNameRef 对应字符串
 *  （多数为空），抽取层会 fallback 跳过。  
 *
 *  这些 resource id 自 Android 1.0 起即冻结，跨 SDK 版本稳定。 */
export const ANDROID_ATTR_RESID: Readonly<Record<number, string>> = Object.freeze({
  0x01010001: 'label',
  0x01010002: 'icon',
  0x01010003: 'name',
  0x01010006: 'permission',
  0x0101000c: 'hasCode',
  0x0101000f: 'debuggable',
  0x01010010: 'exported',
  0x01010018: 'authorities',
  0x0101001e: 'enabled',
  0x0101020c: 'minSdkVersion',
  0x0101021b: 'versionCode',
  0x0101021c: 'versionName',
  0x01010270: 'targetSdkVersion',
  0x01010271: 'maxSdkVersion',
});

/* ============================================================ */
/* Public API                                                    */
/* ============================================================ */

export interface ResValue {
  /** 见 TYPE_XXX 常量 */
  dataType: number;
  /** 原始 32-bit 数据；string 类型时是 string pool ref，reference 类型时是 resource id */
  data: number;
}

export interface AxmlAttribute {
  /** 属性的 namespace uri（如 "http://schemas.android.com/apk/res/android"），无 namespace 时为 null */
  namespace: string | null;
  /** 属性名（如 "versionCode"） */
  name: string;
  /** AXML 给的原始字符串值；多数情况下与 typedValue 等价，但当 typedValue 是 int/bool 时为 null */
  rawValue: string | null;
  typedValue: ResValue;
  /**
   * 已格式化为可读字符串的 typedValue。
   *   - TYPE_STRING：直接取 string pool 中的字符串
   *   - TYPE_INT_DEC / INT_HEX：十进制 / 0x 十六进制
   *   - TYPE_INT_BOOLEAN：'true' / 'false'
   *   - TYPE_REFERENCE：'@0x01010001' 形式（manifest 里通常是 @string/@mipmap/@drawable）
   *   - 其它：'<type=0xNN data=0xNN>'
   */
  value: string;
}

export interface AxmlNode {
  /** 元素的 namespace uri，无 namespace 时为 null */
  namespace: string | null;
  /** 元素标签名（如 "manifest"、"uses-permission"） */
  name: string;
  attributes: AxmlAttribute[];
  children: AxmlNode[];
}

export interface AxmlParseResult {
  /** 解析得到的根节点；如果文件 header 损坏或没有 element，为 null */
  root: AxmlNode | null;
  /** 解析期累积的非致命异常（chunk 损坏 / 未知类型等）。致命异常会抛出 */
  warnings: string[];
}

/**
 * 解析 AXML 二进制内容。
 *
 * 失败处理策略：
 *  - 文件头不是 RES_XML_TYPE：抛 Error（致命，调用方一般会 catch 并写入 warning）
 *  - 单个 chunk 越界 / 类型未知：记 warning，跳过该 chunk
 *  - 字符串引用越界：抽取层会以空字符串 fallback，并记 warning
 */
export function parseAxml(buffer: Buffer): AxmlParseResult {
  if (buffer.length < 8) {
    throw new Error(`AXML too small: ${buffer.length} bytes`);
  }

  const fileHeader = readChunkHeader(buffer, 0);
  if (fileHeader.type !== RES_XML_TYPE) {
    throw new Error(
      `Not an AXML file: chunk type=0x${fileHeader.type.toString(16)} (expected 0x${RES_XML_TYPE.toString(16)})`,
    );
  }
  if (fileHeader.size > buffer.length) {
    throw new Error(`AXML file header size ${fileHeader.size} exceeds buffer ${buffer.length}`);
  }

  const warnings: string[] = [];
  let cursor = fileHeader.headerSize;
  const endCursor = fileHeader.size;

  let stringPool: StringPool = EMPTY_STRING_POOL;
  /** XmlResourceMap：string pool index → android attr resource id  */
  let resourceMap: number[] = [];

  // 用栈维护当前 open 的 element，end-element 弹栈
  const stack: AxmlNode[] = [];
  let root: AxmlNode | null = null;
  /** namespace prefix → uri（仅用 uri） */
  const nsStack: Array<{ prefix: number; uri: number }> = [];

  while (cursor + 8 <= endCursor) {
    const header = readChunkHeader(buffer, cursor);
    if (header.size === 0 || cursor + header.size > endCursor) {
      warnings.push(
        `chunk at offset ${cursor} has invalid size ${header.size} (remaining=${endCursor - cursor}); stop parsing`,
      );
      break;
    }
    const chunkEnd = cursor + header.size;

    try {
      switch (header.type) {
        case RES_STRING_POOL_TYPE: {
          stringPool = parseStringPool(buffer, cursor, header);
          break;
        }
        case RES_XML_RESOURCE_MAP_TYPE: {
          resourceMap = parseResourceMap(buffer, cursor, header);
          break;
        }
        case RES_XML_START_NAMESPACE_TYPE: {
          const ns = parseNamespace(buffer, cursor, header);
          nsStack.push(ns);
          break;
        }
        case RES_XML_END_NAMESPACE_TYPE: {
          if (nsStack.length > 0) nsStack.pop();
          break;
        }
        case RES_XML_START_ELEMENT_TYPE: {
          const node = parseStartElement(
            buffer,
            cursor,
            header,
            stringPool,
            resourceMap,
            warnings,
          );
          if (stack.length === 0) {
            if (root) {
              warnings.push(
                `multiple root elements; ignoring '${node.name}' (kept '${root.name}')`,
              );
              stack.push(node); // 仍入栈以匹配 end，避免栈错位
            } else {
              root = node;
              stack.push(node);
            }
          } else {
            const top = stack[stack.length - 1]!;
            top.children.push(node);
            stack.push(node);
          }
          break;
        }
        case RES_XML_END_ELEMENT_TYPE: {
          if (stack.length > 0) stack.pop();
          break;
        }
        case RES_XML_CDATA_TYPE: {
          // manifest 里基本不会出现 CDATA，且 AndroidManifestInfo 不需要文本，
          // 直接忽略保持 parser 行为简单；如果将来要解析 layout，再扩展。
          break;
        }
        default: {
          warnings.push(`unknown chunk type 0x${header.type.toString(16)} at offset ${cursor}`);
          break;
        }
      }
    } catch (err) {
      warnings.push(
        `failed to parse chunk type=0x${header.type.toString(16)} at offset ${cursor}: ${(err as Error).message}`,
      );
    }

    cursor = chunkEnd;
  }

  return { root, warnings };
}

/* ============================================================ */
/* StringPool                                                    */
/* ============================================================ */

interface StringPool {
  strings: string[];
  /** AXML 标记字符串池是 UTF-8 还是 UTF-16 编码 */
  utf8: boolean;
}

const EMPTY_STRING_POOL: StringPool = { strings: [], utf8: false };

/** 取 string pool 中第 idx 个字符串；越界返回空字符串（manifest 容错） */
function getString(pool: StringPool, idx: number): string {
  if (idx < 0 || idx >= pool.strings.length) return '';
  return pool.strings[idx] ?? '';
}

function parseStringPool(buf: Buffer, chunkOffset: number, header: ChunkHeader): StringPool {
  // 头部：ResChunk_header(8) + 5 个 u32 字段 = 28 bytes
  const stringCount = buf.readUInt32LE(chunkOffset + 8);
  // const styleCount = buf.readUInt32LE(chunkOffset + 12);
  const flags = buf.readUInt32LE(chunkOffset + 16);
  const stringsStart = buf.readUInt32LE(chunkOffset + 20);
  // const stylesStart = buf.readUInt32LE(chunkOffset + 24);

  const utf8 = (flags & STRING_POOL_UTF8_FLAG) !== 0;
  const offsetsBase = chunkOffset + header.headerSize;
  const stringsBase = chunkOffset + stringsStart;

  const strings: string[] = new Array(stringCount);
  for (let i = 0; i < stringCount; i++) {
    const off = buf.readUInt32LE(offsetsBase + i * 4);
    const stringOffset = stringsBase + off;
    strings[i] = utf8 ? decodeUtf8String(buf, stringOffset) : decodeUtf16String(buf, stringOffset);
  }
  return { strings, utf8 };
}

/**
 * AXML UTF-8 字符串编码：
 *   - utf16 长度：u8（高位 0x80 表示后面再跟一个 u8 拼成 15-bit 数）
 *   - utf8 长度：u8（同样的高位扩展规则）
 *   - 长度个字节的 UTF-8 数据
 *   - 0x00 结尾
 */
function decodeUtf8String(buf: Buffer, offset: number): string {
  let cursor = offset;
  // 第一组：utf16Length（用不到，但要跳过）
  let firstByte = buf.readUInt8(cursor++);
  if ((firstByte & 0x80) !== 0) cursor++;
  // 第二组：utf8Length
  let utf8Len = buf.readUInt8(cursor++);
  if ((utf8Len & 0x80) !== 0) {
    utf8Len = ((utf8Len & 0x7f) << 8) | buf.readUInt8(cursor++);
  }
  return buf.toString('utf8', cursor, cursor + utf8Len);
}

/**
 * AXML UTF-16 字符串编码：
 *   - 长度：u16（高位 0x8000 表示后面再跟一个 u16 拼成 31-bit 数；通常用不到）
 *   - 长度个 UTF-16 code unit (LE)
 *   - u16 0 结尾
 */
function decodeUtf16String(buf: Buffer, offset: number): string {
  let cursor = offset;
  let len = buf.readUInt16LE(cursor);
  cursor += 2;
  if ((len & 0x8000) !== 0) {
    len = ((len & 0x7fff) << 16) | buf.readUInt16LE(cursor);
    cursor += 2;
  }
  return buf.toString('utf16le', cursor, cursor + len * 2);
}

/* ============================================================ */
/* ResourceMap                                                   */
/* ============================================================ */

function parseResourceMap(buf: Buffer, chunkOffset: number, header: ChunkHeader): number[] {
  const idsByteLen = header.size - header.headerSize;
  const count = Math.floor(idsByteLen / 4);
  const base = chunkOffset + header.headerSize;
  const ids: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    ids[i] = buf.readUInt32LE(base + i * 4);
  }
  return ids;
}

/* ============================================================ */
/* Namespace                                                     */
/* ============================================================ */

function parseNamespace(
  buf: Buffer,
  chunkOffset: number,
  header: ChunkHeader,
): { prefix: number; uri: number } {
  // header(8) + lineNumber(4) + commentRef(4) = 16
  const body = chunkOffset + header.headerSize;
  return {
    prefix: buf.readUInt32LE(body),
    uri: buf.readUInt32LE(body + 4),
  };
}

/* ============================================================ */
/* StartElement                                                  */
/* ============================================================ */

function parseStartElement(
  buf: Buffer,
  chunkOffset: number,
  header: ChunkHeader,
  pool: StringPool,
  resMap: number[],
  warnings: string[],
): AxmlNode {
  // header(8) + lineNumber(4) + commentRef(4) = 16
  const body = chunkOffset + header.headerSize;
  const nsRef = buf.readInt32LE(body);
  const nameRef = buf.readInt32LE(body + 4);
  const attrStart = buf.readUInt16LE(body + 8);
  const attrSize = buf.readUInt16LE(body + 10);
  const attrCount = buf.readUInt16LE(body + 12);
  // idIndex/classIndex/styleIndex 用不到
  // const idIndex = buf.readUInt16LE(body + 14);
  // const classIndex = buf.readUInt16LE(body + 16);
  // const styleIndex = buf.readUInt16LE(body + 18);

  const node: AxmlNode = {
    namespace: nsRef === -1 ? null : getString(pool, nsRef),
    name: getString(pool, nameRef),
    attributes: [],
    children: [],
  };

  const attrsBase = body + attrStart;
  for (let i = 0; i < attrCount; i++) {
    const attrOff = attrsBase + i * attrSize;
    try {
      const attr = parseAttribute(buf, attrOff, pool, resMap);
      node.attributes.push(attr);
    } catch (err) {
      warnings.push(
        `failed to parse attribute #${i} of <${node.name}>: ${(err as Error).message}`,
      );
    }
  }

  return node;
}

function parseAttribute(
  buf: Buffer,
  offset: number,
  pool: StringPool,
  resMap: number[],
): AxmlAttribute {
  // u32 nsRef, u32 nameRef, u32 rawValueRef, ResValue{u16 size, u8 res0, u8 dataType, u32 data}
  const nsRef = buf.readInt32LE(offset);
  const nameRef = buf.readInt32LE(offset + 4);
  const rawValueRef = buf.readInt32LE(offset + 8);
  // ResValue 起始
  // const resValueSize = buf.readUInt16LE(offset + 12);
  // const res0 = buf.readUInt8(offset + 14);
  const dataType = buf.readUInt8(offset + 15);
  const data = buf.readUInt32LE(offset + 16);

  let name = nameRef === -1 ? '' : getString(pool, nameRef);
  if (!name && nameRef >= 0 && nameRef < resMap.length) {
    // 走 ResourceMap 反查：根据 resource id 拿"标准"属性名
    const resId = resMap[nameRef];
    if (resId !== undefined) {
      const known = ANDROID_ATTR_RESID[resId];
      if (known) name = known;
    }
  }

  const rawValue = rawValueRef === -1 ? null : getString(pool, rawValueRef);
  const typedValue: ResValue = { dataType, data };

  return {
    namespace: nsRef === -1 ? null : getString(pool, nsRef),
    name,
    rawValue,
    typedValue,
    value: formatResValue(typedValue, rawValue, pool),
  };
}

/**
 * 把 ResValue 渲染成可读字符串。
 *
 * 优先级：
 *  1. TYPE_STRING：取 string pool 中 data 索引对应的字符串
 *  2. TYPE_INT_BOOLEAN：'true' / 'false'（0xFFFFFFFF = true, 0 = false）
 *  3. TYPE_INT_DEC / INT_HEX：直接展示数字
 *  4. TYPE_REFERENCE：'@0x{id}' 形式
 *  5. 其它：fallback 到 rawValue（如果有）或 '<type=0xNN data=0xNN>'
 */
function formatResValue(value: ResValue, rawValue: string | null, pool: StringPool): string {
  switch (value.dataType) {
    case TYPE_NULL:
      return '';
    case TYPE_STRING:
      return getString(pool, value.data);
    case TYPE_INT_BOOLEAN:
      return value.data === 0 ? 'false' : 'true';
    case TYPE_INT_DEC:
      return String(value.data | 0);
    case TYPE_INT_HEX:
      return '0x' + (value.data >>> 0).toString(16);
    case TYPE_REFERENCE:
    case TYPE_DYNAMIC_REFERENCE:
      return '@0x' + (value.data >>> 0).toString(16);
    case TYPE_ATTRIBUTE:
      return '?0x' + (value.data >>> 0).toString(16);
    case TYPE_FLOAT: {
      const f = new Float32Array(new Uint32Array([value.data >>> 0]).buffer)[0];
      return String(f);
    }
    case TYPE_DIMENSION:
    case TYPE_FRACTION:
      return rawValue ?? `<type=0x${value.dataType.toString(16)} data=0x${value.data.toString(16)}>`;
    default:
      return rawValue ?? `<type=0x${value.dataType.toString(16)} data=0x${value.data.toString(16)}>`;
  }
}

/* ============================================================ */
/* 共用                                                          */
/* ============================================================ */

interface ChunkHeader {
  type: number;
  headerSize: number;
  size: number;
}

function readChunkHeader(buf: Buffer, offset: number): ChunkHeader {
  return {
    type: buf.readUInt16LE(offset),
    headerSize: buf.readUInt16LE(offset + 2),
    size: buf.readUInt32LE(offset + 4),
  };
}
