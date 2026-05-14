import type {
  Analyzer,
  AnalyzerContext,
  HapNativeLibMitigations,
  HapNativeLibRodataStrings,
  HapNativeLibSection,
  HapNativeLibSymbols,
  HapNativeLibSymbolsInfo,
  HapNativeSymbol,
  HapReport,
  NativeSymbolBind,
  NativeSymbolType,
} from '../../shared/schema.js';
import { basename } from '../../shared/utils.js';

/**
 * 可选深度分析：对每个 libs/<arch>/*.so 做"ELF 多维度解剖"。
 *
 * 输出维度（每项失败都 fail-soft，不影响其它）：
 *   - elfClass / 符号表（.dynsym + .dynstr）：自身定义 vs 导入；按 size 排序后截断保留 Top-N
 *   - sections：所有 section 的 name / type / size / offset / flags（A/X/W/S/T）
 *   - needed：动态依赖 DT_NEEDED（运行时链接的其它 so）
 *   - buildId：`.note.gnu.build-id` 的 hex 指纹
 *   - comment：`.comment` 段中编译器版本字符串
 *   - mitigations：NX / RELRO (full/partial/none) / PIE / StackCanary / FORTIFY
 *   - glibcVersions：`.gnu.version_r` 里 Verneed→Vernaux 抽出的版本符号集合
 *   - rodataStrings：从 `.rodata` 段启发式抽取的字符串池，按 url/path/sql/other 分类
 *
 * 设计要点：
 *   - **零外部依赖**：手写 ELF 解析器（header / section / program header / 动态表 / 注释 / 版本需求），
 *     仅依赖 Node Buffer。
 *   - **fail-soft**：任一子解析抛错都被 try/catch 包住，写入 warning 但 keep 其它字段；只有"非 ELF /
 *     文件太短 / section header 越界"这类彻底无法继续的错才设 error 并清空各维度。
 *   - **符号默认全量**：`maxSymbolsPerLib=0` 默认不截，保证 differ 准确；
 *     viewer 通过分页（每页 50）让用户翻看，不再依赖 analyzer 截断。
 *     需要压缩 JSON 时仍可显式传 `maxSymbolsPerLib=N` 强制截断。
 *   - **rodata 字符串限额**：每分类 Top-N，默认 2000；其它分类压到 200，因为噪声多。
 *
 * 默认关闭（enabledByDefault: false），需要 `--extras nativeSymbols` 或 workbench 多选启用。
 */
export const nativeSymbolsAnalyzer: Analyzer = {
  id: 'nativeSymbols',
  name: 'Native Deep Analysis',
  enabledByDefault: false,
  async run(ctx: AnalyzerContext): Promise<Partial<HapReport>> {
    // 项目级硬约定（见 .cursor/rules/data-completeness.mdc）：所有限额默认 0 = 全量。
    // viewer 用 paginated() 分页，不依赖 analyzer 截断。
    const maxPerLib = clampMax(ctx.options.maxSymbolsPerLib, 0);
    const rodataLimit = clampMax(ctx.options.rodataStringLimit, 0);
    const targets = ctx.hap.entries.filter(
      (e) => !e.isDirectory && /^libs\/([^/]+)\/.+\.so$/i.test(e.path),
    );

    const perLib: HapNativeLibSymbols[] = [];
    for (const entry of targets) {
      const m = /^libs\/([^/]+)\/(.+)$/.exec(entry.path)!;
      const arch = m[1] ?? '';
      const name = basename(m[2] ?? '');
      try {
        const buf = await ctx.hap.readFile(entry.path);
        const parsed = parseElfDeep(buf, { maxPerLib, rodataLimit, addWarning: ctx.addWarning, path: entry.path });
        perLib.push({ arch, name, ...parsed });
      } catch (err) {
        perLib.push({
          arch,
          name,
          elfClass: 'UNKNOWN',
          totalSymbols: 0,
          definedCount: 0,
          importedCount: 0,
          symbols: [],
          error: (err as Error).message ?? String(err),
        });
        ctx.addWarning({
          code: 'NATIVE_DEEP_PARSE_FAILED',
          level: 'warn',
          message: `解析 ${entry.path} 失败: ${(err as Error).message ?? String(err)}`,
        });
      }
    }

    perLib.sort((a, b) => {
      if (a.arch !== b.arch) return a.arch.localeCompare(b.arch);
      return a.name.localeCompare(b.name);
    });

    const info: HapNativeLibSymbolsInfo = {
      perLib,
      scanned: perLib.length,
      maxSymbolsPerLib: maxPerLib,
      rodataStringLimit: rodataLimit,
    };
    return { nativeLibSymbols: info };
  },
};

function clampMax(input: number | undefined, fallback: number): number {
  if (input === undefined) return fallback;
  if (!Number.isFinite(input) || input < 0) return fallback;
  return Math.floor(input);
}

/* ============================================================================
 * ELF 解析（多阶段）
 * ============================================================================ */

const ELF_MAGIC = 0x7f454c46; // \x7fELF (big-endian read)
const ELFCLASS32 = 1;
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const ELFDATA2MSB = 2;

/* sh_type */
const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;
const SHT_HASH = 5;
const SHT_DYNAMIC = 6;
const SHT_NOTE = 7;
const SHT_NOBITS = 8;
const SHT_REL = 9;
const SHT_DYNSYM = 11;
const SHT_INIT_ARRAY = 14;
const SHT_FINI_ARRAY = 15;
const SHT_GNU_verdef = 0x6ffffffd;
const SHT_GNU_verneed = 0x6ffffffe;
const SHT_GNU_versym = 0x6fffffff;

/* sh_flags */
const SHF_WRITE = 0x1;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;
const SHF_STRINGS = 0x20;
const SHF_TLS = 0x400;

/* p_type */
const PT_GNU_STACK = 0x6474e551;
const PT_GNU_RELRO = 0x6474e552;
const PF_X = 1;

/* d_tag */
const DT_NULL = 0;
const DT_NEEDED = 1;
const DT_BIND_NOW = 24;
const DT_FLAGS_1 = 0x6ffffffb;
const DF_1_NOW = 0x1;

/* st_info / SHN */
const SHN_UNDEF = 0;

/* note: NT_GNU_BUILD_ID */
const NT_GNU_BUILD_ID = 3;

interface SectionHeader {
  index: number;
  nameIdx: number;
  name: string;
  type: number;
  flags: number;
  offset: number;
  size: number;
  link: number;
  info: number;
  entsize: number;
}

interface ProgramHeader {
  type: number;
  flags: number;
  offset: number;
  filesz: number;
  memsz: number;
}

interface ParsedElf {
  buf: Buffer;
  is64: boolean;
  isLE: boolean;
  eType: number;
  eMachine: number;
  sections: SectionHeader[];
  programHeaders: ProgramHeader[];
  /** 按 name 反向索引 */
  sectionByName: Map<string, SectionHeader>;
  r16(off: number): number;
  r32(off: number): number;
  rWord(off: number): number;
}

interface DeepOpts {
  maxPerLib: number;
  rodataLimit: number;
  path: string;
  addWarning: AnalyzerContext['addWarning'];
}

function parseElfDeep(buf: Buffer, opts: DeepOpts): Omit<HapNativeLibSymbols, 'arch' | 'name'> {
  const base: Omit<HapNativeLibSymbols, 'arch' | 'name'> = {
    elfClass: 'UNKNOWN',
    totalSymbols: 0,
    definedCount: 0,
    importedCount: 0,
    symbols: [],
  };

  const elf = parseElfBasics(buf);
  base.elfClass = elf.is64 ? 'ELF64' : 'ELF32';

  /** 任一子项失败都不影响其它字段；失败信息进 warning，不写 error */
  const trySub = <T,>(code: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (err) {
      opts.addWarning({
        code,
        level: 'warn',
        message: `${opts.path}: ${(err as Error).message ?? String(err)}`,
      });
      return undefined;
    }
  };

  /* 1. 符号表（保留原有行为：取 .dynsym，否则退化 .symtab） */
  const dynsymRes = trySub('NATIVE_DEEP_SYMBOLS_FAILED', () => parseSymbolTable(elf, opts.maxPerLib));
  if (dynsymRes) {
    base.totalSymbols = dynsymRes.totalSymbols;
    base.definedCount = dynsymRes.definedCount;
    base.importedCount = dynsymRes.importedCount;
    base.symbols = dynsymRes.symbols;
  }

  /* 2. sections breakdown */
  const sections = trySub('NATIVE_DEEP_SECTIONS_FAILED', () => parseSectionsBreakdown(elf));
  if (sections) base.sections = sections;

  /* 3. dynamic table → needed + bindNow / df_1_now */
  const dyn = trySub('NATIVE_DEEP_DYNAMIC_FAILED', () => parseDynamic(elf));
  if (dyn) {
    if (dyn.needed.length > 0) base.needed = dyn.needed;
  }

  /* 4. build-id + comment */
  const buildId = trySub('NATIVE_DEEP_BUILDID_FAILED', () => parseBuildId(elf));
  if (buildId) base.buildId = buildId;
  const comment = trySub('NATIVE_DEEP_COMMENT_FAILED', () => parseComment(elf));
  if (comment) base.comment = comment;

  /* 5. glibc versions（.gnu.version_r） */
  const glibcVersions = trySub('NATIVE_DEEP_VERNEED_FAILED', () => parseSymbolVersions(elf));
  if (glibcVersions && glibcVersions.length > 0) base.glibcVersions = glibcVersions;

  /* 6. mitigations（需要 program headers + dyn flags + dynsym 导入符号） */
  const mitigations = trySub('NATIVE_DEEP_MITIGATIONS_FAILED', () =>
    parseMitigations(elf, dyn, dynsymRes?.allImports ?? new Set()),
  );
  if (mitigations) base.mitigations = mitigations;

  /* 7. .rodata 字符串 */
  const rodataStrings = trySub('NATIVE_DEEP_RODATA_FAILED', () =>
    parseRodataStrings(elf, opts.rodataLimit),
  );
  if (rodataStrings) base.rodataStrings = rodataStrings;

  return base;
}

/* ---------------------------------------------------------------------------
 * 1. ELF 头 + section header table + program header table
 * --------------------------------------------------------------------------- */

function parseElfBasics(buf: Buffer): ParsedElf {
  if (buf.length < 16) throw new Error('文件太短，非 ELF');
  if (buf.readUInt32BE(0) !== ELF_MAGIC) throw new Error('ELF magic 不匹配');

  const eiClass = buf.readUInt8(4);
  const eiData = buf.readUInt8(5);
  const is64 = eiClass === ELFCLASS64;
  const isLE = eiData === ELFDATA2LSB;
  if (eiClass !== ELFCLASS32 && eiClass !== ELFCLASS64) {
    throw new Error(`未知 EI_CLASS=${eiClass}`);
  }
  if (eiData !== ELFDATA2LSB && eiData !== ELFDATA2MSB) {
    throw new Error(`未知 EI_DATA=${eiData}`);
  }

  const r16 = (off: number) => (isLE ? buf.readUInt16LE(off) : buf.readUInt16BE(off));
  const r32 = (off: number) => (isLE ? buf.readUInt32LE(off) : buf.readUInt32BE(off));
  const rWord = (off: number): number =>
    is64
      ? Number(isLE ? buf.readBigUInt64LE(off) : buf.readBigUInt64BE(off))
      : r32(off);

  // ELF Header
  const eType = r16(16);
  const eMachine = r16(18);
  const ePhoff = is64 ? rWord(32) : r32(28);
  const ePhentsize = is64 ? r16(54) : r16(42);
  const ePhnum = is64 ? r16(56) : r16(44);
  const eShoff = is64 ? rWord(40) : r32(32);
  const eShentsize = is64 ? r16(58) : r16(46);
  const eShnum = is64 ? r16(60) : r16(48);
  const eShstrndx = is64 ? r16(62) : r16(50);

  /* Program headers */
  const programHeaders: ProgramHeader[] = [];
  if (ePhoff !== 0 && ePhnum > 0) {
    if (ePhoff + ePhnum * ePhentsize > buf.length) {
      throw new Error('program header table 越界');
    }
    for (let i = 0; i < ePhnum; i++) {
      const base = ePhoff + i * ePhentsize;
      if (is64) {
        // ELF64 phdr: p_type(4) p_flags(4) p_offset(8) p_vaddr(8) p_paddr(8) p_filesz(8) p_memsz(8) p_align(8)
        programHeaders.push({
          type: r32(base + 0),
          flags: r32(base + 4),
          offset: rWord(base + 8),
          filesz: rWord(base + 32),
          memsz: rWord(base + 40),
        });
      } else {
        // ELF32 phdr: p_type(4) p_offset(4) p_vaddr(4) p_paddr(4) p_filesz(4) p_memsz(4) p_flags(4) p_align(4)
        programHeaders.push({
          type: r32(base + 0),
          offset: r32(base + 4),
          filesz: r32(base + 16),
          memsz: r32(base + 20),
          flags: r32(base + 24),
        });
      }
    }
  }

  /* Section headers */
  if (eShoff === 0 || eShnum === 0) {
    // 没 section header（极少见，被严格 strip 时）— 返回空 section 列表，让上层能继续走 PHDR-only 维度
    return {
      buf,
      is64,
      isLE,
      eType,
      eMachine,
      sections: [],
      programHeaders,
      sectionByName: new Map(),
      r16,
      r32,
      rWord,
    };
  }
  if (eShoff + eShnum * eShentsize > buf.length) {
    throw new Error('section header table 越界');
  }

  const rawSections: SectionHeader[] = [];
  for (let i = 0; i < eShnum; i++) {
    const base = eShoff + i * eShentsize;
    const nameIdx = r32(base + 0);
    const type = r32(base + 4);
    if (is64) {
      // ELF64: sh_name(4) sh_type(4) sh_flags(8) sh_addr(8) sh_offset(8) sh_size(8) sh_link(4) sh_info(4) sh_addralign(8) sh_entsize(8)
      rawSections.push({
        index: i,
        nameIdx,
        name: '',
        type,
        flags: Number(isLE ? buf.readBigUInt64LE(base + 8) : buf.readBigUInt64BE(base + 8)),
        offset: rWord(base + 24),
        size: rWord(base + 32),
        link: r32(base + 40),
        info: r32(base + 44),
        entsize: rWord(base + 56),
      });
    } else {
      // ELF32: sh_name(4) sh_type(4) sh_flags(4) sh_addr(4) sh_offset(4) sh_size(4) sh_link(4) sh_info(4) sh_addralign(4) sh_entsize(4)
      rawSections.push({
        index: i,
        nameIdx,
        name: '',
        type,
        flags: r32(base + 8),
        offset: r32(base + 16),
        size: r32(base + 20),
        link: r32(base + 24),
        info: r32(base + 28),
        entsize: r32(base + 36),
      });
    }
  }

  /* shstrtab 解析 section name */
  const shstr = rawSections[eShstrndx];
  if (shstr && shstr.offset + shstr.size <= buf.length) {
    for (const s of rawSections) {
      s.name = readNullTerminated(buf, shstr.offset + s.nameIdx, shstr.size - s.nameIdx);
    }
  }

  const sectionByName = new Map<string, SectionHeader>();
  for (const s of rawSections) {
    if (s.name && !sectionByName.has(s.name)) sectionByName.set(s.name, s);
  }

  return {
    buf,
    is64,
    isLE,
    eType,
    eMachine,
    sections: rawSections,
    programHeaders,
    sectionByName,
    r16,
    r32,
    rWord,
  };
}

/* ---------------------------------------------------------------------------
 * 2. 符号表（.dynsym → 退化 .symtab）
 * --------------------------------------------------------------------------- */

interface ParsedSymbols {
  totalSymbols: number;
  definedCount: number;
  importedCount: number;
  symbols: HapNativeSymbol[];
  /** 所有导入符号名集合（mitigations 用） */
  allImports: Set<string>;
}

function parseSymbolTable(elf: ParsedElf, maxPerLib: number): ParsedSymbols {
  const { buf, is64, sections, r16, r32, rWord } = elf;
  const symbolSection =
    sections.find((s) => s.type === SHT_DYNSYM) ?? sections.find((s) => s.type === SHT_SYMTAB);
  if (!symbolSection) {
    return { totalSymbols: 0, definedCount: 0, importedCount: 0, symbols: [], allImports: new Set() };
  }

  const strSection = sections[symbolSection.link];
  if (!strSection) throw new Error('符号表关联的字符串表不存在');
  if (strSection.offset + strSection.size > buf.length) {
    throw new Error('字符串表越界');
  }

  const symEntSize = symbolSection.entsize > 0 ? symbolSection.entsize : (is64 ? 24 : 16);
  if (symEntSize !== (is64 ? 24 : 16)) {
    throw new Error(`不识别的 symbol entry size=${symEntSize}`);
  }
  const symCount = Math.floor(symbolSection.size / symEntSize);
  if (symbolSection.offset + symbolSection.size > buf.length) {
    throw new Error('符号表越界');
  }

  const allSymbols: HapNativeSymbol[] = [];
  const allImports = new Set<string>();
  let definedCount = 0;
  let importedCount = 0;

  for (let i = 0; i < symCount; i++) {
    const base = symbolSection.offset + i * symEntSize;
    let stName: number;
    let stInfo: number;
    let stShndx: number;
    let stSize: number;
    if (is64) {
      stName = r32(base + 0);
      stInfo = buf.readUInt8(base + 4);
      stShndx = r16(base + 6);
      stSize = rWord(base + 16);
    } else {
      stName = r32(base + 0);
      stSize = r32(base + 8);
      stInfo = buf.readUInt8(base + 12);
      stShndx = r16(base + 14);
    }

    if (i === 0 && stName === 0 && stInfo === 0) continue;

    const name = readNullTerminated(buf, strSection.offset + stName, strSection.size - stName);
    if (!name) continue;

    const bind = decodeBind(stInfo >> 4);
    const type = decodeType(stInfo & 0x0f);
    const imported = stShndx === SHN_UNDEF;
    if (imported) {
      importedCount += 1;
      allImports.add(name);
    } else {
      definedCount += 1;
    }

    allSymbols.push({ name, bind, type, size: stSize, imported });
  }

  allSymbols.sort((a, b) => {
    if (a.size !== b.size) return b.size - a.size;
    return a.name.localeCompare(b.name);
  });
  const symbols = maxPerLib > 0 ? allSymbols.slice(0, maxPerLib) : allSymbols;

  return {
    totalSymbols: allSymbols.length,
    definedCount,
    importedCount,
    symbols,
    allImports,
  };
}

function decodeBind(b: number): NativeSymbolBind {
  switch (b) {
    case 0: return 'LOCAL';
    case 1: return 'GLOBAL';
    case 2: return 'WEAK';
    default: return 'UNKNOWN';
  }
}

function decodeType(t: number): NativeSymbolType {
  switch (t) {
    case 0: return 'NOTYPE';
    case 1: return 'OBJECT';
    case 2: return 'FUNC';
    case 3: return 'SECTION';
    case 4: return 'FILE';
    case 5: return 'COMMON';
    case 6: return 'TLS';
    default: return 'UNKNOWN';
  }
}

/* ---------------------------------------------------------------------------
 * 3. sections breakdown
 * --------------------------------------------------------------------------- */

function parseSectionsBreakdown(elf: ParsedElf): HapNativeLibSection[] {
  return elf.sections
    .filter((s) => s.name !== '' || s.size > 0) // 跳过 index 0 的 NULL section
    .map((s) => ({
      name: s.name || `<${s.index}>`,
      type: decodeShType(s.type),
      size: s.size,
      offset: s.offset,
      flags: decodeShFlags(s.flags),
    }))
    .sort((a, b) => a.offset - b.offset);
}

function decodeShType(t: number): string {
  switch (t) {
    case 0: return 'NULL';
    case SHT_PROGBITS: return 'PROGBITS';
    case SHT_SYMTAB: return 'SYMTAB';
    case SHT_STRTAB: return 'STRTAB';
    case SHT_RELA: return 'RELA';
    case SHT_HASH: return 'HASH';
    case SHT_DYNAMIC: return 'DYNAMIC';
    case SHT_NOTE: return 'NOTE';
    case SHT_NOBITS: return 'NOBITS';
    case SHT_REL: return 'REL';
    case SHT_DYNSYM: return 'DYNSYM';
    case SHT_INIT_ARRAY: return 'INIT_ARRAY';
    case SHT_FINI_ARRAY: return 'FINI_ARRAY';
    case SHT_GNU_verdef: return 'GNU_verdef';
    case SHT_GNU_verneed: return 'GNU_verneed';
    case SHT_GNU_versym: return 'GNU_versym';
    case 0x6ffffff6: return 'GNU_HASH';
    case 0x70000003: return 'ARM_ATTRIBUTES';
    default: return `0x${t.toString(16)}`;
  }
}

function decodeShFlags(f: number): string {
  let s = '';
  if (f & SHF_ALLOC) s += 'A';
  if (f & SHF_EXECINSTR) s += 'X';
  if (f & SHF_WRITE) s += 'W';
  if (f & SHF_STRINGS) s += 'S';
  if (f & SHF_TLS) s += 'T';
  return s;
}

/* ---------------------------------------------------------------------------
 * 4. dynamic table → needed + bindNow flags
 * --------------------------------------------------------------------------- */

interface ParsedDynamic {
  needed: string[];
  bindNow: boolean;
  df1Now: boolean;
}

function parseDynamic(elf: ParsedElf): ParsedDynamic {
  const { buf, is64, sections, rWord } = elf;
  const dyn = sections.find((s) => s.type === SHT_DYNAMIC);
  if (!dyn) return { needed: [], bindNow: false, df1Now: false };
  const dynstr = sections[dyn.link];
  if (!dynstr) throw new Error('.dynamic 关联的字符串表不存在');
  if (dynstr.offset + dynstr.size > buf.length) throw new Error('.dynstr 越界');
  if (dyn.offset + dyn.size > buf.length) throw new Error('.dynamic 越界');

  const entSize = is64 ? 16 : 8;
  const count = Math.floor(dyn.size / entSize);
  const neededSet = new Set<string>();
  let bindNow = false;
  let df1Now = false;

  for (let i = 0; i < count; i++) {
    const base = dyn.offset + i * entSize;
    const dTag = is64
      ? Number(elf.isLE
          ? buf.readBigInt64LE(base)
          : buf.readBigInt64BE(base))
      : (elf.isLE ? buf.readInt32LE(base) : buf.readInt32BE(base));
    const dUn = rWord(base + (is64 ? 8 : 4));
    if (dTag === DT_NULL) break;
    if (dTag === DT_NEEDED) {
      const name = readNullTerminated(buf, dynstr.offset + dUn, dynstr.size - dUn);
      if (name) neededSet.add(name);
    } else if (dTag === DT_BIND_NOW) {
      bindNow = true;
    } else if (dTag === DT_FLAGS_1) {
      if (dUn & DF_1_NOW) df1Now = true;
    }
  }

  return {
    needed: [...neededSet].sort(),
    bindNow,
    df1Now,
  };
}

/* ---------------------------------------------------------------------------
 * 5. .note.gnu.build-id + .comment
 * --------------------------------------------------------------------------- */

function parseBuildId(elf: ParsedElf): string | undefined {
  const sec = elf.sectionByName.get('.note.gnu.build-id');
  if (!sec || sec.size <= 12) return undefined;
  if (sec.offset + sec.size > elf.buf.length) throw new Error('.note.gnu.build-id 越界');
  const { buf } = elf;
  // note layout: namesz(4) descsz(4) type(4) name(padded4) desc(padded4)
  const namesz = elf.r32(sec.offset + 0);
  const descsz = elf.r32(sec.offset + 4);
  const noteType = elf.r32(sec.offset + 8);
  if (noteType !== NT_GNU_BUILD_ID) return undefined;
  const nameStart = sec.offset + 12;
  const nameAligned = align4(namesz);
  const descStart = nameStart + nameAligned;
  if (descStart + descsz > sec.offset + sec.size) throw new Error('build-id desc 越界');
  return buf.toString('hex', descStart, descStart + descsz);
}

function parseComment(elf: ParsedElf): string | undefined {
  const sec = elf.sectionByName.get('.comment');
  if (!sec || sec.size === 0) return undefined;
  if (sec.offset + sec.size > elf.buf.length) throw new Error('.comment 越界');
  const slice = elf.buf.subarray(sec.offset, sec.offset + sec.size);
  // .comment 是 null 分隔的字符串序列，常见为 "GCC: (...) 12.2.0\0"
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i <= slice.length; i++) {
    if (i === slice.length || slice[i] === 0) {
      if (i > start) {
        const s = decodeIfValidUtf8(slice.subarray(start, i));
        if (s) parts.push(s);
      }
      start = i + 1;
    }
  }
  // 去重保留顺序
  const seen = new Set<string>();
  const dedup: string[] = [];
  for (const p of parts) {
    if (!seen.has(p)) {
      seen.add(p);
      dedup.push(p);
    }
  }
  return dedup.length > 0 ? dedup.join(' | ') : undefined;
}

function align4(n: number): number {
  return (n + 3) & ~3;
}

/* ---------------------------------------------------------------------------
 * 6. .gnu.version_r → GLIBC_x.y / GCC_x.y 这些 versioning 需求集合
 * --------------------------------------------------------------------------- */

function parseSymbolVersions(elf: ParsedElf): string[] {
  const { buf, sections, r16, r32 } = elf;
  const verneed = sections.find((s) => s.type === SHT_GNU_verneed);
  if (!verneed || verneed.size === 0) return [];
  const dynstr = sections[verneed.link];
  if (!dynstr) throw new Error('.gnu.version_r 关联的字符串表不存在');
  if (verneed.offset + verneed.size > buf.length) throw new Error('.gnu.version_r 越界');
  if (dynstr.offset + dynstr.size > buf.length) throw new Error('.dynstr (for verneed) 越界');

  // verneed sh_info 是 Verneed 条目数；vn_next 指向下一条（0 表示结束）
  const entryCount = verneed.info;
  const names = new Set<string>();
  let curVn = verneed.offset;
  for (let i = 0; i < entryCount && curVn < verneed.offset + verneed.size; i++) {
    // Verneed: vn_version(2) vn_cnt(2) vn_file(4) vn_aux(4) vn_next(4)
    const vnCnt = r16(curVn + 2);
    const vnAux = r32(curVn + 8);
    const vnNext = r32(curVn + 12);

    let curVa = curVn + vnAux;
    for (let j = 0; j < vnCnt && curVa < verneed.offset + verneed.size; j++) {
      // Vernaux: vna_hash(4) vna_flags(2) vna_other(2) vna_name(4) vna_next(4)
      const vnaName = r32(curVa + 8);
      const vnaNext = r32(curVa + 12);
      const name = readNullTerminated(buf, dynstr.offset + vnaName, dynstr.size - vnaName);
      if (name) names.add(name);
      if (vnaNext === 0) break;
      curVa += vnaNext;
    }

    if (vnNext === 0) break;
    curVn += vnNext;
  }

  return [...names].sort();
}

/* ---------------------------------------------------------------------------
 * 7. mitigations
 * --------------------------------------------------------------------------- */

const ET_DYN = 3;

function parseMitigations(
  elf: ParsedElf,
  dyn: ParsedDynamic | undefined,
  imports: Set<string>,
): HapNativeLibMitigations {
  // NX：找 PT_GNU_STACK；存在 + 不带 PF_X 即 NX
  const gnuStack = elf.programHeaders.find((p) => p.type === PT_GNU_STACK);
  const nx = gnuStack ? (gnuStack.flags & PF_X) === 0 : false;

  // RELRO：PT_GNU_RELRO 存在 = at least partial；+ (DT_BIND_NOW 或 DF_1_NOW) = full
  const hasRelro = elf.programHeaders.some((p) => p.type === PT_GNU_RELRO);
  const bindNow = (dyn?.bindNow ?? false) || (dyn?.df1Now ?? false);
  const relro: 'full' | 'partial' | 'none' = !hasRelro
    ? 'none'
    : bindNow
      ? 'full'
      : 'partial';

  // PIE：ET_DYN（共享库与 PIE 可执行文件都是 DYN）
  const pie = elf.eType === ET_DYN;

  // Stack canary：dynsym 中导入 __stack_chk_fail
  const stackCanary = imports.has('__stack_chk_fail');

  // FORTIFY：任何 *_chk 形式的 libc 包装（保守起见排除 __stack_chk_*）
  let fortify = false;
  for (const s of imports) {
    if (s.startsWith('__stack_chk_')) continue;
    if (s.startsWith('__') && s.endsWith('_chk')) {
      fortify = true;
      break;
    }
  }

  return { nx, relro, pie, stackCanary, fortify };
}

/* ---------------------------------------------------------------------------
 * 8. .rodata 字符串池
 * --------------------------------------------------------------------------- */

const RODATA_MIN_LEN = 6;
const RODATA_MAX_LEN = 1024;

function parseRodataStrings(elf: ParsedElf, limit: number): HapNativeLibRodataStrings | undefined {
  const sec = elf.sectionByName.get('.rodata');
  if (!sec || sec.size === 0) return undefined;
  if (sec.offset + sec.size > elf.buf.length) throw new Error('.rodata 越界');
  const slice = elf.buf.subarray(sec.offset, sec.offset + sec.size);

  const seen = new Set<string>();
  const all: string[] = [];
  let start = -1;

  for (let i = 0; i < slice.length; i++) {
    const b = slice[i]!;
    if (isPrintableOrUtf8(b)) {
      if (start < 0) start = i;
      continue;
    }
    if (b === 0x00 && start >= 0) {
      const len = i - start;
      if (len >= RODATA_MIN_LEN && len <= RODATA_MAX_LEN) {
        const str = decodeIfValidUtf8(slice.subarray(start, i));
        if (str && acceptRodataStr(str) && !seen.has(str)) {
          seen.add(str);
          all.push(str);
        }
      }
    }
    start = -1;
  }

  const urls: string[] = [];
  const paths: string[] = [];
  const sqlLike: string[] = [];
  const other: string[] = [];

  for (const s of all) {
    if (URL_RE.test(s)) urls.push(s);
    else if (PATH_RE.test(s)) paths.push(s);
    else if (SQL_RE.test(s)) sqlLike.push(s);
    else other.push(s);
  }

  urls.sort();
  paths.sort();
  sqlLike.sort();
  other.sort();

  const apply = (arr: string[], cap: number): { kept: string[]; truncated: boolean } => {
    if (cap <= 0 || arr.length <= cap) return { kept: arr, truncated: false };
    return { kept: arr.slice(0, cap), truncated: true };
  };

  // 全量输出：限额 0 透传到 apply()，不再单独压"其它"分类。
  // acceptRodataStr 的严过滤已经把碎片噪声挡掉了大半；剩下的真噪声让用户分页翻看。
  const r1 = apply(urls, limit);
  const r2 = apply(paths, limit);
  const r3 = apply(sqlLike, limit);
  const r4 = apply(other, limit);

  return {
    totalDistinct: all.length,
    urls: r1.kept,
    paths: r2.kept,
    sqlLike: r3.kept,
    other: r4.kept,
    extractLimit: limit,
    truncated: r1.truncated || r2.truncated || r3.truncated || r4.truncated,
  };
}

/**
 * 过滤掉对 diff 没价值的"垃圾字符串"。
 *
 * `.rodata` 里除了字符串字面量，还有跳转表 / vtable / 常量数组 / RTTI 等结构化二进制数据，
 * 偶尔会出现"4-8 字节连续可打印 ASCII + 0 终止"的伪字符串。下列规则尽量挡掉这类噪声：
 *
 *   1. 至少要有一个字母（拒掉纯数字 / 纯标点）。
 *   2. 必须含一段连续 ≥4 字母数字下划线的"实词"——挡掉 "x &j" "0 9V" 这种"字母 + 空格 + 标点"
 *      碎片，这是最有效的过滤项。
 *   3. 不允许"非 word 字符 / 总长度"占比超过 40%——挡掉 "C/D/E/F/G/H" 这种以分隔符为主的碎片。
 *   4. 排除典型 C printf 格式串。
 */
function acceptRodataStr(s: string): boolean {
  if (!/[A-Za-z]/.test(s)) return false;
  if (!/[A-Za-z0-9_]{4,}/.test(s)) return false;
  const nonWord = (s.match(/[^A-Za-z0-9_]/g) ?? []).length;
  if (nonWord / s.length > 0.4) return false;
  if (/^\s*(%[-+#0 ]*\d*\.?\d*[lhjztL]*[sdfioxXcgGpnu]\s*)+\s*$/.test(s)) return false;
  return true;
}

const URL_RE = /^(?:https?|ftp|ws|wss|file|smb|rtsp|rtmp|content):\/\//i;
const PATH_RE =
  // Unix 绝对路径 / Windows 盘符 / 含 / 的相对路径（至少 2 段）
  /^(?:\/[A-Za-z0-9_./@+\-]+|[A-Za-z]:[\\/][A-Za-z0-9_./\-@+\\]+|(?:[A-Za-z0-9_.\-]+\/){1,}[A-Za-z0-9_.\-]+)$/;
const SQL_RE = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE\s+(?:TABLE|INDEX)|DROP\s+(?:TABLE|INDEX)|ALTER\s+TABLE|REPLACE\s+INTO|PRAGMA)\b/i;

/* ---------------------------------------------------------------------------
 * 公共工具
 * --------------------------------------------------------------------------- */

function readNullTerminated(buf: Buffer, start: number, maxLen: number): string {
  if (start < 0 || start >= buf.length) return '';
  const end = Math.min(buf.length, start + Math.max(0, maxLen));
  let i = start;
  while (i < end && buf[i] !== 0) i++;
  return buf.toString('utf8', start, i);
}

function isPrintableOrUtf8(b: number): boolean {
  if (b >= 0x20 && b <= 0x7e) return true;
  if (b === 0x09 || b === 0x0a || b === 0x0d) return true; // tab / lf / cr
  if (b >= 0xc0 && b <= 0xfd) return true;
  if (b >= 0x80 && b <= 0xbf) return true;
  return false;
}

function decodeIfValidUtf8(slice: Buffer): string | null {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const s = decoder.decode(slice);
    if (!/[A-Za-z0-9_/.&;$:?=\-]/.test(s)) return null;
    return s;
  } catch {
    return null;
  }
}
