import { describe, expect, it } from 'vitest';

import { diffPackageReports } from '@kingsdk/core/differ/index.js';
import { keyBy, listDiff, numberDelta } from '@kingsdk/core/differ/utils.js';
import { SCHEMA_VERSION } from '@kingsdk/shared/schema.js';
import type {
  DexDetailsInfo,
  DexInfo,
  HarmonyAbcInfo,
  PackageBasicInfo,
  HarmonyDependenciesInfo,
  PackageFileEntry,
  NativeLibsInfo,
  PackagePermission,
  HarmonyRawfileInfo,
  PackageReport,
  PackageResources,
  PackageSignatureInfo,
  PackageSizeInfo,
} from '@kingsdk/shared/schema.js';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function makeReport(overrides: Partial<PackageReport> = {}): PackageReport {
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      file: 'a.hap',
      fileSize: 100,
      sha256: 'a'.repeat(64),
      analyzedAt: '2026-05-09T00:00:00.000Z',
      toolVersion: '0.1.0',
      ...overrides.meta,
    },
    warnings: [],
    ...overrides,
  };
}

function basic(overrides: Partial<PackageBasicInfo> = {}): PackageBasicInfo {
  return {
    bundleName: 'com.kings.demo',
    versionCode: 100,
    versionName: '1.0.0',
    moduleName: 'entry',
    moduleType: 'entry',
    deviceTypes: ['phone'],
    abilities: [{ name: 'EntryAbility', type: 'page' }],
    ...overrides,
  };
}

function size(overrides: Partial<PackageSizeInfo> = {}): PackageSizeInfo {
  return {
    total: 1000,
    compressed: 500,
    fileCount: 10,
    breakdown: [
      { category: 'libs', bytes: 700, ratio: 0.7, fileCount: 4 },
      { category: 'resources', bytes: 200, ratio: 0.2, fileCount: 5 },
      { category: 'config', bytes: 100, ratio: 0.1, fileCount: 1 },
    ],
    topFiles: [],
    ...overrides,
  };
}

function files(arr: PackageFileEntry[]): PackageFileEntry[] {
  return arr;
}

/* -------------------------------------------------------------------------- */
/* utils                                                                       */
/* -------------------------------------------------------------------------- */

describe('differ/utils', () => {
  it('numberDelta：正常 from/to 计算 ratio', () => {
    expect(numberDelta(100, 150)).toEqual({ from: 100, to: 150, delta: 50, ratio: 0.5 });
    expect(numberDelta(200, 100)).toEqual({ from: 200, to: 100, delta: -100, ratio: -0.5 });
  });

  it('numberDelta：from=0 时 ratio 为 null（除非 to 也=0）', () => {
    expect(numberDelta(0, 100).ratio).toBeNull();
    expect(numberDelta(0, 0).ratio).toBe(0);
  });

  it('listDiff：保持原始顺序，正确分 added/removed/unchanged', () => {
    const r = listDiff(['a', 'b', 'c'], ['b', 'c', 'd', 'e']);
    expect(r.added).toEqual(['d', 'e']);
    expect(r.removed).toEqual(['a']);
    expect(r.unchanged).toEqual(['b', 'c']);
  });

  it('keyBy：后者覆盖前者', () => {
    const m = keyBy([{ k: '1', v: 1 }, { k: '2', v: 2 }, { k: '1', v: 99 }], (x) => x.k);
    expect(m.size).toBe(2);
    expect(m.get('1')!.v).toBe(99);
  });
});

/* -------------------------------------------------------------------------- */
/* diffPackageReports：顶层结构                                                     */
/* -------------------------------------------------------------------------- */

describe('diffPackageReports - 总体结构', () => {
  it('两侧完全相同时 summary.identical=true，且各维度 delta=0', () => {
    const a = makeReport({ basic: basic(), size: size(), files: [] });
    const b = makeReport({ basic: basic(), size: size(), files: [] });
    const d = diffPackageReports(a, b);

    expect(d.schemaVersion).toBe(SCHEMA_VERSION);
    expect(d.summary.identical).toBe(true);
    expect(d.summary.totalSizeDelta).toBe(0);
    expect(d.summary.fileCountDelta).toBe(0);
    expect(d.summary.filesAdded + d.summary.filesRemoved + d.summary.filesChanged).toBe(0);
    expect(d.size?.total.delta).toBe(0);
  });

  it('两侧都没有该维度时 diff 输出不出现该字段', () => {
    const a = makeReport();
    const b = makeReport();
    const d = diffPackageReports(a, b);
    expect(d.basic).toBeUndefined();
    expect(d.size).toBeUndefined();
    expect(d.permissions).toBeUndefined();
    expect(d.rawfile).toBeUndefined();
  });

  it('summary.versionLine 用 left → right 拼出版本号变化', () => {
    const a = makeReport({ basic: basic({ versionName: '1.0.0', versionCode: 100 }) });
    const b = makeReport({ basic: basic({ versionName: '1.1.0', versionCode: 110 }) });
    const d = diffPackageReports(a, b);
    expect(d.summary.versionLine).toBe('1.0.0 (100) → 1.1.0 (110)');
  });
});

/* -------------------------------------------------------------------------- */
/* basic                                                                       */
/* -------------------------------------------------------------------------- */

describe('diffPackageReports - basic', () => {
  it('版本号 / deviceTypes / abilities 变化都会被收集到 changed', () => {
    const a = makeReport({ basic: basic({ versionCode: 100, deviceTypes: ['phone'], abilities: [{ name: 'A' }] }) });
    const b = makeReport({
      basic: basic({ versionCode: 110, deviceTypes: ['phone', 'tablet'], abilities: [{ name: 'A' }, { name: 'B' }] }),
    });
    const d = diffPackageReports(a, b);
    expect(d.basic?.changed.map((c) => c.field)).toEqual(
      expect.arrayContaining(['versionCode', 'deviceTypes', 'abilities']),
    );
  });

  it('字段无变化时 changed 为空数组', () => {
    const a = makeReport({ basic: basic() });
    const b = makeReport({ basic: basic() });
    const d = diffPackageReports(a, b);
    expect(d.basic?.changed).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* size                                                                        */
/* -------------------------------------------------------------------------- */

describe('diffPackageReports - size', () => {
  it('breakdown 按 |delta| 降序排序', () => {
    const a = makeReport({ size: size({ breakdown: [
      { category: 'libs', bytes: 100, ratio: 0.5, fileCount: 1 },
      { category: 'resources', bytes: 100, ratio: 0.5, fileCount: 1 },
    ] }) });
    const b = makeReport({ size: size({ breakdown: [
      { category: 'libs', bytes: 1000, ratio: 0.9, fileCount: 1 },
      { category: 'resources', bytes: 110, ratio: 0.1, fileCount: 1 },
    ] }) });
    const d = diffPackageReports(a, b);
    expect(d.size?.breakdown[0]!.category).toBe('libs');
    expect(d.size?.breakdown[0]!.delta).toBe(900);
    expect(d.size?.breakdown[1]!.delta).toBe(10);
  });

  it('一侧缺失 category 时使用 0 兜底', () => {
    const a = makeReport({ size: size({ breakdown: [{ category: 'libs', bytes: 1000, ratio: 1, fileCount: 1 }] }) });
    const b = makeReport({ size: size({ breakdown: [
      { category: 'libs', bytes: 1000, ratio: 0.5, fileCount: 1 },
      { category: 'resources', bytes: 1000, ratio: 0.5, fileCount: 1 },
    ] }) });
    const d = diffPackageReports(a, b);
    const r = d.size?.breakdown.find((x) => x.category === 'resources');
    expect(r).toEqual(expect.objectContaining({ fromBytes: 0, toBytes: 1000, delta: 1000 }));
    expect(r?.ratio).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* files                                                                       */
/* -------------------------------------------------------------------------- */

describe('diffPackageReports - files', () => {
  it('正确切分 added/removed/changed/unchanged', () => {
    const a = makeReport({ files: files([
      { path: 'a.txt', bytes: 10, compressed: 10, category: 'other', crc: 1 },
      { path: 'b.txt', bytes: 20, compressed: 20, category: 'other', crc: 2 },
      { path: 'c.txt', bytes: 30, compressed: 30, category: 'other', crc: 3 },
    ]) });
    const b = makeReport({ files: files([
      { path: 'a.txt', bytes: 10, compressed: 10, category: 'other', crc: 1 }, // unchanged
      { path: 'b.txt', bytes: 25, compressed: 22, category: 'other', crc: 9 }, // changed (size+crc)
      { path: 'd.txt', bytes: 40, compressed: 40, category: 'other', crc: 4 }, // added
    ]) });
    const d = diffPackageReports(a, b);
    expect(d.files?.totals).toEqual({ added: 1, removed: 1, changed: 1, unchanged: 1 });
    expect(d.files?.added[0]!.path).toBe('d.txt');
    expect(d.files?.removed[0]!.path).toBe('c.txt');
    expect(d.files?.changed[0]!.path).toBe('b.txt');
    expect(d.files?.changed[0]!.delta).toBe(5);
  });

  it('size 相同但 crc 变化也判定为 changed', () => {
    const a = makeReport({ files: files([
      { path: 'x.bin', bytes: 100, compressed: 100, category: 'other', crc: 1 },
    ]) });
    const b = makeReport({ files: files([
      { path: 'x.bin', bytes: 100, compressed: 100, category: 'other', crc: 2 },
    ]) });
    const d = diffPackageReports(a, b);
    expect(d.files?.totals.changed).toBe(1);
    expect(d.files?.changed[0]!.delta).toBe(0);
  });

  it('缺失任一侧时跳过 files diff 并生成 warning', () => {
    const a = makeReport({ files: [] });
    const b = makeReport(); // no files
    const d = diffPackageReports(a, b);
    expect(d.files).toBeUndefined();
    expect(d.warnings.find((w) => w.code === 'DIFF_FILES_MISSING_SIDE')).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* permissions                                                                 */
/* -------------------------------------------------------------------------- */

describe('diffPackageReports - permissions', () => {
  it('added/removed 列表敏感项排在前面', () => {
    const a = makeReport({ permissions: <PackagePermission[]>[
      { name: 'ohos.permission.INTERNET', sensitive: false },
    ] });
    const b = makeReport({ permissions: <PackagePermission[]>[
      { name: 'ohos.permission.INTERNET', sensitive: false },
      { name: 'ohos.permission.READ_CONTACTS', sensitive: true },
      { name: 'ohos.permission.MICROPHONE', sensitive: true },
    ] });
    const d = diffPackageReports(a, b);
    expect(d.permissions?.added.length).toBe(2);
    expect(d.permissions?.added[0]!.sensitive).toBe(true);
    expect(d.permissions?.unchanged).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* resources / rawfile / abc / signature / dependencies / nativeLibs           */
/* -------------------------------------------------------------------------- */

describe('diffPackageReports - 其它维度 smoke', () => {
  it('resources：locale 集合差并入 strings.localesAdded/Removed', () => {
    const r1: PackageResources = {
      images: { count: 2, bytes: 2000, topLargest: [] },
      strings: { count: 3, locales: ['zh_CN', 'en_US'] },
      media: { count: 0, bytes: 0 },
    };
    const r2: PackageResources = {
      images: { count: 5, bytes: 5000, topLargest: [] },
      strings: { count: 4, locales: ['zh_CN', 'ja_JP'] },
      media: { count: 1, bytes: 1024 },
    };
    const d = diffPackageReports(makeReport({ resources: r1 }), makeReport({ resources: r2 }));
    expect(d.resources?.images.count.delta).toBe(3);
    expect(d.resources?.images.bytes.delta).toBe(3000);
    expect(d.resources?.strings.localesAdded).toEqual(['ja_JP']);
    expect(d.resources?.strings.localesRemoved).toEqual(['en_US']);
  });

  it('rawfile：fileCount/totalBytes/group/category 全输出', () => {
    const rf1: HarmonyRawfileInfo = {
      fileCount: 2,
      totalBytes: 1000,
      topLevelGroups: [{ path: 'Data/Package', bytes: 1000, fileCount: 2, ratio: 1 }],
      byExtension: [],
      categories: [{ category: 'qts-vfs', bytes: 1000, fileCount: 2, ratio: 1 }],
      topFiles: [],
    };
    const rf2: HarmonyRawfileInfo = {
      fileCount: 3,
      totalBytes: 2000,
      topLevelGroups: [{ path: 'Data/Package', bytes: 2000, fileCount: 3, ratio: 1 }],
      byExtension: [],
      categories: [{ category: 'qts-vfs', bytes: 2000, fileCount: 3, ratio: 1 }],
      topFiles: [],
    };
    const d = diffPackageReports(makeReport({ rawfile: rf1 }), makeReport({ rawfile: rf2 }));
    expect(d.rawfile?.fileCount.delta).toBe(1);
    expect(d.rawfile?.totalBytes.delta).toBe(1000);
    expect(d.rawfile?.topLevelGroups[0]!.delta).toBe(1000);
    expect(d.rawfile?.categories[0]!.category).toBe('qts-vfs');
  });

  it('nativeLibs：架构集合 + 库 added/removed/changed', () => {
    const n1: NativeLibsInfo = {
      architectures: ['arm64-v8a'],
      totalBytes: 1000,
      libs: [
        { arch: 'arm64-v8a', name: 'libfoo.so', bytes: 500 },
        { arch: 'arm64-v8a', name: 'libbar.so', bytes: 500 },
      ],
    };
    const n2: NativeLibsInfo = {
      architectures: ['arm64-v8a', 'x86_64'],
      totalBytes: 1100,
      libs: [
        { arch: 'arm64-v8a', name: 'libfoo.so', bytes: 600 }, // changed +100
        { arch: 'x86_64', name: 'libfoo.so', bytes: 500 }, // added
      ],
    };
    const d = diffPackageReports(makeReport({ nativeLibs: n1 }), makeReport({ nativeLibs: n2 }));
    expect(d.nativeLibs?.architectures.added).toEqual(['x86_64']);
    expect(d.nativeLibs?.added.length).toBe(1);
    expect(d.nativeLibs?.removed.length).toBe(1);
    expect(d.nativeLibs?.changed[0]!.delta).toBe(100);
  });

  it('abc：modulesAbc bytes 与 sourceMap 变化', () => {
    const a: HarmonyAbcInfo = { modulesAbc: { bytes: 1000, hasSourceMap: false }, extraAbcFiles: [] };
    const b: HarmonyAbcInfo = {
      modulesAbc: { bytes: 1500, hasSourceMap: true },
      extraAbcFiles: [{ path: 'ets/extra.abc', bytes: 200 }],
    };
    const d = diffPackageReports(makeReport({ abc: a }), makeReport({ abc: b }));
    expect(d.abc?.modulesAbc.delta).toBe(500);
    expect(d.abc?.modulesAbc.sourceMapChanged).toBe(true);
    expect(d.abc?.extra.added.length).toBe(1);
  });

  it('signature：subject 变化时 fields 中标 changed=true', () => {
    const a: PackageSignatureInfo = { present: true, subject: 'CN=Old' };
    const b: PackageSignatureInfo = { present: true, subject: 'CN=New', issuer: 'CN=CA' };
    const d = diffPackageReports(makeReport({ signature: a }), makeReport({ signature: b }));
    expect(d.signature?.fromPresent).toBe(true);
    expect(d.signature?.presentChanged).toBe(false);
    const subj = d.signature?.fields.find((x) => x.field === 'subject');
    expect(subj?.changed).toBe(true);
    expect(subj?.from).toBe('CN=Old');
    expect(subj?.to).toBe('CN=New');
  });

  it('dependencies：HSP/HAR added/removed', () => {
    const a: HarmonyDependenciesInfo = { hsp: ['libA'], har: ['libC'] };
    const b: HarmonyDependenciesInfo = { hsp: ['libA', 'libB'], har: [] };
    const d = diffPackageReports(makeReport({ dependencies: a }), makeReport({ dependencies: b }));
    expect(d.dependencies?.hsp.added).toEqual(['libB']);
    expect(d.dependencies?.har.removed).toEqual(['libC']);
  });
});

/* -------------------------------------------------------------------------- */
/* dex（Android default analyzer 产物）                                          */
/* -------------------------------------------------------------------------- */

function dexSummary(overrides: Partial<DexInfo['files'][number]> = {}): DexInfo['files'][number] {
  return {
    path: 'classes.dex',
    bytes: 1024,
    magic: 'DEX',
    version: '035',
    checksum: 0xdeadbeef,
    fileSize: 1024,
    stringIds: 100,
    typeIds: 30,
    protoIds: 40,
    fieldIds: 20,
    methodIds: 50,
    classDefs: 10,
    ...overrides,
  };
}

function dexInfo(files: DexInfo['files']): DexInfo {
  return {
    fileCount: files.length,
    totalBytes: files.reduce((s, f) => s + f.bytes, 0),
    files,
  };
}

describe('diffPackageReports - dex', () => {
  it('双侧都没 dex 时不出 dex 字段', () => {
    const d = diffPackageReports(makeReport(), makeReport());
    expect(d.dex).toBeUndefined();
  });

  it('classes2.dex 新增 / 删除 / 头部计数变化', () => {
    const a: DexInfo = dexInfo([
      dexSummary({ path: 'classes.dex', methodIds: 100, classDefs: 20 }),
      dexSummary({ path: 'classes2.dex', methodIds: 80, classDefs: 15 }),
    ]);
    const b: DexInfo = dexInfo([
      dexSummary({ path: 'classes.dex', methodIds: 110, classDefs: 22 }), // changed
      dexSummary({ path: 'classes3.dex', methodIds: 50, classDefs: 8 }), // added
    ]);
    const d = diffPackageReports(makeReport({ dex: a }), makeReport({ dex: b }));
    expect(d.dex?.added.map((x) => x.path)).toEqual(['classes3.dex']);
    expect(d.dex?.removed.map((x) => x.path)).toEqual(['classes2.dex']);
    expect(d.dex?.changed[0]!.path).toBe('classes.dex');
    expect(d.dex?.changed[0]!.methodIdsDelta).toBe(10);
    expect(d.dex?.changed[0]!.classDefsDelta).toBe(2);
  });

  it('totals.methodIdsCount / classDefsCount 汇总跨所有 dex 的 delta', () => {
    const a: DexInfo = dexInfo([
      dexSummary({ path: 'classes.dex', methodIds: 100, classDefs: 20 }),
      dexSummary({ path: 'classes2.dex', methodIds: 80, classDefs: 15 }),
    ]);
    const b: DexInfo = dexInfo([
      dexSummary({ path: 'classes.dex', methodIds: 110, classDefs: 22 }),
      dexSummary({ path: 'classes3.dex', methodIds: 50, classDefs: 8 }),
    ]);
    const d = diffPackageReports(makeReport({ dex: a }), makeReport({ dex: b }));
    expect(d.dex?.totals.methodIdsCount).toEqual(
      expect.objectContaining({ from: 180, to: 160, delta: -20 }),
    );
    expect(d.dex?.totals.classDefsCount).toEqual(
      expect.objectContaining({ from: 35, to: 30, delta: -5 }),
    );
  });

  it('一侧 stringIds=null（解析失败）时 delta 兜底为 null 且不阻塞 changed 判定', () => {
    const a: DexInfo = dexInfo([dexSummary({ stringIds: null, methodIds: null })]);
    const b: DexInfo = dexInfo([dexSummary({ stringIds: 200, methodIds: 100 })]);
    const d = diffPackageReports(makeReport({ dex: a }), makeReport({ dex: b }));
    // bytes 没变、magic/version 没变；stringIds 一侧 null 不算 header changed；methodIds 一侧 null 也不算
    // 所以 changed 应该为空（bytes 相同 + 仅 null-delta），但若两侧 bytes 不同会进 changed
    expect(d.dex?.changed.length).toBe(0);
    expect(d.dex?.totals.fileCount.delta).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* dexDetails（可选深度差异：字符串集合）                                          */
/* -------------------------------------------------------------------------- */

describe('diffPackageReports - dexDetails', () => {
  it('双侧都跑 dexDetails 时输出 classDescriptors/methodSignatures add/remove', () => {
    const a: DexDetailsInfo = {
      entries: [
        {
          path: 'classes.dex',
          bytes: 1024,
          sha256: 'a'.repeat(64),
          strings: {
            totalDistinct: 4,
            classDescriptors: ['Lcom/king/Foo;', 'Lcom/king/Bar;'],
            methodSignatures: ['(I)V', '(Ljava/lang/String;)V'],
            sourceFiles: ['Foo.java'],
            identifiers: ['foo', 'bar'],
            other: [],
            extractLimit: 0,
            truncated: false,
          },
        },
      ],
      scanned: 1,
    };
    const b: DexDetailsInfo = {
      entries: [
        {
          path: 'classes.dex',
          bytes: 1024,
          sha256: 'b'.repeat(64), // sha256 变了 → changed
          strings: {
            totalDistinct: 5,
            classDescriptors: ['Lcom/king/Foo;', 'Lcom/king/Baz;'], // remove Bar, add Baz
            methodSignatures: ['(I)V', '(Ljava/lang/String;)V', '(Z)V'], // add (Z)V
            sourceFiles: ['Foo.java'],
            identifiers: ['foo', 'baz'],
            other: [],
            extractLimit: 0,
            truncated: false,
          },
        },
      ],
      scanned: 1,
    };
    const d = diffPackageReports(makeReport({ dexDetails: a }), makeReport({ dexDetails: b }));
    expect(d.dexDetails?.totals).toEqual({
      changed: 1,
      total: 1,
      methodsAdded: 0,
      methodsRemoved: 0,
      methodsChanged: 0,
    });
    const entry = d.dexDetails!.entries[0]!;
    expect(entry.changed).toBe(true);
    expect(entry.stringsDiff?.classDescriptors.added).toEqual(['Lcom/king/Baz;']);
    expect(entry.stringsDiff?.classDescriptors.removed).toEqual(['Lcom/king/Bar;']);
    expect(entry.stringsDiff?.methodSignatures.added).toEqual(['(Z)V']);
    expect(entry.stringsDiff?.anyChanged).toBe(true);
  });

  it('一侧整个 dex 缺失时 changed=true，dex 文件被算作新增/删除', () => {
    const a: DexDetailsInfo = { entries: [], scanned: 0 };
    const b: DexDetailsInfo = {
      entries: [
        {
          path: 'classes.dex',
          bytes: 1024,
          sha256: 'b'.repeat(64),
          strings: {
            totalDistinct: 1,
            classDescriptors: ['Lcom/king/New;'],
            methodSignatures: [],
            sourceFiles: [],
            identifiers: [],
            other: [],
            extractLimit: 0,
            truncated: false,
          },
        },
      ],
      scanned: 1,
    };
    const d = diffPackageReports(makeReport({ dexDetails: a }), makeReport({ dexDetails: b }));
    expect(d.dexDetails?.totals.changed).toBe(1);
    expect(d.dexDetails?.totals.total).toBe(1);
    const e = d.dexDetails!.entries[0]!;
    expect(e.fromBytes).toBeNull();
    expect(e.toBytes).toBe(1024);
    expect(e.stringsDiff?.classDescriptors.added).toEqual(['Lcom/king/New;']);
  });
});

/* -------------------------------------------------------------------------- */
/* dex method-level diff（9d）                                                   */
/* -------------------------------------------------------------------------- */

import type { DexMethodEntry } from '@kingsdk/shared/schema.js';

function dexMethod(overrides: Partial<DexMethodEntry> = {}): DexMethodEntry {
  return {
    classDescriptor: 'Lcom/king/Foo;',
    name: 'bar',
    proto: '()V',
    fullName: 'Lcom/king/Foo;->bar()V',
    accessFlags: 0x0001,
    hasCode: true,
    insnsSize: 4,
    registers: 1,
    insnsSha256: null,
    ...overrides,
  };
}

describe('diffPackageReports - dex method-level', () => {
  it('add / remove / size-changed 三种信号同 dex 文件内同时出', () => {
    const a: DexDetailsInfo = {
      entries: [
        {
          path: 'classes.dex',
          bytes: 1024,
          sha256: 'a'.repeat(64),
          methods: [
            dexMethod({ fullName: 'Lcom/king/Foo;->keep()V', name: 'keep' }),
            dexMethod({
              fullName: 'Lcom/king/Foo;->resize(I)V',
              name: 'resize',
              proto: '(I)V',
              insnsSize: 4,
            }),
            dexMethod({
              fullName: 'Lcom/king/Foo;->gone()V',
              name: 'gone',
            }),
          ],
        },
      ],
      scanned: 1,
    };
    const b: DexDetailsInfo = {
      entries: [
        {
          path: 'classes.dex',
          bytes: 1024,
          sha256: 'b'.repeat(64),
          methods: [
            dexMethod({ fullName: 'Lcom/king/Foo;->keep()V', name: 'keep' }),
            dexMethod({
              fullName: 'Lcom/king/Foo;->resize(I)V',
              name: 'resize',
              proto: '(I)V',
              insnsSize: 10, // +6
            }),
            dexMethod({ fullName: 'Lcom/king/Foo;->fresh()V', name: 'fresh' }),
          ],
        },
      ],
      scanned: 1,
    };
    const d = diffPackageReports(makeReport({ dexDetails: a }), makeReport({ dexDetails: b }));
    const md = d.dexDetails!.entries[0]!.methodsDiff!;
    expect(md.added.map((m) => m.fullName)).toEqual(['Lcom/king/Foo;->fresh()V']);
    expect(md.removed.map((m) => m.fullName)).toEqual(['Lcom/king/Foo;->gone()V']);
    expect(md.changed).toHaveLength(1);
    expect(md.changed[0]).toEqual(
      expect.objectContaining({
        fullName: 'Lcom/king/Foo;->resize(I)V',
        fromInsnsSize: 4,
        toInsnsSize: 10,
        insnsSizeDelta: 6,
        bodyChanged: null, // 两侧都没 sha256
      }),
    );
    expect(md.totals).toEqual({ added: 1, removed: 1, changed: 1, unchanged: 1 });

    // dexDetails 顶层 totals 汇总
    expect(d.dexDetails?.totals).toEqual({
      changed: 1,
      total: 1,
      methodsAdded: 1,
      methodsRemoved: 1,
      methodsChanged: 1,
    });
  });

  it('bodyChanged 信号：两侧 insnsSha256 都有且不等时 = true（即使 insnsSize 相同）', () => {
    const a: DexDetailsInfo = {
      entries: [
        {
          path: 'classes.dex',
          bytes: 1024,
          sha256: 'a'.repeat(64),
          methods: [
            dexMethod({
              fullName: 'Lcom/king/Foo;->stable()V',
              name: 'stable',
              insnsSize: 6,
              insnsSha256: 'aa'.repeat(32),
            }),
          ],
        },
      ],
      scanned: 1,
    };
    const b: DexDetailsInfo = {
      entries: [
        {
          path: 'classes.dex',
          bytes: 1024,
          sha256: 'a'.repeat(64),
          methods: [
            dexMethod({
              fullName: 'Lcom/king/Foo;->stable()V',
              name: 'stable',
              insnsSize: 6,
              insnsSha256: 'bb'.repeat(32),
            }),
          ],
        },
      ],
      scanned: 1,
    };
    const d = diffPackageReports(makeReport({ dexDetails: a }), makeReport({ dexDetails: b }));
    const md = d.dexDetails!.entries[0]!.methodsDiff!;
    expect(md.changed).toHaveLength(1);
    expect(md.changed[0]!.bodyChanged).toBe(true);
    expect(md.changed[0]!.insnsSizeDelta).toBe(0);
  });

  it('access_flags 变化（如 public→private）也算 changed', () => {
    const a: DexDetailsInfo = {
      entries: [
        {
          path: 'classes.dex',
          bytes: 1024,
          sha256: 'a'.repeat(64),
          methods: [dexMethod({ fullName: 'Lcom/king/Foo;->m()V', accessFlags: 0x0001 })],
        },
      ],
      scanned: 1,
    };
    const b: DexDetailsInfo = {
      entries: [
        {
          path: 'classes.dex',
          bytes: 1024,
          sha256: 'a'.repeat(64),
          methods: [dexMethod({ fullName: 'Lcom/king/Foo;->m()V', accessFlags: 0x0002 })],
        },
      ],
      scanned: 1,
    };
    const d = diffPackageReports(makeReport({ dexDetails: a }), makeReport({ dexDetails: b }));
    const md = d.dexDetails!.entries[0]!.methodsDiff!;
    expect(md.changed).toHaveLength(1);
    expect(md.changed[0]!.accessFlagsChanged).toBe(true);
    expect(md.changed[0]!.insnsSizeDelta).toBe(0);
  });

  it('dex 文件本身被新增：methods 全数算 added', () => {
    const a: DexDetailsInfo = { entries: [], scanned: 0 };
    const b: DexDetailsInfo = {
      entries: [
        {
          path: 'classes2.dex',
          bytes: 1024,
          sha256: 'b'.repeat(64),
          methods: [
            dexMethod({ fullName: 'Lnew/M;->a()V' }),
            dexMethod({ fullName: 'Lnew/M;->b()V', name: 'b' }),
          ],
        },
      ],
      scanned: 1,
    };
    const d = diffPackageReports(makeReport({ dexDetails: a }), makeReport({ dexDetails: b }));
    const e = d.dexDetails!.entries[0]!;
    expect(e.methodsDiff?.added.map((m) => m.fullName)).toEqual([
      'Lnew/M;->a()V',
      'Lnew/M;->b()V',
    ]);
    expect(e.methodsDiff?.removed).toEqual([]);
    expect(d.dexDetails?.totals.methodsAdded).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* signature.versions / signingBlock（Android）                                  */
/* -------------------------------------------------------------------------- */

describe('diffPackageReports - signature.versions / signingBlock', () => {
  it('Android：versions diff 标 v1→v2 升级；signingBlock pair add/remove 与 size delta', () => {
    const a: PackageSignatureInfo = {
      present: true,
      versions: { v1: true, v2: false, v3: false, v31: false },
      signingBlock: {
        totalBytes: 200,
        offset: 1000,
        entries: [
          { idHex: '0x42726577', name: 'padding', sizeBytes: 50 },
          { idHex: '0x7109871a', name: 'apk-v2', sizeBytes: 100 },
        ],
      },
    };
    const b: PackageSignatureInfo = {
      present: true,
      versions: { v1: false, v2: true, v3: true, v31: false },
      signingBlock: {
        totalBytes: 320,
        offset: 1000,
        entries: [
          { idHex: '0x42726577', name: 'padding', sizeBytes: 50 },
          { idHex: '0x7109871a', name: 'apk-v2', sizeBytes: 120 }, // changed +20
          { idHex: '0xf05368c0', name: 'apk-v3', sizeBytes: 100 }, // added
        ],
      },
    };
    const d = diffPackageReports(makeReport({ signature: a }), makeReport({ signature: b }));
    const v = d.signature?.versions;
    expect(v?.v1).toEqual({ from: true, to: false, changed: true });
    expect(v?.v2).toEqual({ from: false, to: true, changed: true });
    expect(v?.v3).toEqual({ from: false, to: true, changed: true });
    expect(v?.v31).toEqual({ from: false, to: false, changed: false });
    expect(v?.anyChanged).toBe(true);

    const sb = d.signature?.signingBlock;
    expect(sb?.fromTotalBytes).toBe(200);
    expect(sb?.toTotalBytes).toBe(320);
    expect(sb?.totalBytesDelta).toBe(120);
    expect(sb?.added.map((e) => e.idHex)).toEqual(['0xf05368c0']);
    expect(sb?.removed).toEqual([]);
    expect(sb?.changedSizes[0]).toEqual(
      expect.objectContaining({ idHex: '0x7109871a', delta: 20 }),
    );
    expect(sb?.anyChanged).toBe(true);
  });

  it('双侧都没 versions/signingBlock 时不出对应字段（HarmonyOS 兼容）', () => {
    const a: PackageSignatureInfo = { present: true, subject: 'CN=Old' };
    const b: PackageSignatureInfo = { present: true, subject: 'CN=New' };
    const d = diffPackageReports(makeReport({ signature: a }), makeReport({ signature: b }));
    expect(d.signature?.versions).toBeUndefined();
    expect(d.signature?.signingBlock).toBeUndefined();
  });
});
