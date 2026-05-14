import { describe, expect, it } from 'vitest';

import { diffHapReports } from '../src/core/differ/index.js';
import { keyBy, listDiff, numberDelta } from '../src/core/differ/utils.js';
import { SCHEMA_VERSION } from '../src/shared/schema.js';
import type {
  HapAbcInfo,
  HapBasicInfo,
  HapDependenciesInfo,
  HapFileEntry,
  HapNativeLibsInfo,
  HapPermission,
  HapRawfileInfo,
  HapReport,
  HapResources,
  HapSignatureInfo,
  HapSizeInfo,
} from '../src/shared/schema.js';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function makeReport(overrides: Partial<HapReport> = {}): HapReport {
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

function basic(overrides: Partial<HapBasicInfo> = {}): HapBasicInfo {
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

function size(overrides: Partial<HapSizeInfo> = {}): HapSizeInfo {
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

function files(arr: HapFileEntry[]): HapFileEntry[] {
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
/* diffHapReports：顶层结构                                                     */
/* -------------------------------------------------------------------------- */

describe('diffHapReports - 总体结构', () => {
  it('两侧完全相同时 summary.identical=true，且各维度 delta=0', () => {
    const a = makeReport({ basic: basic(), size: size(), files: [] });
    const b = makeReport({ basic: basic(), size: size(), files: [] });
    const d = diffHapReports(a, b);

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
    const d = diffHapReports(a, b);
    expect(d.basic).toBeUndefined();
    expect(d.size).toBeUndefined();
    expect(d.permissions).toBeUndefined();
    expect(d.rawfile).toBeUndefined();
  });

  it('summary.versionLine 用 left → right 拼出版本号变化', () => {
    const a = makeReport({ basic: basic({ versionName: '1.0.0', versionCode: 100 }) });
    const b = makeReport({ basic: basic({ versionName: '1.1.0', versionCode: 110 }) });
    const d = diffHapReports(a, b);
    expect(d.summary.versionLine).toBe('1.0.0 (100) → 1.1.0 (110)');
  });
});

/* -------------------------------------------------------------------------- */
/* basic                                                                       */
/* -------------------------------------------------------------------------- */

describe('diffHapReports - basic', () => {
  it('版本号 / deviceTypes / abilities 变化都会被收集到 changed', () => {
    const a = makeReport({ basic: basic({ versionCode: 100, deviceTypes: ['phone'], abilities: [{ name: 'A' }] }) });
    const b = makeReport({
      basic: basic({ versionCode: 110, deviceTypes: ['phone', 'tablet'], abilities: [{ name: 'A' }, { name: 'B' }] }),
    });
    const d = diffHapReports(a, b);
    expect(d.basic?.changed.map((c) => c.field)).toEqual(
      expect.arrayContaining(['versionCode', 'deviceTypes', 'abilities']),
    );
  });

  it('字段无变化时 changed 为空数组', () => {
    const a = makeReport({ basic: basic() });
    const b = makeReport({ basic: basic() });
    const d = diffHapReports(a, b);
    expect(d.basic?.changed).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* size                                                                        */
/* -------------------------------------------------------------------------- */

describe('diffHapReports - size', () => {
  it('breakdown 按 |delta| 降序排序', () => {
    const a = makeReport({ size: size({ breakdown: [
      { category: 'libs', bytes: 100, ratio: 0.5, fileCount: 1 },
      { category: 'resources', bytes: 100, ratio: 0.5, fileCount: 1 },
    ] }) });
    const b = makeReport({ size: size({ breakdown: [
      { category: 'libs', bytes: 1000, ratio: 0.9, fileCount: 1 },
      { category: 'resources', bytes: 110, ratio: 0.1, fileCount: 1 },
    ] }) });
    const d = diffHapReports(a, b);
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
    const d = diffHapReports(a, b);
    const r = d.size?.breakdown.find((x) => x.category === 'resources');
    expect(r).toEqual(expect.objectContaining({ fromBytes: 0, toBytes: 1000, delta: 1000 }));
    expect(r?.ratio).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* files                                                                       */
/* -------------------------------------------------------------------------- */

describe('diffHapReports - files', () => {
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
    const d = diffHapReports(a, b);
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
    const d = diffHapReports(a, b);
    expect(d.files?.totals.changed).toBe(1);
    expect(d.files?.changed[0]!.delta).toBe(0);
  });

  it('缺失任一侧时跳过 files diff 并生成 warning', () => {
    const a = makeReport({ files: [] });
    const b = makeReport(); // no files
    const d = diffHapReports(a, b);
    expect(d.files).toBeUndefined();
    expect(d.warnings.find((w) => w.code === 'DIFF_FILES_MISSING_SIDE')).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* permissions                                                                 */
/* -------------------------------------------------------------------------- */

describe('diffHapReports - permissions', () => {
  it('added/removed 列表敏感项排在前面', () => {
    const a = makeReport({ permissions: <HapPermission[]>[
      { name: 'ohos.permission.INTERNET', sensitive: false },
    ] });
    const b = makeReport({ permissions: <HapPermission[]>[
      { name: 'ohos.permission.INTERNET', sensitive: false },
      { name: 'ohos.permission.READ_CONTACTS', sensitive: true },
      { name: 'ohos.permission.MICROPHONE', sensitive: true },
    ] });
    const d = diffHapReports(a, b);
    expect(d.permissions?.added.length).toBe(2);
    expect(d.permissions?.added[0]!.sensitive).toBe(true);
    expect(d.permissions?.unchanged).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* resources / rawfile / abc / signature / dependencies / nativeLibs           */
/* -------------------------------------------------------------------------- */

describe('diffHapReports - 其它维度 smoke', () => {
  it('resources：locale 集合差并入 strings.localesAdded/Removed', () => {
    const r1: HapResources = {
      images: { count: 2, bytes: 2000, topLargest: [] },
      strings: { count: 3, locales: ['zh_CN', 'en_US'] },
      media: { count: 0, bytes: 0 },
    };
    const r2: HapResources = {
      images: { count: 5, bytes: 5000, topLargest: [] },
      strings: { count: 4, locales: ['zh_CN', 'ja_JP'] },
      media: { count: 1, bytes: 1024 },
    };
    const d = diffHapReports(makeReport({ resources: r1 }), makeReport({ resources: r2 }));
    expect(d.resources?.images.count.delta).toBe(3);
    expect(d.resources?.images.bytes.delta).toBe(3000);
    expect(d.resources?.strings.localesAdded).toEqual(['ja_JP']);
    expect(d.resources?.strings.localesRemoved).toEqual(['en_US']);
  });

  it('rawfile：fileCount/totalBytes/group/category 全输出', () => {
    const rf1: HapRawfileInfo = {
      fileCount: 2,
      totalBytes: 1000,
      topLevelGroups: [{ path: 'Data/Package', bytes: 1000, fileCount: 2, ratio: 1 }],
      byExtension: [],
      categories: [{ category: 'qts-vfs', bytes: 1000, fileCount: 2, ratio: 1 }],
      topFiles: [],
    };
    const rf2: HapRawfileInfo = {
      fileCount: 3,
      totalBytes: 2000,
      topLevelGroups: [{ path: 'Data/Package', bytes: 2000, fileCount: 3, ratio: 1 }],
      byExtension: [],
      categories: [{ category: 'qts-vfs', bytes: 2000, fileCount: 3, ratio: 1 }],
      topFiles: [],
    };
    const d = diffHapReports(makeReport({ rawfile: rf1 }), makeReport({ rawfile: rf2 }));
    expect(d.rawfile?.fileCount.delta).toBe(1);
    expect(d.rawfile?.totalBytes.delta).toBe(1000);
    expect(d.rawfile?.topLevelGroups[0]!.delta).toBe(1000);
    expect(d.rawfile?.categories[0]!.category).toBe('qts-vfs');
  });

  it('nativeLibs：架构集合 + 库 added/removed/changed', () => {
    const n1: HapNativeLibsInfo = {
      architectures: ['arm64-v8a'],
      totalBytes: 1000,
      libs: [
        { arch: 'arm64-v8a', name: 'libfoo.so', bytes: 500 },
        { arch: 'arm64-v8a', name: 'libbar.so', bytes: 500 },
      ],
    };
    const n2: HapNativeLibsInfo = {
      architectures: ['arm64-v8a', 'x86_64'],
      totalBytes: 1100,
      libs: [
        { arch: 'arm64-v8a', name: 'libfoo.so', bytes: 600 }, // changed +100
        { arch: 'x86_64', name: 'libfoo.so', bytes: 500 }, // added
      ],
    };
    const d = diffHapReports(makeReport({ nativeLibs: n1 }), makeReport({ nativeLibs: n2 }));
    expect(d.nativeLibs?.architectures.added).toEqual(['x86_64']);
    expect(d.nativeLibs?.added.length).toBe(1);
    expect(d.nativeLibs?.removed.length).toBe(1);
    expect(d.nativeLibs?.changed[0]!.delta).toBe(100);
  });

  it('abc：modulesAbc bytes 与 sourceMap 变化', () => {
    const a: HapAbcInfo = { modulesAbc: { bytes: 1000, hasSourceMap: false }, extraAbcFiles: [] };
    const b: HapAbcInfo = {
      modulesAbc: { bytes: 1500, hasSourceMap: true },
      extraAbcFiles: [{ path: 'ets/extra.abc', bytes: 200 }],
    };
    const d = diffHapReports(makeReport({ abc: a }), makeReport({ abc: b }));
    expect(d.abc?.modulesAbc.delta).toBe(500);
    expect(d.abc?.modulesAbc.sourceMapChanged).toBe(true);
    expect(d.abc?.extra.added.length).toBe(1);
  });

  it('signature：subject 变化时 fields 中标 changed=true', () => {
    const a: HapSignatureInfo = { present: true, subject: 'CN=Old' };
    const b: HapSignatureInfo = { present: true, subject: 'CN=New', issuer: 'CN=CA' };
    const d = diffHapReports(makeReport({ signature: a }), makeReport({ signature: b }));
    expect(d.signature?.fromPresent).toBe(true);
    expect(d.signature?.presentChanged).toBe(false);
    const subj = d.signature?.fields.find((x) => x.field === 'subject');
    expect(subj?.changed).toBe(true);
    expect(subj?.from).toBe('CN=Old');
    expect(subj?.to).toBe('CN=New');
  });

  it('dependencies：HSP/HAR added/removed', () => {
    const a: HapDependenciesInfo = { hsp: ['libA'], har: ['libC'] };
    const b: HapDependenciesInfo = { hsp: ['libA', 'libB'], har: [] };
    const d = diffHapReports(makeReport({ dependencies: a }), makeReport({ dependencies: b }));
    expect(d.dependencies?.hsp.added).toEqual(['libB']);
    expect(d.dependencies?.har.removed).toEqual(['libC']);
  });
});
