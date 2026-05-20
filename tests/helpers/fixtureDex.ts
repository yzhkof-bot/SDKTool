/**
 * Minimal DEX 文件构造器（测试用）。
 *
 * 双模式：
 *   1) strings: string[]                      → 仅生成 string_ids 表，其它表全空
 *   2) classes: BuildDexClass[]               → 生成 string_ids / type_ids / proto_ids /
 *      method_ids / class_defs / class_data_item / code_item 全套，可被 extractDexMethods 还原
 *
 * 两种模式可以叠加：`strings` 中的额外字符串会被加入 string_ids 表但不参与 type/method 索引。
 *
 * 对齐策略（与 dex-format 一致）：
 *   - type_list / code_item：4 字节对齐
 *   - string_data_item / class_data_item：紧排（ULEB128，不需要对齐）
 *
 * 不实现的部分（不影响 header 解析、字符串抽取、方法表抽取）：
 *   - checksum / sha1：占位 0
 *   - map_list / annotations / debug_info：全部 size=0/off=0
 *   - encoded_field（fields_size 始终为 0）
 *   - try_items / handlers（每个 code_item 的 tries_size=0）
 *
 * 与 fixtureAxml 同样套路：高级 API in / 二进制 Buffer out。
 */

const DEX_MAGIC = Buffer.from([0x64, 0x65, 0x78, 0x0a]); // "dex\n"
const DEX_HEADER_SIZE = 0x70;
const DEX_ENDIAN_CONSTANT = 0x12345678;

export interface BuildDexMethod {
  /** 方法名，如 "onCreate" */
  name: string;
  /** proto 签名，形如 "(Landroid/os/Bundle;)V"；解析为参数列表 + 返回类型 */
  proto: string;
  /** access_flags，默认 0x0001 (public) */
  accessFlags?: number;
  /**
   * code_item.insns 字节段；undefined / 长度 0 → abstract/native（无 code_item）。
   * 长度必须为偶数（dex 以 16-bit code units 计 insns_size）。
   */
  insnsBytes?: Buffer;
  /** code_item.registers_size，默认 0 */
  registers?: number;
}

export interface BuildDexClass {
  /** 类描述符："Lcom/king/Foo;" */
  classDescriptor: string;
  /** 该类的方法列表（合并 direct + virtual，本 helper 不区分；全部写入 direct_methods） */
  methods?: BuildDexMethod[];
}

export interface BuildDexOptions {
  /** DEX 版本字符串，3 位数字。默认 "035" */
  version?: string;
  /**
   * 额外字符串（不参与 type/method 索引），仅写入 string_ids 表。
   * 与 `classes` 中自动收集的字符串合并去重。
   */
  strings?: string[];
  /** 类 + 方法列表 */
  classes?: BuildDexClass[];
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

export function buildDex(options: BuildDexOptions = {}): Buffer {
  const version = normaliseVersion(options.version);
  const classes = options.classes ?? [];
  const extraStrings = options.strings ?? [];

  // 1) 收集所有 string / type / proto / method 全集
  const ctx = buildSymbolTables(classes, extraStrings);

  // 2) 计算固定表区段大小
  const stringIdsSize = ctx.stringList.length * 4;
  const typeIdsSize = ctx.typeList.length * 4;
  const protoIdsSize = ctx.protoList.length * 12;
  const methodIdsSize = ctx.methodList.length * 8;
  const classDefsSize = classes.length * 32;

  const stringIdsOff = DEX_HEADER_SIZE;
  const typeIdsOff = stringIdsOff + stringIdsSize;
  const protoIdsOff = typeIdsOff + typeIdsSize;
  const methodIdsOff = protoIdsOff + protoIdsSize;
  const classDefsOff = methodIdsOff + methodIdsSize;

  let cursor = classDefsOff + classDefsSize;

  // 3) string_data_items
  const stringDataChunks: { off: number; data: Buffer }[] = [];
  for (const s of ctx.stringList) {
    const data = encodeStringDataItem(s);
    stringDataChunks.push({ off: cursor, data });
    cursor += data.length;
  }

  // 4) type_lists（每个 proto 的 parameters_off；空参 proto 不分配）
  const typeListOffByProto: (number | 0)[] = new Array(ctx.protoList.length).fill(0);
  const typeListChunks: { off: number; data: Buffer }[] = [];
  ctx.protoList.forEach((proto, idx) => {
    if (proto.parameterTypeIdxs.length === 0) return;
    cursor = align4(cursor);
    typeListOffByProto[idx] = cursor;
    const data = encodeTypeList(proto.parameterTypeIdxs);
    typeListChunks.push({ off: cursor, data });
    cursor += data.length;
  });

  // 5) class_data_items：每个类含 direct_methods（virtual_methods_size 始终 0）
  //    需要先计算每个方法的 code_off（要在 class_data 后才能放 code_item，
  //    所以两遍：第一遍 layout class_data_item，第二遍 layout code_item 并回填 code_off）。
  //    为简化：先生成 placeholder class_data_item（code_off 填 0），随后遍历方法 layout code_item，
  //    最后重新生成 class_data_item bytes 并把真实 code_off 写进去。
  const classDataOffs: number[] = new Array(classes.length).fill(0);
  const classDataChunks: { off: number; data: Buffer }[] = [];
  for (let i = 0; i < classes.length; i++) {
    classDataOffs[i] = cursor;
    const placeholder = encodeClassDataItem(classes[i]!, ctx, i, () => 0);
    classDataChunks.push({ off: cursor, data: placeholder });
    cursor += placeholder.length;
  }

  // 6) code_items：每个有 insnsBytes 的方法
  //    遍历顺序与 method 在 class_data_item 中的顺序一致；用 (classIdx, methodIdx) 作 key。
  const codeOffByMethodKey = new Map<string, number>();
  const codeChunks: { off: number; data: Buffer }[] = [];
  for (let ci = 0; ci < classes.length; ci++) {
    const cls = classes[ci]!;
    for (const m of cls.methods ?? []) {
      if (!m.insnsBytes || m.insnsBytes.length === 0) continue;
      cursor = align4(cursor);
      const methodIdx = ctx.methodIndexByKey.get(methodKeyOf(ci, m.name, m.proto))!;
      codeOffByMethodKey.set(`${ci}:${methodIdx}`, cursor);
      const data = encodeCodeItem(m);
      codeChunks.push({ off: cursor, data });
      cursor += data.length;
    }
  }

  // 7) 重新生成 class_data_item，回填真实 code_off
  for (let i = 0; i < classes.length; i++) {
    const cls = classes[i]!;
    const finalData = encodeClassDataItem(cls, ctx, i, (methodIdx) => {
      const k = `${i}:${methodIdx}`;
      return codeOffByMethodKey.get(k) ?? 0;
    });
    const old = classDataChunks[i]!;
    if (finalData.length !== old.data.length) {
      throw new Error(
        `fixtureDex: class_data_item size mismatch at class ${i} (${old.data.length} → ${finalData.length}). 实现 bug：encodeClassDataItem 必须 idempotent in size.`,
      );
    }
    classDataChunks[i] = { off: old.off, data: finalData };
  }

  const fileSize = cursor;

  // 8) header
  const header = Buffer.alloc(DEX_HEADER_SIZE);
  DEX_MAGIC.copy(header, 0);
  Buffer.from(version, 'ascii').copy(header, 4);
  header.writeUInt8(0x00, 7);
  header.writeUInt32LE(0, 0x08); // checksum
  // [0x0C..0x20) sha1：留 0
  header.writeUInt32LE(fileSize, 0x20);
  header.writeUInt32LE(DEX_HEADER_SIZE, 0x24);
  header.writeUInt32LE(DEX_ENDIAN_CONSTANT, 0x28);
  header.writeUInt32LE(0, 0x2c); // link_size
  header.writeUInt32LE(0, 0x30); // link_off
  header.writeUInt32LE(0, 0x34); // map_off

  writeIdsPair(header, 0x38, ctx.stringList.length, stringIdsOff);
  writeIdsPair(header, 0x40, ctx.typeList.length, typeIdsOff);
  writeIdsPair(header, 0x48, ctx.protoList.length, protoIdsOff);
  writeIdsPair(header, 0x50, 0, 0); // field_ids 不构造
  writeIdsPair(header, 0x58, ctx.methodList.length, methodIdsOff);
  writeIdsPair(header, 0x60, classes.length, classDefsOff);
  writeIdsPair(header, 0x68, 0, 0); // data_size / data_off：不严格需要

  // 9) string_ids 表
  const stringIdsBuf = Buffer.alloc(stringIdsSize);
  for (let i = 0; i < stringDataChunks.length; i++) {
    stringIdsBuf.writeUInt32LE(stringDataChunks[i]!.off, i * 4);
  }

  // 10) type_ids 表（每项 = descriptor 的 string_idx）
  const typeIdsBuf = Buffer.alloc(typeIdsSize);
  for (let i = 0; i < ctx.typeList.length; i++) {
    typeIdsBuf.writeUInt32LE(ctx.typeList[i]!.stringIdx, i * 4);
  }

  // 11) proto_ids 表
  const protoIdsBuf = Buffer.alloc(protoIdsSize);
  for (let i = 0; i < ctx.protoList.length; i++) {
    const p = ctx.protoList[i]!;
    protoIdsBuf.writeUInt32LE(p.shortyStringIdx, i * 12); // shorty_idx
    protoIdsBuf.writeUInt32LE(p.returnTypeIdx, i * 12 + 4);
    protoIdsBuf.writeUInt32LE(typeListOffByProto[i]!, i * 12 + 8);
  }

  // 12) method_ids 表
  const methodIdsBuf = Buffer.alloc(methodIdsSize);
  for (let i = 0; i < ctx.methodList.length; i++) {
    const m = ctx.methodList[i]!;
    methodIdsBuf.writeUInt16LE(m.classIdx, i * 8);
    methodIdsBuf.writeUInt16LE(m.protoIdx, i * 8 + 2);
    methodIdsBuf.writeUInt32LE(m.nameStringIdx, i * 8 + 4);
  }

  // 13) class_defs 表（superclass / interfaces / source_file / annotations / static_values 全 NO_INDEX）
  const NO_INDEX = 0xffffffff;
  const classDefsBuf = Buffer.alloc(classDefsSize);
  for (let i = 0; i < classes.length; i++) {
    const cls = classes[i]!;
    const classIdx = ctx.typeIndexByDesc.get(cls.classDescriptor)!;
    const base = i * 32;
    classDefsBuf.writeUInt32LE(classIdx, base); // class_idx
    classDefsBuf.writeUInt32LE(0x0001, base + 4); // access_flags = public
    classDefsBuf.writeUInt32LE(NO_INDEX, base + 8); // superclass_idx
    classDefsBuf.writeUInt32LE(0, base + 12); // interfaces_off
    classDefsBuf.writeUInt32LE(NO_INDEX, base + 16); // source_file_idx
    classDefsBuf.writeUInt32LE(0, base + 20); // annotations_off
    classDefsBuf.writeUInt32LE(classDataOffs[i]!, base + 24); // class_data_off
    classDefsBuf.writeUInt32LE(0, base + 28); // static_values_off
  }

  // 14) 拼整文件：按 cursor 计算的 offset 填入对应 chunks
  const out = Buffer.alloc(fileSize);
  header.copy(out, 0);
  stringIdsBuf.copy(out, stringIdsOff);
  typeIdsBuf.copy(out, typeIdsOff);
  protoIdsBuf.copy(out, protoIdsOff);
  methodIdsBuf.copy(out, methodIdsOff);
  classDefsBuf.copy(out, classDefsOff);
  for (const c of stringDataChunks) c.data.copy(out, c.off);
  for (const c of typeListChunks) c.data.copy(out, c.off);
  for (const c of classDataChunks) c.data.copy(out, c.off);
  for (const c of codeChunks) c.data.copy(out, c.off);
  return out;
}

function writeIdsPair(buf: Buffer, off: number, size: number, ptr: number): void {
  buf.writeUInt32LE(size, off);
  buf.writeUInt32LE(ptr, off + 4);
}

function align4(off: number): number {
  return (off + 3) & ~3;
}

function normaliseVersion(input: string | undefined): string {
  const version = (input ?? '035').padEnd(3, '0').slice(0, 3);
  if (!/^\d{3}$/.test(version)) {
    throw new Error(`buildDex: version must be 3 ASCII digits, got "${version}"`);
  }
  return version;
}

/* ------------------------------------------------------------------ */
/* 符号表收集                                                          */
/* ------------------------------------------------------------------ */

interface SymbolTables {
  /** 全 dex 的 string 集合（按最终 string_ids 顺序） */
  stringList: string[];
  stringIndexByValue: Map<string, number>;
  /** type 集合：每项 = 描述符 + 对应 string_ids 索引 */
  typeList: { descriptor: string; stringIdx: number }[];
  typeIndexByDesc: Map<string, number>;
  /** proto 集合 */
  protoList: { returnTypeIdx: number; parameterTypeIdxs: number[]; shortyStringIdx: number; key: string }[];
  protoIndexByKey: Map<string, number>;
  /** method 集合（method_ids 表顺序） */
  methodList: { classIdx: number; protoIdx: number; nameStringIdx: number; key: string }[];
  methodIndexByKey: Map<string, number>;
}

function methodKeyOf(classDefIdx: number, name: string, proto: string): string {
  return `${classDefIdx}\u0001${name}\u0001${proto}`;
}

function buildSymbolTables(classes: BuildDexClass[], extraStrings: string[]): SymbolTables {
  // 阶段 1：收集所有 type_descriptor + 字符串原文
  const allTypes = new Set<string>();
  const allStrings = new Set<string>();
  // strings-only 模式希望保留输入顺序（兼容 buildDemoDex 老断言）；
  // 用 orderedStrings 维护"先来先得"，再补充 classes 模式收集的剩余字符串。
  const orderedStrings: string[] = [];
  const addString = (s: string) => {
    if (!s) return;
    if (allStrings.has(s)) return;
    allStrings.add(s);
    orderedStrings.push(s);
  };

  for (const s of extraStrings) addString(s);

  for (const cls of classes) {
    allTypes.add(cls.classDescriptor);
    addString(cls.classDescriptor);
    for (const m of cls.methods ?? []) {
      addString(m.name);
      // 解析 proto 拿到所有 type descriptors
      const { params, ret, shorty } = parseProtoSignature(m.proto);
      for (const t of params) {
        allTypes.add(t);
        addString(t);
      }
      allTypes.add(ret);
      addString(ret);
      addString(shorty);
    }
  }

  // 阶段 2：分配 string_ids
  // - strings-only 模式：保留输入顺序（兼容 fixture 直接断言 demo 字符串顺序）
  // - classes 模式：按字典序排序（让 type_ids 按 string_idx 升序更稳定；
  //   实际 DEX 规范要求字符串按 utf-8 升序，但我们的 parser 不强校验）
  const stringList =
    classes.length === 0 ? orderedStrings.slice() : orderedStrings.slice().sort();
  const stringIndexByValue = new Map<string, number>();
  stringList.forEach((s, i) => stringIndexByValue.set(s, i));

  // 阶段 3：分配 type_ids（按 string_idx 升序，DEX 规范要求）
  const typeArr = [...allTypes].map((desc) => ({ descriptor: desc, stringIdx: stringIndexByValue.get(desc)! }));
  typeArr.sort((a, b) => a.stringIdx - b.stringIdx);
  const typeList = typeArr;
  const typeIndexByDesc = new Map<string, number>();
  typeList.forEach((t, i) => typeIndexByDesc.set(t.descriptor, i));

  // 阶段 4：分配 proto_ids（去重）
  const protoArr: SymbolTables['protoList'] = [];
  const protoIndexByKey = new Map<string, number>();
  for (const cls of classes) {
    for (const m of cls.methods ?? []) {
      const { params, ret, shorty } = parseProtoSignature(m.proto);
      const paramIdxs = params.map((t) => typeIndexByDesc.get(t)!);
      const key = `${typeIndexByDesc.get(ret)!}|${paramIdxs.join(',')}`;
      if (!protoIndexByKey.has(key)) {
        protoIndexByKey.set(key, protoArr.length);
        protoArr.push({
          returnTypeIdx: typeIndexByDesc.get(ret)!,
          parameterTypeIdxs: paramIdxs,
          shortyStringIdx: stringIndexByValue.get(shorty)!,
          key,
        });
      }
    }
  }
  // proto_ids 排序：DEX 规范要求按 (return_type_idx, parameters_idx_list) 升序
  protoArr.sort((a, b) => {
    if (a.returnTypeIdx !== b.returnTypeIdx) return a.returnTypeIdx - b.returnTypeIdx;
    for (let i = 0; i < Math.min(a.parameterTypeIdxs.length, b.parameterTypeIdxs.length); i++) {
      if (a.parameterTypeIdxs[i] !== b.parameterTypeIdxs[i]) {
        return a.parameterTypeIdxs[i]! - b.parameterTypeIdxs[i]!;
      }
    }
    return a.parameterTypeIdxs.length - b.parameterTypeIdxs.length;
  });
  // 排序后重建 key→index 映射
  const protoList = protoArr;
  const protoIndexByKey2 = new Map<string, number>();
  protoList.forEach((p, i) => protoIndexByKey2.set(p.key, i));

  // 阶段 5：分配 method_ids（DEX 规范要求按 (class_idx, name_idx, proto_idx) 升序）
  const methodArr: SymbolTables['methodList'] = [];
  for (let ci = 0; ci < classes.length; ci++) {
    const cls = classes[ci]!;
    const classIdx = typeIndexByDesc.get(cls.classDescriptor)!;
    for (const m of cls.methods ?? []) {
      const { params, ret } = parseProtoSignature(m.proto);
      const paramIdxs = params.map((t) => typeIndexByDesc.get(t)!);
      const pkey = `${typeIndexByDesc.get(ret)!}|${paramIdxs.join(',')}`;
      const protoIdx = protoIndexByKey2.get(pkey)!;
      const nameStringIdx = stringIndexByValue.get(m.name)!;
      methodArr.push({
        classIdx,
        protoIdx,
        nameStringIdx,
        key: methodKeyOf(ci, m.name, m.proto),
      });
    }
  }
  methodArr.sort((a, b) => {
    if (a.classIdx !== b.classIdx) return a.classIdx - b.classIdx;
    if (a.nameStringIdx !== b.nameStringIdx) return a.nameStringIdx - b.nameStringIdx;
    return a.protoIdx - b.protoIdx;
  });
  const methodList = methodArr;
  const methodIndexByKey = new Map<string, number>();
  methodList.forEach((m, i) => methodIndexByKey.set(m.key, i));

  return {
    stringList,
    stringIndexByValue,
    typeList,
    typeIndexByDesc,
    protoList,
    protoIndexByKey: protoIndexByKey2,
    methodList,
    methodIndexByKey,
  };
}

/* ------------------------------------------------------------------ */
/* proto 字符串解析                                                    */
/* ------------------------------------------------------------------ */

/**
 * 把 "(Landroid/os/Bundle;ILjava/lang/String;)V" 解析为：
 *   params: ['Landroid/os/Bundle;', 'I', 'Ljava/lang/String;']
 *   ret:    'V'
 *   shorty: 'VLIL'（return + 每个 param 的"形状"：原始类型用其单字符；类用 L；数组用 [）
 *
 * 规则：参数列表中支持单字符基础类型 (V Z B S C I J F D)、
 * 类描述符 L...; 以及数组 [<elem>。
 */
function parseProtoSignature(proto: string): { params: string[]; ret: string; shorty: string } {
  const m = /^\((.*)\)(.+)$/.exec(proto);
  if (!m) throw new Error(`buildDex: proto must look like (...)X, got "${proto}"`);
  const paramsStr = m[1]!;
  const ret = m[2]!;
  const params: string[] = [];
  let p = 0;
  while (p < paramsStr.length) {
    const ch = paramsStr[p]!;
    if ('VZBSCIJFD'.includes(ch)) {
      params.push(ch);
      p += 1;
    } else if (ch === 'L') {
      const end = paramsStr.indexOf(';', p);
      if (end < 0) throw new Error(`buildDex: 未闭合的类描述符 in "${proto}"`);
      params.push(paramsStr.slice(p, end + 1));
      p = end + 1;
    } else if (ch === '[') {
      // 数组：吞掉所有连续的 [，再吞一个元素描述符
      let q = p;
      while (q < paramsStr.length && paramsStr[q] === '[') q += 1;
      if (q >= paramsStr.length) throw new Error(`buildDex: 数组类型截断 in "${proto}"`);
      const elemStart = q;
      const elemCh = paramsStr[q]!;
      if (elemCh === 'L') {
        const end = paramsStr.indexOf(';', q);
        if (end < 0) throw new Error(`buildDex: 数组中类描述符未闭合 in "${proto}"`);
        q = end + 1;
      } else if ('VZBSCIJFD'.includes(elemCh)) {
        q += 1;
      } else {
        throw new Error(`buildDex: 数组元素类型无法识别 in "${proto}"`);
      }
      params.push(paramsStr.slice(p, q));
      p = q;
      // shorty 描述数组用 'L'，这里返回完整数组描述符即可
      // 注意：shorty 字符串中数组也写 'L'（规范），下面 buildShorty 统一处理
      void elemStart;
    } else {
      throw new Error(`buildDex: 无法识别的 proto 字符 "${ch}" in "${proto}"`);
    }
  }
  const shorty = buildShorty(ret, params);
  return { params, ret, shorty };
}

/** shorty：return + 各 param 一个字符；类 / 数组都映射为 'L' */
function buildShorty(ret: string, params: string[]): string {
  const ch = (t: string) => {
    if (t.startsWith('L') || t.startsWith('[')) return 'L';
    return t;
  };
  return ch(ret) + params.map(ch).join('');
}

/* ------------------------------------------------------------------ */
/* 编码 helpers                                                        */
/* ------------------------------------------------------------------ */

function encodeUleb128(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`encodeUleb128: value must be a non-negative integer, got ${value}`);
  }
  const bytes: number[] = [];
  let v = value;
  // do/while 保证 value=0 也输出 1 个字节
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function encodeStringDataItem(s: string): Buffer {
  const utf8 = Buffer.from(s, 'utf-8');
  const lenBytes = encodeUleb128(s.length); // utf-16 char count；ASCII 下等于字节数
  return Buffer.concat([lenBytes, utf8, Buffer.from([0x00])]);
}

function encodeTypeList(typeIdxs: number[]): Buffer {
  const buf = Buffer.alloc(4 + typeIdxs.length * 2);
  buf.writeUInt32LE(typeIdxs.length, 0);
  for (let i = 0; i < typeIdxs.length; i++) {
    buf.writeUInt16LE(typeIdxs[i]!, 4 + i * 2);
  }
  return buf;
}

/**
 * 编码 class_data_item：所有方法走 direct_methods（virtual_methods_size=0）。
 *
 * 关键约束：buildDex 用两遍 layout 算 code_off，要求第一遍 placeholder 和第二遍真值
 * 字节数严格相等。因此 method_idx_diff / access_flags / code_off 三个 ULEB128 都用
 * 5 字节 padding 编码（DEX 规范允许：高位连续 bit 为 0 即可）。
 */
function encodeClassDataItem(
  cls: BuildDexClass,
  ctx: SymbolTables,
  classDefIdx: number,
  codeOffResolver: (methodIdx: number) => number,
): Buffer {
  const methods = cls.methods ?? [];
  // 取出该类的方法，按 method_ids 中的全局 index 升序（diff 累加要 non-negative）
  const sorted = methods
    .map((m) => {
      const idx = ctx.methodIndexByKey.get(methodKeyOf(classDefIdx, m.name, m.proto));
      if (idx === undefined) {
        throw new Error(
          `fixtureDex: 方法 ${cls.classDescriptor}->${m.name}${m.proto} 未在 method_ids 表中`,
        );
      }
      return { method: m, methodIdx: idx };
    })
    .sort((a, b) => a.methodIdx - b.methodIdx);

  const parts: Buffer[] = [];
  parts.push(encodeUleb128(0)); // static_fields_size
  parts.push(encodeUleb128(0)); // instance_fields_size
  parts.push(encodeUleb128(sorted.length)); // direct_methods_size
  parts.push(encodeUleb128(0)); // virtual_methods_size

  let lastIdx = 0;
  for (const { method, methodIdx } of sorted) {
    const diff = methodIdx - lastIdx;
    lastIdx = methodIdx;
    parts.push(encodeUleb128Padded(diff, 5));
    parts.push(encodeUleb128Padded(method.accessFlags ?? 0x0001, 5));
    parts.push(encodeUleb128Padded(codeOffResolver(methodIdx), 5));
  }
  return Buffer.concat(parts);
}

/** 把 value 编码为指定字节数的 ULEB128（padding 通过保留 continuation bit 实现） */
function encodeUleb128Padded(value: number, byteCount: number): Buffer {
  if (byteCount < 1 || byteCount > 5) throw new Error(`encodeUleb128Padded: bytes must be 1..5, got ${byteCount}`);
  const buf = Buffer.alloc(byteCount);
  let v = value;
  for (let i = 0; i < byteCount; i++) {
    let byte = v & 0x7f;
    v >>>= 7;
    if (i < byteCount - 1) byte |= 0x80;
    buf[i] = byte;
  }
  if (v !== 0) throw new Error(`encodeUleb128Padded: value ${value} 超出 ${byteCount} 字节范围`);
  return buf;
}

function encodeCodeItem(m: BuildDexMethod): Buffer {
  const insns = m.insnsBytes!;
  if (insns.length % 2 !== 0) {
    throw new Error(`buildDex: insnsBytes 长度必须为偶数，got ${insns.length}`);
  }
  const insnsSize = insns.length / 2;
  const head = Buffer.alloc(16);
  head.writeUInt16LE(m.registers ?? 0, 0);
  head.writeUInt16LE(0, 2); // ins_size
  head.writeUInt16LE(0, 4); // outs_size
  head.writeUInt16LE(0, 6); // tries_size
  head.writeUInt32LE(0, 8); // debug_info_off
  head.writeUInt32LE(insnsSize, 12);
  return Buffer.concat([head, insns]);
}

/* ------------------------------------------------------------------ */
/* Demo / 兼容老 API                                                   */
/* ------------------------------------------------------------------ */

/** 与旧 fixtureDex 行为一致：只生成 string_ids 表的 demo dex（无 type/method） */
export const DEMO_DEX_STRINGS = [
  'Lcom/king/demo/MainActivity;',
  'Landroidx/core/app/ActivityCompat;',
  '(Landroid/os/Bundle;)V',
  '(Ljava/lang/String;I)Ljava/lang/Object;',
  'MainActivity.java',
  'AndroidManifestParser.kt',
  'onCreate',
  'requestPermissions',
  '<init>',
  '<clinit>',
];

export function buildDemoDex(): Buffer {
  return buildDex({ version: '035', strings: DEMO_DEX_STRINGS });
}

/* ------------------------------------------------------------------ */
/* Demo 带方法表的 dex（9c 新增；method-level diff 单测专用）           */
/* ------------------------------------------------------------------ */

/** 默认 insns：一个 return-void (op=0x0e) + padding (0x00)，占 4 字节（2 code units） */
const DEFAULT_INSNS = Buffer.from([0x0e, 0x00, 0x00, 0x00]);

/** 单方法 8 字节 insns：const/4 v0,#0 + return v0 + padding */
function makeInsns(bytes: number): Buffer {
  if (bytes % 2 !== 0) throw new Error(`makeInsns: 字节数必须为偶数，got ${bytes}`);
  const buf = Buffer.alloc(bytes);
  // 仅写一个 return-void 占头 2 字节，剩余填 0；DEX 解析器不验证 insns 内容
  if (bytes >= 2) buf.writeUInt8(0x0e, 0);
  return buf;
}

export interface BuildDemoDexWithMethodsOptions {
  /** 覆盖默认类列表（高级测试用） */
  classes?: BuildDexClass[];
}

/**
 * 内置 demo dex：两个类、共 4 个方法、insns 大小有差异，
 * 方便 method-level diff 单测断言 add/remove/changed 三种信号都能出。
 */
export function buildDemoDexWithMethods(opts: BuildDemoDexWithMethodsOptions = {}): Buffer {
  const classes: BuildDexClass[] =
    opts.classes ??
    [
      {
        classDescriptor: 'Lcom/king/demo/MainActivity;',
        methods: [
          { name: '<init>', proto: '()V', insnsBytes: DEFAULT_INSNS, registers: 1 },
          {
            name: 'onCreate',
            proto: '(Landroid/os/Bundle;)V',
            insnsBytes: makeInsns(8),
            registers: 2,
          },
        ],
      },
      {
        classDescriptor: 'Lcom/king/demo/Utils;',
        methods: [
          { name: 'add', proto: '(II)I', insnsBytes: makeInsns(6), registers: 3 },
          { name: 'noop', proto: '()V' }, // abstract: no insnsBytes
        ],
      },
    ];
  return buildDex({ version: '035', classes });
}

/* ------------------------------------------------------------------ */
/* Smoke 用：左右两侧 method-level 差异演示                          */
/* ------------------------------------------------------------------ */

/**
 * 左侧 demo dex：含 3 个方法
 *  - Lcom/king/Util;->oldMethod()V         （右侧将删除）
 *  - Lcom/king/Util;->common()V            （右侧 insns 大小不变但 body 改变 → body changed）
 *  - Lcom/king/Util;->grow(I)V             （右侧 insns 大小从 4 → 12，size delta）
 */
export function buildSmokeDexLeft(): Buffer {
  return buildDex({
    version: '035',
    classes: [
      {
        classDescriptor: 'Lcom/king/Util;',
        methods: [
          { name: '<init>', proto: '()V', insnsBytes: DEFAULT_INSNS, registers: 1 },
          { name: 'oldMethod', proto: '()V', insnsBytes: makeInsns(4), registers: 1 },
          {
            name: 'common',
            proto: '()V',
            // body=A：第一字节 0x0e (return-void)
            insnsBytes: Buffer.from([0x0e, 0x00, 0x00, 0x00]),
            registers: 1,
          },
          { name: 'grow', proto: '(I)V', insnsBytes: makeInsns(4), registers: 2 },
        ],
      },
    ],
  });
}

/**
 * 右侧 demo dex：相对左侧的变化：
 *  - 删除 oldMethod
 *  - 新增 brandNew(Ljava/lang/String;)V
 *  - common()V 大小不变但首字节不同 → body changed (依赖 sha256 启用)
 *  - grow(I)V insns 大小 4 → 12 → insnsSizeDelta=+4 code units
 */
export function buildSmokeDexRight(): Buffer {
  return buildDex({
    version: '035',
    classes: [
      {
        classDescriptor: 'Lcom/king/Util;',
        methods: [
          { name: '<init>', proto: '()V', insnsBytes: DEFAULT_INSNS, registers: 1 },
          {
            name: 'common',
            proto: '()V',
            // body=B：与左侧相同长度但字节不同（0x12 const/4 v0,#0 + 0x0f return v0）
            insnsBytes: Buffer.from([0x12, 0x00, 0x0f, 0x00]),
            registers: 1,
          },
          { name: 'grow', proto: '(I)V', insnsBytes: makeInsns(12), registers: 2 },
          {
            name: 'brandNew',
            proto: '(Ljava/lang/String;)V',
            insnsBytes: makeInsns(6),
            registers: 2,
          },
        ],
      },
    ],
  });
}
