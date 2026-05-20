/**
 * DEX 二进制格式的零依赖解析 helper（被 dex.ts / dexDetails.ts 共用）。
 *
 * 规范来源：Android 官方 dex-format
 *   https://source.android.com/docs/core/runtime/dex-format
 *
 * 设计原则与 axml.ts 一致：
 *  - 失败即返回带 magic='INVALID' 的占位对象，不抛异常（让 pipeline 继续）。
 *  - 不验证 checksum / sha1（专注信息提取，不当签名校验工具）。
 *  - 不依赖 MUTF-8 完整解码：对 ASCII / BMP 内 UTF-8 字符正确解码；
 *    含 supplementary plane 字符的 MUTF-8 surrogate pair 会落入 'other' 桶
 *    或被 TextDecoder 丢弃。生产 APK 内 99% 字符串都是 ASCII。
 */

/** DEX header 完整（含 offset 字段）。轻量 analyzer 用其中 size 字段；
 * dexDetails 还会用 stringIds.off / size 去切 string_ids 表。 */
export interface DexHeaderRaw {
  magic: 'DEX' | 'CDEX' | 'INVALID';
  version: string | null;
  checksum: number | null;
  fileSize: number | null;
  headerSize: number | null;
  endianTag: number | null;
  stringIds: { size: number; off: number } | null;
  typeIds: { size: number; off: number } | null;
  protoIds: { size: number; off: number } | null;
  fieldIds: { size: number; off: number } | null;
  methodIds: { size: number; off: number } | null;
  classDefs: { size: number; off: number } | null;
}

const DEX_MAGIC_PREFIX = Buffer.from('dex\n', 'ascii'); // 0x64 0x65 0x78 0x0A
const CDEX_MAGIC_PREFIX = Buffer.from('cdex', 'ascii'); // Android Q+ compact dex

/** 标准 DEX header 长度（dex-format 规定恒为 0x70） */
export const DEX_HEADER_SIZE = 0x70;

/** 标准小端 endian_tag */
export const DEX_ENDIAN_CONSTANT = 0x12345678;

export function parseDexHeader(buf: Buffer): DexHeaderRaw {
  if (buf.length < DEX_HEADER_SIZE) {
    return makeInvalid();
  }

  // magic[0..3] decide standard DEX vs Compact DEX
  const dexHead = buf.subarray(0, 4);
  const cdexHead = buf.subarray(0, 4);
  let magic: DexHeaderRaw['magic'] = 'INVALID';
  let version: string | null = null;
  if (dexHead.equals(DEX_MAGIC_PREFIX)) {
    magic = 'DEX';
    // magic[4..7] = "035\0" / "038\0" / "039\0"
    version = decodeMagicVersion(buf.subarray(4, 7));
  } else if (cdexHead.equals(CDEX_MAGIC_PREFIX)) {
    magic = 'CDEX';
    // cdex magic 形如 "cdex001\0"；版本在 [4..7]
    version = decodeMagicVersion(buf.subarray(4, 7));
  }

  if (magic === 'INVALID') {
    return makeInvalid();
  }

  // endian_tag：dex 仅小端实现是标准；大端历史上不存在生产用例，遇到大端按 INVALID
  const endianTag = buf.readUInt32LE(0x28);
  if (endianTag !== DEX_ENDIAN_CONSTANT) {
    return { ...makeInvalid(), magic, version };
  }

  const checksum = buf.readUInt32LE(0x08);
  const fileSize = buf.readUInt32LE(0x20);
  const headerSize = buf.readUInt32LE(0x24);

  const readPair = (sizeOff: number, offOff: number): { size: number; off: number } => ({
    size: buf.readUInt32LE(sizeOff),
    off: buf.readUInt32LE(offOff),
  });

  return {
    magic,
    version,
    checksum,
    fileSize,
    headerSize,
    endianTag,
    stringIds: readPair(0x38, 0x3c),
    typeIds: readPair(0x40, 0x44),
    protoIds: readPair(0x48, 0x4c),
    fieldIds: readPair(0x50, 0x54),
    methodIds: readPair(0x58, 0x5c),
    classDefs: readPair(0x60, 0x64),
  };
}

function makeInvalid(): DexHeaderRaw {
  return {
    magic: 'INVALID',
    version: null,
    checksum: null,
    fileSize: null,
    headerSize: null,
    endianTag: null,
    stringIds: null,
    typeIds: null,
    protoIds: null,
    fieldIds: null,
    methodIds: null,
    classDefs: null,
  };
}

function decodeMagicVersion(slice: Buffer): string | null {
  // 期望 3 字节 ASCII 数字，后接 '\0'（已经在调用处截到 [4..7]）
  const s = slice.toString('ascii');
  if (/^\d{3}$/.test(s)) return s;
  return null;
}

/* ------------------------------------------------------------------ */
/* string_ids 表 + string_data_items 抽取                              */
/* ------------------------------------------------------------------ */

/**
 * 从 dex buffer 抽取 string_ids 表对应的全部字符串。
 *
 * - 每个 string_id_item 是 4 字节 LE 的 string_data_off
 * - 每个 string_data_item = ULEB128 length（以 UTF-16 字符为单位，非字节数）+ MUTF-8 bytes + 0x00
 * - 我们以 0x00 边界切，配合 TextDecoder('utf-8', { fatal: true }) 兜底；MUTF-8 的"4-byte → 双 3-byte
 *   surrogate pair"细节对 ASCII / 普通 UTF-8 字符无影响，剩下解不出的字符串会被丢弃。
 *
 * 性能：单次 O(stringIds.size) 顺读，无回溯；对几 MB 的 classes.dex 实测 < 50ms。
 *
 * 返回值是"按 string_ids 表的索引顺序排好的原始字符串"（包含重复）；调用方再去重 / 排序 / 分桶。
 */
export function extractDexStringList(
  buf: Buffer,
  stringIdsSize: number,
  stringIdsOff: number,
): string[] {
  if (stringIdsSize <= 0 || stringIdsOff <= 0) return [];
  if (stringIdsOff + stringIdsSize * 4 > buf.length) return [];

  const out: string[] = [];
  for (let i = 0; i < stringIdsSize; i++) {
    const dataOff = buf.readUInt32LE(stringIdsOff + i * 4);
    if (dataOff <= 0 || dataOff >= buf.length) {
      out.push('');
      continue;
    }
    const decoded = decodeStringDataItem(buf, dataOff);
    out.push(decoded ?? '');
  }
  return out;
}

/** 读取 string_data_item：ULEB128 length（UTF-16 chars）+ MUTF-8 bytes + 0x00 terminator */
function decodeStringDataItem(buf: Buffer, off: number): string | null {
  const skip = skipUleb128(buf, off);
  if (skip === null) return '';
  const dataStart = skip;
  let dataEnd = dataStart;
  while (dataEnd < buf.length && buf[dataEnd] !== 0x00) dataEnd += 1;
  if (dataEnd === dataStart) return ''; // 空字符串合法
  const slice = buf.subarray(dataStart, dataEnd);
  return decodeMutf8(slice);
}

/* ------------------------------------------------------------------ */
/* ULEB128 解码 helper（class_data_item / encoded_method 共用）        */
/* ------------------------------------------------------------------ */

/**
 * 解码一个 ULEB128 数；返回数值 + 该数字占用的字节数。
 *
 * dex-format 的 ULEB128 最多 5 字节（32-bit）。第 6 字节起视为损坏，返回 null。
 * 调用方应配合 `off + result.bytes` 推进游标。
 */
export function readUleb128(buf: Buffer, off: number): { value: number; bytes: number } | null {
  let value = 0;
  let shift = 0;
  let bytes = 0;
  let p = off;
  while (p < buf.length && bytes < 5) {
    const b = buf[p]!;
    value |= (b & 0x7f) << shift;
    p += 1;
    bytes += 1;
    if ((b & 0x80) === 0) {
      // ULEB128 在 32-bit 边界外的位会"溢出"，TS 这里 >>> 0 转为无符号即可
      return { value: value >>> 0, bytes };
    }
    shift += 7;
  }
  return null;
}

/** 跳过一个 ULEB128，返回 ULEB128 之后的 offset；遇错返回 null（调用方自行兜底） */
function skipUleb128(buf: Buffer, off: number): number | null {
  const r = readUleb128(buf, off);
  if (!r) return null;
  return off + r.bytes;
}

/* ------------------------------------------------------------------ */
/* type_ids / proto_ids / method_ids / class_defs / class_data /       */
/* code_item 解析（DexMethodEntry 抽取链路）                            */
/* ------------------------------------------------------------------ */

/** dex method 在 type_ids / proto_ids / method_ids 表上的索引三元组 */
export interface DexMethodIdRaw {
  classIdx: number;
  protoIdx: number;
  nameIdx: number;
}

/** dex proto 的"返回类型 + 参数类型列表"（已经是 type_ids 索引） */
export interface DexProtoIdRaw {
  returnTypeIdx: number;
  parameterTypeIdxs: number[];
}

/** dex class_def_item 关键字段（method 抽取只需要 class_data_off） */
export interface DexClassDefRaw {
  classIdx: number;
  classDataOff: number;
}

/**
 * 读取 type_ids 表：每个 entry 4 字节 LE = descriptor_idx（string_ids 索引）。
 * 返回的字符串数组与 type_ids 同序，元素为类型描述符（"Lcom/foo/Bar;" / "I" / "[B" 等）。
 *
 * 解析失败（offset/size 越界、对应 string_id 越界）时填空字符串占位，保证索引对齐。
 */
export function extractDexTypeDescriptors(
  buf: Buffer,
  stringList: string[],
  typeIdsSize: number,
  typeIdsOff: number,
): string[] {
  if (typeIdsSize <= 0 || typeIdsOff <= 0) return [];
  if (typeIdsOff + typeIdsSize * 4 > buf.length) return [];
  const out: string[] = new Array(typeIdsSize);
  for (let i = 0; i < typeIdsSize; i++) {
    const idx = buf.readUInt32LE(typeIdsOff + i * 4);
    out[i] = stringList[idx] ?? '';
  }
  return out;
}

/**
 * 读取 proto_ids 表：每个 entry 12 字节
 *   shorty_idx (u32) + return_type_idx (u32) + parameters_off (u32)
 *
 * 同时解析 parameters_off 指向的 type_list（size u32 + items u16[size]）；
 * 解析失败时 parameterTypeIdxs = []，保证返回数组长度 = proto_ids 表大小。
 */
export function extractDexProtoIds(
  buf: Buffer,
  protoIdsSize: number,
  protoIdsOff: number,
): DexProtoIdRaw[] {
  if (protoIdsSize <= 0 || protoIdsOff <= 0) return [];
  if (protoIdsOff + protoIdsSize * 12 > buf.length) return [];
  const out: DexProtoIdRaw[] = new Array(protoIdsSize);
  for (let i = 0; i < protoIdsSize; i++) {
    const base = protoIdsOff + i * 12;
    const returnTypeIdx = buf.readUInt32LE(base + 4);
    const parametersOff = buf.readUInt32LE(base + 8);
    out[i] = { returnTypeIdx, parameterTypeIdxs: readTypeList(buf, parametersOff) };
  }
  return out;
}

/** type_list 结构：size (u32) + list (u16[size])；off=0 表示空列表 */
function readTypeList(buf: Buffer, off: number): number[] {
  if (off <= 0 || off + 4 > buf.length) return [];
  const size = buf.readUInt32LE(off);
  if (size <= 0) return [];
  const start = off + 4;
  if (start + size * 2 > buf.length) return [];
  const out: number[] = new Array(size);
  for (let i = 0; i < size; i++) out[i] = buf.readUInt16LE(start + i * 2);
  return out;
}

/**
 * 读取 method_ids 表：每个 entry 8 字节
 *   class_idx (u16) + proto_idx (u16) + name_idx (u32)
 */
export function extractDexMethodIds(
  buf: Buffer,
  methodIdsSize: number,
  methodIdsOff: number,
): DexMethodIdRaw[] {
  if (methodIdsSize <= 0 || methodIdsOff <= 0) return [];
  if (methodIdsOff + methodIdsSize * 8 > buf.length) return [];
  const out: DexMethodIdRaw[] = new Array(methodIdsSize);
  for (let i = 0; i < methodIdsSize; i++) {
    const base = methodIdsOff + i * 8;
    out[i] = {
      classIdx: buf.readUInt16LE(base),
      protoIdx: buf.readUInt16LE(base + 2),
      nameIdx: buf.readUInt32LE(base + 4),
    };
  }
  return out;
}

/**
 * 读取 class_defs 表：每个 entry 32 字节，本 helper 只关心 class_idx + class_data_off。
 *
 * dex-format 字段顺序（u32 各一）：
 *   class_idx, access_flags, superclass_idx, interfaces_off, source_file_idx,
 *   annotations_off, class_data_off, static_values_off
 */
export function extractDexClassDefs(
  buf: Buffer,
  classDefsSize: number,
  classDefsOff: number,
): DexClassDefRaw[] {
  if (classDefsSize <= 0 || classDefsOff <= 0) return [];
  if (classDefsOff + classDefsSize * 32 > buf.length) return [];
  const out: DexClassDefRaw[] = new Array(classDefsSize);
  for (let i = 0; i < classDefsSize; i++) {
    const base = classDefsOff + i * 32;
    out[i] = {
      classIdx: buf.readUInt32LE(base),
      classDataOff: buf.readUInt32LE(base + 24),
    };
  }
  return out;
}

/** code_item 头部 16 字节关键字段 + insns 字节（不解析 try/handler） */
export interface DexCodeItemHead {
  registers: number;
  insnsSize: number;
  insnsBytes: Buffer;
}

/**
 * 读取 code_item header + insns 字节段。
 *
 * code_item 结构（小端）：
 *   u16 registers_size
 *   u16 ins_size
 *   u16 outs_size
 *   u16 tries_size
 *   u32 debug_info_off
 *   u32 insns_size  // 以 16-bit code units 计
 *   u16 insns[insns_size]
 *   ... padding + tries + handlers ...
 *
 * 当 codeOff=0（abstract/native 方法）返回 null。解析失败时也返回 null。
 */
export function readCodeItemHead(buf: Buffer, codeOff: number): DexCodeItemHead | null {
  if (codeOff <= 0 || codeOff + 16 > buf.length) return null;
  const registers = buf.readUInt16LE(codeOff);
  const insnsSize = buf.readUInt32LE(codeOff + 12);
  const insnsStart = codeOff + 16;
  const insnsBytes = insnsSize * 2;
  if (insnsBytes < 0 || insnsStart + insnsBytes > buf.length) {
    return { registers, insnsSize, insnsBytes: Buffer.alloc(0) };
  }
  return {
    registers,
    insnsSize,
    insnsBytes: buf.subarray(insnsStart, insnsStart + insnsBytes),
  };
}

/** 单个方法的扁平描述（不含索引、不含未消费字段） */
export interface DexFlatMethod {
  classDescriptor: string;
  name: string;
  proto: string;
  fullName: string;
  accessFlags: number;
  hasCode: boolean;
  insnsSize: number | null;
  registers: number | null;
  /** insns 字节段；hashBodies=false 时为 null（避免占内存） */
  insnsBytes: Buffer | null;
}

export interface ExtractDexMethodsOptions {
  /** 是否保留 insns 字节段以便上层算 sha256（默认 false） */
  hashBodies?: boolean;
  /** 单 dex 最多输出多少方法；0 = 不限。超出后停止解析剩余 class_data_item */
  methodLimit?: number;
}

export interface ExtractDexMethodsResult {
  methods: DexFlatMethod[];
  truncated: boolean;
  /** 解析中的非致命警告（如 ULEB128 坏掉、code_off 越界、type_idx 越界等） */
  warnings: string[];
}

/**
 * 从 dex buffer 抽取全量方法描述。
 *
 * 整体步骤：
 *   1. 读 string_ids → stringList
 *   2. 读 type_ids → typeDescriptors（索引对齐 stringList）
 *   3. 读 proto_ids → 拼出 proto 签名（如 "(I)V"）
 *   4. 读 method_ids → 三元组 → 拼 fullName
 *   5. 读 class_defs → 遍历 class_data_item.encoded_methods，拿 access_flags / code_off
 *   6. code_off > 0 时读 code_item.head → registers + insnsSize（+ 可选 insns bytes）
 *
 * 设计要点：
 *   - 任一表越界 / ULEB128 损坏：跳过当前条目并 warn，不中断整体抽取
 *   - 方法名 + proto 优先级 > insns；header 损坏的 method 仍能出 fullName，
 *     方便 differ 至少做到方法集 add/remove
 *   - methodLimit：单 dex 几万方法时可截断，避免单包几十 MB Buffer
 */
export function extractDexMethods(
  buf: Buffer,
  header: DexHeaderRaw,
  options: ExtractDexMethodsOptions = {},
): ExtractDexMethodsResult {
  const warnings: string[] = [];
  const limit = options.methodLimit ?? 0;

  if (header.magic !== 'DEX') {
    return { methods: [], truncated: false, warnings: ['method 抽取仅支持标准 DEX magic'] };
  }
  if (!header.stringIds || !header.typeIds || !header.protoIds || !header.methodIds || !header.classDefs) {
    return { methods: [], truncated: false, warnings: ['header 中关键 *_ids 表缺失'] };
  }

  const stringList = extractDexStringList(buf, header.stringIds.size, header.stringIds.off);
  const typeDescriptors = extractDexTypeDescriptors(
    buf,
    stringList,
    header.typeIds.size,
    header.typeIds.off,
  );
  const protoIds = extractDexProtoIds(buf, header.protoIds.size, header.protoIds.off);
  const methodIds = extractDexMethodIds(buf, header.methodIds.size, header.methodIds.off);
  const classDefs = extractDexClassDefs(buf, header.classDefs.size, header.classDefs.off);

  if (
    typeDescriptors.length !== header.typeIds.size ||
    protoIds.length !== header.protoIds.size ||
    methodIds.length !== header.methodIds.size ||
    classDefs.length !== header.classDefs.size
  ) {
    warnings.push('部分 *_ids 表越界，已按 0 兜底；method fullName 可能不完整');
  }

  const protoStrings: string[] = protoIds.map((p) => buildProtoSignature(p, typeDescriptors));
  const methods: DexFlatMethod[] = [];
  let truncated = false;

  outer: for (const def of classDefs) {
    if (def.classDataOff <= 0) continue;
    const classDescriptor = typeDescriptors[def.classIdx] ?? '';

    const data = readClassDataMethods(buf, def.classDataOff);
    if (!data) {
      warnings.push(`class_data_item 解析失败 @ 0x${def.classDataOff.toString(16)}`);
      continue;
    }

    for (const em of data) {
      const mid = methodIds[em.methodIdx];
      if (!mid) {
        warnings.push(`method_idx ${em.methodIdx} 越界`);
        continue;
      }
      const name = stringList[mid.nameIdx] ?? '';
      const proto = protoStrings[mid.protoIdx] ?? '';
      const fullName = `${classDescriptor}->${name}${proto}`;

      let hasCode = false;
      let insnsSize: number | null = null;
      let registers: number | null = null;
      let insnsBytes: Buffer | null = null;
      if (em.codeOff > 0) {
        const ci = readCodeItemHead(buf, em.codeOff);
        if (ci) {
          hasCode = true;
          insnsSize = ci.insnsSize;
          registers = ci.registers;
          if (options.hashBodies) insnsBytes = ci.insnsBytes;
        } else {
          warnings.push(`code_item 解析失败 @ 0x${em.codeOff.toString(16)}`);
        }
      }

      methods.push({
        classDescriptor,
        name,
        proto,
        fullName,
        accessFlags: em.accessFlags,
        hasCode,
        insnsSize,
        registers,
        insnsBytes,
      });

      if (limit > 0 && methods.length >= limit) {
        truncated = true;
        break outer;
      }
    }
  }

  return { methods, truncated, warnings };
}

interface EncodedMethodRaw {
  methodIdx: number;
  accessFlags: number;
  codeOff: number;
}

/**
 * 读 class_data_item，返回 direct + virtual methods 的扁平列表（method_idx 已累加复原）。
 *
 * class_data_item 全部使用 ULEB128，结构：
 *   u32-style ULEB128 static_fields_size
 *   u32-style ULEB128 instance_fields_size
 *   u32-style ULEB128 direct_methods_size
 *   u32-style ULEB128 virtual_methods_size
 *   encoded_field static_fields[static_fields_size]
 *   encoded_field instance_fields[instance_fields_size]
 *   encoded_method direct_methods[direct_methods_size]
 *   encoded_method virtual_methods[virtual_methods_size]
 *
 * encoded_field/encoded_method 的 idx_diff 在每个列表内独立累加（virtual_methods 从 0 重新累加）。
 *
 * 任一 ULEB128 损坏或字段越界时返回 null。
 */
function readClassDataMethods(buf: Buffer, off: number): EncodedMethodRaw[] | null {
  let p = off;
  const sf = readUleb128(buf, p); if (!sf) return null; p += sf.bytes;
  const inf = readUleb128(buf, p); if (!inf) return null; p += inf.bytes;
  const dm = readUleb128(buf, p); if (!dm) return null; p += dm.bytes;
  const vm = readUleb128(buf, p); if (!vm) return null; p += vm.bytes;

  // 跳过 fields（每个 encoded_field = 2 个 ULEB128）
  for (let i = 0; i < sf.value; i++) {
    const a = readUleb128(buf, p); if (!a) return null; p += a.bytes;
    const b = readUleb128(buf, p); if (!b) return null; p += b.bytes;
  }
  for (let i = 0; i < inf.value; i++) {
    const a = readUleb128(buf, p); if (!a) return null; p += a.bytes;
    const b = readUleb128(buf, p); if (!b) return null; p += b.bytes;
  }

  const out: EncodedMethodRaw[] = [];
  let lastIdx = 0;
  for (let i = 0; i < dm.value; i++) {
    const diff = readUleb128(buf, p); if (!diff) return null; p += diff.bytes;
    const af = readUleb128(buf, p); if (!af) return null; p += af.bytes;
    const co = readUleb128(buf, p); if (!co) return null; p += co.bytes;
    lastIdx += diff.value;
    out.push({ methodIdx: lastIdx, accessFlags: af.value, codeOff: co.value });
  }
  lastIdx = 0;
  for (let i = 0; i < vm.value; i++) {
    const diff = readUleb128(buf, p); if (!diff) return null; p += diff.bytes;
    const af = readUleb128(buf, p); if (!af) return null; p += af.bytes;
    const co = readUleb128(buf, p); if (!co) return null; p += co.bytes;
    lastIdx += diff.value;
    out.push({ methodIdx: lastIdx, accessFlags: af.value, codeOff: co.value });
  }
  return out;
}

/**
 * 把 proto_id 的"返回类型 + 参数类型列表"拼成 Java 类型签名形式：
 *   (Landroid/os/Bundle;Ljava/lang/String;)V
 *
 * 解析失败时把对应位置的 type 占位为空，保证签名串至少可读。
 */
function buildProtoSignature(proto: DexProtoIdRaw, typeDescriptors: string[]): string {
  const params = proto.parameterTypeIdxs.map((idx) => typeDescriptors[idx] ?? '?').join('');
  const ret = typeDescriptors[proto.returnTypeIdx] ?? '?';
  return `(${params})${ret}`;
}

/**
 * MUTF-8 严格解码（容错）。
 *
 * 与标准 UTF-8 区别：
 *  1) U+0000 编码为 0xC0 0x80（避免内嵌 0 终止符）—— 我们的切片靠 0x00 边界，不会遇到
 *  2) supplementary plane (U+10000..) 字符以"双 3-byte surrogate pair"编码
 *
 * 对 (1) 我们容忍（0xC0 0x80 → \0）；对 (2) 我们走原始 UTF-8 decoder，
 * MUTF-8 surrogate pair 会解为两个独立的非法字符（fatal 模式会抛），catch 后返回 null。
 *
 * fixture / 真实 APK 内 99% 字符串都是 ASCII + 常用 CJK，UTF-8 decoder 足够。
 */
function decodeMutf8(slice: Buffer): string | null {
  try {
    const dec = new TextDecoder('utf-8', { fatal: true });
    return dec.decode(slice);
  } catch {
    // 退化：宽松解码（碰到非法字节用 \uFFFD 替换）
    try {
      return new TextDecoder('utf-8').decode(slice);
    } catch {
      return null;
    }
  }
}
