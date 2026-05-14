import { createHash } from 'node:crypto';

import type {
  Analyzer,
  AnalyzerContext,
  HapIl2cppLiterals,
  HapIl2cppMetadata,
  HapIl2cppMetadataInfo,
  HapIl2cppNames,
  HapReport,
} from '../../shared/schema.js';

/**
 * 可选深度分析：解析 Unity IL2CPP 游戏的 `global-metadata.dat`。
 *
 * 设计目标：**让"Unity 游戏 hap"也具备和 .so / .abc 同级别的可读 diff 能力**。
 * Unity 游戏把 C# 类型系统剥到这个文件里（5–50 MB），改一行 C# 代码就会让它彻底变。
 * 不解析它，diff 只能看到"global-metadata.dat: 12 MB → 14 MB"，再无下文。
 *
 * 解析策略（"通用 header + 字符串池抽取"，避开 strided 表的版本碎片化坑）：
 *  1. **Header 前 32 字节**在 v21–v31 所有版本都稳定：
 *       0x00 sanity (u32, 0xFAB11BAF)
 *       0x04 version (i32, 21/22/24/27/29/31...)
 *       0x08 stringLiteralOffset / stringLiteralSize       — 字面量索引表 (entry: length+dataIndex)
 *       0x10 stringLiteralDataOffset / stringLiteralDataSize — 字面量原始 UTF-8 数据
 *       0x18 stringOffset / stringSize                      — 名字字符串池（null-terminated UTF-8）
 *  2. **名字池**：直接按 0x00 切片即可拿到 type/method/field/parameter/event/property/namespace/
 *     assembly 的全部字符串（混杂在一起，启发式分类）。
 *  3. **字面量池**：按 stringLiteral 表的 (length, dataIndex) 二元组从 stringLiteralData 切片。
 *  4. 不依赖具体表（typeDefinitions / methods / ...）的字段布局——这些在 v24/v27/v29 之间不一致，
 *     工程量大且收益低（精确计数对 diff 价值有限，名字集已经覆盖大部分诊断需求）。
 *
 * 加密 metadata 检测：sanity != 0xFAB11BAF 时落 magic='ENCRYPTED'，其它字段不填，但 sha256/bytes
 * 仍输出，让 diff 能看到"加密产物变了"。
 *
 * 默认关闭（enabledByDefault: false），需要 `--extras il2cppMetadata` 或 workbench 多选启用。
 *
 * 项目级硬约定（见 .cursor/rules/data-completeness.mdc）：所有字符串集合默认全量输出，
 * viewer 用 paginated() 分页展示。
 */
export const il2cppMetadataAnalyzer: Analyzer = {
  id: 'il2cppMetadata',
  name: 'IL2CPP Metadata',
  enabledByDefault: false,
  async run(ctx: AnalyzerContext): Promise<Partial<HapReport>> {
    const targets = ctx.hap.entries.filter(
      (e) => !e.isDirectory && IL2CPP_METADATA_PATTERN.test(e.path),
    );

    const files: HapIl2cppMetadata[] = [];
    for (const e of targets) {
      try {
        const buf = await ctx.hap.readFile(e.path);
        const parsed = parseIl2cppMetadata(buf);
        files.push({ path: e.path, bytes: buf.length, ...parsed });
      } catch (err) {
        files.push({
          path: e.path,
          bytes: e.uncompressedSize,
          sha256: '',
          magic: 'INVALID',
          sanityHex: '',
          metadataVersion: null,
          unityVersionRange: null,
          error: (err as Error).message ?? String(err),
        });
        ctx.addWarning({
          code: 'IL2CPP_METADATA_PARSE_FAILED',
          level: 'warn',
          message: `解析 ${e.path} 失败: ${(err as Error).message ?? String(err)}`,
        });
      }
    }

    files.sort((a, b) => a.path.localeCompare(b.path));
    const info: HapIl2cppMetadataInfo = { files, scanned: files.length };
    return { il2cppMetadata: info };
  },
};

/** 标准路径：`<rawfile-prefix>/Data/Managed/Metadata/global-metadata.dat`；也兼容直接放在根的变体 */
const IL2CPP_METADATA_PATTERN =
  /(?:^|\/)Data\/Managed\/Metadata\/global-metadata\.dat$|(?:^|\/)global-metadata\.dat$/i;

/* -----------------------------------------------------------------------
 * Header / 字符串池解析
 * ----------------------------------------------------------------------- */

const SANITY_IL2CPP = 0xfab11baf;

interface ParsedMetadata {
  sha256: string;
  magic: 'IL2CPP' | 'ENCRYPTED' | 'INVALID';
  sanityHex: string;
  metadataVersion: number | null;
  unityVersionRange: string | null;
  names?: HapIl2cppNames;
  literals?: HapIl2cppLiterals;
}

function parseIl2cppMetadata(buf: Buffer): ParsedMetadata {
  const sha256 = createHash('sha256').update(buf).digest('hex');
  if (buf.length < 32) {
    return {
      sha256,
      magic: 'INVALID',
      sanityHex: '',
      metadataVersion: null,
      unityVersionRange: null,
    };
  }

  const sanity = buf.readUInt32LE(0);
  const sanityHex = sanity.toString(16).padStart(8, '0');
  if (sanity !== SANITY_IL2CPP) {
    // 非标准 sanity：可能是加密 metadata 或非 il2cpp 文件
    return {
      sha256,
      magic: 'ENCRYPTED',
      sanityHex,
      metadataVersion: null,
      unityVersionRange: null,
    };
  }

  const version = buf.readInt32LE(4);
  const unityVersionRange = inferUnityVersionRange(version);

  const stringLiteralOffset = buf.readUInt32LE(8);
  const stringLiteralSize = buf.readUInt32LE(12);
  const stringLiteralDataOffset = buf.readUInt32LE(16);
  const stringLiteralDataSize = buf.readUInt32LE(20);
  const stringOffset = buf.readUInt32LE(24);
  const stringSize = buf.readUInt32LE(28);

  // 范围校验：任一池越界都标 INVALID
  if (
    stringLiteralOffset + stringLiteralSize > buf.length ||
    stringLiteralDataOffset + stringLiteralDataSize > buf.length ||
    stringOffset + stringSize > buf.length
  ) {
    return {
      sha256,
      magic: 'INVALID',
      sanityHex,
      metadataVersion: version,
      unityVersionRange,
    };
  }

  const names = extractNames(
    buf.subarray(stringOffset, stringOffset + stringSize),
    stringSize,
  );
  const literals = extractLiterals(
    buf.subarray(stringLiteralOffset, stringLiteralOffset + stringLiteralSize),
    buf.subarray(stringLiteralDataOffset, stringLiteralDataOffset + stringLiteralDataSize),
    stringLiteralDataSize,
  );

  return {
    sha256,
    magic: 'IL2CPP',
    sanityHex,
    metadataVersion: version,
    unityVersionRange,
    names,
    literals,
  };
}

/* -----------------------------------------------------------------------
 * Unity 版本范围映射（按 metadataVersion 主版本号）
 * ----------------------------------------------------------------------- */
function inferUnityVersionRange(v: number): string | null {
  switch (v) {
    case 21:
      return 'Unity 5.0 – 5.2';
    case 22:
      return 'Unity 5.2 – 5.3';
    case 23:
      return 'Unity 5.3.4 – 5.5';
    case 24:
      return 'Unity 5.6 – 2021.x（v24 含 .0–.5 子版本）';
    case 25:
      return 'Unity 2017.x';
    case 27:
      return 'Unity 2020.2 – 2022.x';
    case 28:
      return 'Unity 2022.x（实验）';
    case 29:
      return 'Unity 2022.x – 2023.x';
    case 30:
      return 'Unity 2023.x';
    case 31:
      return 'Unity 2023.2+ / Unity 6';
    default:
      return v > 0 ? `未知 metadataVersion=${v}` : null;
  }
}

/* -----------------------------------------------------------------------
 * 名字字符串池抽取（含 type/method/field/参数/namespace/assembly 名字）
 * ----------------------------------------------------------------------- */
function extractNames(slice: Buffer, poolBytes: number): HapIl2cppNames {
  const seen = new Set<string>();
  const all: string[] = [];
  let start = 0;
  for (let i = 0; i <= slice.length; i++) {
    if (i === slice.length || slice[i] === 0) {
      if (i > start) {
        const len = i - start;
        if (len >= 1 && len <= 1024) {
          const str = decodeIfValidUtf8(slice.subarray(start, i));
          if (str && !seen.has(str)) {
            seen.add(str);
            all.push(str);
          }
        }
      }
      start = i + 1;
    }
  }

  const typeNames: string[] = [];
  const namespaces: string[] = [];
  const identifiers: string[] = [];
  const assemblies: string[] = [];
  const other: string[] = [];

  for (const s of all) {
    if (looksLikeAssembly(s)) assemblies.push(s);
    else if (looksLikeTypeName(s)) typeNames.push(s);
    else if (looksLikeNamespace(s)) namespaces.push(s);
    else if (looksLikeIdentifier(s)) identifiers.push(s);
    else other.push(s);
  }

  typeNames.sort();
  namespaces.sort();
  identifiers.sort();
  assemblies.sort();
  other.sort();

  return {
    poolBytes,
    totalDistinct: all.length,
    typeNames,
    namespaces,
    identifiers,
    assemblies,
    other,
  };
}

/** 常见 BCL / Unity / 第三方常用 assembly 名（用于命中后归类到 assemblies） */
const ASSEMBLY_ALLOW_LIST = new Set<string>([
  'mscorlib',
  'netstandard',
  'System',
  'System.Core',
  'System.Xml',
  'System.Data',
  'System.Net',
  'System.Net.Http',
  'System.Drawing',
  'System.Memory',
  'System.IO',
  'System.Reflection',
  'System.Runtime',
  'System.Threading',
  'Mono.Security',
  'Bugly',
  'Firebase',
  'Newtonsoft.Json',
]);

const ASSEMBLY_RE =
  /^(?:UnityEngine[A-Za-z0-9.]*|Unity\.[A-Za-z0-9.]+|Assembly-CSharp[A-Za-z0-9-]*|System\.[A-Za-z0-9.]+|Microsoft\.[A-Za-z0-9.]+|Google\.[A-Za-z0-9.]+|Newtonsoft\.[A-Za-z0-9.]+)$/;
const TYPE_NAME_RE = /^(?:[A-Z][A-Za-z0-9_]*\.)+[A-Z][A-Za-z0-9_]*(?:`\d+)?$/;
const NAMESPACE_RE = /^(?:[a-z][A-Za-z0-9_-]*\.)+[a-zA-Z][A-Za-z0-9_-]*$/;
const IDENTIFIER_RE = /^[A-Za-z_<][A-Za-z0-9_$<>]{0,200}$/;

function looksLikeAssembly(s: string): boolean {
  if (ASSEMBLY_ALLOW_LIST.has(s)) return true;
  return ASSEMBLY_RE.test(s);
}
function looksLikeTypeName(s: string): boolean {
  return TYPE_NAME_RE.test(s);
}
function looksLikeNamespace(s: string): boolean {
  return NAMESPACE_RE.test(s);
}
function looksLikeIdentifier(s: string): boolean {
  // 排除含 `.` 的（已经被 typeNames/namespaces 处理）
  if (s.includes('.')) return false;
  // 编译器生成的 <>...$  ...   常见，归 identifier 而非 other
  return IDENTIFIER_RE.test(s);
}

/* -----------------------------------------------------------------------
 * 字符串字面量池抽取（C# 代码里的 "..." 字面量）
 *
 * stringLiteral 表 entry: { length: u32, dataIndex: u32 } 共 8 字节
 *   v21–v22 一些版本 entry 是 (offset+length) 形式，但绝大多数 v24+ 都是 (length, dataIndex)。
 *   这里按 v24+ 解析；v21/v22 出现"切片越界"的 entry 会被跳过，不影响其它 entry。
 * ----------------------------------------------------------------------- */

function extractLiterals(
  table: Buffer,
  data: Buffer,
  poolBytes: number,
): HapIl2cppLiterals {
  const seen = new Set<string>();
  const all: string[] = [];

  const entrySize = 8;
  const totalCount = Math.floor(table.length / entrySize);
  for (let i = 0; i < totalCount; i++) {
    const length = table.readUInt32LE(i * entrySize);
    const dataIndex = table.readUInt32LE(i * entrySize + 4);
    if (length === 0 || length > 0x100000) continue; // 跳过 0 长 / 异常巨长（>1MiB）的 entry
    if (dataIndex + length > data.length) continue;
    const str = decodeIfValidUtf8(data.subarray(dataIndex, dataIndex + length));
    if (str && !seen.has(str)) {
      seen.add(str);
      all.push(str);
    }
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

  return {
    poolBytes,
    totalCount,
    totalDistinct: all.length,
    urls,
    paths,
    sqlLike,
    other,
  };
}

const URL_RE = /^(?:https?|ftp|ws|wss|file|smb|rtsp|rtmp|content):\/\//i;
const PATH_RE =
  /^(?:\/[A-Za-z0-9_./@+\-]+|[A-Za-z]:[\\/][A-Za-z0-9_./\-@+\\]+|(?:[A-Za-z0-9_.\-]+\/){1,}[A-Za-z0-9_.\-]+)$/;
const SQL_RE = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE\s+(?:TABLE|INDEX)|DROP\s+(?:TABLE|INDEX)|ALTER\s+TABLE|REPLACE\s+INTO|PRAGMA)\b/i;

/* -----------------------------------------------------------------------
 * 公共工具
 * ----------------------------------------------------------------------- */

function decodeIfValidUtf8(slice: Buffer): string | null {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const s = decoder.decode(slice);
    if (s.length === 0) return null;
    return s;
  } catch {
    return null;
  }
}
