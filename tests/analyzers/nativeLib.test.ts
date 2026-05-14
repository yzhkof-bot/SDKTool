import { describe, expect, it } from 'vitest';

import { analyzeHap } from '../../src/core/index.js';

import { buildFixtureHap } from '../helpers/fixtureHap.js';

describe('NativeLibAnalyzer', () => {
  it('提取所有架构与 lib 列表', async () => {
    const hap = await buildFixtureHap();
    const report = await analyzeHap(hap, { toolVersion: 't', only: ['nativeLib'] });

    const n = report.nativeLibs!;
    expect(n.architectures).toEqual(['arm64-v8a', 'x86_64']);
    expect(n.libs).toHaveLength(3);
    expect(n.totalBytes).toBe(4096 + 8192 + 3072);

    // 排序：arch 字典序，arch 内 name 字典序
    expect(n.libs[0]).toEqual({ arch: 'arm64-v8a', name: 'libbar.so', bytes: 8192 });
    expect(n.libs[1]).toEqual({ arch: 'arm64-v8a', name: 'libfoo.so', bytes: 4096 });
    expect(n.libs[2]).toEqual({ arch: 'x86_64', name: 'libfoo.so', bytes: 3072 });
  });

  it('无 libs/ 时返回空结构', async () => {
    // 用一个不带任何 libs/ 的 hap：通过覆盖默认 fixture，仅传 module.json
    const { writeMiniZip } = await import('../helpers/miniZip.js');
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'kingsdk-libs-empty-'));
    const file = join(dir, 'demo.hap');
    await writeMiniZip(file, [
      { path: 'module.json', content: '{"app":{},"module":{}}' },
    ]);
    const report = await analyzeHap(file, { toolVersion: 't', only: ['nativeLib'] });
    expect(report.nativeLibs!.architectures).toEqual([]);
    expect(report.nativeLibs!.libs).toEqual([]);
    expect(report.nativeLibs!.totalBytes).toBe(0);
  });
});
