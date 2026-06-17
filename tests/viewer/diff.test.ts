/**
 * Diff viewer 单测（happy-dom 环境）。
 *
 * 重点是"mountDiffApp 在各种 diff shape 下都不抛错"——sections.ts 几百行 DOM 构造，
 * 任何一处 render 函数对 undefined / 空数组的处理失误，都会让浏览器看到白屏。
 * 这里用最少 fixture 把分支跑一遍。
 */

import { describe, expect, it } from 'vitest';

import {
  deltaBytes,
  deltaCount,
  deltaRatio,
  deltaText,
  fromTo,
} from '../../src/viewer/diff/helpers.js';
import { mountDiffApp } from '../../src/viewer/diff/app.js';
import { SCHEMA_VERSION, type PackageDiffReport } from '../../src/shared/schema.js';

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

describe('viewer/diff/helpers', () => {
  it('deltaText 0 → muted "0"，正数染红，负数染绿，符号统一为 +/−', () => {
    expect(deltaText(0).className).toBe('delta-zero');
    expect(deltaText(0).textContent).toBe('0');
    expect(deltaText(10).className).toBe('delta-pos');
    expect(deltaText(10).textContent).toBe('+10');
    expect(deltaText(-7).className).toBe('delta-neg');
    expect(deltaText(-7).textContent).toBe('−7');
  });

  it('deltaBytes 用 KiB/MiB 等单位格式化', () => {
    const node = deltaBytes(2048 * 1024); // 2 MiB
    expect(node.textContent).toContain('+');
    expect(node.textContent).toMatch(/MiB/);
  });

  it('deltaCount 用本地化千分位', () => {
    expect(deltaCount(1234).textContent).toMatch(/^\+1[,.]234$/);
  });

  it('deltaRatio null → "—"，0 → "0%"，正负带符号', () => {
    expect(deltaRatio(null).textContent).toBe('—');
    expect(deltaRatio(0).textContent).toBe('0%');
    expect(deltaRatio(0.123).className).toBe('delta-pos');
    expect(deltaRatio(-0.5).className).toBe('delta-neg');
  });

  it('fromTo 渲染 from / to 两段 code 中间用箭头分隔', () => {
    const node = fromTo('1.0', '1.1');
    expect(node.querySelectorAll('code').length).toBe(2);
    expect(node.textContent).toContain('1.0');
    expect(node.textContent).toContain('1.1');
    expect(node.textContent).toContain('→');
  });
});

/* -------------------------------------------------------------------------- */
/* mountDiffApp - 不崩烟测                                                     */
/* -------------------------------------------------------------------------- */

function emptyDiff(): PackageDiffReport {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: '2026-05-09T00:00:00.000Z',
    toolVersion: '0.0.0-test',
    left: {
      meta: {
        file: 'a.hap',
        fileSize: 100,
        sha256: 'a'.repeat(64),
        analyzedAt: '2026-05-09T00:00:00.000Z',
        toolVersion: '0.0.0-test',
      },
    },
    right: {
      meta: {
        file: 'b.hap',
        fileSize: 100,
        sha256: 'b'.repeat(64),
        analyzedAt: '2026-05-09T00:00:00.000Z',
        toolVersion: '0.0.0-test',
      },
    },
    summary: {
      totalSizeDelta: 0,
      compressedDelta: 0,
      fileCountDelta: 0,
      filesAdded: 0,
      filesRemoved: 0,
      filesChanged: 0,
      permissionsAdded: 0,
      permissionsRemoved: 0,
      identical: true,
    },
    warnings: [],
  };
}

function richDiff(): PackageDiffReport {
  return {
    ...emptyDiff(),
    summary: {
      totalSizeDelta: 1024 * 1024,
      compressedDelta: 512 * 1024,
      fileCountDelta: 3,
      filesAdded: 5,
      filesRemoved: 2,
      filesChanged: 7,
      permissionsAdded: 1,
      permissionsRemoved: 1,
      versionLine: '1.0.0 (100) → 1.1.0 (110)',
      identical: false,
    },
    dex: {
      added: [{ path: 'classes3.dex', bytes: 1024, magic: 'DEX', version: '038' }],
      removed: [],
      changed: [
        {
          path: 'classes.dex',
          fromBytes: 2048,
          toBytes: 3072,
          bytesDelta: 1024,
          fromMagic: 'DEX',
          toMagic: 'DEX',
          fromVersion: '035',
          toVersion: '035',
          stringIdsDelta: 5,
          typeIdsDelta: 2,
          protoIdsDelta: 1,
          fieldIdsDelta: 0,
          methodIdsDelta: 10,
          classDefsDelta: 1,
          changed: true,
        },
      ],
      totals: {
        fileCount: { from: 1, to: 2, delta: 1, ratio: 1 },
        totalBytes: { from: 2048, to: 4096, delta: 2048, ratio: 1 },
        methodIdsCount: { from: 100, to: 110, delta: 10, ratio: 0.1 },
        classDefsCount: { from: 20, to: 21, delta: 1, ratio: 0.05 },
      },
    },
    dexDetails: {
      totals: { changed: 1, total: 1, methodsAdded: 1, methodsRemoved: 1, methodsChanged: 1 },
      entries: [
        {
          path: 'classes.dex',
          fromBytes: 2048,
          toBytes: 3072,
          fromSha256: 'aa'.repeat(32),
          toSha256: 'bb'.repeat(32),
          changed: true,
          methodsDiff: {
            added: [
              {
                fullName: 'Lcom/king/Foo;->fresh()V',
                classDescriptor: 'Lcom/king/Foo;',
                name: 'fresh',
                proto: '()V',
                insnsSize: 4,
              },
            ],
            removed: [
              {
                fullName: 'Lcom/king/Foo;->gone()V',
                classDescriptor: 'Lcom/king/Foo;',
                name: 'gone',
                proto: '()V',
                insnsSize: 2,
              },
            ],
            changed: [
              {
                fullName: 'Lcom/king/Foo;->resize(I)V',
                classDescriptor: 'Lcom/king/Foo;',
                name: 'resize',
                proto: '(I)V',
                fromInsnsSize: 4,
                toInsnsSize: 10,
                insnsSizeDelta: 6,
                fromRegisters: 2,
                toRegisters: 3,
                fromAccessFlags: 0x0001,
                toAccessFlags: 0x0001,
                accessFlagsChanged: false,
                bodyChanged: true,
              },
            ],
            totals: { added: 1, removed: 1, changed: 1, unchanged: 3 },
          },
        },
      ],
    },
    basic: {
      changed: [
        { field: 'versionCode', from: 100, to: 110 },
        { field: 'versionName', from: '1.0.0', to: '1.1.0' },
      ],
    },
    size: {
      total: { from: 1000, to: 2000, delta: 1000, ratio: 1 },
      compressed: { from: 500, to: 800, delta: 300, ratio: 0.6 },
      fileCount: { from: 10, to: 13, delta: 3, ratio: 0.3 },
      breakdown: [
        { category: 'libs', fromBytes: 500, toBytes: 1500, delta: 1000, ratio: 2 },
        { category: 'resources', fromBytes: 500, toBytes: 500, delta: 0, ratio: 0 },
      ],
    },
    files: {
      added: [{ path: 'new.bin', bytes: 100, category: 'other' }],
      removed: [{ path: 'old.bin', bytes: 200, category: 'other' }],
      changed: [{ path: 'libs/x.so', fromBytes: 500, toBytes: 1500, delta: 1000, category: 'libs' }],
      totals: { added: 1, removed: 1, changed: 1, unchanged: 5 },
    },
    permissions: {
      added: [{ name: 'ohos.permission.CAMERA', sensitive: true }],
      removed: [{ name: 'ohos.permission.INTERNET', sensitive: false }],
      unchanged: 2,
    },
    nativeLibs: {
      architectures: { added: ['x86_64'], removed: [] },
      totalBytes: { from: 100, to: 300, delta: 200, ratio: 2 },
      added: [{ arch: 'x86_64', name: 'libfoo.so', bytes: 200 }],
      removed: [],
      changed: [{ arch: 'arm64-v8a', name: 'libbar.so', fromBytes: 100, toBytes: 100, delta: 0 }],
    },
    nativeLibSymbols: {
      perLib: [
        {
          arch: 'arm64-v8a',
          name: 'libdemo.so',
          fromMissing: false,
          toMissing: false,
          added: [{ name: 'brand', bind: 'GLOBAL', type: 'FUNC', size: 16, imported: false }],
          removed: [{ name: 'gone', bind: 'GLOBAL', type: 'FUNC', size: 8, imported: false }],
          changed: [
            // size 变 + body 也变 —— size-changed 是主信号；body badge 显示 'body changed'
            {
              name: 'bar',
              fromSize: 16,
              toSize: 32,
              delta: 16,
              bind: 'GLOBAL',
              type: 'FUNC',
              imported: false,
              bodyChanged: true,
            },
            // size 变 + body 不变 —— 罕见但合法（末尾对齐 padding 调整）
            {
              name: 'pad',
              fromSize: 12,
              toSize: 16,
              delta: 4,
              bind: 'GLOBAL',
              type: 'FUNC',
              imported: false,
              bodyChanged: false,
            },
            // 未启用 hash（老 report）—— 字段缺省，回退到"未计 sha256"
            {
              name: 'legacy',
              fromSize: 24,
              toSize: 28,
              delta: 4,
              bind: 'GLOBAL',
              type: 'FUNC',
              imported: false,
            },
          ],
          // size 一致但 hash 不同的"漂移项"已下线（PC-rel 重链接噪声占主导）：
          // 这里只验 differ 不再把它们当 changed/不再产 bodyHashOnly 名单。
          totals: { added: 1, removed: 1, changed: 3, unchanged: 7 },
        },
      ],
    },
    abc: {
      modulesAbc: { fromBytes: 1000, toBytes: 1500, delta: 500, sourceMapChanged: true },
      extra: {
        added: [{ path: 'ets/extra.abc', bytes: 100 }],
        removed: [],
        changed: [],
      },
    },
    signature: {
      fromPresent: true,
      toPresent: true,
      presentChanged: false,
      fields: [
        { field: 'subject', from: 'CN=A', to: 'CN=B', changed: true },
        { field: 'issuer', from: 'CN=CA', to: 'CN=CA', changed: false },
        { field: 'notBefore', changed: false },
        { field: 'notAfter', changed: false },
      ],
      versions: {
        v1: { from: true, to: false, changed: true },
        v2: { from: true, to: true, changed: false },
        v3: { from: false, to: true, changed: true },
        v31: { from: false, to: false, changed: false },
        anyChanged: true,
      },
      signingBlock: {
        fromTotalBytes: 200,
        toTotalBytes: 320,
        totalBytesDelta: 120,
        added: [{ idHex: '0xf05368c0', name: 'apk-v3', sizeBytes: 100 }],
        removed: [],
        changedSizes: [
          { idHex: '0x7109871a', name: 'apk-v2', fromSize: 100, toSize: 120, delta: 20 },
        ],
        anyChanged: true,
      },
    },
    dependencies: {
      hsp: { added: ['libNew'], removed: [] },
      har: { added: [], removed: ['libOld'] },
    },
    rawfile: {
      fileCount: { from: 100, to: 150, delta: 50, ratio: 0.5 },
      totalBytes: { from: 1024, to: 2048, delta: 1024, ratio: 1 },
      topLevelGroups: [
        { path: 'Data/Package', fromBytes: 1024, toBytes: 2048, delta: 1024, fromCount: 100, toCount: 150 },
      ],
      categories: [
        { category: 'qts-vfs', fromBytes: 1024, toBytes: 2048, delta: 1024, fromCount: 100, toCount: 150 },
      ],
      packages: [
        { packageId: '1001', fromBytes: 1024, toBytes: 2048, delta: 1024, fromCount: 100, toCount: 150 },
      ],
    },
    resources: {
      images: { count: { from: 10, to: 12, delta: 2, ratio: 0.2 }, bytes: { from: 1000, to: 1200, delta: 200, ratio: 0.2 } },
      strings: { count: { from: 5, to: 5, delta: 0, ratio: 0 }, localesAdded: ['ja_JP'], localesRemoved: [] },
      media: { count: { from: 1, to: 0, delta: -1, ratio: -1 }, bytes: { from: 1024, to: 0, delta: -1024, ratio: -1 } },
    },
    warnings: [
      { code: 'TEST', level: 'warn', message: 'demo warning', source: 'differ' },
    ],
  };
}

describe('mountDiffApp', () => {
  it('在最简空 diff 上挂载不崩，sidebar 包含全部 section', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    expect(() => mountDiffApp(root, emptyDiff())).not.toThrow();

    const navItems = root.querySelectorAll('.nav-item');
    expect(navItems.length).toBeGreaterThanOrEqual(12); // 概览+12 维度，加 IL2CPP/DEX 后 sidebar 共 14 项
    const labels = [...navItems].map((n) => n.querySelector('span:first-child')?.textContent);
    expect(labels).toEqual(
      expect.arrayContaining([
        '概览',
        'Basic',
        '体积',
        'Files',
        '权限',
        '资源',
        'Rawfile',
        'Native',
        'ABC',
        'IL2CPP',
        'DEX',
        '签名',
        '依赖',
        '警告',
      ]),
    );

    document.body.removeChild(root);
  });

  it('对 identical diff 在概览展示 ✓ identical 徽章', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountDiffApp(root, emptyDiff());
    const idBadge = root.querySelector('.topbar .badge.success');
    expect(idBadge?.textContent).toContain('identical');
    document.body.removeChild(root);
  });

  it('对真实有差异的 diff 渲染所有维度，且每个 section 都有节点产出', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountDiffApp(root, richDiff());

    const sections = root.querySelectorAll('section[data-section]');
    expect(sections.length).toBeGreaterThanOrEqual(11);
    for (const sec of sections) {
      // 每个 section 至少含一个 h2.section-title（除了 overview 之外都要）
      expect(sec.children.length).toBeGreaterThan(0);
    }

    // size 页面应当有表格
    const sizeTable = root.querySelector('#section-size table.tbl');
    expect(sizeTable).toBeTruthy();
    // size 表格首行 td 数量应 = 表头数（M3 修复的 P0 不能再出现）
    const ths = sizeTable!.querySelectorAll('thead th').length;
    const firstRowTds = sizeTable!.querySelectorAll('tbody tr')[0]?.querySelectorAll('td').length ?? 0;
    expect(firstRowTds).toBe(ths);

    // 文件页面应当有 added/removed/changed 三块面板标题
    const filesPanels = [...root.querySelectorAll('#section-files .panel-title')].map((t) => t.textContent);
    expect(filesPanels.some((t) => t!.includes('新增'))).toBe(true);
    expect(filesPanels.some((t) => t!.includes('删除'))).toBe(true);
    expect(filesPanels.some((t) => t!.includes('修改'))).toBe(true);

    // 警告页应当展示 1 条
    const warnRows = root.querySelectorAll('#section-warnings tbody tr');
    expect(warnRows.length).toBe(1);

    document.body.removeChild(root);
  });

  it('hash 路由：初始 #size 时该 section 显示 active', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    window.location.hash = '#size';
    mountDiffApp(root, richDiff());
    const active = root.querySelectorAll('section.active');
    expect(active.length).toBe(1);
    expect(active[0]!.getAttribute('data-section')).toBe('size');
    window.location.hash = '';
    document.body.removeChild(root);
  });

  it('DEX section 渲染：文件级 add/remove/changed + 方法级 fullName + 字符串折叠面板都出', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountDiffApp(root, richDiff());

    const dexSection = root.querySelector('#section-dex');
    expect(dexSection).toBeTruthy();
    const text = dexSection!.textContent ?? '';
    // 文件级汇总
    expect(text).toContain('dex 文件级汇总');
    expect(text).toContain('methodIds 总和');
    expect(text).toContain('新增 dex');
    expect(text).toContain('classes3.dex');
    expect(text).toContain('修改 dex');
    expect(text).toContain('classes.dex');
    // 方法级
    expect(text).toContain('方法级差异');
    expect(text).toContain('Lcom/king/Foo;->fresh()V');
    expect(text).toContain('Lcom/king/Foo;->gone()V');
    expect(text).toContain('Lcom/king/Foo;->resize(I)V');
    expect(text).toContain('body changed');

    document.body.removeChild(root);
  });

  it('Native 符号 changed 表渲染：size-changed 主路径 + 三态 body badge 都出', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountDiffApp(root, richDiff());

    const nativeSection = root.querySelector('#section-nativeLibs');
    expect(nativeSection).toBeTruthy();
    const text = nativeSection!.textContent ?? '';
    // size-changed 主信号
    expect(text).toContain('bar');
    expect(text).toContain('pad');
    expect(text).toContain('legacy');
    // 三态 body badge
    expect(text).toContain('body changed');
    expect(text).toContain('body 不变');
    expect(text).toContain('未计 sha256');
    expect(text).toContain('Body');

    document.body.removeChild(root);
  });

  it('Native 符号：size 一致的"漂移项"既不进 changed 表也不再有独立面板（已下线）', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountDiffApp(root, richDiff());

    const nativeSection = root.querySelector('#section-nativeLibs');
    expect(nativeSection).toBeTruthy();

    // 折叠面板不应再渲染
    expect(nativeSection!.querySelector('details.body-hash-only-panel')).toBeNull();

    // 顶层"符号表变化"标题里不再混入 body-only 计数
    const titles = [...nativeSection!.querySelectorAll('.panel-title')].map(
      (t) => t.textContent ?? '',
    );
    const symbolsTitle = titles.find((t) => t.includes('符号表变化'));
    expect(symbolsTitle).toBeTruthy();
    expect(symbolsTitle!).not.toContain('body-only');

    document.body.removeChild(root);
  });

  it('Signature section 渲染：Android versions v1/v2/v3 + signingBlock pair diff 都出', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountDiffApp(root, richDiff());

    const sigSection = root.querySelector('#section-signature');
    expect(sigSection).toBeTruthy();
    const text = sigSection!.textContent ?? '';
    expect(text).toContain('Android 签名 Scheme 对比');
    expect(text).toContain('v1');
    expect(text).toContain('v2');
    expect(text).toContain('v3');
    expect(text).toContain('APK Signing Block 对比');
    expect(text).toContain('apk-v3');
    expect(text).toContain('apk-v2');

    document.body.removeChild(root);
  });
});
