import type { AndroidPermissionLevel, Platform, SizeCategory } from './schema.js';

/**
 * Android 权限保护等级清单（与官方 Manifest.permission 文档对齐）。
 *
 * 清单不必穷举（Android 已声明数百个权限），只覆盖应用最常见的：
 *   - 全部 dangerous（runtime）权限，让 sensitive 标记尽量准确
 *   - 几个最常见 normal 权限（INTERNET / NETWORK_STATE / WAKE_LOCK 等），
 *     让 viewer 在统计图上能给出清晰的 'normal' 计数
 *   - 少量 signature 级权限作为示例
 *
 * 未列出的权限 level=undefined → 视为 'unknown'，sensitive=false。
 * 不构成完整的 Android 权限百科；后续按需逐步补全。
 */
export const ANDROID_PERMISSION_LEVELS: Readonly<Record<string, AndroidPermissionLevel>> =
  Object.freeze({
    // ------ Calendar ------
    'android.permission.READ_CALENDAR': 'dangerous',
    'android.permission.WRITE_CALENDAR': 'dangerous',
    // ------ Call Log ------
    'android.permission.READ_CALL_LOG': 'dangerous',
    'android.permission.WRITE_CALL_LOG': 'dangerous',
    'android.permission.PROCESS_OUTGOING_CALLS': 'dangerous',
    // ------ Camera ------
    'android.permission.CAMERA': 'dangerous',
    // ------ Contacts ------
    'android.permission.READ_CONTACTS': 'dangerous',
    'android.permission.WRITE_CONTACTS': 'dangerous',
    'android.permission.GET_ACCOUNTS': 'dangerous',
    // ------ Location ------
    'android.permission.ACCESS_FINE_LOCATION': 'dangerous',
    'android.permission.ACCESS_COARSE_LOCATION': 'dangerous',
    'android.permission.ACCESS_BACKGROUND_LOCATION': 'dangerous',
    // ------ Microphone ------
    'android.permission.RECORD_AUDIO': 'dangerous',
    // ------ Phone ------
    'android.permission.READ_PHONE_STATE': 'dangerous',
    'android.permission.READ_PHONE_NUMBERS': 'dangerous',
    'android.permission.CALL_PHONE': 'dangerous',
    'android.permission.ANSWER_PHONE_CALLS': 'dangerous',
    'android.permission.ADD_VOICEMAIL': 'dangerous',
    'android.permission.USE_SIP': 'dangerous',
    'android.permission.ACCEPT_HANDOVER': 'dangerous',
    // ------ Sensors ------
    'android.permission.BODY_SENSORS': 'dangerous',
    'android.permission.BODY_SENSORS_BACKGROUND': 'dangerous',
    // ------ SMS ------
    'android.permission.SEND_SMS': 'dangerous',
    'android.permission.RECEIVE_SMS': 'dangerous',
    'android.permission.READ_SMS': 'dangerous',
    'android.permission.RECEIVE_WAP_PUSH': 'dangerous',
    'android.permission.RECEIVE_MMS': 'dangerous',
    // ------ Storage (legacy) ------
    'android.permission.READ_EXTERNAL_STORAGE': 'dangerous',
    'android.permission.WRITE_EXTERNAL_STORAGE': 'dangerous',
    // ------ Storage (Android 13+ split) ------
    'android.permission.READ_MEDIA_IMAGES': 'dangerous',
    'android.permission.READ_MEDIA_VIDEO': 'dangerous',
    'android.permission.READ_MEDIA_AUDIO': 'dangerous',
    'android.permission.READ_MEDIA_VISUAL_USER_SELECTED': 'dangerous',
    // ------ Activity Recognition ------
    'android.permission.ACTIVITY_RECOGNITION': 'dangerous',
    // ------ Notifications (Android 13+) ------
    'android.permission.POST_NOTIFICATIONS': 'dangerous',
    // ------ Nearby Devices (Android 12+) ------
    'android.permission.NEARBY_WIFI_DEVICES': 'dangerous',
    'android.permission.BLUETOOTH_SCAN': 'dangerous',
    'android.permission.BLUETOOTH_CONNECT': 'dangerous',
    'android.permission.BLUETOOTH_ADVERTISE': 'dangerous',
    // ------ 常见 normal ------
    'android.permission.INTERNET': 'normal',
    'android.permission.ACCESS_NETWORK_STATE': 'normal',
    'android.permission.ACCESS_WIFI_STATE': 'normal',
    'android.permission.CHANGE_WIFI_STATE': 'normal',
    'android.permission.WAKE_LOCK': 'normal',
    'android.permission.FOREGROUND_SERVICE': 'normal',
    'android.permission.VIBRATE': 'normal',
    'android.permission.RECEIVE_BOOT_COMPLETED': 'normal',
    'android.permission.SET_WALLPAPER': 'normal',
    'android.permission.MODIFY_AUDIO_SETTINGS': 'normal',
    'android.permission.BLUETOOTH': 'normal',
    'android.permission.BLUETOOTH_ADMIN': 'normal',
    'android.permission.NFC': 'normal',
    // ------ 常见 signature ------
    'android.permission.READ_VOICEMAIL': 'signature',
    'android.permission.WRITE_VOICEMAIL': 'signature',
    'android.permission.BIND_DEVICE_ADMIN': 'signature',
    'android.permission.BIND_ACCESSIBILITY_SERVICE': 'signature',
  });

/**
 * Android 敏感权限集合：所有 level==='dangerous' 的权限名。
 *
 * permission analyzer 用它给 PackagePermission.sensitive=true 打标。
 * 与 ANDROID_PERMISSION_LEVELS 保持唯一来源（自动派生，不必手动维护双份）。
 */
export const ANDROID_SENSITIVE_PERMISSIONS: ReadonlySet<string> = new Set(
  Object.entries(ANDROID_PERMISSION_LEVELS)
    .filter(([, level]) => level === 'dangerous')
    .map(([name]) => name),
);

/**
 * HarmonyOS 敏感权限白名单（按场景大致分组）。
 *
 * 仅用于在报告中给 sensitive: true 标，不做合规校验。
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

export interface SizeCategoryRule {
  prefix: string;
  category: SizeCategory;
}

/**
 * 体积分析的目录归类规则（前缀匹配，按数组顺序优先级递减）。
 *
 * 不同平台用不同前缀：
 *   - HarmonyOS: ets/ resources/ libs/ META-INF/
 *   - Android:   classes*.dex 分类靠 SIZE_CATEGORY_FILE_RULES，res/ assets/
 *                lib/ META-INF/ 走这里
 *   - iOS:      暂未实现
 *
 * 一旦命中前缀就停止。"config" 由 SIZE_CONFIG_FILES_BY_PLATFORM 在前缀都不命中
 * 时的兜底匹配。
 */
export const SIZE_CATEGORY_RULES_BY_PLATFORM: Readonly<Record<Platform, readonly SizeCategoryRule[]>> =
  Object.freeze({
    harmony: [
      { prefix: 'ets/', category: 'ets' },
      { prefix: 'resources/', category: 'resources' },
      { prefix: 'libs/', category: 'libs' },
      { prefix: 'META-INF/', category: 'signature' },
    ],
    android: [
      { prefix: 'res/', category: 'resources' },
      { prefix: 'assets/', category: 'assets' },
      { prefix: 'lib/', category: 'libs' },
      { prefix: 'META-INF/', category: 'signature' },
    ],
    ios: [],
  });

/**
 * @deprecated 用 {@link SIZE_CATEGORY_RULES_BY_PLATFORM}.harmony；保留这个名字
 * 让已有 import 不破坏。
 */
export const SIZE_CATEGORY_RULES: readonly SizeCategoryRule[] =
  SIZE_CATEGORY_RULES_BY_PLATFORM.harmony;

/**
 * 顶层精确文件归类（按平台）。
 *
 * Android 没有"顶层配置文件"概念，所有 manifest 类信息都在 AndroidManifest.xml
 * （二进制），算 'other'；这里只声明 classes*.dex 一类。
 */
export const SIZE_CONFIG_FILES_BY_PLATFORM: Readonly<Record<Platform, ReadonlySet<string>>> =
  Object.freeze({
    harmony: new Set([
      'module.json',
      'module.json5',
      'config.json',
      'pack.info',
      'rawfile',
      'resources.index',
    ]),
    android: new Set<string>(),
    ios: new Set<string>(),
  });

/**
 * @deprecated 用 {@link SIZE_CONFIG_FILES_BY_PLATFORM}.harmony；保留旧名兼容。
 */
export const SIZE_CONFIG_FILES: ReadonlySet<string> =
  SIZE_CONFIG_FILES_BY_PLATFORM.harmony;

/**
 * Android 平台对"特定文件名"的额外分类规则（前缀规则之后兜底）。
 *  - classes*.dex / AndroidManifest.xml / resources.arsc 这些都不是普通配置。
 *
 * HarmonyOS 走 SIZE_CONFIG_FILES_BY_PLATFORM.harmony 那条路径，不进这里。
 */
export const ANDROID_SPECIAL_FILE_CATEGORY: ReadonlyArray<{
  test: (path: string) => boolean;
  category: SizeCategory;
}> = [
  { test: (p) => /^classes\d*\.dex$/.test(p), category: 'dex' },
  { test: (p) => p === 'AndroidManifest.xml', category: 'config' },
  { test: (p) => p === 'resources.arsc', category: 'config' },
];

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
