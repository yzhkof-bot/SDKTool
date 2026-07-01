/**
 * Viewer DEX section 渲染回归。
 */

import { describe, expect, it } from 'vitest';

import type { PackageReport } from '@kingsdk/shared/schema.js';
import { renderDex } from '@kingsdk/viewer/sections/dex.js';

function baseReport(overrides: Partial<PackageReport> = {}): PackageReport {
  return {
    schemaVersion: '1.0',
    platform: 'android',
    meta: {
      file: '/tmp/demo.apk',
      fileSize: 1,
      sha256: 'a'.repeat(64),
      analyzedAt: '2026-01-01T00:00:00.000Z',
      toolVersion: 'test',
    },
    warnings: [],
    ...overrides,
  };
}

describe('viewer/sections/dex', () => {
  it('完整 dex + 字符串池：渲染概览 / 头部表 / 字符串折叠面板', () => {
    const el = renderDex(
      baseReport({
        dex: {
          fileCount: 2,
          totalBytes: 1024 + 2048,
          files: [
            {
              path: 'classes.dex',
              bytes: 1024,
              magic: 'DEX',
              version: '035',
              checksum: 1234,
              fileSize: 1024,
              stringIds: 10,
              typeIds: 5,
              protoIds: 3,
              fieldIds: 2,
              methodIds: 8,
              classDefs: 4,
            },
            {
              path: 'classes2.dex',
              bytes: 2048,
              magic: 'DEX',
              version: '038',
              checksum: 5678,
              fileSize: 2048,
              stringIds: 20,
              typeIds: 10,
              protoIds: 6,
              fieldIds: 4,
              methodIds: 16,
              classDefs: 8,
            },
          ],
        },
        dexDetails: {
          scanned: 1,
          entries: [
            {
              path: 'classes.dex',
              bytes: 1024,
              sha256: 'b'.repeat(64),
              strings: {
                totalDistinct: 4,
                classDescriptors: ['Lcom/king/Foo;', 'Lcom/king/Bar;'],
                methodSignatures: ['(Landroid/os/Bundle;)V'],
                sourceFiles: ['Foo.java'],
                identifiers: [],
                other: [],
                extractLimit: 0,
                truncated: false,
              },
            },
          ],
        },
      }),
    );
    const text = el.textContent ?? '';
    expect(text).toContain('DEX 概览');
    expect(text).toContain('classes.dex');
    expect(text).toContain('classes2.dex');
    // magic badges
    expect(text).toContain('DEX');
    // 版本
    expect(text).toContain('035');
    expect(text).toContain('038');
    // dexDetails 字符串池
    expect(text).toContain('DEX 字符串池');
    expect(text).toContain('Lcom/king/Foo;');
    expect(text).toContain('Foo.java');
  });

  it('CDEX magic 渲染对应 badge', () => {
    const el = renderDex(
      baseReport({
        dex: {
          fileCount: 1,
          totalBytes: 100,
          files: [
            {
              path: 'classes.dex',
              bytes: 100,
              magic: 'CDEX',
              version: '001',
              checksum: null,
              fileSize: null,
              stringIds: null,
              typeIds: null,
              protoIds: null,
              fieldIds: null,
              methodIds: null,
              classDefs: null,
            },
          ],
        },
      }),
    );
    expect(el.textContent ?? '').toContain('CDEX');
  });

  it('INVALID magic 渲染 danger badge', () => {
    const el = renderDex(
      baseReport({
        dex: {
          fileCount: 1,
          totalBytes: 32,
          files: [
            {
              path: 'classes.dex',
              bytes: 32,
              magic: 'INVALID',
              version: null,
              checksum: null,
              fileSize: null,
              stringIds: null,
              typeIds: null,
              protoIds: null,
              fieldIds: null,
              methodIds: null,
              classDefs: null,
              error: 'magic 不识别',
            },
          ],
        },
      }),
    );
    const text = el.textContent ?? '';
    expect(text).toContain('INVALID');
    expect(text).toContain('magic 不识别');
  });

  it('dex 为空 / 缺失：emptyState', () => {
    const el1 = renderDex(
      baseReport({ dex: { fileCount: 0, totalBytes: 0, files: [] } }),
    );
    expect(el1.textContent ?? '').toContain('未检测到 classes*.dex');

    const el2 = renderDex(baseReport());
    expect(el2.textContent ?? '').toContain('未检测到 classes*.dex');
  });

  it('dexDetails.methods 存在时渲染方法表折叠面板（含 abstract / sha256 短哈希列）', () => {
    const el = renderDex(
      baseReport({
        dex: {
          fileCount: 1,
          totalBytes: 64,
          files: [
            {
              path: 'classes.dex',
              bytes: 64,
              magic: 'DEX',
              version: '035',
              checksum: 1,
              fileSize: 64,
              stringIds: 4,
              typeIds: 2,
              protoIds: 1,
              fieldIds: 0,
              methodIds: 2,
              classDefs: 1,
            },
          ],
        },
        dexDetails: {
          scanned: 1,
          entries: [
            {
              path: 'classes.dex',
              bytes: 64,
              sha256: 'c'.repeat(64),
              strings: {
                totalDistinct: 1,
                classDescriptors: ['Lcom/king/Foo;'],
                methodSignatures: [],
                sourceFiles: [],
                identifiers: [],
                other: [],
                extractLimit: 0,
                truncated: false,
              },
              methods: [
                {
                  classDescriptor: 'Lcom/king/Foo;',
                  name: 'bar',
                  proto: '()V',
                  fullName: 'Lcom/king/Foo;->bar()V',
                  accessFlags: 0x0001,
                  hasCode: true,
                  insnsSize: 4,
                  registers: 1,
                  insnsSha256: 'a'.repeat(64),
                },
                {
                  classDescriptor: 'Lcom/king/Foo;',
                  name: 'noop',
                  proto: '()V',
                  fullName: 'Lcom/king/Foo;->noop()V',
                  accessFlags: 0x0401, // public + abstract
                  hasCode: false,
                  insnsSize: null,
                  registers: null,
                  insnsSha256: null,
                },
              ],
              methodsTruncated: false,
            },
          ],
        },
      }),
    );
    const text = el.textContent ?? '';
    expect(text).toContain('方法表');
    expect(text).toContain('Lcom/king/Foo;->bar()V');
    expect(text).toContain('Lcom/king/Foo;->noop()V');
    expect(text).toContain('0x0001');
    expect(text).toContain('0x0401');
    expect(text).toContain('abstract'); // hasCode=false 的 badge 文本
  });
});
