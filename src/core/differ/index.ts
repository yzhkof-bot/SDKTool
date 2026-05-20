/**
 * Differ：消费两份 PackageReport，产出 PackageDiffReport。
 *
 * 设计原则：
 *  1. **纯函数**：不读文件、不依赖 hap/zip，只看入参 JSON 结构，方便单测与异步管道复用。
 *  2. **侧未填充则跳过该维度**：例如双方都没有 abc 维度时，diff 输出里就不会出现 abc 字段。
 *  3. **全量数据**：files / nativeLibs / dependencies 等全部输出 added/removed/changed 的全集，
 *     不在 differ 内做截断；展示侧（CLI/HTML）才决定 Top N。
 *  4. **稳定排序**：所有 added/removed/changed 列表都按 |delta| 或 bytes desc 排序，便于直接看头部。
 */

import { SCHEMA_VERSION } from '../../shared/schema.js';
import type {
  ApkSignatureBlockEntry,
  ApkSigningBlock,
  DeltaNumber,
  DexDetailEntry,
  DexDetailsInfo,
  DexFileSummary,
  DexInfo,
  DexMethodEntry,
  DexStrings,
  DiffApkSignatureVersionFlag,
  DiffApkSignatureVersions,
  DiffApkSigningBlock,
  DiffApkSigningBlockEntryChanged,
  DiffDex,
  DiffDexDetailEntry,
  DiffDexDetails,
  DiffDexFileChanged,
  DiffDexFileSide,
  DiffDexMethodChanged,
  DiffDexMethodSide,
  DiffDexMethods,
  DiffDexStrings,
  HarmonyAbcDetailsInfo,
  HarmonyAbcInfo,
  HarmonyAbcStrings,
  PackageBasicInfo,
  HarmonyDependenciesInfo,
  HarmonyDiffAbc,
  HarmonyDiffAbcDetailEntry,
  HarmonyDiffAbcDetails,
  HarmonyDiffAbcStringSet,
  HarmonyDiffAbcStrings,
  PackageDiffBasicChange,
  HarmonyDiffDependencies,
  PackageDiffFiles,
  DiffIl2cppLiterals,
  DiffIl2cppMetadata,
  DiffIl2cppMetadataEntry,
  DiffIl2cppNames,
  DiffNativeLibBuildInfo,
  DiffNativeLibMitigations,
  DiffNativeLibRodataStrings,
  DiffNativeLibSectionItem,
  DiffNativeLibSections,
  DiffNativeLibSymbols,
  DiffNativeLibSymbolsItem,
  DiffNativeLibs,
  PackageDiffPermissions,
  HarmonyDiffRawfile,
  PackageDiffReport,
  PackageDiffResources,
  PackageDiffSide,
  PackageDiffSignature,
  PackageDiffSize,
  DiffStringSet,
  PackageDiffSummary,
  DiffSymbolChanged,
  PackageFileEntry,
  Il2cppLiterals,
  Il2cppMetadata,
  Il2cppMetadataInfo,
  Il2cppNames,
  NativeLib,
  NativeLibMitigations,
  NativeLibRodataStrings,
  NativeLibSection,
  NativeLibSymbols,
  NativeLibSymbolsInfo,
  NativeLibsInfo,
  NativeSymbol,
  PackagePermission,
  HarmonyRawfileInfo,
  PackageReport,
  PackageResources,
  PackageSignatureInfo,
  PackageSizeInfo,
  RawfileCategory,
  ReportWarning,
  SizeCategory,
} from '../../shared/schema.js';

import { keyBy, listDiff, numberDelta } from './utils.js';

export interface DiffOptions {
  /** 工具版本，写到 diff.toolVersion；不传则取 left/right meta 中较新的 */
  toolVersion?: string;
  /** 生成时间，调试用；不传走 new Date().toISOString() */
  generatedAt?: string;
}

/**
 * Diff 入口：对比两份 PackageReport，产出 PackageDiffReport。
 *
 * 调用方必须保证两侧 platform 一致；本函数不做平台校验，由 CLI / workbench
 * runner 在更外层拦截（两个不同平台的包对比目前没有意义）。
 */
export function diffPackageReports(
  left: PackageReport,
  right: PackageReport,
  options: DiffOptions = {},
): PackageDiffReport {
  const warnings: ReportWarning[] = [];

  const sideLeft: PackageDiffSide = { meta: left.meta, basic: left.basic };
  const sideRight: PackageDiffSide = { meta: right.meta, basic: right.basic };

  const basicChanges = diffBasic(left.basic, right.basic);
  const size = diffSize(left.size, right.size);
  const files = diffFiles(left.files, right.files, warnings);
  const permissions = diffPermissions(left.permissions, right.permissions);
  const resources = diffResources(left.resources, right.resources);
  const rawfile = diffRawfile(left.rawfile, right.rawfile);
  const nativeLibs = diffNativeLibs(left.nativeLibs, right.nativeLibs);
  const abc = diffAbc(left.abc, right.abc);
  const nativeLibSymbols = diffNativeLibSymbols(left.nativeLibSymbols, right.nativeLibSymbols);
  const abcDetails = diffAbcDetails(left.abcDetails, right.abcDetails);
  const il2cppMetadata = diffIl2cppMetadata(left.il2cppMetadata, right.il2cppMetadata);
  const dex = diffDex(left.dex, right.dex);
  const dexDetails = diffDexDetails(left.dexDetails, right.dexDetails);
  const signature = diffSignature(left.signature, right.signature);
  const dependencies = diffDependencies(left.dependencies, right.dependencies);

  const summary = buildSummary({
    left,
    right,
    size,
    files,
    permissions,
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    toolVersion: options.toolVersion ?? newer(left.meta.toolVersion, right.meta.toolVersion),
    left: sideLeft,
    right: sideRight,
    summary,
    ...(basicChanges ? { basic: { changed: basicChanges } } : {}),
    ...(size ? { size } : {}),
    ...(files ? { files } : {}),
    ...(permissions ? { permissions } : {}),
    ...(resources ? { resources } : {}),
    ...(rawfile ? { rawfile } : {}),
    ...(nativeLibs ? { nativeLibs } : {}),
    ...(abc ? { abc } : {}),
    ...(nativeLibSymbols ? { nativeLibSymbols } : {}),
    ...(abcDetails ? { abcDetails } : {}),
    ...(il2cppMetadata ? { il2cppMetadata } : {}),
    ...(dex ? { dex } : {}),
    ...(dexDetails ? { dexDetails } : {}),
    ...(signature ? { signature } : {}),
    ...(dependencies ? { dependencies } : {}),
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* basic                                                                       */
/* -------------------------------------------------------------------------- */

const BASIC_FIELDS: ReadonlyArray<keyof PackageBasicInfo> = [
  'bundleName',
  'bundleType',
  'versionCode',
  'versionName',
  'moduleName',
  'moduleType',
  'targetAPIVersion',
  'minAPIVersion',
  'deviceTypes',
];

function diffBasic(
  left?: PackageBasicInfo,
  right?: PackageBasicInfo,
): PackageDiffBasicChange[] | undefined {
  if (!left && !right) return undefined;
  const changed: PackageDiffBasicChange[] = [];
  for (const field of BASIC_FIELDS) {
    const a = left?.[field];
    const b = right?.[field];
    if (!shallowEqual(a, b)) {
      changed.push({ field, from: a, to: b });
    }
  }
  // abilities：只比较 name 集合
  const aAbilities = (left?.abilities ?? []).map((x) => x.name).sort();
  const bAbilities = (right?.abilities ?? []).map((x) => x.name).sort();
  if (!shallowEqual(aAbilities, bAbilities)) {
    changed.push({ field: 'abilities', from: aAbilities, to: bAbilities });
  }
  return changed;
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* size                                                                        */
/* -------------------------------------------------------------------------- */

function diffSize(left?: PackageSizeInfo, right?: PackageSizeInfo): PackageDiffSize | undefined {
  if (!left && !right) return undefined;
  const lTotal = left?.total ?? 0;
  const rTotal = right?.total ?? 0;
  const lCompressed = left?.compressed ?? 0;
  const rCompressed = right?.compressed ?? 0;
  const lCount = left?.fileCount ?? 0;
  const rCount = right?.fileCount ?? 0;

  const cats = new Set<SizeCategory>();
  for (const it of left?.breakdown ?? []) cats.add(it.category);
  for (const it of right?.breakdown ?? []) cats.add(it.category);
  const lMap = keyBy(left?.breakdown ?? [], (x) => x.category);
  const rMap = keyBy(right?.breakdown ?? [], (x) => x.category);

  const breakdown = [...cats].map((category) => {
    const fromBytes = lMap.get(category)?.bytes ?? 0;
    const toBytes = rMap.get(category)?.bytes ?? 0;
    const delta = toBytes - fromBytes;
    const ratio = fromBytes === 0 ? (toBytes === 0 ? 0 : null) : delta / fromBytes;
    return { category, fromBytes, toBytes, delta, ratio };
  });
  breakdown.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    total: numberDelta(lTotal, rTotal),
    compressed: numberDelta(lCompressed, rCompressed),
    fileCount: numberDelta(lCount, rCount),
    breakdown,
  };
}

/* -------------------------------------------------------------------------- */
/* files                                                                       */
/* -------------------------------------------------------------------------- */

function diffFiles(
  left?: PackageFileEntry[],
  right?: PackageFileEntry[],
  warnings?: ReportWarning[],
): PackageDiffFiles | undefined {
  if (!left && !right) return undefined;
  if (!left || !right) {
    warnings?.push({
      code: 'DIFF_FILES_MISSING_SIDE',
      level: 'warn',
      message: '一侧报告未包含完整 files 列表，逐文件 diff 跳过',
      source: 'differ',
    });
    return undefined;
  }
  const lMap = keyBy(left, (f) => f.path);
  const rMap = keyBy(right, (f) => f.path);

  const added: PackageDiffFiles['added'] = [];
  const removed: PackageDiffFiles['removed'] = [];
  const changed: PackageDiffFiles['changed'] = [];
  let unchanged = 0;

  for (const f of right) {
    const prev = lMap.get(f.path);
    if (!prev) {
      added.push({ path: f.path, bytes: f.bytes, category: f.category });
    } else if (prev.bytes !== f.bytes || (prev.crc !== undefined && f.crc !== undefined && prev.crc !== f.crc)) {
      changed.push({
        path: f.path,
        fromBytes: prev.bytes,
        toBytes: f.bytes,
        delta: f.bytes - prev.bytes,
        category: f.category,
      });
    } else {
      unchanged += 1;
    }
  }
  for (const f of left) {
    if (!rMap.has(f.path)) {
      removed.push({ path: f.path, bytes: f.bytes, category: f.category });
    }
  }

  added.sort((a, b) => b.bytes - a.bytes);
  removed.sort((a, b) => b.bytes - a.bytes);
  changed.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    added,
    removed,
    changed,
    totals: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* permissions                                                                 */
/* -------------------------------------------------------------------------- */

function diffPermissions(
  left?: PackagePermission[],
  right?: PackagePermission[],
): PackageDiffPermissions | undefined {
  if (!left && !right) return undefined;
  const l = left ?? [];
  const r = right ?? [];
  const lMap = keyBy(l, (p) => p.name);
  const rMap = keyBy(r, (p) => p.name);
  const added: PackagePermission[] = [];
  const removed: PackagePermission[] = [];
  let unchanged = 0;
  for (const p of r) {
    if (!lMap.has(p.name)) added.push(p);
    else unchanged += 1;
  }
  for (const p of l) {
    if (!rMap.has(p.name)) removed.push(p);
  }
  added.sort(sortBySensitive);
  removed.sort(sortBySensitive);
  return { added, removed, unchanged };
}

function sortBySensitive(a: PackagePermission, b: PackagePermission): number {
  if (a.sensitive !== b.sensitive) return a.sensitive ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/* -------------------------------------------------------------------------- */
/* resources                                                                   */
/* -------------------------------------------------------------------------- */

function diffResources(
  left?: PackageResources,
  right?: PackageResources,
): PackageDiffResources | undefined {
  if (!left && !right) return undefined;
  const lImg = left?.images ?? { count: 0, bytes: 0, topLargest: [] };
  const rImg = right?.images ?? { count: 0, bytes: 0, topLargest: [] };
  const lStr = left?.strings ?? { count: 0, locales: [] };
  const rStr = right?.strings ?? { count: 0, locales: [] };
  const lMed = left?.media ?? { count: 0, bytes: 0 };
  const rMed = right?.media ?? { count: 0, bytes: 0 };

  const localesDiff = listDiff(lStr.locales, rStr.locales);
  return {
    images: {
      count: numberDelta(lImg.count, rImg.count),
      bytes: numberDelta(lImg.bytes, rImg.bytes),
    },
    strings: {
      count: numberDelta(lStr.count, rStr.count),
      localesAdded: localesDiff.added,
      localesRemoved: localesDiff.removed,
    },
    media: {
      count: numberDelta(lMed.count, rMed.count),
      bytes: numberDelta(lMed.bytes, rMed.bytes),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* rawfile                                                                     */
/* -------------------------------------------------------------------------- */

function diffRawfile(
  left?: HarmonyRawfileInfo,
  right?: HarmonyRawfileInfo,
): HarmonyDiffRawfile | undefined {
  if (!left && !right) return undefined;
  const l = left ?? emptyRawfile();
  const r = right ?? emptyRawfile();

  const groupKeys = new Set<string>();
  for (const g of l.topLevelGroups) groupKeys.add(g.path);
  for (const g of r.topLevelGroups) groupKeys.add(g.path);
  const lG = keyBy(l.topLevelGroups, (g) => g.path);
  const rG = keyBy(r.topLevelGroups, (g) => g.path);
  const topLevelGroups = [...groupKeys].map((path) => {
    const a = lG.get(path);
    const b = rG.get(path);
    return {
      path,
      fromBytes: a?.bytes ?? 0,
      toBytes: b?.bytes ?? 0,
      delta: (b?.bytes ?? 0) - (a?.bytes ?? 0),
      fromCount: a?.fileCount ?? 0,
      toCount: b?.fileCount ?? 0,
    };
  });
  topLevelGroups.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const catKeys = new Set<RawfileCategory>();
  for (const c of l.categories) catKeys.add(c.category);
  for (const c of r.categories) catKeys.add(c.category);
  const lC = keyBy(l.categories, (c) => c.category);
  const rC = keyBy(r.categories, (c) => c.category);
  const categories = [...catKeys].map((category) => {
    const a = lC.get(category);
    const b = rC.get(category);
    return {
      category,
      fromBytes: a?.bytes ?? 0,
      toBytes: b?.bytes ?? 0,
      delta: (b?.bytes ?? 0) - (a?.bytes ?? 0),
      fromCount: a?.fileCount ?? 0,
      toCount: b?.fileCount ?? 0,
    };
  });
  categories.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  let packages: HarmonyDiffRawfile['packages'];
  if ((l.packages && l.packages.length > 0) || (r.packages && r.packages.length > 0)) {
    const ids = new Set<string>();
    for (const p of l.packages ?? []) ids.add(p.packageId);
    for (const p of r.packages ?? []) ids.add(p.packageId);
    const lP = keyBy(l.packages ?? [], (p) => p.packageId);
    const rP = keyBy(r.packages ?? [], (p) => p.packageId);
    packages = [...ids].map((packageId) => {
      const a = lP.get(packageId);
      const b = rP.get(packageId);
      return {
        packageId,
        fromBytes: a?.bytes ?? 0,
        toBytes: b?.bytes ?? 0,
        delta: (b?.bytes ?? 0) - (a?.bytes ?? 0),
        fromCount: a?.fileCount ?? 0,
        toCount: b?.fileCount ?? 0,
      };
    });
    packages.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  }

  return {
    fileCount: numberDelta(l.fileCount, r.fileCount),
    totalBytes: numberDelta(l.totalBytes, r.totalBytes),
    topLevelGroups,
    categories,
    ...(packages ? { packages } : {}),
  };
}

function emptyRawfile(): HarmonyRawfileInfo {
  return {
    fileCount: 0,
    totalBytes: 0,
    topLevelGroups: [],
    byExtension: [],
    categories: [],
    topFiles: [],
  };
}

/* -------------------------------------------------------------------------- */
/* nativeLibs                                                                  */
/* -------------------------------------------------------------------------- */

function libKey(l: NativeLib): string {
  return `${l.arch}/${l.name}`;
}

function diffNativeLibs(
  left?: NativeLibsInfo,
  right?: NativeLibsInfo,
): DiffNativeLibs | undefined {
  if (!left && !right) return undefined;
  const l = left ?? { architectures: [], libs: [], totalBytes: 0 };
  const r = right ?? { architectures: [], libs: [], totalBytes: 0 };

  const archDiff = listDiff(l.architectures, r.architectures);
  const lMap = keyBy(l.libs, libKey);
  const rMap = keyBy(r.libs, libKey);
  const added: NativeLib[] = [];
  const removed: NativeLib[] = [];
  const changed: DiffNativeLibs['changed'] = [];

  for (const lib of r.libs) {
    const prev = lMap.get(libKey(lib));
    if (!prev) added.push(lib);
    else if (prev.bytes !== lib.bytes) {
      changed.push({
        arch: lib.arch,
        name: lib.name,
        fromBytes: prev.bytes,
        toBytes: lib.bytes,
        delta: lib.bytes - prev.bytes,
      });
    }
  }
  for (const lib of l.libs) {
    if (!rMap.has(libKey(lib))) removed.push(lib);
  }
  added.sort((a, b) => b.bytes - a.bytes);
  removed.sort((a, b) => b.bytes - a.bytes);
  changed.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    architectures: { added: archDiff.added, removed: archDiff.removed },
    totalBytes: numberDelta(l.totalBytes, r.totalBytes),
    added,
    removed,
    changed,
  };
}

/* -------------------------------------------------------------------------- */
/* abc                                                                         */
/* -------------------------------------------------------------------------- */

function diffAbc(left?: HarmonyAbcInfo, right?: HarmonyAbcInfo): HarmonyDiffAbc | undefined {
  if (!left && !right) return undefined;
  const l = left ?? { extraAbcFiles: [] };
  const r = right ?? { extraAbcFiles: [] };

  const fromBytes = l.modulesAbc?.bytes ?? null;
  const toBytes = r.modulesAbc?.bytes ?? null;
  const delta = fromBytes !== null && toBytes !== null ? toBytes - fromBytes : null;
  const fromHasMap = !!l.modulesAbc?.hasSourceMap;
  const toHasMap = !!r.modulesAbc?.hasSourceMap;

  const lMap = keyBy(l.extraAbcFiles, (x) => x.path);
  const rMap = keyBy(r.extraAbcFiles, (x) => x.path);
  const added: HarmonyDiffAbc['extra']['added'] = [];
  const removed: HarmonyDiffAbc['extra']['removed'] = [];
  const changed: HarmonyDiffAbc['extra']['changed'] = [];
  for (const f of r.extraAbcFiles) {
    const prev = lMap.get(f.path);
    if (!prev) added.push({ path: f.path, bytes: f.bytes });
    else if (prev.bytes !== f.bytes) {
      changed.push({
        path: f.path,
        fromBytes: prev.bytes,
        toBytes: f.bytes,
        delta: f.bytes - prev.bytes,
      });
    }
  }
  for (const f of l.extraAbcFiles) {
    if (!rMap.has(f.path)) removed.push({ path: f.path, bytes: f.bytes });
  }
  added.sort((a, b) => b.bytes - a.bytes);
  removed.sort((a, b) => b.bytes - a.bytes);
  changed.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    modulesAbc: {
      fromBytes,
      toBytes,
      delta,
      sourceMapChanged: fromHasMap !== toHasMap,
    },
    extra: { added, removed, changed },
  };
}

/* -------------------------------------------------------------------------- */
/* nativeLibSymbols（可选深度差异）                                             */
/* -------------------------------------------------------------------------- */

function symbolKey(s: NativeSymbol): string {
  // imported 不同的同名符号视为不同（一个是 dlsym 进来的、一个是自己导出的）
  return `${s.name}\u0001${s.imported ? 'U' : 'D'}`;
}

/**
 * 判定一对同名符号的"函数体"是否变化：
 *   - 两侧都有 codeSha256：严格 string 比较 → true/false
 *   - 任一侧缺 codeSha256：无法判断 → null
 *   - 两侧都没 codeSha256：analyzer 未开启 hash → undefined（DiffSymbolChanged.bodyChanged 字段不出现）
 */
function computeSymbolBodyChanged(
  left: string | undefined,
  right: string | undefined,
): boolean | null | undefined {
  if (left !== undefined && right !== undefined) return left !== right;
  if (left === undefined && right === undefined) return undefined;
  return null;
}

function diffOneLib(
  left: NativeLibSymbols | undefined,
  right: NativeLibSymbols | undefined,
  key: { arch: string; name: string },
): DiffNativeLibSymbolsItem {
  const lSyms = left?.symbols ?? [];
  const rSyms = right?.symbols ?? [];
  const lMap = keyBy(lSyms, symbolKey);
  const rMap = keyBy(rSyms, symbolKey);

  const added: NativeSymbol[] = [];
  const removed: NativeSymbol[] = [];
  const changed: DiffSymbolChanged[] = [];
  let unchanged = 0;

  for (const s of rSyms) {
    const k = symbolKey(s);
    const prev = lMap.get(k);
    if (!prev) {
      added.push(s);
      continue;
    }
    const bodyChanged = computeSymbolBodyChanged(prev.codeSha256, s.codeSha256);
    const sizeChanged = prev.size !== s.size;
    if (sizeChanged || bodyChanged === true) {
      changed.push({
        name: s.name,
        fromSize: prev.size,
        toSize: s.size,
        delta: s.size - prev.size,
        bind: s.bind,
        type: s.type,
        imported: s.imported,
        ...(bodyChanged === undefined ? {} : { bodyChanged }),
        ...(prev.codeSha256 ? { fromCodeSha256: prev.codeSha256 } : {}),
        ...(s.codeSha256 ? { toCodeSha256: s.codeSha256 } : {}),
      });
    } else {
      unchanged += 1;
    }
  }
  for (const s of lSyms) {
    if (!rMap.has(symbolKey(s))) removed.push(s);
  }

  added.sort((a, b) => (b.size - a.size) || a.name.localeCompare(b.name));
  removed.sort((a, b) => (b.size - a.size) || a.name.localeCompare(b.name));
  changed.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const sectionsDiff = diffNativeLibSections(left?.sections, right?.sections);
  const neededDiff = diffStringSetIfAny(left?.needed, right?.needed);
  const mitigationsDiff = diffNativeLibMitigations(left?.mitigations, right?.mitigations);
  const glibcDiff = diffStringSetIfAny(left?.glibcVersions, right?.glibcVersions);
  const rodataDiff = diffNativeLibRodataStrings(left?.rodataStrings, right?.rodataStrings);
  const buildInfoDiff = diffNativeLibBuildInfo(left, right);

  return {
    arch: key.arch,
    name: key.name,
    fromMissing: !left,
    toMissing: !right,
    added,
    removed,
    changed,
    totals: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged,
    },
    ...(sectionsDiff ? { sectionsDiff } : {}),
    ...(neededDiff ? { neededDiff } : {}),
    ...(mitigationsDiff ? { mitigationsDiff } : {}),
    ...(glibcDiff ? { glibcDiff } : {}),
    ...(rodataDiff ? { rodataDiff } : {}),
    ...(buildInfoDiff ? { buildInfoDiff } : {}),
  };
}

/* ----- sections diff ----- */
function diffNativeLibSections(
  left?: NativeLibSection[],
  right?: NativeLibSection[],
): DiffNativeLibSections | undefined {
  if (!left && !right) return undefined;
  const l = left ?? [];
  const r = right ?? [];
  const lMap = keyBy(l, (s) => s.name);
  const rMap = keyBy(r, (s) => s.name);
  const added: DiffNativeLibSectionItem[] = [];
  const removed: DiffNativeLibSectionItem[] = [];
  const changed: DiffNativeLibSectionItem[] = [];
  for (const s of r) {
    const prev = lMap.get(s.name);
    if (!prev) {
      added.push({ name: s.name, fromSize: 0, toSize: s.size, delta: s.size });
    } else if (prev.size !== s.size) {
      changed.push({ name: s.name, fromSize: prev.size, toSize: s.size, delta: s.size - prev.size });
    }
  }
  for (const s of l) {
    if (!rMap.has(s.name)) {
      removed.push({ name: s.name, fromSize: s.size, toSize: 0, delta: -s.size });
    }
  }
  added.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  removed.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  changed.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const anyChanged = added.length + removed.length + changed.length > 0;
  return { added, removed, changed, anyChanged };
}

/* ----- mitigations diff ----- */
function diffNativeLibMitigations(
  left?: NativeLibMitigations,
  right?: NativeLibMitigations,
): DiffNativeLibMitigations | undefined {
  if (!left && !right) return undefined;
  const l = left ?? defaultMitigations();
  const r = right ?? defaultMitigations();
  const flag = (a: boolean, b: boolean) => ({ from: a, to: b, changed: a !== b });
  const nx = flag(l.nx, r.nx);
  const pie = flag(l.pie, r.pie);
  const stackCanary = flag(l.stackCanary, r.stackCanary);
  const fortify = flag(l.fortify, r.fortify);
  const relro = { from: l.relro, to: r.relro, changed: l.relro !== r.relro };
  const anyChanged =
    nx.changed || pie.changed || stackCanary.changed || fortify.changed || relro.changed;
  return { nx, relro, pie, stackCanary, fortify, anyChanged };
}

function defaultMitigations(): NativeLibMitigations {
  return { nx: false, relro: 'none', pie: false, stackCanary: false, fortify: false };
}

/* ----- rodata strings diff ----- */
function diffNativeLibRodataStrings(
  left?: NativeLibRodataStrings,
  right?: NativeLibRodataStrings,
): DiffNativeLibRodataStrings | undefined {
  if (!left && !right) return undefined;
  const urls = diffStringSet(left?.urls, right?.urls);
  const paths = diffStringSet(left?.paths, right?.paths);
  const sqlLike = diffStringSet(left?.sqlLike, right?.sqlLike);
  const other = diffStringSet(left?.other, right?.other);
  const anyChanged =
    urls.added.length + urls.removed.length > 0 ||
    paths.added.length + paths.removed.length > 0 ||
    sqlLike.added.length + sqlLike.removed.length > 0 ||
    other.added.length + other.removed.length > 0;
  return { urls, paths, sqlLike, other, anyChanged };
}

/* ----- build-info diff ----- */
function diffNativeLibBuildInfo(
  left: NativeLibSymbols | undefined,
  right: NativeLibSymbols | undefined,
): DiffNativeLibBuildInfo | undefined {
  const fromBuildId = left?.buildId;
  const toBuildId = right?.buildId;
  const fromComment = left?.comment;
  const toComment = right?.comment;
  // 双侧都没就跳过
  if (
    fromBuildId === undefined &&
    toBuildId === undefined &&
    fromComment === undefined &&
    toComment === undefined
  ) {
    return undefined;
  }
  const buildIdChanged = (fromBuildId ?? '') !== (toBuildId ?? '');
  const commentChanged = (fromComment ?? '') !== (toComment ?? '');
  return {
    ...(fromBuildId !== undefined ? { fromBuildId } : {}),
    ...(toBuildId !== undefined ? { toBuildId } : {}),
    buildIdChanged,
    ...(fromComment !== undefined ? { fromComment } : {}),
    ...(toComment !== undefined ? { toComment } : {}),
    commentChanged,
    anyChanged: buildIdChanged || commentChanged,
  };
}

/** 仅当任一侧非空时返回 diff；否则返回 undefined */
function diffStringSetIfAny(left?: string[], right?: string[]): DiffStringSet | undefined {
  if ((left === undefined || left.length === 0) && (right === undefined || right.length === 0)) {
    return undefined;
  }
  return diffStringSet(left, right);
}

function diffNativeLibSymbols(
  left?: NativeLibSymbolsInfo,
  right?: NativeLibSymbolsInfo,
): DiffNativeLibSymbols | undefined {
  if (!left && !right) return undefined;

  // 以 (arch + name) 作 key 求并集
  const libKeyOf = (s: NativeLibSymbols) => `${s.arch}/${s.name}`;
  const lMap = keyBy(left?.perLib ?? [], libKeyOf);
  const rMap = keyBy(right?.perLib ?? [], libKeyOf);
  const allKeys = new Set<string>([...lMap.keys(), ...rMap.keys()]);

  const perLib: DiffNativeLibSymbolsItem[] = [];
  for (const k of allKeys) {
    const a = lMap.get(k);
    const b = rMap.get(k);
    const arch = (a ?? b)!.arch;
    const name = (a ?? b)!.name;
    perLib.push(diffOneLib(a, b, { arch, name }));
  }

  // 排序：变化总量大的（added+removed+changed）排前面
  perLib.sort((a, b) => {
    const sa = a.totals.added + a.totals.removed + a.totals.changed;
    const sb = b.totals.added + b.totals.removed + b.totals.changed;
    if (sa !== sb) return sb - sa;
    if (a.arch !== b.arch) return a.arch.localeCompare(b.arch);
    return a.name.localeCompare(b.name);
  });

  return { perLib, scanned: perLib.length };
}

/* -------------------------------------------------------------------------- */
/* abcDetails（可选深度差异）                                                  */
/* -------------------------------------------------------------------------- */

function diffAbcDetails(
  left?: HarmonyAbcDetailsInfo,
  right?: HarmonyAbcDetailsInfo,
): HarmonyDiffAbcDetails | undefined {
  if (!left && !right) return undefined;
  const lEntries = left?.entries ?? [];
  const rEntries = right?.entries ?? [];
  const lMap = keyBy(lEntries, (e) => e.path);
  const rMap = keyBy(rEntries, (e) => e.path);
  const allPaths = new Set<string>([...lMap.keys(), ...rMap.keys()]);

  const entries: HarmonyDiffAbcDetailEntry[] = [];
  let changedCount = 0;
  for (const path of allPaths) {
    const a = lMap.get(path);
    const b = rMap.get(path);
    const fromBytes = a ? a.bytes : null;
    const toBytes = b ? b.bytes : null;
    const fromSha256 = a ? (a.sha256 || null) : null;
    const toSha256 = b ? (b.sha256 || null) : null;
    const fromVersion = a ? a.version : null;
    const toVersion = b ? b.version : null;
    const fromNumClasses = a ? a.numClasses : null;
    const toNumClasses = b ? b.numClasses : null;

    // 任何字段不一致都标 changed；一侧不存在自动算 changed（abc 文件被新增/删除）
    const changed =
      !a ||
      !b ||
      fromBytes !== toBytes ||
      (!!fromSha256 && !!toSha256 && fromSha256 !== toSha256) ||
      fromVersion !== toVersion ||
      fromNumClasses !== toNumClasses;

    if (changed) changedCount += 1;
    const stringsDiff = diffAbcStrings(a?.strings, b?.strings);
    entries.push({
      path,
      fromBytes,
      toBytes,
      fromSha256,
      toSha256,
      fromVersion,
      toVersion,
      fromNumClasses,
      toNumClasses,
      changed,
      ...(stringsDiff ? { stringsDiff } : {}),
    });
  }

  // 排序：先 changed 在前；同组内按 path 升序
  entries.sort((a, b) => {
    if (a.changed !== b.changed) return a.changed ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return {
    entries,
    totals: { changed: changedCount, total: entries.length },
  };
}

function diffStringSet(left?: string[], right?: string[]): HarmonyDiffAbcStringSet {
  const l = new Set(left ?? []);
  const r = new Set(right ?? []);
  const added: string[] = [];
  const removed: string[] = [];
  let unchanged = 0;
  for (const s of r) {
    if (l.has(s)) unchanged += 1;
    else added.push(s);
  }
  for (const s of l) {
    if (!r.has(s)) removed.push(s);
  }
  added.sort();
  removed.sort();
  return { added, removed, unchanged };
}

function diffAbcStrings(
  left?: HarmonyAbcStrings,
  right?: HarmonyAbcStrings,
): HarmonyDiffAbcStrings | undefined {
  if (!left && !right) return undefined;
  // 一侧没有：仍然产出（缺失侧当空集），方便看到"新版本新增了所有这些类"的场景
  const classDescriptors = diffStringSet(left?.classDescriptors, right?.classDescriptors);
  const moduleRecords = diffStringSet(left?.moduleRecords, right?.moduleRecords);
  const sourceFiles = diffStringSet(left?.sourceFiles, right?.sourceFiles);
  const identifiers = diffStringSet(left?.identifiers, right?.identifiers);
  const anyChanged =
    classDescriptors.added.length + classDescriptors.removed.length > 0 ||
    moduleRecords.added.length + moduleRecords.removed.length > 0 ||
    sourceFiles.added.length + sourceFiles.removed.length > 0 ||
    identifiers.added.length + identifiers.removed.length > 0;
  return { classDescriptors, moduleRecords, sourceFiles, identifiers, anyChanged };
}

/* -------------------------------------------------------------------------- */
/* il2cppMetadata                                                              */
/* -------------------------------------------------------------------------- */

function diffIl2cppMetadata(
  left?: Il2cppMetadataInfo,
  right?: Il2cppMetadataInfo,
): DiffIl2cppMetadata | undefined {
  if (!left && !right) return undefined;
  const lFiles = left?.files ?? [];
  const rFiles = right?.files ?? [];
  const lMap = keyBy(lFiles, (e) => e.path);
  const rMap = keyBy(rFiles, (e) => e.path);
  const allPaths = new Set<string>([...lMap.keys(), ...rMap.keys()]);

  const entries: DiffIl2cppMetadataEntry[] = [];
  let changedCount = 0;
  for (const path of allPaths) {
    const a = lMap.get(path);
    const b = rMap.get(path);
    const fromBytes = a ? a.bytes : null;
    const toBytes = b ? b.bytes : null;
    const fromSha256 = a ? a.sha256 || null : null;
    const toSha256 = b ? b.sha256 || null : null;
    const fromMetadataVersion = a ? a.metadataVersion : null;
    const toMetadataVersion = b ? b.metadataVersion : null;
    const fromUnityVersionRange = a ? a.unityVersionRange : null;
    const toUnityVersionRange = b ? b.unityVersionRange : null;

    const namesDiff = diffIl2cppNames(a?.names, b?.names);
    const literalsDiff = diffIl2cppLiterals(a?.literals, b?.literals);

    const changed =
      !a ||
      !b ||
      fromBytes !== toBytes ||
      (!!fromSha256 && !!toSha256 && fromSha256 !== toSha256) ||
      fromMetadataVersion !== toMetadataVersion ||
      (namesDiff?.anyChanged ?? false) ||
      (literalsDiff?.anyChanged ?? false);

    if (changed) changedCount += 1;
    entries.push({
      path,
      fromBytes,
      toBytes,
      fromSha256,
      toSha256,
      fromMetadataVersion,
      toMetadataVersion,
      fromUnityVersionRange,
      toUnityVersionRange,
      changed,
      ...(namesDiff ? { namesDiff } : {}),
      ...(literalsDiff ? { literalsDiff } : {}),
    });
  }

  // changed 在前；同组按 path 升序
  entries.sort((a, b) => {
    if (a.changed !== b.changed) return a.changed ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return { entries, totals: { changed: changedCount, total: entries.length } };
}

function diffIl2cppNames(
  left?: Il2cppNames,
  right?: Il2cppNames,
): DiffIl2cppNames | undefined {
  if (!left && !right) return undefined;
  const typeNames = diffStringSet(left?.typeNames, right?.typeNames);
  const namespaces = diffStringSet(left?.namespaces, right?.namespaces);
  const identifiers = diffStringSet(left?.identifiers, right?.identifiers);
  const assemblies = diffStringSet(left?.assemblies, right?.assemblies);
  const other = diffStringSet(left?.other, right?.other);
  const anyChanged =
    typeNames.added.length + typeNames.removed.length > 0 ||
    namespaces.added.length + namespaces.removed.length > 0 ||
    identifiers.added.length + identifiers.removed.length > 0 ||
    assemblies.added.length + assemblies.removed.length > 0 ||
    other.added.length + other.removed.length > 0;
  return { typeNames, namespaces, identifiers, assemblies, other, anyChanged };
}

function diffIl2cppLiterals(
  left?: Il2cppLiterals,
  right?: Il2cppLiterals,
): DiffIl2cppLiterals | undefined {
  if (!left && !right) return undefined;
  const urls = diffStringSet(left?.urls, right?.urls);
  const paths = diffStringSet(left?.paths, right?.paths);
  const sqlLike = diffStringSet(left?.sqlLike, right?.sqlLike);
  const other = diffStringSet(left?.other, right?.other);
  const anyChanged =
    urls.added.length + urls.removed.length > 0 ||
    paths.added.length + paths.removed.length > 0 ||
    sqlLike.added.length + sqlLike.removed.length > 0 ||
    other.added.length + other.removed.length > 0;
  return { urls, paths, sqlLike, other, anyChanged };
}

/* -------------------------------------------------------------------------- */
/* signature                                                                   */
/* -------------------------------------------------------------------------- */

const SIGNATURE_FIELDS = ['subject', 'issuer', 'notBefore', 'notAfter'] as const;

function diffSignature(
  left?: PackageSignatureInfo,
  right?: PackageSignatureInfo,
): PackageDiffSignature | undefined {
  if (!left && !right) return undefined;
  const l = left ?? { present: false };
  const r = right ?? { present: false };
  const versions = diffSignatureVersions(l.versions, r.versions);
  const signingBlock = diffSigningBlock(l.signingBlock, r.signingBlock);
  return {
    fromPresent: l.present,
    toPresent: r.present,
    presentChanged: l.present !== r.present,
    fields: SIGNATURE_FIELDS.map((field) => {
      const a = l[field];
      const b = r[field];
      return { field, from: a, to: b, changed: a !== b };
    }),
    ...(versions ? { versions } : {}),
    ...(signingBlock ? { signingBlock } : {}),
  };
}

function flag(a: boolean, b: boolean): DiffApkSignatureVersionFlag {
  return { from: a, to: b, changed: a !== b };
}

function diffSignatureVersions(
  left?: PackageSignatureInfo['versions'],
  right?: PackageSignatureInfo['versions'],
): DiffApkSignatureVersions | undefined {
  if (!left && !right) return undefined;
  const blank = { v1: false, v2: false, v3: false, v31: false };
  const l = left ?? blank;
  const r = right ?? blank;
  const v1 = flag(l.v1, r.v1);
  const v2 = flag(l.v2, r.v2);
  const v3 = flag(l.v3, r.v3);
  const v31 = flag(l.v31, r.v31);
  return {
    v1,
    v2,
    v3,
    v31,
    anyChanged: v1.changed || v2.changed || v3.changed || v31.changed,
  };
}

function diffSigningBlock(
  left?: ApkSigningBlock,
  right?: ApkSigningBlock,
): DiffApkSigningBlock | undefined {
  if (!left && !right) return undefined;
  const fromTotalBytes = left ? left.totalBytes : null;
  const toTotalBytes = right ? right.totalBytes : null;
  const totalBytesDelta =
    fromTotalBytes !== null && toTotalBytes !== null ? toTotalBytes - fromTotalBytes : null;

  const lMap = keyBy(left?.entries ?? [], (e) => e.idHex);
  const rMap = keyBy(right?.entries ?? [], (e) => e.idHex);
  const added: ApkSignatureBlockEntry[] = [];
  const removed: ApkSignatureBlockEntry[] = [];
  const changedSizes: DiffApkSigningBlockEntryChanged[] = [];

  for (const e of right?.entries ?? []) {
    const prev = lMap.get(e.idHex);
    if (!prev) {
      added.push(e);
    } else if (prev.sizeBytes !== e.sizeBytes) {
      changedSizes.push({
        idHex: e.idHex,
        name: e.name,
        fromSize: prev.sizeBytes,
        toSize: e.sizeBytes,
        delta: e.sizeBytes - prev.sizeBytes,
      });
    }
  }
  for (const e of left?.entries ?? []) {
    if (!rMap.has(e.idHex)) removed.push(e);
  }

  added.sort((a, b) => a.idHex.localeCompare(b.idHex));
  removed.sort((a, b) => a.idHex.localeCompare(b.idHex));
  changedSizes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const anyChanged =
    (totalBytesDelta ?? 0) !== 0 ||
    added.length + removed.length + changedSizes.length > 0;

  return {
    fromTotalBytes,
    toTotalBytes,
    totalBytesDelta,
    added,
    removed,
    changedSizes,
    anyChanged,
  };
}

/* -------------------------------------------------------------------------- */
/* dex（Android default analyzer 产物 diff）                                    */
/* -------------------------------------------------------------------------- */

function dexFileSide(f: DexFileSummary): DiffDexFileSide {
  return {
    path: f.path,
    bytes: f.bytes,
    magic: f.magic,
    version: f.version,
  };
}

/** 两侧都有 dex 时减；任一侧解析失败（null）则 delta 也为 null */
function nullableDelta(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return b - a;
}

function diffDex(left?: DexInfo, right?: DexInfo): DiffDex | undefined {
  if (!left && !right) return undefined;
  const l = left ?? { fileCount: 0, totalBytes: 0, files: [] };
  const r = right ?? { fileCount: 0, totalBytes: 0, files: [] };

  const lMap = keyBy(l.files, (f) => f.path);
  const rMap = keyBy(r.files, (f) => f.path);

  const added: DiffDexFileSide[] = [];
  const removed: DiffDexFileSide[] = [];
  const changed: DiffDexFileChanged[] = [];

  for (const f of r.files) {
    const prev = lMap.get(f.path);
    if (!prev) {
      added.push(dexFileSide(f));
      continue;
    }
    const stringIdsDelta = nullableDelta(prev.stringIds, f.stringIds);
    const typeIdsDelta = nullableDelta(prev.typeIds, f.typeIds);
    const protoIdsDelta = nullableDelta(prev.protoIds, f.protoIds);
    const fieldIdsDelta = nullableDelta(prev.fieldIds, f.fieldIds);
    const methodIdsDelta = nullableDelta(prev.methodIds, f.methodIds);
    const classDefsDelta = nullableDelta(prev.classDefs, f.classDefs);
    const headerCountChanged =
      (stringIdsDelta ?? 0) !== 0 ||
      (typeIdsDelta ?? 0) !== 0 ||
      (protoIdsDelta ?? 0) !== 0 ||
      (fieldIdsDelta ?? 0) !== 0 ||
      (methodIdsDelta ?? 0) !== 0 ||
      (classDefsDelta ?? 0) !== 0;
    const isChanged =
      prev.bytes !== f.bytes ||
      prev.magic !== f.magic ||
      prev.version !== f.version ||
      headerCountChanged;
    if (isChanged) {
      changed.push({
        path: f.path,
        fromBytes: prev.bytes,
        toBytes: f.bytes,
        bytesDelta: f.bytes - prev.bytes,
        fromMagic: prev.magic,
        toMagic: f.magic,
        fromVersion: prev.version,
        toVersion: f.version,
        stringIdsDelta,
        typeIdsDelta,
        protoIdsDelta,
        fieldIdsDelta,
        methodIdsDelta,
        classDefsDelta,
        changed: true,
      });
    }
  }
  for (const f of l.files) {
    if (!rMap.has(f.path)) removed.push(dexFileSide(f));
  }

  added.sort((a, b) => b.bytes - a.bytes);
  removed.sort((a, b) => b.bytes - a.bytes);
  changed.sort((a, b) => Math.abs(b.bytesDelta) - Math.abs(a.bytesDelta));

  const sumIds = (files: DexFileSummary[], pick: (f: DexFileSummary) => number | null) =>
    files.reduce((acc, f) => acc + (pick(f) ?? 0), 0);

  return {
    added,
    removed,
    changed,
    totals: {
      fileCount: numberDelta(l.fileCount, r.fileCount),
      totalBytes: numberDelta(l.totalBytes, r.totalBytes),
      methodIdsCount: numberDelta(
        sumIds(l.files, (f) => f.methodIds),
        sumIds(r.files, (f) => f.methodIds),
      ),
      classDefsCount: numberDelta(
        sumIds(l.files, (f) => f.classDefs),
        sumIds(r.files, (f) => f.classDefs),
      ),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* dexDetails（字符串集合差异；9d 起将接 method-level）                          */
/* -------------------------------------------------------------------------- */

function diffDexDetails(
  left?: DexDetailsInfo,
  right?: DexDetailsInfo,
): DiffDexDetails | undefined {
  if (!left && !right) return undefined;
  const lEntries: DexDetailEntry[] = left?.entries ?? [];
  const rEntries: DexDetailEntry[] = right?.entries ?? [];
  const lMap = keyBy(lEntries, (e) => e.path);
  const rMap = keyBy(rEntries, (e) => e.path);
  const allPaths = new Set<string>([...lMap.keys(), ...rMap.keys()]);

  const entries: DiffDexDetailEntry[] = [];
  let changedCount = 0;
  let methodsAdded = 0;
  let methodsRemoved = 0;
  let methodsChanged = 0;

  for (const path of allPaths) {
    const a = lMap.get(path);
    const b = rMap.get(path);
    const fromBytes = a ? a.bytes : null;
    const toBytes = b ? b.bytes : null;
    const fromSha256 = a ? a.sha256 || null : null;
    const toSha256 = b ? b.sha256 || null : null;
    const sha256Changed =
      !!fromSha256 && !!toSha256 && fromSha256 !== toSha256;
    const changed = !a || !b || fromBytes !== toBytes || sha256Changed;
    if (changed) changedCount += 1;
    const stringsDiff = diffDexStrings(a?.strings, b?.strings);
    const methodsDiff = diffDexMethodsOfDex(a?.methods, b?.methods);
    if (methodsDiff) {
      methodsAdded += methodsDiff.totals.added;
      methodsRemoved += methodsDiff.totals.removed;
      methodsChanged += methodsDiff.totals.changed;
    }
    entries.push({
      path,
      fromBytes,
      toBytes,
      fromSha256,
      toSha256,
      changed,
      ...(stringsDiff ? { stringsDiff } : {}),
      ...(methodsDiff ? { methodsDiff } : {}),
    });
  }

  entries.sort((a, b) => {
    if (a.changed !== b.changed) return a.changed ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return {
    entries,
    totals: {
      changed: changedCount,
      total: entries.length,
      methodsAdded,
      methodsRemoved,
      methodsChanged,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* dex method-level diff（9d）                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 把一个 DexMethodEntry 压成 add/remove 列表项格式（剔除 differ 不关心的字段）。
 */
function methodSideOf(m: DexMethodEntry): DiffDexMethodSide {
  return {
    fullName: m.fullName,
    classDescriptor: m.classDescriptor,
    name: m.name,
    proto: m.proto,
    insnsSize: m.insnsSize,
  };
}

/**
 * 对单 dex 文件的方法集合做 diff：
 *   - 一侧 methods 字段缺失（dex 文件本身被新增/删除或未跑深度抽取） → undefined，
 *     由调用方决定是否填空 methodsDiff（一般空字段更友好）
 *   - fullName 作为方法主键（全 dex 唯一；同名 overload 已经在 proto 中区分）
 *   - 同 fullName 但 insnsSize / registers / accessFlags / insnsSha256 任一变化 → changed
 *
 * 排序：
 *   - added / removed：按 fullName 字典序
 *   - changed：按 |insnsSizeDelta| 降序；null delta 排在最后
 */
function diffDexMethodsOfDex(
  left?: DexMethodEntry[],
  right?: DexMethodEntry[],
): DiffDexMethods | undefined {
  if (!left && !right) return undefined;
  const l = left ?? [];
  const r = right ?? [];
  // 仅一侧有 methods 时也产出 diff（让 UI 能直接展示"新增/删除了所有方法"）
  // ；双侧都为 undefined 时上面已返回。
  const lMap = keyBy(l, (m) => m.fullName);
  const rMap = keyBy(r, (m) => m.fullName);

  const added: DiffDexMethodSide[] = [];
  const removed: DiffDexMethodSide[] = [];
  const changed: DiffDexMethodChanged[] = [];
  let unchanged = 0;

  for (const m of r) {
    const prev = lMap.get(m.fullName);
    if (!prev) {
      added.push(methodSideOf(m));
      continue;
    }
    const insnsSizeDelta = nullableDelta(prev.insnsSize, m.insnsSize);
    const accessFlagsChanged = prev.accessFlags !== m.accessFlags;
    const registersChanged = prev.registers !== m.registers;
    // bodyChanged：仅当两侧都有 sha256 才能判断；否则返回 null（待 hashBodies 开启后才有）
    let bodyChanged: boolean | null;
    if (prev.insnsSha256 !== null && m.insnsSha256 !== null) {
      bodyChanged = prev.insnsSha256 !== m.insnsSha256;
    } else {
      bodyChanged = null;
    }
    const sizeChanged = (insnsSizeDelta ?? 0) !== 0;
    if (sizeChanged || accessFlagsChanged || registersChanged || bodyChanged === true) {
      changed.push({
        fullName: m.fullName,
        classDescriptor: m.classDescriptor,
        name: m.name,
        proto: m.proto,
        fromInsnsSize: prev.insnsSize,
        toInsnsSize: m.insnsSize,
        insnsSizeDelta,
        fromRegisters: prev.registers,
        toRegisters: m.registers,
        fromAccessFlags: prev.accessFlags,
        toAccessFlags: m.accessFlags,
        accessFlagsChanged,
        bodyChanged,
      });
    } else {
      unchanged += 1;
    }
  }
  for (const m of l) {
    if (!rMap.has(m.fullName)) removed.push(methodSideOf(m));
  }

  added.sort((a, b) => a.fullName.localeCompare(b.fullName));
  removed.sort((a, b) => a.fullName.localeCompare(b.fullName));
  changed.sort((a, b) => {
    const da = a.insnsSizeDelta === null ? -1 : Math.abs(a.insnsSizeDelta);
    const db = b.insnsSizeDelta === null ? -1 : Math.abs(b.insnsSizeDelta);
    if (da !== db) return db - da;
    return a.fullName.localeCompare(b.fullName);
  });

  return {
    added,
    removed,
    changed,
    totals: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged,
    },
  };
}

function diffDexStrings(
  left?: DexStrings,
  right?: DexStrings,
): DiffDexStrings | undefined {
  if (!left && !right) return undefined;
  const classDescriptors = diffStringSet(left?.classDescriptors, right?.classDescriptors);
  const methodSignatures = diffStringSet(left?.methodSignatures, right?.methodSignatures);
  const sourceFiles = diffStringSet(left?.sourceFiles, right?.sourceFiles);
  const identifiers = diffStringSet(left?.identifiers, right?.identifiers);
  const other = diffStringSet(left?.other, right?.other);
  const anyChanged =
    classDescriptors.added.length + classDescriptors.removed.length > 0 ||
    methodSignatures.added.length + methodSignatures.removed.length > 0 ||
    sourceFiles.added.length + sourceFiles.removed.length > 0 ||
    identifiers.added.length + identifiers.removed.length > 0 ||
    other.added.length + other.removed.length > 0;
  return { classDescriptors, methodSignatures, sourceFiles, identifiers, other, anyChanged };
}

/* -------------------------------------------------------------------------- */
/* dependencies                                                                */
/* -------------------------------------------------------------------------- */

function diffDependencies(
  left?: HarmonyDependenciesInfo,
  right?: HarmonyDependenciesInfo,
): HarmonyDiffDependencies | undefined {
  if (!left && !right) return undefined;
  const l = left ?? { hsp: [], har: [] };
  const r = right ?? { hsp: [], har: [] };
  const hspDiff = listDiff(l.hsp, r.hsp);
  const harDiff = listDiff(l.har, r.har);
  return {
    hsp: { added: hspDiff.added, removed: hspDiff.removed },
    har: { added: harDiff.added, removed: harDiff.removed },
  };
}

/* -------------------------------------------------------------------------- */
/* summary                                                                     */
/* -------------------------------------------------------------------------- */

function buildSummary(args: {
  left: PackageReport;
  right: PackageReport;
  size?: PackageDiffSize;
  files?: PackageDiffFiles;
  permissions?: PackageDiffPermissions;
}): PackageDiffSummary {
  const totalSizeDelta = args.size?.total.delta ?? 0;
  const compressedDelta = args.size?.compressed.delta ?? 0;
  const fileCountDelta = args.size?.fileCount.delta ?? 0;
  const filesAdded = args.files?.totals.added ?? 0;
  const filesRemoved = args.files?.totals.removed ?? 0;
  const filesChanged = args.files?.totals.changed ?? 0;
  const permissionsAdded = args.permissions?.added.length ?? 0;
  const permissionsRemoved = args.permissions?.removed.length ?? 0;

  const versionLine = buildVersionLine(args.left.basic, args.right.basic);
  const identical =
    totalSizeDelta === 0 &&
    compressedDelta === 0 &&
    fileCountDelta === 0 &&
    filesAdded === 0 &&
    filesRemoved === 0 &&
    filesChanged === 0 &&
    permissionsAdded === 0 &&
    permissionsRemoved === 0;

  return {
    totalSizeDelta,
    compressedDelta,
    fileCountDelta,
    filesAdded,
    filesRemoved,
    filesChanged,
    permissionsAdded,
    permissionsRemoved,
    versionLine,
    identical,
  };
}

function buildVersionLine(l?: PackageBasicInfo, r?: PackageBasicInfo): string | undefined {
  if (!l && !r) return undefined;
  const fmt = (b?: PackageBasicInfo) =>
    b ? `${b.versionName ?? '?'} (${b.versionCode ?? '?'})` : '—';
  return `${fmt(l)} → ${fmt(r)}`;
}

function newer(a?: string, b?: string): string {
  if (!a) return b ?? 'unknown';
  if (!b) return a;
  return a >= b ? a : b;
}

/** 仅供测试断言用，避免外部直接 import 内部类型 */
export type { DeltaNumber };

/**
 * @deprecated 用 {@link diffPackageReports}。
 *
 * 历史 API 名字（一期 tool 只跑 .hap 时叫 diffHapReports）。alias 保留给外部
 * 调用者一个迁移窗口，行为与 diffPackageReports 完全一致。
 */
export const diffHapReports = diffPackageReports;
