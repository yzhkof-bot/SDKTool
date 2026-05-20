import { describe, expect, it } from 'vitest';

import { analyzePackage } from '../src/core/index.js';
import { SCHEMA_VERSION } from '../src/shared/schema.js';

import { buildFixtureHap, DEMO_MODULE_JSON } from './helpers/fixtureHap.js';

describe('analyzePackage (M1 端到端)', () => {
  it('能产出符合 schema 的完整报告', async () => {
    const hapPath = await buildFixtureHap({ includePackInfo: true });
    const report = await analyzePackage(hapPath, { toolVersion: '0.0.0-test' });

    expect(report.schemaVersion).toBe(SCHEMA_VERSION);
    expect(report.meta.file).toBe(hapPath);
    expect(report.meta.toolVersion).toBe('0.0.0-test');
    expect(report.meta.fileSize).toBeGreaterThan(0);
    expect(report.meta.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof report.meta.analyzedAt).toBe('string');
  });

  it('basic analyzer 解析 module.json', async () => {
    const hapPath = await buildFixtureHap();
    const report = await analyzePackage(hapPath, { toolVersion: 'test' });

    expect(report.basic).toBeDefined();
    expect(report.basic?.bundleName).toBe(DEMO_MODULE_JSON.app.bundleName);
    expect(report.basic?.versionCode).toBe(DEMO_MODULE_JSON.app.versionCode);
    expect(report.basic?.versionName).toBe(DEMO_MODULE_JSON.app.versionName);
    expect(report.basic?.moduleName).toBe('entry');
    expect(report.basic?.moduleType).toBe('entry');
    expect(report.basic?.deviceTypes).toEqual(['phone', 'tablet']);
    expect(report.basic?.abilities).toHaveLength(2);
    expect(report.basic?.abilities[0]).toEqual({
      name: 'EntryAbility',
      type: 'page',
      visible: true,
    });
    expect(report.basic?.targetAPIVersion).toBe(11);
    expect(report.basic?.minAPIVersion).toBe(9);
  });

  it('basic analyzer 在 module.json 缺失时只产生 warning 不抛错', async () => {
    const hapPath = await buildFixtureHap({ includeModuleJson: false });
    const report = await analyzePackage(hapPath, { toolVersion: 'test' });

    expect(report.basic).toBeUndefined();
    expect(report.warnings.some((w) => w.code === 'MODULE_JSON_NOT_FOUND')).toBe(true);
  });

  it('size analyzer 给出 breakdown / topFiles / fileCount', async () => {
    const hapPath = await buildFixtureHap();
    const report = await analyzePackage(hapPath, { toolVersion: 'test', topFilesLimit: 3 });

    expect(report.size).toBeDefined();
    expect(report.size!.fileCount).toBeGreaterThan(0);
    expect(report.size!.total).toBeGreaterThan(0);
    expect(report.size!.compressed).toBeGreaterThan(0);

    // 目录归类应包含 ets / resources / libs / signature / config
    const categories = new Set(report.size!.breakdown.map((b) => b.category));
    expect(categories.has('ets')).toBe(true);
    expect(categories.has('resources')).toBe(true);
    expect(categories.has('libs')).toBe(true);
    expect(categories.has('signature')).toBe(true);
    expect(categories.has('config')).toBe(true);

    // ratio 之和应接近 1
    const ratioSum = report.size!.breakdown.reduce((a, b) => a + b.ratio, 0);
    expect(ratioSum).toBeGreaterThan(0.99);
    expect(ratioSum).toBeLessThan(1.01);

    // topFilesLimit = 3
    expect(report.size!.topFiles).toHaveLength(3);
    // 应该按 bytes 倒序
    for (let i = 1; i < report.size!.topFiles.length; i += 1) {
      const prev = report.size!.topFiles[i - 1]!;
      const curr = report.size!.topFiles[i]!;
      expect(prev.bytes).toBeGreaterThanOrEqual(curr.bytes);
    }
  });

  it('--only 限制只跑 size analyzer', async () => {
    const hapPath = await buildFixtureHap();
    const report = await analyzePackage(hapPath, {
      toolVersion: 'test',
      only: ['size'],
    });
    expect(report.basic).toBeUndefined();
    expect(report.size).toBeDefined();
  });

  it('analyzer 抛错时不影响其它 analyzer，且写入 error 级 warning', async () => {
    const hapPath = await buildFixtureHap();
    const failingAnalyzer = {
      id: 'boom',
      name: 'Boom',
      enabledByDefault: true,
      run: async () => {
        throw new Error('boom!');
      },
    };
    const { basicInfoAnalyzer, sizeAnalyzer } = await import('../src/core/analyzers/index.js');

    const report = await analyzePackage(hapPath, {
      toolVersion: 'test',
      analyzers: [basicInfoAnalyzer, sizeAnalyzer, failingAnalyzer],
    });
    expect(report.basic).toBeDefined();
    expect(report.size).toBeDefined();
    const failed = report.warnings.find((w) => w.code === 'ANALYZER_FAILED');
    expect(failed).toBeDefined();
    expect(failed?.source).toBe('boom');
  });
});
