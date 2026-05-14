import { describe, expect, it } from 'vitest';

import { analyzeHap } from '../../src/core/index.js';

import { buildFixtureHap, DEMO_MODULE_JSON } from '../helpers/fixtureHap.js';

describe('DependencyAnalyzer', () => {
  it('根据 pack.info 区分 HSP 与 HAR', async () => {
    const hap = await buildFixtureHap({ includePackInfo: true });
    const report = await analyzeHap(hap, { toolVersion: 't', only: ['dependency'] });

    const d = report.dependencies!;
    expect(d.hsp).toEqual(['com.king.shared/libcommon@100']);
    expect(d.har).toEqual(['libutil@50']);
    expect(d.raw).toEqual(DEMO_MODULE_JSON.module.dependencies);
    expect(report.warnings.some((w) => w.code === 'DEPENDENCY_TYPE_UNKNOWN')).toBe(false);
  });

  it('无 pack.info 时全部归入 hsp + 写一条 info 警告', async () => {
    const hap = await buildFixtureHap({ includePackInfo: false });
    const report = await analyzeHap(hap, { toolVersion: 't', only: ['dependency'] });

    const d = report.dependencies!;
    expect(d.hsp).toEqual(['com.king.shared/libcommon@100', 'libutil@50']);
    expect(d.har).toEqual([]);
    expect(report.warnings.some((w) => w.code === 'DEPENDENCY_TYPE_UNKNOWN')).toBe(true);
  });

  it('无 dependencies 字段时返回空数组', async () => {
    const moduleJson = JSON.parse(JSON.stringify(DEMO_MODULE_JSON));
    delete moduleJson.module.dependencies;
    const hap = await buildFixtureHap({ moduleJson });
    const report = await analyzeHap(hap, { toolVersion: 't', only: ['dependency'] });

    expect(report.dependencies!.hsp).toEqual([]);
    expect(report.dependencies!.har).toEqual([]);
    expect(report.dependencies!.raw).toBeUndefined();
  });

  it('module.json 缺失时返回空依赖结构', async () => {
    const hap = await buildFixtureHap({ includeModuleJson: false });
    const report = await analyzeHap(hap, { toolVersion: 't', only: ['dependency'] });

    expect(report.dependencies).toEqual({ hsp: [], har: [] });
  });
});
