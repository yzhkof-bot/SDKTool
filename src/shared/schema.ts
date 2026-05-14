/**
 * 跨层契约：核心层产出、CLI 层透传、视图层消费的标准化数据结构。
 *
 * 所有报告都带 schemaVersion，便于未来视图层做向前/向后兼容。
 */

export const SCHEMA_VERSION = '1.0' as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

export type WarningLevel = 'info' | 'warn' | 'error';

export interface ReportWarning {
  code: string;
  level: WarningLevel;
  message: string;
  /** 哪个 analyzer 抛出的，便于定位 */
  source?: string;
}

export interface HapReportMeta {
  /** 原始路径，绝对或相对皆可 */
  file: string;
  /** Hap 文件本身字节大小 */
  fileSize: number;
  /** 文件内容 SHA-256，用于幂等比对 */
  sha256: string;
  /** ISO-8601 时间戳 */
  analyzedAt: string;
  /** 工具版本，与 package.json 同步 */
  toolVersion: string;
}

export interface HapBasicInfo {
  bundleName: string;
  bundleType?: string;
  versionCode: number;
  versionName: string;
  moduleName: string;
  moduleType: string;
  deviceTypes: string[];
  targetAPIVersion?: number;
  minAPIVersion?: number;
  abilities: Array<{ name: string; type?: string; visible?: boolean }>;
  /** 原始 module.json 全文，便于上层做扩展分析 */
  rawModuleJson?: unknown;
  /** 原始 pack.info（如果存在） */
  rawPackInfo?: unknown;
}

export type SizeCategory = 'ets' | 'resources' | 'libs' | 'signature' | 'config' | 'other';

export interface HapSizeBreakdownItem {
  category: SizeCategory;
  bytes: number;
  ratio: number;
  fileCount: number;
}

export interface HapSizeTopFile {
  path: string;
  bytes: number;
  ratio: number;
  category: SizeCategory;
}

export interface HapSizeInfo {
  /** 解压后所有 entry 的总字节数 */
  total: number;
  /** Hap 文件本身（zip 压缩后）字节数 */
  compressed: number;
  breakdown: HapSizeBreakdownItem[];
  topFiles: HapSizeTopFile[];
  /** 文件总数 */
  fileCount: number;
}

export interface HapPermission {
  name: string;
  reason?: string;
  usedScene?: unknown;
  /** 工具内置敏感权限清单标注 */
  sensitive: boolean;
}

export interface HapResources {
  images: { count: number; bytes: number; topLargest: Array<{ path: string; bytes: number }> };
  strings: { count: number; locales: string[] };
  media: { count: number; bytes: number };
  rawResIndex?: { bytes: number };
}

export interface HapNativeLib {
  arch: string;
  name: string;
  bytes: number;
}

export interface HapNativeLibsInfo {
  architectures: string[];
  libs: HapNativeLib[];
  totalBytes: number;
}

export interface HapAbcInfo {
  modulesAbc?: { bytes: number; hasSourceMap: boolean };
  extraAbcFiles: Array<{ path: string; bytes: number }>;
}

/* ------------------------------------------------------------------ */
/* 可选深度分析：Native 符号表（默认关闭，需要在 extras 显式开启）        */
/* ------------------------------------------------------------------ */

export type NativeSymbolBind = 'LOCAL' | 'GLOBAL' | 'WEAK' | 'UNKNOWN';
export type NativeSymbolType =
  | 'NOTYPE'
  | 'OBJECT'
  | 'FUNC'
  | 'SECTION'
  | 'FILE'
  | 'COMMON'
  | 'TLS'
  | 'UNKNOWN';

export interface HapNativeSymbol {
  /** demangled 暂不做；保留原始符号名 */
  name: string;
  bind: NativeSymbolBind;
  type: NativeSymbolType;
  /** 占用字节（FUNC/OBJECT 才有意义；其它 0） */
  size: number;
  /** true 表示导入符号（ELF SHN_UNDEF）；false 表示自身定义 */
  imported: boolean;
}

/* ELF 节区（section）摘要：name / type / size / offset / 权限标志 */
export interface HapNativeLibSection {
  /** 例如 ".text" / ".rodata" / ".dynsym" / ".debug_info" */
  name: string;
  /** sh_type 的字符串名（"PROGBITS" / "NOBITS" / "DYNSYM" 等）；未知时填 "0x<hex>" */
  type: string;
  /** sh_size，字节 */
  size: number;
  /** sh_offset，文件内偏移 */
  offset: number;
  /**
   * sh_flags 的字符化压缩：
   *   A = SHF_ALLOC（占内存）  X = SHF_EXECINSTR  W = SHF_WRITE  S = SHF_STRINGS  T = SHF_TLS
   * 没有任何 flag 时为空串
   */
  flags: string;
}

/** ELF 安全编译选项（hardening）汇总 */
export interface HapNativeLibMitigations {
  /** 不可执行栈（NX / DEP）：PT_GNU_STACK 存在且不含 PF_X */
  nx: boolean;
  /** RELRO 强度："full" 需要 PT_GNU_RELRO + (DT_BIND_NOW 或 DF_1_NOW)；"partial" 仅 RELRO 段；"none" 都没有 */
  relro: 'full' | 'partial' | 'none';
  /** Position Independent Executable：共享库均为 ET_DYN，此处也按 ET_DYN 标 true */
  pie: boolean;
  /** 是否启用了栈保护：dynsym 中导入了 __stack_chk_fail */
  stackCanary: boolean;
  /** 是否启用了 _FORTIFY_SOURCE：dynsym 中存在任意 *_chk 的 libc 包装（如 __strcpy_chk） */
  fortify: boolean;
}

/** .rodata 段内启发式抽取并分类后的字符串集合（结构与 HapAbcStrings 对齐） */
export interface HapNativeLibRodataStrings {
  /** 抽出的去重字符串总数（未截断前） */
  totalDistinct: number;
  /** URL 类：以 scheme:// 开头（http/https/ftp/ws/wss/file 等） */
  urls: string[];
  /** 路径类：Unix /xxx 或 Windows X:\xxx 或包含 / 的相对路径 */
  paths: string[];
  /** SQL 类：开头是 SELECT/INSERT/UPDATE/DELETE/CREATE TABLE/DROP 等 */
  sqlLike: string[];
  /** 其它"看起来有信息量"的字符串（已过滤格式串/纯符号） */
  other: string[];
  /** 每个分类应用的最大保留个数（0 表示不限） */
  extractLimit: number;
  /** 任一分类被截断时为 true */
  truncated: boolean;
}

export interface HapNativeLibSymbols {
  arch: string;
  /** 不含目录的 so 文件名 */
  name: string;
  /** ELF class，"ELF32" / "ELF64" / "UNKNOWN" */
  elfClass: string;
  /** 总符号数（.dynsym 完整） */
  totalSymbols: number;
  /** 自身定义的符号数（imported=false） */
  definedCount: number;
  /** 导入符号数（imported=true，SHN_UNDEF） */
  importedCount: number;
  /** 受 maxSymbolsPerLib 截断后的符号清单，按 size desc 再 name asc 排序 */
  symbols: HapNativeSymbol[];
  /* ---- 以下字段为"深度分析增强"，按可用性可选；解析失败/不存在时省略 ---- */
  /** 全部 ELF section 摘要（按文件偏移升序） */
  sections?: HapNativeLibSection[];
  /** DT_NEEDED 列表：运行时依赖的 so 库名（按字典序排序、去重） */
  needed?: string[];
  /** `.note.gnu.build-id` 中的构建指纹，hex；不存在时省略 */
  buildId?: string;
  /** `.comment` 段中的编译器版本字符串（多条以 " | " 连接） */
  comment?: string;
  /** 安全 mitigations 汇总 */
  mitigations?: HapNativeLibMitigations;
  /** 通过 `.gnu.version_r` 解析出的 GLIBC 等 symbol versioning 需求，按字典序去重排序 */
  glibcVersions?: string[];
  /** 从 `.rodata` 段启发式抽取的字符串池（分类后） */
  rodataStrings?: HapNativeLibRodataStrings;
  /** 解析失败时填入 */
  error?: string;
}

export interface HapNativeLibSymbolsInfo {
  /** 每个 so 的符号详情 */
  perLib: HapNativeLibSymbols[];
  /** 实际处理的 so 数量 */
  scanned: number;
  /** 应用的每库符号截断阈值（0 表示未截断 = 全量） */
  maxSymbolsPerLib: number;
  /** 应用的 .rodata 字符串每分类截断阈值（0 表示不限） */
  rodataStringLimit: number;
}

/* ------------------------------------------------------------------ */
/* 可选深度分析：abc 头部细节（默认关闭）                                */
/* ------------------------------------------------------------------ */

/**
 * 从 abc 字节里启发式扒出来、按用途分类后的字符串集合。
 *
 * panda bytecode 的索引/类区结构跨版本变化大，写一个稳健的 PANDA 解析器工程量太大；
 * 但 abc 内的字符串池本身是 UTF-8 + 0 终止的标准格式，按"可打印字节序列 + null 边界"扫
 * 几乎能 100% 抓出来类描述符 / 方法名 / 源文件路径 / 模块记录名等可读符号，对 diff 价值极高。
 *
 * 每个分类的字符串列表都按字典序排序、去重，并受 extractLimit 约束（避免 8MiB modules.abc
 * 喂出 50K 字符串撑爆 JSON 与 viewer）。
 */
export interface HapAbcStrings {
  /** 抽出的去重字符串总数（未截断前） */
  totalDistinct: number;
  /** Java/PANDA 风格类描述符：^L[\w$/]+;$，例如 Lcom/foo/Bar; */
  classDescriptors: string[];
  /** HarmonyOS 模块记录名：&entry/xxx 或 &<bundle>&<module> 或 L_GLOBAL... */
  moduleRecords: string[];
  /** 源文件路径：以 .ets/.ts/.js/.json 结尾 */
  sourceFiles: string[];
  /** 方法/标识符样式：^[A-Za-z_$][\w$]{2,}$ */
  identifiers: string[];
  /** 兜底：以上都没命中的"看起来像字符串"的字面量（含截断标记） */
  other: string[];
  /** 每个分类应用的最大保留个数（0 表示不限） */
  extractLimit: number;
  /** 任一分类被截断时为 true，提示用户用 JSON 拿全量 */
  truncated: boolean;
}

export interface HapAbcDetailEntry {
  /** zip entry 路径（含 ets/ 前缀） */
  path: string;
  bytes: number;
  /** abc 文件 SHA-256，用于"size 相同但内容变化"的判定 */
  sha256: string;
  /** PANDA magic 字符串；非 PANDA 文件为 null */
  magic: string | null;
  /** 4 字节版本号字符串，例如 "0.0.0.2" */
  version: string | null;
  /** PANDA header 中声明的 file_size（≈ uncompressed bytes） */
  headerFileSize: number | null;
  /** PANDA header 中声明的 class 数量 */
  numClasses: number | null;
  /** 启发式抽取到的字符串池（仅 PANDA 文件填充） */
  strings?: HapAbcStrings;
  /** 解析失败原因 */
  error?: string;
}

export interface HapAbcDetailsInfo {
  entries: HapAbcDetailEntry[];
  scanned: number;
}

/* ------------------------------------------------------------------ */
/* 可选深度分析：il2cpp global-metadata.dat（Unity 游戏专用，默认关闭）   */
/* ------------------------------------------------------------------ */

/**
 * IL2CPP metadata 的"名字字符串池"（Il2CppMetadataHeader.string）启发式分类后的全量集合。
 *
 * 名字池是个 null-terminated UTF-8 串的扁平连续表，里面**混杂了** type/method/field/parameter/
 * event/property/namespace/assembly 名字，无法只从池本身严格区分。我们用启发式正则按命名约定分桶。
 */
export interface HapIl2cppNames {
  /** 名字池字节数（Il2Cpp string 表的 size） */
  poolBytes: number;
  /** 抽到的去重字符串总数 */
  totalDistinct: number;
  /** 类型名样式：含 `.`、每段开头大写（`Foo.Bar` / `UnityEngine.GameObject`） */
  typeNames: string[];
  /** 命名空间样式：含 `.`、末段全小写或为短名（`com.foo.bar`） */
  namespaces: string[];
  /** 标识符样式：单词，[A-Za-z_$][A-Za-z0-9_$]+，不含 `.` */
  identifiers: string[];
  /** Assembly 名字样式：`*.Module` / `*.CoreModule` / `Assembly-CSharp*` / 常见 BCL（`mscorlib` 等） */
  assemblies: string[];
  /** 兜底：含 `<>$#` 等编译器生成符号或不像有意义命名的 */
  other: string[];
}

/** IL2CPP metadata 的 stringLiteral 表（C# 字符串字面量池）启发式分类后的全量集合 */
export interface HapIl2cppLiterals {
  /** 字面量数据总字节 */
  poolBytes: number;
  /** 字面量条目总数（stringLiteral 表 entry 数） */
  totalCount: number;
  /** 去重后总数 */
  totalDistinct: number;
  /** URL 类（http/https/ftp/ws/wss 等 scheme://） */
  urls: string[];
  /** 路径类（Unix `/...` / Windows `X:\...` / 含多层 `/` 的相对路径） */
  paths: string[];
  /** SQL 类（SELECT/INSERT/UPDATE/DELETE/CREATE TABLE/PRAGMA 等开头） */
  sqlLike: string[];
  /** 其它（可能是错误消息/格式串/常量） */
  other: string[];
}

export interface HapIl2cppMetadata {
  /** zip entry 路径（通常 `resources/rawfile/Data/Managed/Metadata/global-metadata.dat`） */
  path: string;
  bytes: number;
  /** 整文件 SHA-256，用于"size 相同但内容已变"的检测 */
  sha256: string;
  /** "IL2CPP" / "ENCRYPTED" / "INVALID"；非标准 sanity 时落 ENCRYPTED */
  magic: 'IL2CPP' | 'ENCRYPTED' | 'INVALID';
  /** sanity 字段 hex（通常 `fab11baf`） */
  sanityHex: string;
  /** metadata 内部版本号（21/22/24/27/29/31...）；INVALID 时为 null */
  metadataVersion: number | null;
  /** 推测的 Unity 版本范围（按 metadataVersion 映射） */
  unityVersionRange: string | null;
  /** 名字字符串池启发式抽取（仅 IL2CPP magic 时填充） */
  names?: HapIl2cppNames;
  /** 字符串字面量池抽取（仅 IL2CPP magic 时填充） */
  literals?: HapIl2cppLiterals;
  /** 解析失败时填入 */
  error?: string;
}

export interface HapIl2cppMetadataInfo {
  /** 命中的 metadata 文件（一般 1 个；同 hap 里偶有多份） */
  files: HapIl2cppMetadata[];
  /** 实际处理的文件数 */
  scanned: number;
}

export interface HapSignatureInfo {
  present: boolean;
  issuer?: string;
  subject?: string;
  notBefore?: string;
  notAfter?: string;
}

export interface HapDependenciesInfo {
  hsp: string[];
  har: string[];
  raw?: unknown;
}

/* ------------------------------------------------------------------ */
/* Files（全量精简清单 - 给 differ / 高级查询用，viewer 不主动渲染）  */
/* ------------------------------------------------------------------ */

export interface HapFileEntry {
  path: string;
  /** 解压后字节 */
  bytes: number;
  /** 压缩后字节 */
  compressed: number;
  category: SizeCategory;
  /** zip CRC32，作为 diff 时检测 "size 相同但内容变化" 的辅助证据 */
  crc?: number;
}

/* ------------------------------------------------------------------ */
/* Rawfile（QTS / 游戏美术资源细分）                                    */
/* ------------------------------------------------------------------ */

/**
 * 启发式资源类别，专门为游戏 hap（特别是 Unity / il2cpp / QTS）设计。
 *
 * 游戏 hap 通常把 90% 体积压在 resources/rawfile/ 下，但通用 resourceAnalyzer
 * 只会笼统报"图片/媒体/字符串"。这里再补一层细分。
 */
export type RawfileCategory =
  | 'il2cpp-metadata'  // Data/Managed/Metadata/global-metadata.dat 等
  | 'asset-bundle'     // .ab / .bundle / .unity3d
  | 'qts-vfs'          // Data/Package/(builtin|external|patch)/<id>/<id>_*.db 这类项目 QTS VFS 数据
  | 'streaming-asset'  // Data/StreamingAssets/*
  | 'ai-model'         // .dla / .nb / .mnn / .tflite / .onnx
  | 'script'           // .lua / .js / .ts / .py
  | 'texture'          // .pvr / .ktx / .ktx2 / .astc / .etc / .dds
  | 'image'            // 通用图片（.png / .jpg / 等）
  | 'audio'            // 通用音频
  | 'video'            // 通用视频
  | 'data'             // .json / .xml / .yaml / .bin / .dat（非已识别）
  | 'other';

export interface RawfileGroupSummary {
  /** 相对 rawfile/ 的顶层段；Data/* 路径取前两段（Data/Package、Data/Managed 等），其它取一段 */
  path: string;
  bytes: number;
  fileCount: number;
  /** 占 rawfile 总体积比例 */
  ratio: number;
}

export interface RawfileExtensionSummary {
  /** 含点小写扩展名，无扩展名为 '(none)' */
  ext: string;
  bytes: number;
  fileCount: number;
  ratio: number;
}

export interface RawfileCategorySummary {
  category: RawfileCategory;
  bytes: number;
  fileCount: number;
  ratio: number;
}

export interface RawfileFileSummary {
  /** 相对 rawfile/ 的路径（不含 'resources/rawfile/' 前缀） */
  path: string;
  bytes: number;
  ratio: number;
  ext: string;
  category: RawfileCategory;
}

export interface RawfilePackageSummary {
  /** Data/Package/builtin/<id>/* 中的 <id> */
  packageId: string;
  bytes: number;
  fileCount: number;
}

export interface HapRawfileInfo {
  /** rawfile 内文件总数 */
  fileCount: number;
  /** rawfile 内总字节（uncompressed） */
  totalBytes: number;
  topLevelGroups: RawfileGroupSummary[];
  byExtension: RawfileExtensionSummary[];
  categories: RawfileCategorySummary[];
  topFiles: RawfileFileSummary[];
  /** 仅当检测到 Data/Package/builtin/<id>/* 模式时存在 */
  packages?: RawfilePackageSummary[];
}

/**
 * Hap 完整报告。后续视图层、Diff 模块都基于此结构。
 *
 * 字段都带可选标记，是为了在 M1 阶段允许部分 analyzer 未实现时也能给出有效 JSON。
 * M2 完成后所有非 optional 字段都会被填充。
 */
export interface HapReport {
  schemaVersion: SchemaVersion;
  meta: HapReportMeta;
  basic?: HapBasicInfo;
  size?: HapSizeInfo;
  permissions?: HapPermission[];
  resources?: HapResources;
  nativeLibs?: HapNativeLibsInfo;
  abc?: HapAbcInfo;
  signature?: HapSignatureInfo;
  dependencies?: HapDependenciesInfo;
  rawfile?: HapRawfileInfo;
  /** 全量文件清单（zip entries 视图）。给 differ 做逐文件对比，viewer 默认不展示 */
  files?: HapFileEntry[];
  /** 可选深度分析：每个 so 的 ELF 符号表 */
  nativeLibSymbols?: HapNativeLibSymbolsInfo;
  /** 可选深度分析：每个 abc 文件的 PANDA 头部细节 */
  abcDetails?: HapAbcDetailsInfo;
  /** 可选深度分析：il2cpp global-metadata.dat（Unity 游戏专用） */
  il2cppMetadata?: HapIl2cppMetadataInfo;
  warnings: ReportWarning[];
}

/* ------------------------------------------------------------------ */
/* Diff Report                                                         */
/* ------------------------------------------------------------------ */

/**
 * 标量数值差。`ratio` 表示 to 相对 from 的相对变化（0.1 = +10%）；
 * 当 from = 0 且 to ≠ 0 时定义为 null（避免 Infinity 在 JSON 中变成 null 让前端 parse 出错时仍可读）。
 */
export interface DeltaNumber {
  from: number;
  to: number;
  delta: number;
  ratio: number | null;
}

export interface HapDiffSide {
  meta: HapReportMeta;
  basic?: HapBasicInfo;
}

/* ---- basic ---- */

export interface HapDiffBasicChange {
  /** 点路径，如 'bundleName' / 'versionCode' / 'deviceTypes' */
  field: string;
  from: unknown;
  to: unknown;
}

/* ---- size ---- */

export interface HapDiffSizeBreakdownItem {
  category: SizeCategory;
  fromBytes: number;
  toBytes: number;
  delta: number;
  ratio: number | null;
}

export interface HapDiffSize {
  total: DeltaNumber;
  compressed: DeltaNumber;
  fileCount: DeltaNumber;
  breakdown: HapDiffSizeBreakdownItem[];
}

/* ---- files（基于 zip entry 列表的全量逐文件 diff） ---- */

export interface HapDiffFileAdded {
  path: string;
  bytes: number;
  category: SizeCategory;
}

export interface HapDiffFileChanged {
  path: string;
  fromBytes: number;
  toBytes: number;
  delta: number;
  category: SizeCategory;
}

export interface HapDiffFiles {
  /** 全量新增列表（按 bytes desc，前端可继续截断） */
  added: HapDiffFileAdded[];
  removed: HapDiffFileAdded[];
  /** 同名但 size 变化（含 crc 差异时也并入） */
  changed: HapDiffFileChanged[];
  /** 计数（即使 added/removed/changed 被截断，这里仍是真实总数） */
  totals: { added: number; removed: number; changed: number; unchanged: number };
}

/* ---- permission ---- */

export interface HapDiffPermissions {
  added: HapPermission[];
  removed: HapPermission[];
  unchanged: number;
}

/* ---- resource ---- */

export interface HapDiffResources {
  images: { count: DeltaNumber; bytes: DeltaNumber };
  strings: { count: DeltaNumber; localesAdded: string[]; localesRemoved: string[] };
  media: { count: DeltaNumber; bytes: DeltaNumber };
}

/* ---- rawfile ---- */

export interface HapDiffRawfileGroup {
  path: string;
  fromBytes: number;
  toBytes: number;
  delta: number;
  fromCount: number;
  toCount: number;
}

export interface HapDiffRawfileCategory {
  category: RawfileCategory;
  fromBytes: number;
  toBytes: number;
  delta: number;
  fromCount: number;
  toCount: number;
}

export interface HapDiffRawfilePackage {
  packageId: string;
  fromBytes: number;
  toBytes: number;
  delta: number;
  fromCount: number;
  toCount: number;
}

export interface HapDiffRawfile {
  fileCount: DeltaNumber;
  totalBytes: DeltaNumber;
  topLevelGroups: HapDiffRawfileGroup[];
  categories: HapDiffRawfileCategory[];
  packages?: HapDiffRawfilePackage[];
}

/* ---- nativeLib ---- */

export interface HapDiffNativeLibChanged {
  arch: string;
  name: string;
  fromBytes: number;
  toBytes: number;
  delta: number;
}

export interface HapDiffNativeLibs {
  architectures: { added: string[]; removed: string[] };
  totalBytes: DeltaNumber;
  added: HapNativeLib[];
  removed: HapNativeLib[];
  changed: HapDiffNativeLibChanged[];
}

/* ---- abc ---- */

export interface HapDiffAbc {
  /** modules.abc 主文件大小变化；任一侧不存在时对应字段为 null */
  modulesAbc: {
    fromBytes: number | null;
    toBytes: number | null;
    delta: number | null;
    sourceMapChanged: boolean;
  };
  extra: {
    added: Array<{ path: string; bytes: number }>;
    removed: Array<{ path: string; bytes: number }>;
    changed: Array<{ path: string; fromBytes: number; toBytes: number; delta: number }>;
  };
}

/* ---- nativeLibSymbols（可选深度差异） ---- */

export interface HapDiffSymbolChanged {
  name: string;
  fromSize: number;
  toSize: number;
  delta: number;
  /** bind / type / imported 在两侧的最终值 */
  bind: NativeSymbolBind;
  type: NativeSymbolType;
  imported: boolean;
}

/* ELF section 的逐 section diff（按 |delta| 降序） */
export interface HapDiffNativeLibSectionItem {
  name: string;
  fromSize: number;
  toSize: number;
  delta: number;
}

export interface HapDiffNativeLibSections {
  /** 双侧都有但 size 变化的 section（按 |delta| 降序） */
  changed: HapDiffNativeLibSectionItem[];
  /** 新增 section（右有左无） */
  added: HapDiffNativeLibSectionItem[];
  /** 删除 section（左有右无） */
  removed: HapDiffNativeLibSectionItem[];
  /** 任一 section 有变化时为 true */
  anyChanged: boolean;
}

/** mitigations 的 from/to + 是否变化（per-field） */
export interface HapDiffNativeLibMitigations {
  nx: { from: boolean; to: boolean; changed: boolean };
  relro: {
    from: 'full' | 'partial' | 'none';
    to: 'full' | 'partial' | 'none';
    changed: boolean;
  };
  pie: { from: boolean; to: boolean; changed: boolean };
  stackCanary: { from: boolean; to: boolean; changed: boolean };
  fortify: { from: boolean; to: boolean; changed: boolean };
  anyChanged: boolean;
}

/** 字符串集合的 add/remove/unchanged 差（与 HapDiffAbcStringSet 同形） */
export interface HapDiffStringSet {
  added: string[];
  removed: string[];
  unchanged: number;
}

/** .rodata 字符串池的逐分类差异 */
export interface HapDiffNativeLibRodataStrings {
  urls: HapDiffStringSet;
  paths: HapDiffStringSet;
  sqlLike: HapDiffStringSet;
  other: HapDiffStringSet;
  anyChanged: boolean;
}

/** build-id / .comment 的对比 */
export interface HapDiffNativeLibBuildInfo {
  fromBuildId?: string;
  toBuildId?: string;
  buildIdChanged: boolean;
  fromComment?: string;
  toComment?: string;
  commentChanged: boolean;
  anyChanged: boolean;
}

export interface HapDiffNativeLibSymbolsItem {
  arch: string;
  name: string;
  /** 一侧没有此 so 时为 true（不计入符号 added/removed，只是标记） */
  fromMissing: boolean;
  toMissing: boolean;
  added: HapNativeSymbol[];
  removed: HapNativeSymbol[];
  /** size 变化的符号（同名同 imported） */
  changed: HapDiffSymbolChanged[];
  totals: {
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
  };
  /* ---- 以下字段为深度分析的可选维度，仅当对应 analyzer 字段在两侧任意一边可用时出现 ---- */
  sectionsDiff?: HapDiffNativeLibSections;
  /** DT_NEEDED 列表的 add/remove */
  neededDiff?: HapDiffStringSet;
  /** mitigations 的 per-flag 对比 */
  mitigationsDiff?: HapDiffNativeLibMitigations;
  /** GLIBC 等版本符号需求的 add/remove */
  glibcDiff?: HapDiffStringSet;
  /** .rodata 字符串池差异（仅当任一侧有 rodataStrings 时出现） */
  rodataDiff?: HapDiffNativeLibRodataStrings;
  /** build-id / .comment 对比 */
  buildInfoDiff?: HapDiffNativeLibBuildInfo;
}

export interface HapDiffNativeLibSymbols {
  perLib: HapDiffNativeLibSymbolsItem[];
  /** 双侧任一 so 都未被深度分析时为空，前端可据此 emptyState */
  scanned: number;
}

/* ---- abcDetails（可选深度差异） ---- */

/** 单个分类的字符串差集 */
export interface HapDiffAbcStringSet {
  added: string[];
  removed: string[];
  /** 双侧都有（去重后），仅展示一个数字 */
  unchanged: number;
}

/** abc 内字符串池的逐分类差异（仅当两侧都跑了 abcStrings 抽取时存在） */
export interface HapDiffAbcStrings {
  classDescriptors: HapDiffAbcStringSet;
  moduleRecords: HapDiffAbcStringSet;
  sourceFiles: HapDiffAbcStringSet;
  identifiers: HapDiffAbcStringSet;
  /** 任意分类有变化时 true */
  anyChanged: boolean;
}

export interface HapDiffAbcDetailEntry {
  path: string;
  /** 任一侧缺失（abc 文件本身被新增/删除）时对应字段为 null */
  fromBytes: number | null;
  toBytes: number | null;
  fromSha256: string | null;
  toSha256: string | null;
  fromVersion: string | null;
  toVersion: string | null;
  fromNumClasses: number | null;
  toNumClasses: number | null;
  /** 综合判定：bytes / sha256 / version / numClasses 任一变化 */
  changed: boolean;
  /** 字符串池差异（仅当两侧都有 abc 字符串抽取数据时存在；otherwise undefined） */
  stringsDiff?: HapDiffAbcStrings;
}

export interface HapDiffAbcDetails {
  entries: HapDiffAbcDetailEntry[];
  totals: {
    /** 仅 changed=true 的 abc 数量 */
    changed: number;
    /** 总条目数（双侧并集） */
    total: number;
  };
}

/* ---- il2cppMetadata（Unity / IL2CPP 深度差异） ---- */

export interface HapDiffIl2cppNames {
  typeNames: HapDiffStringSet;
  namespaces: HapDiffStringSet;
  identifiers: HapDiffStringSet;
  assemblies: HapDiffStringSet;
  other: HapDiffStringSet;
  anyChanged: boolean;
}

export interface HapDiffIl2cppLiterals {
  urls: HapDiffStringSet;
  paths: HapDiffStringSet;
  sqlLike: HapDiffStringSet;
  other: HapDiffStringSet;
  anyChanged: boolean;
}

export interface HapDiffIl2cppMetadataEntry {
  path: string;
  fromBytes: number | null;
  toBytes: number | null;
  fromSha256: string | null;
  toSha256: string | null;
  fromMetadataVersion: number | null;
  toMetadataVersion: number | null;
  fromUnityVersionRange: string | null;
  toUnityVersionRange: string | null;
  /** 综合判定：bytes / sha256 / version / 名字集 / 字面量集 任一变化 */
  changed: boolean;
  /** 名字池差异（仅当两侧都解析到 names 时填） */
  namesDiff?: HapDiffIl2cppNames;
  /** 字面量池差异（仅当两侧都解析到 literals 时填） */
  literalsDiff?: HapDiffIl2cppLiterals;
}

export interface HapDiffIl2cppMetadata {
  entries: HapDiffIl2cppMetadataEntry[];
  totals: {
    /** changed=true 的文件数 */
    changed: number;
    /** 总条目数（双侧并集） */
    total: number;
  };
}

/* ---- signature ---- */

export interface HapDiffSignatureField {
  field: 'subject' | 'issuer' | 'notBefore' | 'notAfter';
  from?: string;
  to?: string;
  changed: boolean;
}

export interface HapDiffSignature {
  fromPresent: boolean;
  toPresent: boolean;
  presentChanged: boolean;
  fields: HapDiffSignatureField[];
}

/* ---- dependency ---- */

export interface HapDiffDependencies {
  hsp: { added: string[]; removed: string[] };
  har: { added: string[]; removed: string[] };
}

/* ---- summary ---- */

export interface HapDiffSummary {
  totalSizeDelta: number;
  compressedDelta: number;
  fileCountDelta: number;
  filesAdded: number;
  filesRemoved: number;
  filesChanged: number;
  permissionsAdded: number;
  permissionsRemoved: number;
  /** 形如 "1.0 (100) → 1.1 (101)"，左右版本无 basic 时缺省 */
  versionLine?: string;
  /** left/right 是否完全一致（summary 维度） */
  identical: boolean;
}

export interface HapDiffReport {
  schemaVersion: SchemaVersion;
  /** ISO-8601 生成时间 */
  generatedAt: string;
  /** 工具版本 */
  toolVersion: string;
  left: HapDiffSide;
  right: HapDiffSide;
  summary: HapDiffSummary;
  basic?: { changed: HapDiffBasicChange[] };
  size?: HapDiffSize;
  files?: HapDiffFiles;
  permissions?: HapDiffPermissions;
  resources?: HapDiffResources;
  rawfile?: HapDiffRawfile;
  nativeLibs?: HapDiffNativeLibs;
  abc?: HapDiffAbc;
  /** 可选深度差异：so 内部符号增删改 */
  nativeLibSymbols?: HapDiffNativeLibSymbols;
  /** 可选深度差异：abc 头部细节差异 */
  abcDetails?: HapDiffAbcDetails;
  /** 可选深度差异：il2cpp metadata（Unity 游戏专用） */
  il2cppMetadata?: HapDiffIl2cppMetadata;
  signature?: HapDiffSignature;
  dependencies?: HapDiffDependencies;
  warnings: ReportWarning[];
}

/* ------------------------------------------------------------------ */
/* Analyzer 接口                                                       */
/* ------------------------------------------------------------------ */

/** 单个 entry 的元信息（不含字节内容，按需通过 readFile 获取） */
export interface HapEntry {
  /** 在 zip 内的相对路径，使用正斜杠 */
  path: string;
  /** 是否目录条目 */
  isDirectory: boolean;
  /** 解压后字节数（uncompressed） */
  uncompressedSize: number;
  /** 压缩后字节数（compressed） */
  compressedSize: number;
  /** 修改时间（如有） */
  lastModified?: Date;
  /** CRC32 */
  crc32?: number;
}

export interface VirtualHap {
  /** Hap 文件路径 */
  filePath: string;
  /** Hap 文件本身字节数 */
  fileSize: number;
  /** 文件 SHA-256 hex */
  sha256: string;
  /** 所有 entry 元信息 */
  entries: HapEntry[];
  /** 按需读取一个 entry 的内容 */
  readFile: (path: string) => Promise<Buffer>;
  /** 按需读取并尝试以 utf-8 解码 */
  readText: (path: string) => Promise<string>;
  /** 关闭底层 zip 句柄 */
  close: () => Promise<void>;
}

export interface AnalyzerContext {
  hap: VirtualHap;
  options: AnalyzeOptions;
  /** 由 pipeline 提供的告警收集器 */
  addWarning: (w: Omit<ReportWarning, 'source'>) => void;
}

/**
 * Analyzer 插件接口。
 *
 * 每个 analyzer 输出 HapReport 中自己负责的那部分字段（一个 Partial）。
 * pipeline 负责把所有 analyzer 的结果合并成最终 report。
 */
export interface Analyzer {
  /** 唯一 id，CLI --only 用 */
  id: string;
  /** 人类可读名 */
  name: string;
  /** 默认是否启用（M1 阶段未实现的 analyzer 会被关掉） */
  enabledByDefault: boolean;
  run: (ctx: AnalyzerContext) => Promise<Partial<HapReport>>;
}

export interface AnalyzeOptions {
  /** 仅运行这些 analyzer id；为空则按 enabledByDefault */
  only?: string[];
  /**
   * 在默认启用集合之外，额外开启这些 analyzer id（用于 enabledByDefault=false 的可选深度分析）。
   * 与 only 互斥：only 一旦给出则严格按 only 过滤，extras 被忽略；这样命令行 --only 行为不变。
   */
  extras?: string[];
  /** size analyzer 的 Top N 配置 */
  topFilesLimit?: number;
  /** 工具版本，由 cli 注入到 meta */
  toolVersion?: string;
  /** nativeSymbols：每个 so 最多保留多少符号（0 表示不限，默认值）。
   * 全量保留可保证 differ 在小符号 / imported 符号上的 added/removed 准确性；
   * 仅在 JSON 体积成问题（巨型 so + 数十个 lib）时才考虑设非 0 值。 */
  maxSymbolsPerLib?: number;
  /** nativeSymbols：每个 so 的 .rodata 字符串每分类最多保留多少条（0 表示不限，默认值）。
   * 项目级约定：默认全量；仅在 JSON 体积失控时才显式传非 0。 */
  rodataStringLimit?: number;
  /** abcDetails：每个 abc 字符串分类最多保留多少条（0 表示不限，默认值）。
   * 项目级约定：默认全量；仅在 JSON 体积失控时才显式传非 0。 */
  abcStringExtractLimit?: number;
}

/* ------------------------------------------------------------------ */
/* Workbench (本地图形工作台)                                          */
/* ------------------------------------------------------------------ */

export type WorkbenchJobKind = 'analyze' | 'compare';
export type WorkbenchJobStatus = 'pending' | 'running' | 'done' | 'error';

/**
 * compare job 在主产物（diff）之外，对 left/right 两侧各自单独分析报告的访问入口。
 * 复用 analyze 的 HapReport 数据结构 + viewer 模板，前端可"点进去看单包结果"。
 *
 * - 仅 kind='compare' 且 status='done' 时存在；
 * - 老版本生成的 compare job 不会有此字段，前端需做存在性判断（向后兼容）。
 */
export interface WorkbenchCompareSide {
  /** 该侧原始输入路径（可能是 .hap 也可能是 .json 报告，原样保留） */
  sourcePath: string;
  /** 单侧报告 viewer 页面 */
  htmlUrl: string;
  /** 单侧 HapReport JSON */
  jsonUrl: string;
}

export interface WorkbenchJob {
  id: string;
  kind: WorkbenchJobKind;
  status: WorkbenchJobStatus;
  /** 人类可读标题，例如 "sgame.hap" 或 "a.hap vs b.hap" */
  label: string;
  /** ISO-8601 时间戳 */
  createdAt: string;
  /** 完成或失败时间戳，运行中为 undefined */
  finishedAt?: string;
  /** 输入文件绝对路径（一个或两个） */
  inputs: string[];
  /** 仅 status='error' 时存在 */
  error?: string;
  /** 仅 status='done' 时存在；URL 都是相对路径（相对于 server origin） */
  outputs?: {
    htmlUrl: string;
    jsonUrl: string;
    /** 仅 compare job 才填；analyze job 永远是 undefined */
    sides?: {
      left: WorkbenchCompareSide;
      right: WorkbenchCompareSide;
    };
  };
}
