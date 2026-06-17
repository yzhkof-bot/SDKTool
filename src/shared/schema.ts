/**
 * 跨层契约：核心层产出、CLI 层透传、视图层消费的标准化数据结构。
 *
 * 所有报告都带 schemaVersion，便于未来视图层做向前/向后兼容。
 */

export const SCHEMA_VERSION = '1.0' as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

export type WarningLevel = 'info' | 'warn' | 'error';

/**
 * 支持分析的应用包平台。
 *
 * 一期仅 'harmony'（HarmonyOS .hap）真正可用；'android' / 'ios' 占位，
 * 在 UI 中可见但 disabled，对应 analyzer 集合按平台从 core/analyzers 派发。
 *
 * 兼容策略：所有持久化结构（PackageReport / WorkbenchJob）中的 platform 字段都是
 * 可选的，未填写时一律按 'harmony' 处理，老 JSON / 老 job 能继续工作。
 */
export type Platform = 'harmony' | 'android' | 'ios';

/** 未声明 platform 时的默认值，统一在此处定义避免散落字符串字面量 */
export const DEFAULT_PLATFORM: Platform = 'harmony';

export interface ReportWarning {
  code: string;
  level: WarningLevel;
  message: string;
  /** 哪个 analyzer 抛出的，便于定位 */
  source?: string;
}

export interface PackageReportMeta {
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

export interface PackageBasicInfo {
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

/**
 * size analyzer 把每个文件归到一个 category。前 5 个是 HarmonyOS 历史分类，
 * 后两个为 Android 设计：
 *   - dex      classes*.dex 与 META-INF/services 之外的字节码
 *   - assets   assets/* 原始资源
 *
 * resources 在 HarmonyOS 指 'resources/' 目录；在 Android 复用为 'res/' 目录。
 * libs 在 HarmonyOS 是 'libs/'；在 Android 是 'lib/'。规则集中在
 * shared/constants.ts 的 SIZE_CATEGORY_RULES_BY_PLATFORM 里维护。
 */
export type SizeCategory =
  | 'ets'
  | 'resources'
  | 'libs'
  | 'signature'
  | 'config'
  | 'dex'
  | 'assets'
  | 'other';

export interface PackageSizeBreakdownItem {
  category: SizeCategory;
  bytes: number;
  ratio: number;
  fileCount: number;
}

export interface PackageSizeTopFile {
  path: string;
  bytes: number;
  ratio: number;
  category: SizeCategory;
}

export interface PackageSizeInfo {
  /** 解压后所有 entry 的总字节数 */
  total: number;
  /** Hap 文件本身（zip 压缩后）字节数 */
  compressed: number;
  breakdown: PackageSizeBreakdownItem[];
  topFiles: PackageSizeTopFile[];
  /** 文件总数 */
  fileCount: number;
}

/**
 * Android 权限保护等级（与 Android 文档的 protectionLevel 对齐）。
 *
 *   - 'normal'             默认权限，安装时自动授予，不影响隐私
 *   - 'dangerous'          运行时权限，需用户确认（位置/相机/通讯录/SMS 等）
 *   - 'signature'          仅与系统签名相同的应用可获得
 *   - 'signatureOrSystem'  与系统签名相同 或 位于系统目录的应用（已 deprecated）
 *   - 'unknown'            工具内置清单中未列出，无法判定
 *
 * 仅由 Android permission analyzer 填充；HarmonyOS 不填这个字段。
 */
export type AndroidPermissionLevel =
  | 'normal'
  | 'dangerous'
  | 'signature'
  | 'signatureOrSystem'
  | 'unknown';

export interface PackagePermission {
  name: string;
  reason?: string;
  usedScene?: unknown;
  /** 工具内置敏感权限清单标注（Android: level==='dangerous' 即 true） */
  sensitive: boolean;
  /** Android 权限保护等级；仅 Android analyzer 填充 */
  level?: AndroidPermissionLevel;
}

export interface PackageResources {
  images: { count: number; bytes: number; topLargest: Array<{ path: string; bytes: number }> };
  strings: { count: number; locales: string[] };
  media: { count: number; bytes: number };
  rawResIndex?: { bytes: number };
}

export interface NativeLib {
  arch: string;
  name: string;
  bytes: number;
}

export interface NativeLibsInfo {
  architectures: string[];
  libs: NativeLib[];
  totalBytes: number;
}

export interface HarmonyAbcInfo {
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

export interface NativeSymbol {
  /** demangled 暂不做；保留原始符号名 */
  name: string;
  bind: NativeSymbolBind;
  type: NativeSymbolType;
  /** 占用字节（FUNC/OBJECT 才有意义；其它 0） */
  size: number;
  /** true 表示导入符号（ELF SHN_UNDEF）；false 表示自身定义 */
  imported: boolean;
  /**
   * 该符号在 ELF 文件里对应字节段（按 st_value → file offset 反映射）的 SHA-256。
   * 仅当 type='FUNC' && size>0 && !imported && 落在可执行段且文件偏移可解时填；
   * 其它情况下为 undefined。
   * 由 analyzer 在 `nativeHashSymbolBodies` 启用时计算（默认开），可被
   * differ 用来识别"同名同 size 但函数体改写"的 bodyChanged 信号。
   */
  codeSha256?: string;
}

/* ELF 节区（section）摘要：name / type / size / offset / 权限标志 */
export interface NativeLibSection {
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
export interface NativeLibMitigations {
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

/** .rodata 段内启发式抽取并分类后的字符串集合（结构与 HarmonyAbcStrings 对齐） */
export interface NativeLibRodataStrings {
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

export interface NativeLibSymbols {
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
  symbols: NativeSymbol[];
  /* ---- 以下字段为"深度分析增强"，按可用性可选；解析失败/不存在时省略 ---- */
  /** 全部 ELF section 摘要（按文件偏移升序） */
  sections?: NativeLibSection[];
  /** DT_NEEDED 列表：运行时依赖的 so 库名（按字典序排序、去重） */
  needed?: string[];
  /** `.note.gnu.build-id` 中的构建指纹，hex；不存在时省略 */
  buildId?: string;
  /** `.comment` 段中的编译器版本字符串（多条以 " | " 连接） */
  comment?: string;
  /** 安全 mitigations 汇总 */
  mitigations?: NativeLibMitigations;
  /** 通过 `.gnu.version_r` 解析出的 GLIBC 等 symbol versioning 需求，按字典序去重排序 */
  glibcVersions?: string[];
  /** 从 `.rodata` 段启发式抽取的字符串池（分类后） */
  rodataStrings?: NativeLibRodataStrings;
  /** 解析失败时填入 */
  error?: string;
}

export interface NativeLibSymbolsInfo {
  /** 每个 so 的符号详情 */
  perLib: NativeLibSymbols[];
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
export interface HarmonyAbcStrings {
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

export interface HarmonyAbcDetailEntry {
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
  strings?: HarmonyAbcStrings;
  /** 解析失败原因 */
  error?: string;
}

export interface HarmonyAbcDetailsInfo {
  entries: HarmonyAbcDetailEntry[];
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
export interface Il2cppNames {
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
export interface Il2cppLiterals {
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

export interface Il2cppMetadata {
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
  names?: Il2cppNames;
  /** 字符串字面量池抽取（仅 IL2CPP magic 时填充） */
  literals?: Il2cppLiterals;
  /** 解析失败时填入 */
  error?: string;
}

export interface Il2cppMetadataInfo {
  /** 命中的 metadata 文件（一般 1 个；同 hap 里偶有多份） */
  files: Il2cppMetadata[];
  /** 实际处理的文件数 */
  scanned: number;
}

/**
 * Android APK Signing Block 内的单个 ID-value pair 摘要。
 *
 * 不解析 value（v2/v3 内部还有签名者 / 数字签名 / 公钥三层 nested structure，
 * 完整解析需要 PKCS#7 / ASN.1，这里只暴露顶层结构作为"已签什么 scheme"的可读证据）。
 * 完整证书信息（subject/issuer/notBefore/notAfter）仍走 PackageSignatureInfo
 * 顶层字段（通过 META-INF 的 PKCS#7 容器抽证书）。
 */
export interface ApkSignatureBlockEntry {
  /** Pair ID（u32 hex string，前缀 0x，小写），例如 '0x7109871a' */
  idHex: string;
  /** ID 对应的常见名称（'V2 Signature' / 'V3 Signature' / 'Source Stamp' / 'Padding' / 'unknown'） */
  name: string;
  /** 这个 pair 的 value 字节数（不含 4 字节 ID，但 length 字段本身记录的是 4 + value 大小） */
  sizeBytes: number;
}

/** APK 多版本签名方案的命中情况（来自 Android：v1/v2/v3/v3.1） */
export interface ApkSignatureVersions {
  /** META-INF/*.RSA/.DSA/.EC + .SF 存在（与 JAR Signing 一致） */
  v1: boolean;
  /** APK Signing Block 内含 V2 Signature pair (ID 0x7109871a) */
  v2: boolean;
  /** APK Signing Block 内含 V3 Signature pair (ID 0xf05368c0) */
  v3: boolean;
  /** APK Signing Block 内含 V3.1 Signature pair (ID 0x1b93ad61，Android T+) */
  v31: boolean;
}

/** APK Signing Block 的顶层摘要 */
export interface ApkSigningBlock {
  /** signing block 总字节（含 8 字节 size 头、所有 pair、8 字节 size 重复、16 字节 magic） */
  totalBytes: number;
  /** APK Signing Block 在 APK 文件内的起始偏移（含 8 字节 size 头） */
  offset: number;
  /** 已识别 entries 列表（按出现顺序，便于看到 V2/V3 共存时的实际布局） */
  entries: ApkSignatureBlockEntry[];
}

export interface PackageSignatureInfo {
  present: boolean;
  issuer?: string;
  subject?: string;
  notBefore?: string;
  notAfter?: string;
  /**
   * Android：v1/v2/v3/v3.1 scheme 检测结果。
   * 仅 platform='android' 时由 apkSignature analyzer 填充；HarmonyOS 不填。
   */
  versions?: ApkSignatureVersions;
  /**
   * Android：APK Signing Block 解析详情（仅当文件确实存在 signing block 时填）。
   */
  signingBlock?: ApkSigningBlock;
}

/* ------------------------------------------------------------------ */
/* Android 专属：classes*.dex header + 字符串抽取（深度可选）           */
/* ------------------------------------------------------------------ */

/**
 * 单个 classes*.dex 文件的 header 摘要（轻量，仅读前 0x70 字节）。
 *
 * 字段命名直接对应 Android dex-format 规范：
 *   magic[8] → magic + version
 *   checksum、fileSize（u32）、headerSize（恒为 0x70）
 *   *_ids_size 系列：DEX 内字符串 / 类型 / 原型 / 字段 / 方法表项数
 *   classDefs：DEX 内类定义数（class_defs_size）
 *
 * 兼容性：解析失败时所有数值字段为 null、error 写错误原因；analyzer 不抛异常。
 * 通过 magic='CDEX' 识别 Android Q+ 的 Compact DEX（实际生产 APK 极少使用，
 * 但识别出来可以避免误报 'INVALID'）。
 */
export interface DexFileSummary {
  path: string;
  /** uncompressed bytes */
  bytes: number;
  /** "DEX" 标准 / "CDEX" Compact DEX / "INVALID" magic 不识别 */
  magic: 'DEX' | 'CDEX' | 'INVALID';
  /** "035" / "038" / "039" 等三位数字字符串；INVALID 时为 null */
  version: string | null;
  /** Adler-32 校验值（u32），仅读不校验；INVALID 时为 null */
  checksum: number | null;
  /** header 内声明的 file_size（理想情况下 == bytes） */
  fileSize: number | null;
  /** string_ids_size（DEX 字符串表项数） */
  stringIds: number | null;
  /** type_ids_size（类型描述符表项数） */
  typeIds: number | null;
  /** proto_ids_size（方法原型表项数） */
  protoIds: number | null;
  /** field_ids_size（字段表项数） */
  fieldIds: number | null;
  /** method_ids_size（方法表项数） */
  methodIds: number | null;
  /** class_defs_size（类定义数） */
  classDefs: number | null;
  /** 解析失败原因 */
  error?: string;
}

/**
 * 所有 classes*.dex 文件的汇总信息（轻量 default analyzer 产出）。
 *
 * 即使 APK 里没有任何 dex 也会输出 fileCount=0 的空对象，让 differ 能稳定 join。
 */
export interface DexInfo {
  /** 检测到的 classes*.dex 数量 */
  fileCount: number;
  /** 所有 dex uncompressed bytes 之和 */
  totalBytes: number;
  /** 每个 dex 的 header 摘要，按 path 字典序 */
  files: DexFileSummary[];
}

/**
 * DEX 字符串表（string_ids → string_data_item）启发式分桶后的全量集合。
 *
 * DEX 字符串表本身只有 raw 字符串（不自带 kind 标签），分桶规则与 HarmonyAbcStrings
 * 对齐，便于跨平台 diff 时人眼对比类描述符 / 方法签名 / 源文件名等不同维度。
 *
 * MUTF-8 解码：fixture 中 ASCII 字符串与 UTF-8 完全等价；遇到合法 UTF-8 字符即可正常出。
 * 含 surrogate pair 的字符可能解码为乱码，分到 'other' 桶。
 */
export interface DexStrings {
  /** 抽出的去重字符串总数（未截断前） */
  totalDistinct: number;
  /** 类描述符：^L[A-Za-z0-9_$/-]+;$，如 Lcom/king/Foo; */
  classDescriptors: string[];
  /** 方法签名：^\(.*\).+$，如 (Ljava/lang/String;)V */
  methodSignatures: string[];
  /** 源文件名：.java/.kt/.aidl/.ets/.ts/.js 结尾 */
  sourceFiles: string[];
  /** 普通标识符：^[A-Za-z_$][A-Za-z0-9_$]{2,80}$ */
  identifiers: string[];
  /** 兜底：未命中以上规则的字符串 */
  other: string[];
  /** 每分类应用的最大保留数（0 = 不限） */
  extractLimit: number;
  /** 任一分类被截断时为 true */
  truncated: boolean;
}

/**
 * 单个方法的扁平描述（Android Java/Kotlin 方法级 diff 的最小单元）。
 *
 * 字段语义：
 *   - classDescriptor：Lcom/foo/Bar;（dex 风格）
 *   - name：bar
 *   - proto：(I)V / (Landroid/os/Bundle;)V 等参数+返回类型组合，已展开为完整签名
 *   - fullName：classDescriptor + "->" + name + proto，全 dex 唯一，作为 differ 的 key
 *   - accessFlags：dex 原生 u32 access flags 位掩码（public / static / abstract / native 等）
 *   - hasCode：是否带 code_item（abstract / native 方法没有）
 *   - insnsSize：code_item.insns 长度，以 16-bit code units 计；× 2 = 字节数；hasCode=false 时为 null
 *   - registers：code_item.registers_size；hasCode=false 时为 null
 *   - insnsSha256：insns 字节段 SHA-256（hex）；hashMethodBodies 开关关闭时为 null
 *
 * differ 的方法级判定逻辑（9d 实现）：
 *   - 仅一侧出现 fullName → added / removed
 *   - 双侧 fullName 都在但 insnsSize / accessFlags / registers 任一变化 → changed
 *   - 当两侧都有 insnsSha256 且不相等 → bodyChanged=true（实现变了但 size 未必变）
 */
export interface DexMethodEntry {
  classDescriptor: string;
  name: string;
  proto: string;
  fullName: string;
  accessFlags: number;
  hasCode: boolean;
  insnsSize: number | null;
  registers: number | null;
  insnsSha256: string | null;
}

export interface DexDetailEntry {
  path: string;
  bytes: number;
  /** dex 全文 SHA-256，给"size 相同但内容变化"做双检测 */
  sha256: string;
  /** 启发式抽取的字符串池（仅 magic='DEX' 时填充） */
  strings?: DexStrings;
  /**
   * 方法表全量解析（仅 magic='DEX' + dexDetails analyzer 启用且无致命错误时填充）。
   *
   * 数组按 class_defs 顺序 + 类内 direct→virtual 顺序；fullName 全 dex 唯一，可作 diff key。
   * 截断时由 methodsTruncated=true 标记，调用方知道可能漏方法（dex 太大触发 methodLimit）。
   */
  methods?: DexMethodEntry[];
  /** methods 被 methodLimit 截断时为 true（dex 内仍有未抽取的方法） */
  methodsTruncated?: boolean;
  /** 解析失败原因 */
  error?: string;
}

export interface DexDetailsInfo {
  entries: DexDetailEntry[];
  scanned: number;
}

/**
 * Android 平台：AndroidManifest.xml 解析结果。
 *
 * 仅在 platform='android' 时由 manifest analyzer 填充。字段命名直接对应 Android
 * 文档的 manifest attribute（package / versionCode / versionName / sdk / 四大组件
 * / uses-permission），让对 Android 熟的人能直接看懂；对应 Harmony 的
 * basic + permission + dependency 三块的功能子集（最小可用集，二期再扩）。
 *
 * 兼容性：字段全部可选，AXML 解析失败时整个对象会被省略，只在 warnings 里报错。
 */
export interface AndroidManifestInfo {
  /** <manifest package=...> */
  packageName?: string;
  /** android:versionCode（int） */
  versionCode?: number;
  /** android:versionName（string） */
  versionName?: string;
  /** <uses-sdk> 的三个字段，未声明对应 undefined */
  usesSdk?: {
    minSdkVersion?: number;
    targetSdkVersion?: number;
    maxSdkVersion?: number;
  };
  /** <uses-permission android:name=...>，按出现顺序去重 */
  usesPermissions?: string[];
  /** <application> 内的四大组件 fully qualified class name 列表 */
  components?: {
    activities: string[];
    services: string[];
    receivers: string[];
    providers: string[];
  };
  /** <application android:label> 字符串原值；可能是 @string/xxx 资源引用 */
  applicationLabel?: string;
  /** <application android:icon> 字符串原值；可能是 @mipmap/xxx 资源引用 */
  applicationIcon?: string;
  /** <application android:debuggable> */
  debuggable?: boolean;
  /** AXML 解析时遇到的非致命异常（chunk 损坏 / 未知 chunk type 等） */
  warnings?: string[];
}

export interface HarmonyDependenciesInfo {
  hsp: string[];
  har: string[];
  raw?: unknown;
}

/* ------------------------------------------------------------------ */
/* Files（全量精简清单 - 给 differ / 高级查询用，viewer 不主动渲染）  */
/* ------------------------------------------------------------------ */

export interface PackageFileEntry {
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

export interface HarmonyRawfileInfo {
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
export interface PackageReport {
  schemaVersion: SchemaVersion;
  /**
   * 报告所属平台。未声明时按 'harmony' 处理（向后兼容老报告）。
   * 由 pipeline 在生成 report 时根据 analyzePackage 入参写入。
   */
  platform?: Platform;
  meta: PackageReportMeta;
  basic?: PackageBasicInfo;
  size?: PackageSizeInfo;
  permissions?: PackagePermission[];
  resources?: PackageResources;
  nativeLibs?: NativeLibsInfo;
  abc?: HarmonyAbcInfo;
  signature?: PackageSignatureInfo;
  dependencies?: HarmonyDependenciesInfo;
  rawfile?: HarmonyRawfileInfo;
  /** Android 专属：AndroidManifest.xml 解析结果（platform='android' 时填） */
  androidManifest?: AndroidManifestInfo;
  /** Android 专属：classes*.dex header 汇总（platform='android' 时由 dex analyzer 填） */
  dex?: DexInfo;
  /** 全量文件清单（zip entries 视图）。给 differ 做逐文件对比，viewer 默认不展示 */
  files?: PackageFileEntry[];
  /** 可选深度分析：每个 so 的 ELF 符号表 */
  nativeLibSymbols?: NativeLibSymbolsInfo;
  /** 可选深度分析：每个 abc 文件的 PANDA 头部细节 */
  abcDetails?: HarmonyAbcDetailsInfo;
  /** 可选深度分析：il2cpp global-metadata.dat（Unity 游戏专用） */
  il2cppMetadata?: Il2cppMetadataInfo;
  /** 可选深度分析：每个 classes*.dex 的字符串表抽取（Android 专属） */
  dexDetails?: DexDetailsInfo;
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

export interface PackageDiffSide {
  meta: PackageReportMeta;
  basic?: PackageBasicInfo;
}

/* ---- basic ---- */

export interface PackageDiffBasicChange {
  /** 点路径，如 'bundleName' / 'versionCode' / 'deviceTypes' */
  field: string;
  from: unknown;
  to: unknown;
}

/* ---- size ---- */

export interface PackageDiffSizeBreakdownItem {
  category: SizeCategory;
  fromBytes: number;
  toBytes: number;
  delta: number;
  ratio: number | null;
}

export interface PackageDiffSize {
  total: DeltaNumber;
  compressed: DeltaNumber;
  fileCount: DeltaNumber;
  breakdown: PackageDiffSizeBreakdownItem[];
}

/* ---- files（基于 zip entry 列表的全量逐文件 diff） ---- */

export interface PackageDiffFileAdded {
  path: string;
  bytes: number;
  category: SizeCategory;
}

export interface PackageDiffFileChanged {
  path: string;
  fromBytes: number;
  toBytes: number;
  delta: number;
  category: SizeCategory;
}

export interface PackageDiffFiles {
  /** 全量新增列表（按 bytes desc，前端可继续截断） */
  added: PackageDiffFileAdded[];
  removed: PackageDiffFileAdded[];
  /** 同名但 size 变化（含 crc 差异时也并入） */
  changed: PackageDiffFileChanged[];
  /** 计数（即使 added/removed/changed 被截断，这里仍是真实总数） */
  totals: { added: number; removed: number; changed: number; unchanged: number };
}

/* ---- permission ---- */

export interface PackageDiffPermissions {
  added: PackagePermission[];
  removed: PackagePermission[];
  unchanged: number;
}

/* ---- resource ---- */

export interface PackageDiffResources {
  images: { count: DeltaNumber; bytes: DeltaNumber };
  strings: { count: DeltaNumber; localesAdded: string[]; localesRemoved: string[] };
  media: { count: DeltaNumber; bytes: DeltaNumber };
}

/* ---- rawfile ---- */

export interface HarmonyDiffRawfileGroup {
  path: string;
  fromBytes: number;
  toBytes: number;
  delta: number;
  fromCount: number;
  toCount: number;
}

export interface HarmonyDiffRawfileCategory {
  category: RawfileCategory;
  fromBytes: number;
  toBytes: number;
  delta: number;
  fromCount: number;
  toCount: number;
}

export interface HarmonyDiffRawfilePackage {
  packageId: string;
  fromBytes: number;
  toBytes: number;
  delta: number;
  fromCount: number;
  toCount: number;
}

export interface HarmonyDiffRawfile {
  fileCount: DeltaNumber;
  totalBytes: DeltaNumber;
  topLevelGroups: HarmonyDiffRawfileGroup[];
  categories: HarmonyDiffRawfileCategory[];
  packages?: HarmonyDiffRawfilePackage[];
}

/* ---- nativeLib ---- */

export interface DiffNativeLibChanged {
  arch: string;
  name: string;
  fromBytes: number;
  toBytes: number;
  delta: number;
}

export interface DiffNativeLibs {
  architectures: { added: string[]; removed: string[] };
  totalBytes: DeltaNumber;
  added: NativeLib[];
  removed: NativeLib[];
  changed: DiffNativeLibChanged[];
}

/* ---- abc ---- */

export interface HarmonyDiffAbc {
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

export interface DiffSymbolChanged {
  name: string;
  fromSize: number;
  toSize: number;
  delta: number;
  /** bind / type / imported 在两侧的最终值 */
  bind: NativeSymbolBind;
  type: NativeSymbolType;
  imported: boolean;
  /**
   * 函数体字节是否变化（**仅作为 size 已变时的附加信号**）：
   *   - true：两侧都有 codeSha256 且不一致
   *   - false：两侧都有 codeSha256 且一致
   *   - null：任一侧缺 codeSha256 → 无法判断
   *   - 字段缺省：analyzer 未抽 codeSha256，向后兼容旧 report
   *
   * 注意 differ 已经把 "size 没变但 hash 不同" 的符号从 `changed` 移走了
   * （走到 {@link DiffNativeLibSymbolsItem.bodyHashOnly}），因为那种信号
   * 含大量 PC-relative 重链接位移假阳性。本字段在 `changed` 行里只回答
   * "size 变了同时 body 也变了吗"——绝大多数情况都是 true，少数 false 通常
   * 是末尾对齐 padding 调整。
   */
  bodyChanged?: boolean | null;
  /** 左侧 codeSha256（若有），便于 viewer 展示 */
  fromCodeSha256?: string;
  /** 右侧 codeSha256（若有），便于 viewer 展示 */
  toCodeSha256?: string;
}

/**
 * @deprecated 已默认禁用 —— differ 不再产出，但保留字段定义以确保老 diff.json
 * 与外部脚本读取不炸。
 *
 * 历史背景：曾用于呈现"同名符号 size 完全一致、但 codeSha256 不同"的漂移项。
 * 对真实 strip 过的 release `.so` 来说，ARM64 `bl/adrp/adr/ldr-literal` 等
 * PC-relative 字段只要被链接到不同地址就会产出不同字节——源码一行未改也会触发；
 * analyzer 端的 `.rela.* mask` 只能吸收一部分。最终这种"漂移项"会污染 diff.json
 * 与 AI 注意力，被整体下线。
 *
 * 真要追"size 不变但函数体改写"的强信号，需要反汇编 mnemonic 序列差分（未做）。
 */
export interface DiffSymbolBodyHashOnly {
  name: string;
  /** 符号 size（两侧相同） */
  size: number;
  bind: NativeSymbolBind;
  type: NativeSymbolType;
  imported: boolean;
  fromCodeSha256: string;
  toCodeSha256: string;
}

/* ELF section 的逐 section diff（按 |delta| 降序） */
export interface DiffNativeLibSectionItem {
  name: string;
  fromSize: number;
  toSize: number;
  delta: number;
}

export interface DiffNativeLibSections {
  /** 双侧都有但 size 变化的 section（按 |delta| 降序） */
  changed: DiffNativeLibSectionItem[];
  /** 新增 section（右有左无） */
  added: DiffNativeLibSectionItem[];
  /** 删除 section（左有右无） */
  removed: DiffNativeLibSectionItem[];
  /** 任一 section 有变化时为 true */
  anyChanged: boolean;
}

/** mitigations 的 from/to + 是否变化（per-field） */
export interface DiffNativeLibMitigations {
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

/** 字符串集合的 add/remove/unchanged 差（与 HarmonyDiffAbcStringSet 同形） */
export interface DiffStringSet {
  added: string[];
  removed: string[];
  unchanged: number;
}

/** .rodata 字符串池的逐分类差异 */
export interface DiffNativeLibRodataStrings {
  urls: DiffStringSet;
  paths: DiffStringSet;
  sqlLike: DiffStringSet;
  other: DiffStringSet;
  anyChanged: boolean;
}

/** build-id / .comment 的对比 */
export interface DiffNativeLibBuildInfo {
  fromBuildId?: string;
  toBuildId?: string;
  buildIdChanged: boolean;
  fromComment?: string;
  toComment?: string;
  commentChanged: boolean;
  anyChanged: boolean;
}

export interface DiffNativeLibSymbolsItem {
  arch: string;
  name: string;
  /** 一侧没有此 so 时为 true（不计入符号 added/removed，只是标记） */
  fromMissing: boolean;
  toMissing: boolean;
  added: NativeSymbol[];
  removed: NativeSymbol[];
  /**
   * `size` 变化的符号（同名同 imported）——主"修改"信号。
   * 注意：`size` 未变但 `codeSha256` 不同的符号**不会**进这里，详见
   * {@link DiffNativeLibSymbolsItem.bodyHashOnly}。
   */
  changed: DiffSymbolChanged[];
  /**
   * @deprecated 已默认禁用 —— differ 不再填充。保留字段定义仅为兼容老 diff.json。
   *
   * 历史含义：`size` 未变但 `codeSha256` 不同的符号集合。重链接产生的 PC-relative
   * 字段位移导致大量假阳性，污染 diff 输出与 AI 注意力，已整体下线。
   */
  bodyHashOnly?: DiffSymbolBodyHashOnly[];
  totals: {
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
    /**
     * @deprecated 与 {@link bodyHashOnly} 一同停产；缺省时按 0 算。
     */
    bodyHashOnly?: number;
  };
  /* ---- 以下字段为深度分析的可选维度，仅当对应 analyzer 字段在两侧任意一边可用时出现 ---- */
  sectionsDiff?: DiffNativeLibSections;
  /** DT_NEEDED 列表的 add/remove */
  neededDiff?: DiffStringSet;
  /** mitigations 的 per-flag 对比 */
  mitigationsDiff?: DiffNativeLibMitigations;
  /** GLIBC 等版本符号需求的 add/remove */
  glibcDiff?: DiffStringSet;
  /** .rodata 字符串池差异（仅当任一侧有 rodataStrings 时出现） */
  rodataDiff?: DiffNativeLibRodataStrings;
  /** build-id / .comment 对比 */
  buildInfoDiff?: DiffNativeLibBuildInfo;
}

export interface DiffNativeLibSymbols {
  perLib: DiffNativeLibSymbolsItem[];
  /** 双侧任一 so 都未被深度分析时为空，前端可据此 emptyState */
  scanned: number;
}

/* ---- abcDetails（可选深度差异） ---- */

/** 单个分类的字符串差集 */
export interface HarmonyDiffAbcStringSet {
  added: string[];
  removed: string[];
  /** 双侧都有（去重后），仅展示一个数字 */
  unchanged: number;
}

/** abc 内字符串池的逐分类差异（仅当两侧都跑了 abcStrings 抽取时存在） */
export interface HarmonyDiffAbcStrings {
  classDescriptors: HarmonyDiffAbcStringSet;
  moduleRecords: HarmonyDiffAbcStringSet;
  sourceFiles: HarmonyDiffAbcStringSet;
  identifiers: HarmonyDiffAbcStringSet;
  /** 任意分类有变化时 true */
  anyChanged: boolean;
}

export interface HarmonyDiffAbcDetailEntry {
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
  stringsDiff?: HarmonyDiffAbcStrings;
}

export interface HarmonyDiffAbcDetails {
  entries: HarmonyDiffAbcDetailEntry[];
  totals: {
    /** 仅 changed=true 的 abc 数量 */
    changed: number;
    /** 总条目数（双侧并集） */
    total: number;
  };
}

/* ---- il2cppMetadata（Unity / IL2CPP 深度差异） ---- */

export interface DiffIl2cppNames {
  typeNames: DiffStringSet;
  namespaces: DiffStringSet;
  identifiers: DiffStringSet;
  assemblies: DiffStringSet;
  other: DiffStringSet;
  anyChanged: boolean;
}

export interface DiffIl2cppLiterals {
  urls: DiffStringSet;
  paths: DiffStringSet;
  sqlLike: DiffStringSet;
  other: DiffStringSet;
  anyChanged: boolean;
}

export interface DiffIl2cppMetadataEntry {
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
  namesDiff?: DiffIl2cppNames;
  /** 字面量池差异（仅当两侧都解析到 literals 时填） */
  literalsDiff?: DiffIl2cppLiterals;
}

export interface DiffIl2cppMetadata {
  entries: DiffIl2cppMetadataEntry[];
  totals: {
    /** changed=true 的文件数 */
    changed: number;
    /** 总条目数（双侧并集） */
    total: number;
  };
}

/* ---- dex（Android default analyzer 产物 diff） ---- */

/**
 * dex 文件被新增或移除（add/remove）时的最小描述。
 *
 * magic + version 用 INVALID/null 表示 header 解析失败的 dex 文件，
 * 让 UI 能区分"完全无 dex"和"有 dex 但 header 损坏"。
 */
export interface DiffDexFileSide {
  path: string;
  bytes: number;
  magic: 'DEX' | 'CDEX' | 'INVALID';
  version: string | null;
}

/** 双侧都存在但 header 字段有变化的 dex 文件（按 path 锁定） */
export interface DiffDexFileChanged {
  path: string;
  fromBytes: number;
  toBytes: number;
  bytesDelta: number;
  fromMagic: 'DEX' | 'CDEX' | 'INVALID';
  toMagic: 'DEX' | 'CDEX' | 'INVALID';
  fromVersion: string | null;
  toVersion: string | null;
  /** header 内 *_ids 计数 delta；任一侧解析失败时为 null */
  stringIdsDelta: number | null;
  typeIdsDelta: number | null;
  protoIdsDelta: number | null;
  fieldIdsDelta: number | null;
  methodIdsDelta: number | null;
  classDefsDelta: number | null;
  /** 综合：bytes / magic / version / 任一 *_ids 变化 */
  changed: boolean;
}

export interface DiffDex {
  /** 仅右侧出现的 dex（按 bytes 降序） */
  added: DiffDexFileSide[];
  /** 仅左侧出现的 dex（按 bytes 降序） */
  removed: DiffDexFileSide[];
  /** 同 path 但 header 有变化（按 |bytesDelta| 降序） */
  changed: DiffDexFileChanged[];
  /** 跨 dex 文件的汇总变化（fileCount/totalBytes/methodIds 总和等） */
  totals: {
    fileCount: DeltaNumber;
    totalBytes: DeltaNumber;
    /** 所有 dex methodIds 总和 delta（直观回答"方法表多了多少"） */
    methodIdsCount: DeltaNumber;
    /** 所有 dex classDefs 总和 delta */
    classDefsCount: DeltaNumber;
  };
}

/* ---- dexDetails（可选深度差异：字符串集合 + 方法集合） ---- */

/** dex 字符串池逐分类差异（仅当两侧都跑了 dexDetails 抽取时存在） */
export interface DiffDexStrings {
  classDescriptors: DiffStringSet;
  methodSignatures: DiffStringSet;
  sourceFiles: DiffStringSet;
  identifiers: DiffStringSet;
  other: DiffStringSet;
  /** 任意分类有变化时 true */
  anyChanged: boolean;
}

/** 方法的最小描述（diff added/removed 列表项；不含 insnsSize 等可变属性） */
export interface DiffDexMethodSide {
  /** Lcom/foo/Bar;->m(I)V，全 dex 唯一 */
  fullName: string;
  classDescriptor: string;
  name: string;
  proto: string;
  /** code_item.insns 长度（16-bit code units）；无 code 时为 null */
  insnsSize: number | null;
}

/** 双侧都有同名方法但属性发生变化 */
export interface DiffDexMethodChanged {
  fullName: string;
  classDescriptor: string;
  name: string;
  proto: string;
  fromInsnsSize: number | null;
  toInsnsSize: number | null;
  /** insnsSize delta；任一侧为 null（hasCode=false）时也为 null */
  insnsSizeDelta: number | null;
  fromRegisters: number | null;
  toRegisters: number | null;
  fromAccessFlags: number;
  toAccessFlags: number;
  /** access_flags 任一位变化时为 true */
  accessFlagsChanged: boolean;
  /**
   * 方法体（insns 字节）SHA-256 比对结果。
   * - 两侧都有 insnsSha256 且不等 → true
   * - 任一侧 insnsSha256=null（dexHashMethodBodies 未开启） → null
   * - 两侧都 null 或都相等 → false
   */
  bodyChanged: boolean | null;
}

/** 单个 dex 文件内的方法级差异（按 fullName 作 key） */
export interface DiffDexMethods {
  added: DiffDexMethodSide[];
  removed: DiffDexMethodSide[];
  changed: DiffDexMethodChanged[];
  totals: {
    added: number;
    removed: number;
    /** insnsSize / accessFlags / registers / bodyChanged 任一变化的方法数 */
    changed: number;
    /** 双侧都有且未变的方法数 */
    unchanged: number;
  };
}

export interface DiffDexDetailEntry {
  path: string;
  /** 任一侧缺失（dex 文件本身被新增/删除）时对应字段为 null */
  fromBytes: number | null;
  toBytes: number | null;
  fromSha256: string | null;
  toSha256: string | null;
  /** 综合判定：bytes / sha256 任一变化 */
  changed: boolean;
  /** 字符串池差异（仅当两侧都跑了 dexDetails 抽取时填） */
  stringsDiff?: DiffDexStrings;
  /** 方法级差异（仅当两侧都跑了 dexDetails 且包含 methods 时填；
   * 一侧 dex 整体新增/删除时，方法全数算 added/removed） */
  methodsDiff?: DiffDexMethods;
}

export interface DiffDexDetails {
  entries: DiffDexDetailEntry[];
  totals: {
    /** 仅 changed=true 的 dex 数量 */
    changed: number;
    /** 总条目数（双侧并集） */
    total: number;
    /** 跨所有 dex 文件汇总的方法级变化（含 added/removed/changed 总和） */
    methodsAdded: number;
    methodsRemoved: number;
    methodsChanged: number;
  };
}

/* ---- signature ---- */

export interface PackageDiffSignatureField {
  field: 'subject' | 'issuer' | 'notBefore' | 'notAfter';
  from?: string;
  to?: string;
  changed: boolean;
}

/** Android：单个签名 scheme 标志位 diff（v1/v2/v3/v3.1 各一个） */
export interface DiffApkSignatureVersionFlag {
  from: boolean;
  to: boolean;
  changed: boolean;
}

/** Android：多版本签名 scheme 合集 diff */
export interface DiffApkSignatureVersions {
  v1: DiffApkSignatureVersionFlag;
  v2: DiffApkSignatureVersionFlag;
  v3: DiffApkSignatureVersionFlag;
  v31: DiffApkSignatureVersionFlag;
  anyChanged: boolean;
}

/** APK Signing Block 内"同 ID 但 value 大小变化"的条目 */
export interface DiffApkSigningBlockEntryChanged {
  idHex: string;
  name: string;
  fromSize: number;
  toSize: number;
  delta: number;
}

/** Android：APK Signing Block diff */
export interface DiffApkSigningBlock {
  /** 两侧 signing block 总字节；任一侧无 block 时为 null */
  fromTotalBytes: number | null;
  toTotalBytes: number | null;
  /** 总字节 delta；任一侧 null 时也为 null */
  totalBytesDelta: number | null;
  /** 仅右侧出现的 pair（按 idHex 字典序） */
  added: ApkSignatureBlockEntry[];
  /** 仅左侧出现的 pair（按 idHex 字典序） */
  removed: ApkSignatureBlockEntry[];
  /** 双侧都有但 value 字节数变化的 pair（按 |delta| 降序） */
  changedSizes: DiffApkSigningBlockEntryChanged[];
  /** 任一项有变化时 true */
  anyChanged: boolean;
}

export interface PackageDiffSignature {
  fromPresent: boolean;
  toPresent: boolean;
  presentChanged: boolean;
  fields: PackageDiffSignatureField[];
  /** Android：多版本签名 scheme diff；仅当任一侧有 versions 时填 */
  versions?: DiffApkSignatureVersions;
  /** Android：APK Signing Block diff；仅当任一侧有 signingBlock 时填 */
  signingBlock?: DiffApkSigningBlock;
}

/* ---- dependency ---- */

export interface HarmonyDiffDependencies {
  hsp: { added: string[]; removed: string[] };
  har: { added: string[]; removed: string[] };
}

/* ---- summary ---- */

export interface PackageDiffSummary {
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

export interface PackageDiffReport {
  schemaVersion: SchemaVersion;
  /** ISO-8601 生成时间 */
  generatedAt: string;
  /** 工具版本 */
  toolVersion: string;
  left: PackageDiffSide;
  right: PackageDiffSide;
  summary: PackageDiffSummary;
  basic?: { changed: PackageDiffBasicChange[] };
  size?: PackageDiffSize;
  files?: PackageDiffFiles;
  permissions?: PackageDiffPermissions;
  resources?: PackageDiffResources;
  rawfile?: HarmonyDiffRawfile;
  nativeLibs?: DiffNativeLibs;
  abc?: HarmonyDiffAbc;
  /** 可选深度差异：so 内部符号增删改 */
  nativeLibSymbols?: DiffNativeLibSymbols;
  /** 可选深度差异：abc 头部细节差异 */
  abcDetails?: HarmonyDiffAbcDetails;
  /** 可选深度差异：il2cpp metadata（Unity 游戏专用） */
  il2cppMetadata?: DiffIl2cppMetadata;
  /** Android：classes*.dex header 级 diff（fileCount / *_ids 计数等） */
  dex?: DiffDex;
  /** Android 可选深度差异：dex 字符串池差异（9d 起补 method 级 diff） */
  dexDetails?: DiffDexDetails;
  signature?: PackageDiffSignature;
  dependencies?: HarmonyDiffDependencies;
  warnings: ReportWarning[];
}

/* ------------------------------------------------------------------ */
/* Analyzer 接口                                                       */
/* ------------------------------------------------------------------ */

/** 单个 entry 的元信息（不含字节内容，按需通过 readFile 获取） */
export interface PackageEntry {
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

export interface VirtualPackage {
  /** Hap 文件路径 */
  filePath: string;
  /** Hap 文件本身字节数 */
  fileSize: number;
  /** 文件 SHA-256 hex */
  sha256: string;
  /** 所有 entry 元信息 */
  entries: PackageEntry[];
  /** 按需读取一个 entry 的内容 */
  readFile: (path: string) => Promise<Buffer>;
  /** 按需读取并尝试以 utf-8 解码 */
  readText: (path: string) => Promise<string>;
  /** 关闭底层 zip 句柄 */
  close: () => Promise<void>;
}

export interface AnalyzerContext {
  hap: VirtualPackage;
  options: AnalyzeOptions;
  /**
   * 当前包平台。analyzer 可据此切换路径前缀 / 文件名 / 解析格式。
   * pipeline 总会传值，缺省按 'harmony' 处理（兼容旧调用）。
   */
  platform: Platform;
  /** 由 pipeline 提供的告警收集器 */
  addWarning: (w: Omit<ReportWarning, 'source'>) => void;
}

/**
 * Analyzer 插件接口。
 *
 * 每个 analyzer 输出 PackageReport 中自己负责的那部分字段（一个 Partial）。
 * pipeline 负责把所有 analyzer 的结果合并成最终 report。
 */
export interface Analyzer {
  /** 唯一 id，CLI --only 用 */
  id: string;
  /** 人类可读名 */
  name: string;
  /** 默认是否启用（M1 阶段未实现的 analyzer 会被关掉） */
  enabledByDefault: boolean;
  run: (ctx: AnalyzerContext) => Promise<Partial<PackageReport>>;
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
  /** dexDetails：每个 dex 字符串分类最多保留多少条（0 表示不限，默认值）。
   * 项目级约定：默认全量；仅在 JSON 体积失控时才显式传非 0。 */
  dexStringExtractLimit?: number;
  /** dexDetails：每个 dex 最多抽取多少方法（0 表示不限，默认值）。
   * 单 dex 通常 1-3 万方法；分桶不大时全量保留对 JSON 体积影响有限。 */
  dexMethodExtractLimit?: number;
  /**
   * dexDetails：是否对每个方法的 insns 字节段算 SHA-256。
   * 默认 false 以省 IO/CPU；diff 仅依赖 insnsSize 判定方法体大小变化。
   * 开启后 differ 能识别"大小相同但实现变化"的 body changed 信号。
   */
  dexHashMethodBodies?: boolean;
  /**
   * nativeSymbols：是否对每个 FUNC 符号在 .text/.plt 等可执行段对应的字节段算 SHA-256。
   * 默认 true，对应"同名同 st_size 但函数体改写"的 bodyChanged diff 信号；
   * 大 so（几十 MB）单次额外开销在毫秒级，但若极端追求最快分析速度可显式设为 false。
   */
  nativeHashSymbolBodies?: boolean;
  /**
   * 包平台。决定使用哪一套默认 analyzer 集合 / loader 行为。
   * 未指定时 analyzePackage 会按 'harmony' 处理（向后兼容旧调用）。
   */
  platform?: Platform;
}

/* ------------------------------------------------------------------ */
/* Workbench (本地图形工作台)                                          */
/* ------------------------------------------------------------------ */

export type WorkbenchJobKind = 'analyze' | 'compare';
export type WorkbenchJobStatus = 'pending' | 'running' | 'done' | 'error';

/**
 * compare job 在主产物（diff）之外，对 left/right 两侧各自单独分析报告的访问入口。
 * 复用 analyze 的 PackageReport 数据结构 + viewer 模板，前端可"点进去看单包结果"。
 *
 * - 仅 kind='compare' 且 status='done' 时存在；
 * - 老版本生成的 compare job 不会有此字段，前端需做存在性判断（向后兼容）。
 */
export interface WorkbenchCompareSide {
  /** 该侧原始输入路径（可能是 .hap 也可能是 .json 报告，原样保留） */
  sourcePath: string;
  /** 单侧报告 viewer 页面 */
  htmlUrl: string;
  /** 单侧 PackageReport JSON */
  jsonUrl: string;
}

export interface WorkbenchJob {
  id: string;
  kind: WorkbenchJobKind;
  status: WorkbenchJobStatus;
  /**
   * 该 job 处理的包平台。未填默认 'harmony'（兼容历史 job）。
   * compare job 在创建时已校验两侧 platform 一致，因此一个值即可。
   */
  platform?: Platform;
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

// =====================================================================
// 历史命名兼容层
// =====================================================================
//
// 第一期工具只跑 HarmonyOS .hap，所有 schema 都用 Hap 前缀。
// 在拓展到 Android/iOS 时，所有"包级别"概念都改成 Package 前缀，
// 跨平台的二进制类（native lib / il2cpp）去掉前缀，
// HarmonyOS 专属类（abc / rawfile / dependencies）改为 Harmony 前缀。
//
// 以下 alias 让旧代码（外部使用者或仍未迁移的内部模块）继续 import 旧名字，
// 给迁移留出一个版本的窗口。新代码应该直接用新名字。
// =====================================================================

// ---- 通用前缀：Hap* -> Package* ----
/** @deprecated 用 {@link PackageReport} */
export type HapReport = PackageReport;
/** @deprecated 用 {@link PackageReportMeta} */
export type HapReportMeta = PackageReportMeta;
/** @deprecated 用 {@link PackageBasicInfo} */
export type HapBasicInfo = PackageBasicInfo;
/** @deprecated 用 {@link PackageSizeInfo} */
export type HapSizeInfo = PackageSizeInfo;
/** @deprecated 用 {@link PackageSizeBreakdownItem} */
export type HapSizeBreakdownItem = PackageSizeBreakdownItem;
/** @deprecated 用 {@link PackageSizeTopFile} */
export type HapSizeTopFile = PackageSizeTopFile;
/** @deprecated 用 {@link PackagePermission} */
export type HapPermission = PackagePermission;
/** @deprecated 用 {@link PackageResources} */
export type HapResources = PackageResources;
/** @deprecated 用 {@link PackageSignatureInfo} */
export type HapSignatureInfo = PackageSignatureInfo;
/** @deprecated 用 {@link PackageFileEntry} */
export type HapFileEntry = PackageFileEntry;
/** @deprecated 用 {@link PackageEntry} */
export type HapEntry = PackageEntry;
/** @deprecated 用 {@link VirtualPackage} */
export type VirtualHap = VirtualPackage;

// ---- 跨平台二进制：去 Hap 前缀 ----
/** @deprecated 用 {@link NativeLib} */
export type HapNativeLib = NativeLib;
/** @deprecated 用 {@link NativeLibsInfo} */
export type HapNativeLibsInfo = NativeLibsInfo;
/** @deprecated 用 {@link NativeSymbol} */
export type HapNativeSymbol = NativeSymbol;
/** @deprecated 用 {@link NativeLibSection} */
export type HapNativeLibSection = NativeLibSection;
/** @deprecated 用 {@link NativeLibMitigations} */
export type HapNativeLibMitigations = NativeLibMitigations;
/** @deprecated 用 {@link NativeLibRodataStrings} */
export type HapNativeLibRodataStrings = NativeLibRodataStrings;
/** @deprecated 用 {@link NativeLibSymbols} */
export type HapNativeLibSymbols = NativeLibSymbols;
/** @deprecated 用 {@link NativeLibSymbolsInfo} */
export type HapNativeLibSymbolsInfo = NativeLibSymbolsInfo;
/** @deprecated 用 {@link Il2cppNames} */
export type HapIl2cppNames = Il2cppNames;
/** @deprecated 用 {@link Il2cppLiterals} */
export type HapIl2cppLiterals = Il2cppLiterals;
/** @deprecated 用 {@link Il2cppMetadata} */
export type HapIl2cppMetadata = Il2cppMetadata;
/** @deprecated 用 {@link Il2cppMetadataInfo} */
export type HapIl2cppMetadataInfo = Il2cppMetadataInfo;

// ---- HarmonyOS 专属：加 Harmony 前缀 ----
/** @deprecated 用 {@link HarmonyAbcInfo} */
export type HapAbcInfo = HarmonyAbcInfo;
/** @deprecated 用 {@link HarmonyAbcStrings} */
export type HapAbcStrings = HarmonyAbcStrings;
/** @deprecated 用 {@link HarmonyAbcDetailEntry} */
export type HapAbcDetailEntry = HarmonyAbcDetailEntry;
/** @deprecated 用 {@link HarmonyAbcDetailsInfo} */
export type HapAbcDetailsInfo = HarmonyAbcDetailsInfo;
/** @deprecated 用 {@link HarmonyRawfileInfo} */
export type HapRawfileInfo = HarmonyRawfileInfo;
/** @deprecated 用 {@link HarmonyDependenciesInfo} */
export type HapDependenciesInfo = HarmonyDependenciesInfo;

// ---- Diff 通用前缀：HapDiff* -> PackageDiff* ----
/** @deprecated 用 {@link PackageDiffReport} */
export type HapDiffReport = PackageDiffReport;
/** @deprecated 用 {@link PackageDiffSide} */
export type HapDiffSide = PackageDiffSide;
/** @deprecated 用 {@link PackageDiffBasicChange} */
export type HapDiffBasicChange = PackageDiffBasicChange;
/** @deprecated 用 {@link PackageDiffSize} */
export type HapDiffSize = PackageDiffSize;
/** @deprecated 用 {@link PackageDiffSizeBreakdownItem} */
export type HapDiffSizeBreakdownItem = PackageDiffSizeBreakdownItem;
/** @deprecated 用 {@link PackageDiffFiles} */
export type HapDiffFiles = PackageDiffFiles;
/** @deprecated 用 {@link PackageDiffFileAdded} */
export type HapDiffFileAdded = PackageDiffFileAdded;
/** @deprecated 用 {@link PackageDiffFileChanged} */
export type HapDiffFileChanged = PackageDiffFileChanged;
/** @deprecated 用 {@link PackageDiffPermissions} */
export type HapDiffPermissions = PackageDiffPermissions;
/** @deprecated 用 {@link PackageDiffResources} */
export type HapDiffResources = PackageDiffResources;
/** @deprecated 用 {@link PackageDiffSignature} */
export type HapDiffSignature = PackageDiffSignature;
/** @deprecated 用 {@link PackageDiffSignatureField} */
export type HapDiffSignatureField = PackageDiffSignatureField;
/** @deprecated 用 {@link PackageDiffSummary} */
export type HapDiffSummary = PackageDiffSummary;

// ---- Diff 跨平台二进制：去 Hap 前缀 ----
/** @deprecated 用 {@link DiffNativeLibs} */
export type HapDiffNativeLibs = DiffNativeLibs;
/** @deprecated 用 {@link DiffNativeLibChanged} */
export type HapDiffNativeLibChanged = DiffNativeLibChanged;
/** @deprecated 用 {@link DiffNativeLibSymbols} */
export type HapDiffNativeLibSymbols = DiffNativeLibSymbols;
/** @deprecated 用 {@link DiffNativeLibSymbolsItem} */
export type HapDiffNativeLibSymbolsItem = DiffNativeLibSymbolsItem;
/** @deprecated 用 {@link DiffNativeLibSections} */
export type HapDiffNativeLibSections = DiffNativeLibSections;
/** @deprecated 用 {@link DiffNativeLibSectionItem} */
export type HapDiffNativeLibSectionItem = DiffNativeLibSectionItem;
/** @deprecated 用 {@link DiffNativeLibMitigations} */
export type HapDiffNativeLibMitigations = DiffNativeLibMitigations;
/** @deprecated 用 {@link DiffNativeLibRodataStrings} */
export type HapDiffNativeLibRodataStrings = DiffNativeLibRodataStrings;
/** @deprecated 用 {@link DiffNativeLibBuildInfo} */
export type HapDiffNativeLibBuildInfo = DiffNativeLibBuildInfo;
/** @deprecated 用 {@link DiffSymbolChanged} */
export type HapDiffSymbolChanged = DiffSymbolChanged;
/** @deprecated 用 {@link DiffStringSet} */
export type HapDiffStringSet = DiffStringSet;
/** @deprecated 用 {@link DiffIl2cppNames} */
export type HapDiffIl2cppNames = DiffIl2cppNames;
/** @deprecated 用 {@link DiffIl2cppLiterals} */
export type HapDiffIl2cppLiterals = DiffIl2cppLiterals;
/** @deprecated 用 {@link DiffIl2cppMetadata} */
export type HapDiffIl2cppMetadata = DiffIl2cppMetadata;
/** @deprecated 用 {@link DiffIl2cppMetadataEntry} */
export type HapDiffIl2cppMetadataEntry = DiffIl2cppMetadataEntry;

// ---- Diff HarmonyOS 专属：加 Harmony 前缀 ----
/** @deprecated 用 {@link HarmonyDiffAbc} */
export type HapDiffAbc = HarmonyDiffAbc;
/** @deprecated 用 {@link HarmonyDiffAbcStrings} */
export type HapDiffAbcStrings = HarmonyDiffAbcStrings;
/** @deprecated 用 {@link HarmonyDiffAbcStringSet} */
export type HapDiffAbcStringSet = HarmonyDiffAbcStringSet;
/** @deprecated 用 {@link HarmonyDiffAbcDetailEntry} */
export type HapDiffAbcDetailEntry = HarmonyDiffAbcDetailEntry;
/** @deprecated 用 {@link HarmonyDiffAbcDetails} */
export type HapDiffAbcDetails = HarmonyDiffAbcDetails;
/** @deprecated 用 {@link HarmonyDiffRawfile} */
export type HapDiffRawfile = HarmonyDiffRawfile;
/** @deprecated 用 {@link HarmonyDiffRawfileGroup} */
export type HapDiffRawfileGroup = HarmonyDiffRawfileGroup;
/** @deprecated 用 {@link HarmonyDiffRawfileCategory} */
export type HapDiffRawfileCategory = HarmonyDiffRawfileCategory;
/** @deprecated 用 {@link HarmonyDiffRawfilePackage} */
export type HapDiffRawfilePackage = HarmonyDiffRawfilePackage;
/** @deprecated 用 {@link HarmonyDiffDependencies} */
export type HapDiffDependencies = HarmonyDiffDependencies;
