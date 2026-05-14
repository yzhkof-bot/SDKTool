import type { SizeCategory } from './schema.js';

/**
 * HarmonyOS 敏感权限白名单（按场景大致分组）。
 *
 * 仅用于在报告中给敏感项打 `sensitive: true` 标，不做合规校验。
 * 列表可以随版本增补，对工具行为不构成 breaking change。
 */
export const SENSITIVE_PERMISSIONS: ReadonlySet<string> = new Set([
  // Location
  'ohos.permission.LOCATION',
  'ohos.permission.APPROXIMATELY_LOCATION',
  'ohos.permission.LOCATION_IN_BACKGROUND',
  // Camera & Microphone
  'ohos.permission.CAMERA',
  'ohos.permission.MICROPHONE',
  // Contacts / Calendar / SMS
  'ohos.permission.READ_CONTACTS',
  'ohos.permission.WRITE_CONTACTS',
  'ohos.permission.READ_CALENDAR',
  'ohos.permission.WRITE_CALENDAR',
  'ohos.permission.READ_MESSAGES',
  'ohos.permission.RECEIVE_SMS',
  'ohos.permission.SEND_MESSAGES',
  // Storage / Media
  'ohos.permission.READ_MEDIA',
  'ohos.permission.WRITE_MEDIA',
  'ohos.permission.MEDIA_LOCATION',
  // Identifiers
  'ohos.permission.GET_NETWORK_INFO',
  'ohos.permission.GET_WIFI_INFO',
  'ohos.permission.READ_DEVICE_ID',
  // Telephony
  'ohos.permission.PLACE_CALL',
  'ohos.permission.ANSWER_CALL',
  'ohos.permission.READ_CALL_LOG',
  'ohos.permission.WRITE_CALL_LOG',
]);

/** 体积分析的目录归类规则（前缀匹配） */
export const SIZE_CATEGORY_RULES: ReadonlyArray<{
  prefix: string;
  category: SizeCategory;
}> = [
  { prefix: 'ets/', category: 'ets' },
  { prefix: 'resources/', category: 'resources' },
  { prefix: 'libs/', category: 'libs' },
  { prefix: 'META-INF/', category: 'signature' },
];

/** 体积分析的精确文件归类（顶层配置文件） */
export const SIZE_CONFIG_FILES: ReadonlySet<string> = new Set([
  'module.json',
  'module.json5',
  'config.json',
  'pack.info',
  'rawfile',
  'resources.index',
]);

/** 图片资源扩展名（小写） */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.ico',
]);

/** 媒体资源扩展名 */
export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp3',
  '.mp4',
  '.wav',
  '.ogg',
  '.m4a',
  '.aac',
  '.mov',
  '.avi',
]);

/** 默认 Top N 文件数量（体积分析） */
export const DEFAULT_TOP_FILES_LIMIT = 20;

/* ------------------------------------------------------------------ */
/* Rawfile（QTS / 游戏美术资源）启发式识别规则                          */
/* ------------------------------------------------------------------ */

/** rawfile 在 hap 内的根路径前缀 */
export const RAWFILE_PREFIX = 'resources/rawfile/';

/** Unity AssetBundle 后缀 */
export const ASSET_BUNDLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ab',
  '.bundle',
  '.unity3d',
]);

/** GPU 压缩纹理 / 容器格式后缀 */
export const TEXTURE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pvr',
  '.ktx',
  '.ktx2',
  '.astc',
  '.etc',
  '.etc2',
  '.dds',
  '.basis',
]);

/** AI / ML 推理模型后缀（鸿蒙游戏内常见的几种） */
export const AI_MODEL_EXTENSIONS: ReadonlySet<string> = new Set([
  '.dla', // 华为 NPU 模型
  '.nb', // 各种 NN baked
  '.nn', // 通用 NN 模型（Tencent / 自研）
  '.mnn',
  '.tflite',
  '.onnx',
  '.pb',
  '.tnn',
  '.ncnn',
  '.bnn', // bin neural net
  '.rknn', // Rockchip
]);

/** 脚本后缀 */
export const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.lua',
  '.js',
  '.ts',
  '.py',
  '.mjs',
  '.luac',
]);

/** 通用数据文件后缀（fallback "data" 类别） */
export const DATA_EXTENSIONS: ReadonlySet<string> = new Set([
  '.json',
  '.xml',
  '.yaml',
  '.yml',
  '.bin',
  '.dat',
  '.csv',
  '.txt',
  '.toml',
  '.ini',
  '.proto',
  '.pb',
  '.flatbuffers',
  '.fb',
]);

/**
 * 路径模式启发式：按命中顺序优先级递减。
 *
 * 第一个 test() 命中的规则决定 RawfileCategory。设计上有意把 il2cpp / AssetBundle
 * 这些"明确特征"放在通用扩展名（image/audio）前面，避免被错分。
 */
export interface RawfilePathRule {
  /** 仅做识别用途的描述，可在测试里检索 */
  id: string;
  test: (relPath: string, ext: string) => boolean;
  category:
    | 'il2cpp-metadata'
    | 'asset-bundle'
    | 'qts-vfs'
    | 'streaming-asset'
    | 'ai-model'
    | 'script'
    | 'texture'
    | 'image'
    | 'audio'
    | 'video'
    | 'data'
    | 'other';
}

/** 顶层分组：Data/* 路径取两段；其它取一段 */
export function rawfileTopLevelGroup(relPath: string): string {
  // relPath 是相对 'resources/rawfile/' 的路径，使用 / 分隔
  const parts = relPath.split('/');
  if (parts.length === 1) return '(root)';
  if (parts[0] === 'Data' && parts.length >= 2) {
    return `Data/${parts[1]}`;
  }
  return parts[0]!;
}

/**
 * Data/Package/(builtin|external|patch)/<id>/<id>_*.db 这类项目内 QTS VFS（虚拟文件系统）数据包。
 *
 * 这些 .db 不是 SQLite / 普通配置数据库，而是 King SDK / QTS 引擎自有的 VFS 容器，
 * 每个数值表 / 资源包对应一个目录 + 一个 .db 数据块。
 */
const QTS_VFS_PATTERN = /^Data\/Package\/(?:builtin|external|patch)\/[^/]+\/.+\.db$/;
const IL2CPP_METADATA_PATTERN = /^Data\/Managed\/(?:Metadata\/.+\.dat|.+\.dll)$/;
const STREAMING_ASSET_PATTERN = /^Data\/StreamingAssets\//;

/** 优先级从高到低的路径/扩展名分类规则 */
export const RAWFILE_RULES: ReadonlyArray<RawfilePathRule> = [
  // 路径强特征（必须在通用扩展名规则前面）
  {
    id: 'il2cpp-metadata',
    test: (p) => IL2CPP_METADATA_PATTERN.test(p),
    category: 'il2cpp-metadata',
  },
  {
    id: 'qts-vfs',
    test: (p) => QTS_VFS_PATTERN.test(p),
    category: 'qts-vfs',
  },
  {
    id: 'streaming-asset',
    test: (p) => STREAMING_ASSET_PATTERN.test(p),
    category: 'streaming-asset',
  },
  // 扩展名规则
  {
    id: 'asset-bundle',
    test: (_p, ext) => ASSET_BUNDLE_EXTENSIONS.has(ext),
    category: 'asset-bundle',
  },
  {
    id: 'ai-model',
    test: (_p, ext) => AI_MODEL_EXTENSIONS.has(ext),
    category: 'ai-model',
  },
  {
    id: 'texture',
    test: (_p, ext) => TEXTURE_EXTENSIONS.has(ext),
    category: 'texture',
  },
  {
    id: 'script',
    test: (_p, ext) => SCRIPT_EXTENSIONS.has(ext),
    category: 'script',
  },
  {
    id: 'image',
    test: (_p, ext) => IMAGE_EXTENSIONS.has(ext),
    category: 'image',
  },
  {
    id: 'audio',
    test: (_p, ext) => MEDIA_EXTENSIONS.has(ext) && /\.(mp3|wav|ogg|m4a|aac)$/i.test(ext),
    category: 'audio',
  },
  {
    id: 'video',
    test: (_p, ext) => MEDIA_EXTENSIONS.has(ext) && /\.(mp4|mov|avi|webm|mkv)$/i.test(ext),
    category: 'video',
  },
  {
    id: 'data',
    test: (_p, ext) => DATA_EXTENSIONS.has(ext),
    category: 'data',
  },
];

/** 提取 Data/Package/builtin/<id>/* 中的 <id>，命中返回 id；否则 null */
export function extractRawfilePackageId(relPath: string): string | null {
  const m = relPath.match(/^Data\/Package\/(?:builtin|external|patch)\/([^/]+)\//);
  return m ? m[1]! : null;
}
