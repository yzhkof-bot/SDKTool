/**
 * Minimal ELF64 LSB shared-object fixture（测试用）。
 *
 * 用途：给 `nativeSymbols` analyzer + native symbol diff 单测构造可控的 .so 内容。
 * 不追求完整 ELF 语义（无 program header / 无 dynamic / 无 GNU note），
 * 仅保证 zero-dep ELF parser 能正确读出：
 *   - ELF header（class=64 / data=LSB / type=ET_DYN / machine=AARCH64）
 *   - Section headers（NULL + .text + .dynstr + .dynsym + .shstrtab，
 *     可选 + .rela.text 用于 relocation mask 单测）
 *   - .dynsym 内的 FUNC 符号 + 其 st_value 落在 .text 范围内
 *
 * Layout（紧排，按声明顺序，无 padding 间隙）：
 *   [ELF header 64B]
 *   [.text bytes ...]
 *   [.dynstr ...]
 *   [.dynsym entries ...]
 *   [.rela.text entries (可选)]
 *   [.shstrtab ...]
 *   [section header table (5-6 × 64B)]
 *
 * 注意：`.text` 的 sh_addr 与 sh_offset 取同一个值，方便 mapVaddrToFileOffset
 * 直接由 st_value 找回文件偏移；也跟真实链接器对 PIC .so 的常见结果一致。
 */

const ELF64_HEADER_SIZE = 64;
const ELF64_SHDR_SIZE = 64;
const ELF64_DYNSYM_ENT = 24;
const ELF64_RELA_ENT = 24;

/* sh_type */
const SHT_NULL = 0;
const SHT_PROGBITS = 1;
const SHT_STRTAB = 3;
const SHT_DYNSYM = 11;
const SHT_RELA = 4;

/* sh_flags */
const SHF_WRITE = 0x1;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;
const SHF_STRINGS = 0x20;

/* st_info bind/type */
const STB_GLOBAL = 1;
const STT_FUNC = 2;
const STT_OBJECT = 1;
const STT_NOTYPE = 0;

/* SHN */
const SHN_UNDEF = 0;

/* e_type */
const ET_DYN = 3;
const EM_AARCH64 = 183;

export interface BuildElfSymbol {
  /** 符号名（如 "foo"）；imported 时 body 必须为 undefined */
  name: string;
  /** 函数体字节内容；undefined 表示 imported（st_shndx=SHN_UNDEF, size=0） */
  body?: Buffer;
  /** 强制覆盖 st_size（很少需要；默认 = body.length 或 0） */
  sizeOverride?: number;
  /** 符号类型，默认 FUNC（imported 自动 NOTYPE） */
  type?: 'FUNC' | 'OBJECT' | 'NOTYPE';
}

export interface BuildElfReloc {
  /** 落在 .text 段内的偏移（相对 .text 起始字节），覆盖字节数由 type 决定 */
  textOffset: number;
  /** AArch64 reloc type，例如 283=R_AARCH64_CALL26（4 字节）、256=R_AARCH64_ABS64（8 字节） */
  type: number;
}

export interface BuildElfOptions {
  symbols: BuildElfSymbol[];
  /** .text 起始虚拟地址，默认 0x1000；mapVaddrToFileOffset 对此基址透明 */
  textVaddr?: number;
  /**
   * 注入到 .rela.text 段的 reloc 条目（可选）。analyzer 会按 type 推断 mask 字节数，
   * 把这些字节范围在 hash 前置零——用于验证"重链接位移噪声被吸收"的关键链路。
   */
  textRelocations?: BuildElfReloc[];
}

/**
 * 构造一个最小可被 nativeSymbols analyzer 解析的 ELF64 LSB shared-object。
 */
export function buildElf(opts: BuildElfOptions): Buffer {
  const textVaddr = opts.textVaddr ?? 0x1000;

  /* 1. 拼 .text + 记录每个 defined 符号在 .text 内的偏移 */
  const textChunks: Buffer[] = [];
  const symbolMeta: Array<{
    nameOffset: number;
    stValue: number;
    stSize: number;
    stInfo: number;
    stShndx: number;
  }> = [];

  let textCursor = 0;
  // 占位，后面回填 nameOffset
  const defByIdx: Array<{ body: Buffer | undefined; type: BuildElfSymbol['type'] }> = [];
  for (const s of opts.symbols) defByIdx.push({ body: s.body, type: s.type });

  for (const sym of opts.symbols) {
    if (sym.body) {
      const off = textCursor;
      textChunks.push(sym.body);
      textCursor += sym.body.length;
      symbolMeta.push({
        nameOffset: 0, // 占位
        stValue: 0, // 占位，等 .text 起始 vaddr 算出后回填
        stSize: sym.sizeOverride ?? sym.body.length,
        stInfo: encodeStInfo(STB_GLOBAL, encodeStType(sym.type ?? 'FUNC')),
        stShndx: 1, // .text 的 section index（NULL=0, .text=1）
      });
      symbolMeta[symbolMeta.length - 1]!.stValue = textVaddr + off;
    } else {
      symbolMeta.push({
        nameOffset: 0,
        stValue: 0,
        stSize: sym.sizeOverride ?? 0,
        stInfo: encodeStInfo(STB_GLOBAL, encodeStType(sym.type ?? 'NOTYPE')),
        stShndx: SHN_UNDEF,
      });
    }
  }
  const textBytes = Buffer.concat(textChunks);

  /* 2. 拼 .dynstr：第一个字节 \0；其余按声明顺序拼 name + \0 */
  const dynstrChunks: Buffer[] = [Buffer.from([0])];
  let dynstrCursor = 1;
  for (let i = 0; i < opts.symbols.length; i++) {
    symbolMeta[i]!.nameOffset = dynstrCursor;
    const nameBuf = Buffer.from(opts.symbols[i]!.name, 'utf8');
    dynstrChunks.push(nameBuf, Buffer.from([0]));
    dynstrCursor += nameBuf.length + 1;
  }
  const dynstrBytes = Buffer.concat(dynstrChunks);

  /* 3. 拼 .dynsym：第 0 项是 NULL，后面是用户符号 */
  const dynsymBytes = Buffer.alloc((opts.symbols.length + 1) * ELF64_DYNSYM_ENT);
  for (let i = 0; i < opts.symbols.length; i++) {
    const m = symbolMeta[i]!;
    const baseOff = (i + 1) * ELF64_DYNSYM_ENT;
    dynsymBytes.writeUInt32LE(m.nameOffset, baseOff + 0);
    dynsymBytes.writeUInt8(m.stInfo, baseOff + 4);
    dynsymBytes.writeUInt8(0, baseOff + 5); // st_other
    dynsymBytes.writeUInt16LE(m.stShndx, baseOff + 6);
    dynsymBytes.writeBigUInt64LE(BigInt(m.stValue), baseOff + 8);
    dynsymBytes.writeBigUInt64LE(BigInt(m.stSize), baseOff + 16);
  }

  /* 4. .shstrtab：含每个 section 的名字 */
  const sectionNames = hasReloFixedNames()
    ? ['', '.text', '.dynstr', '.dynsym', '.rela.text', '.shstrtab']
    : ['', '.text', '.dynstr', '.dynsym', '.shstrtab'];

  function hasReloFixedNames(): boolean {
    return (opts.textRelocations?.length ?? 0) > 0;
  }
  const shstrChunks: Buffer[] = [];
  const shstrOffsets: number[] = [];
  let shstrCursor = 0;
  for (const n of sectionNames) {
    shstrOffsets.push(shstrCursor);
    const b = Buffer.from(n + '\0', 'utf8');
    shstrChunks.push(b);
    shstrCursor += b.length;
  }
  const shstrBytes = Buffer.concat(shstrChunks);

  /* 4.5. .rela.text（可选） */
  const hasRela = (opts.textRelocations?.length ?? 0) > 0;
  const relaBytes = hasRela
    ? Buffer.alloc(opts.textRelocations!.length * ELF64_RELA_ENT)
    : Buffer.alloc(0);
  if (hasRela) {
    for (let i = 0; i < opts.textRelocations!.length; i++) {
      const r = opts.textRelocations![i]!;
      const off = i * ELF64_RELA_ENT;
      // r_offset = textVaddr + textOffset（analyzer 会用 r_offset - text.shAddr
      // 还原段内偏移；text.shAddr 我们设为 textVaddr，所以 r_offset 直接等于
      // textVaddr + textOffset）
      relaBytes.writeBigUInt64LE(BigInt(textVaddr + r.textOffset), off + 0);
      // r_info：高 32 位 = sym index（这里固定 0，不影响 mask 逻辑）；
      // 低 32 位 = type（analyzer 用小端读 base+8 的低 32 位）
      relaBytes.writeUInt32LE(r.type >>> 0, off + 8);
      relaBytes.writeUInt32LE(0, off + 12);
      // r_addend = 0
      relaBytes.writeBigInt64LE(0n, off + 16);
    }
  }

  /* 5. 算各 section 的文件偏移（紧排，按声明顺序） */
  const textOff = ELF64_HEADER_SIZE;
  const dynstrOff = textOff + textBytes.length;
  const dynsymOff = dynstrOff + dynstrBytes.length;
  const relaOff = dynsymOff + dynsymBytes.length;
  const shstrOff = relaOff + relaBytes.length;
  const shdrOff = shstrOff + shstrBytes.length;
  // section 总数：NULL + .text + .dynstr + .dynsym + (.rela.text 可选) + .shstrtab
  const sectionCount = hasRela ? 6 : 5;

  /* 6. 组装 section header table */
  const shdrTable = Buffer.alloc(sectionCount * ELF64_SHDR_SIZE);
  // [0] NULL
  // [1] .text
  writeShdr(shdrTable, 1, {
    shName: shstrOffsets[1]!,
    shType: SHT_PROGBITS,
    shFlags: SHF_ALLOC | SHF_EXECINSTR,
    shAddr: textVaddr,
    shOffset: textOff,
    shSize: textBytes.length,
    shLink: 0,
    shInfo: 0,
    shAddrAlign: 4,
    shEntSize: 0,
  });
  // [2] .dynstr
  writeShdr(shdrTable, 2, {
    shName: shstrOffsets[2]!,
    shType: SHT_STRTAB,
    shFlags: SHF_ALLOC | SHF_STRINGS,
    shAddr: 0,
    shOffset: dynstrOff,
    shSize: dynstrBytes.length,
    shLink: 0,
    shInfo: 0,
    shAddrAlign: 1,
    shEntSize: 0,
  });
  // [3] .dynsym（sh_link = .dynstr index = 2）
  writeShdr(shdrTable, 3, {
    shName: shstrOffsets[3]!,
    shType: SHT_DYNSYM,
    shFlags: SHF_ALLOC,
    shAddr: 0,
    shOffset: dynsymOff,
    shSize: dynsymBytes.length,
    shLink: 2,
    shInfo: 1, // first non-local; 不影响本 fixture 的 diff 路径
    shAddrAlign: 8,
    shEntSize: ELF64_DYNSYM_ENT,
  });

  // 可选 [4] .rela.text（sh_info=1 指向 .text；sh_link=3 指向 .dynsym）
  // 仅当有 reloc 注入时插入；后续 .shstrtab 索引随之 +1
  const shstrSectionIdx = hasRela ? 5 : 4;
  if (hasRela) {
    writeShdr(shdrTable, 4, {
      shName: shstrOffsets[4]!,
      shType: SHT_RELA,
      shFlags: 0,
      shAddr: 0,
      shOffset: relaOff,
      shSize: relaBytes.length,
      shLink: 3, // .dynsym
      shInfo: 1, // .text
      shAddrAlign: 8,
      shEntSize: ELF64_RELA_ENT,
    });
  }

  // .shstrtab（索引随是否有 .rela.text 浮动）
  writeShdr(shdrTable, shstrSectionIdx, {
    shName: shstrOffsets[shstrSectionIdx]!,
    shType: SHT_STRTAB,
    shFlags: 0,
    shAddr: 0,
    shOffset: shstrOff,
    shSize: shstrBytes.length,
    shLink: 0,
    shInfo: 0,
    shAddrAlign: 1,
    shEntSize: 0,
  });

  /* 7. 组装 ELF header */
  const totalSize = shdrOff + shdrTable.length;
  const out = Buffer.alloc(totalSize);
  // e_ident
  out.writeUInt32BE(0x7f454c46, 0); // \x7fELF
  out.writeUInt8(2, 4); // EI_CLASS=ELFCLASS64
  out.writeUInt8(1, 5); // EI_DATA=ELFDATA2LSB
  out.writeUInt8(1, 6); // EI_VERSION
  // EI_OSABI .. EI_PAD 全 0
  out.writeUInt16LE(ET_DYN, 16); // e_type
  out.writeUInt16LE(EM_AARCH64, 18); // e_machine
  out.writeUInt32LE(1, 20); // e_version
  out.writeBigUInt64LE(0n, 24); // e_entry
  out.writeBigUInt64LE(0n, 32); // e_phoff (no PHDR)
  out.writeBigUInt64LE(BigInt(shdrOff), 40); // e_shoff
  out.writeUInt32LE(0, 48); // e_flags
  out.writeUInt16LE(ELF64_HEADER_SIZE, 52); // e_ehsize
  out.writeUInt16LE(0, 54); // e_phentsize
  out.writeUInt16LE(0, 56); // e_phnum
  out.writeUInt16LE(ELF64_SHDR_SIZE, 58); // e_shentsize
  out.writeUInt16LE(sectionCount, 60); // e_shnum
  out.writeUInt16LE(shstrSectionIdx, 62); // e_shstrndx

  // payload
  textBytes.copy(out, textOff);
  dynstrBytes.copy(out, dynstrOff);
  dynsymBytes.copy(out, dynsymOff);
  if (hasRela) relaBytes.copy(out, relaOff);
  shstrBytes.copy(out, shstrOff);
  shdrTable.copy(out, shdrOff);

  return out;
}

function writeShdr(
  table: Buffer,
  idx: number,
  s: {
    shName: number;
    shType: number;
    shFlags: number;
    shAddr: number;
    shOffset: number;
    shSize: number;
    shLink: number;
    shInfo: number;
    shAddrAlign: number;
    shEntSize: number;
  },
): void {
  const off = idx * ELF64_SHDR_SIZE;
  table.writeUInt32LE(s.shName, off + 0);
  table.writeUInt32LE(s.shType, off + 4);
  table.writeBigUInt64LE(BigInt(s.shFlags), off + 8);
  table.writeBigUInt64LE(BigInt(s.shAddr), off + 16);
  table.writeBigUInt64LE(BigInt(s.shOffset), off + 24);
  table.writeBigUInt64LE(BigInt(s.shSize), off + 32);
  table.writeUInt32LE(s.shLink, off + 40);
  table.writeUInt32LE(s.shInfo, off + 44);
  table.writeBigUInt64LE(BigInt(s.shAddrAlign), off + 48);
  table.writeBigUInt64LE(BigInt(s.shEntSize), off + 56);
}

function encodeStInfo(bind: number, type: number): number {
  return ((bind & 0xf) << 4) | (type & 0xf);
}

function encodeStType(t: BuildElfSymbol['type'] | undefined): number {
  switch (t) {
    case 'FUNC':
    case undefined:
      return STT_FUNC;
    case 'OBJECT':
      return STT_OBJECT;
    case 'NOTYPE':
      return STT_NOTYPE;
    default:
      return STT_FUNC;
  }
}

/* ------------------------------------------------------------------ */
/* Smoke 用：左右双 .so 演示同名同 size 但 body 不同的 diff 信号       */
/* ------------------------------------------------------------------ */

/**
 * 左侧 demo .so：
 *   foo  (FUNC, 8B body=AA)        → 右侧 size 不变 body 变  → bodyChanged=true
 *   bar  (FUNC, 8B body=BB)        → 右侧 size 8→16 增长     → sizeChanged + bodyChanged=true
 *   gone (FUNC, 4B body)           → 右侧删除                → removed
 *   shared (FUNC, 4B body=CC)      → 右侧完全一致           → unchanged
 */
export function buildSmokeElfLeft(): Buffer {
  return buildElf({
    symbols: [
      { name: 'foo', body: Buffer.alloc(8, 0xaa) },
      { name: 'bar', body: Buffer.alloc(8, 0xbb) },
      { name: 'gone', body: Buffer.alloc(4, 0xcc) },
      { name: 'shared', body: Buffer.from([0xcc, 0xcc, 0xcc, 0xcc]) },
    ],
  });
}

/**
 * 右侧 demo .so：
 *   foo (FUNC, 8B body=DD)         → 与左侧 size 相同 body 全异 → bodyChanged=true delta=0
 *   bar (FUNC, 16B body=BB,EE 各半) → size 8→16，body 也变       → bodyChanged=true delta=+8
 *   shared (FUNC, 4B body=CC)      → 与左侧完全一致              → unchanged
 *   brand (FUNC, 6B body=FF)       → 全新增                      → added
 */
export function buildSmokeElfRight(): Buffer {
  return buildElf({
    symbols: [
      { name: 'foo', body: Buffer.alloc(8, 0xdd) },
      {
        name: 'bar',
        body: Buffer.concat([Buffer.alloc(8, 0xbb), Buffer.alloc(8, 0xee)]),
      },
      { name: 'shared', body: Buffer.from([0xcc, 0xcc, 0xcc, 0xcc]) },
      { name: 'brand', body: Buffer.alloc(6, 0xff) },
    ],
  });
}
