import { describe, expect, it } from 'vitest';

import { analyzePackage } from '../../src/core/index.js';

import { buildFixtureHap } from '../helpers/fixtureHap.js';

describe('AbcAnalyzer', () => {
  it('识别主 abc / sourceMap / 子模块 abc', async () => {
    const hap = await buildFixtureHap();
    const report = await analyzePackage(hap, { toolVersion: 't', only: ['abc'] });

    const a = report.abc!;
    expect(a.modulesAbc).toEqual({ bytes: 2048, hasSourceMap: true });
    expect(a.extraAbcFiles).toEqual([{ path: 'ets/library/modules.abc', bytes: 256 }]);
  });

  it('无主 abc 时写一条 warning 但仍返回结构', async () => {
    const { writeMiniZip } = await import('../helpers/miniZip.js');
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'kingsdk-abc-empty-'));
    const file = join(dir, 'demo.hap');
    await writeMiniZip(file, [
      { path: 'module.json', content: '{"app":{},"module":{}}' },
    ]);
    const report = await analyzePackage(file, { toolVersion: 't', only: ['abc'] });
    expect(report.abc!.modulesAbc).toBeUndefined();
    expect(report.abc!.extraAbcFiles).toEqual([]);
    expect(report.warnings.some((w) => w.code === 'MAIN_ABC_MISSING')).toBe(true);
  });

  it('无 sourceMap 时 hasSourceMap=false', async () => {
    const { writeMiniZip } = await import('../helpers/miniZip.js');
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'kingsdk-abc-nomap-'));
    const file = join(dir, 'demo.hap');
    await writeMiniZip(file, [
      { path: 'module.json', content: '{"app":{},"module":{}}' },
      { path: 'ets/modules.abc', content: Buffer.alloc(100) },
    ]);
    const report = await analyzePackage(file, { toolVersion: 't', only: ['abc'] });
    expect(report.abc!.modulesAbc).toEqual({ bytes: 100, hasSourceMap: false });
  });
});
