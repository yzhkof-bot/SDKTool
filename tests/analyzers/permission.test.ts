import { describe, expect, it } from 'vitest';

import { analyzePackage } from '@kingsdk/core/index.js';

import { buildFixtureHap, DEMO_MODULE_JSON } from '../helpers/fixtureHap.js';

describe('PermissionAnalyzer', () => {
  it('提取所有权限并标注 sensitive', async () => {
    const hap = await buildFixtureHap();
    const report = await analyzePackage(hap, { toolVersion: 't', only: ['permission'] });

    expect(report.permissions).toBeDefined();
    const map = new Map(report.permissions!.map((p) => [p.name, p]));

    expect(map.get('ohos.permission.LOCATION')?.sensitive).toBe(true);
    expect(map.get('ohos.permission.CAMERA')?.sensitive).toBe(true);
    expect(map.get('ohos.permission.GET_NETWORK_INFO')?.sensitive).toBe(true);
    expect(map.get('ohos.permission.INTERNET')?.sensitive).toBe(false);
  });

  it('透传 reason / usedScene', async () => {
    const hap = await buildFixtureHap();
    const report = await analyzePackage(hap, { toolVersion: 't', only: ['permission'] });

    const loc = report.permissions!.find((p) => p.name === 'ohos.permission.LOCATION');
    expect(loc?.reason).toBe('$string:perm_reason_location');
    expect(loc?.usedScene).toEqual({ abilities: ['EntryAbility'], when: 'inuse' });
  });

  it('排序：敏感优先 + 字典序', async () => {
    const hap = await buildFixtureHap();
    const report = await analyzePackage(hap, { toolVersion: 't', only: ['permission'] });

    const list = report.permissions!;
    // 前面应该全是 sensitive=true
    let firstNonSensitive = list.findIndex((p) => !p.sensitive);
    if (firstNonSensitive < 0) firstNonSensitive = list.length;
    for (let i = 0; i < firstNonSensitive; i += 1) {
      expect(list[i]!.sensitive).toBe(true);
    }
    for (let i = firstNonSensitive; i < list.length; i += 1) {
      expect(list[i]!.sensitive).toBe(false);
    }
  });

  it('module.json 缺失时返回空数组（不抛错）', async () => {
    const hap = await buildFixtureHap({ includeModuleJson: false });
    const report = await analyzePackage(hap, { toolVersion: 't', only: ['permission'] });
    expect(report.permissions).toEqual([]);
  });

  it('requestPermissions 缺失时返回空数组', async () => {
    const moduleJson = JSON.parse(JSON.stringify(DEMO_MODULE_JSON));
    delete moduleJson.module.requestPermissions;
    const hap = await buildFixtureHap({ moduleJson });
    const report = await analyzePackage(hap, { toolVersion: 't', only: ['permission'] });
    expect(report.permissions).toEqual([]);
  });

  it('权限项无 name 字段时跳过 + 写一条 warning', async () => {
    const moduleJson = JSON.parse(JSON.stringify(DEMO_MODULE_JSON));
    moduleJson.module.requestPermissions = [
      { reason: 'no name field' },
      { name: 'ohos.permission.INTERNET' },
    ];
    const hap = await buildFixtureHap({ moduleJson });
    const report = await analyzePackage(hap, { toolVersion: 't', only: ['permission'] });
    expect(report.permissions).toHaveLength(1);
    expect(report.permissions![0]!.name).toBe('ohos.permission.INTERNET');
    expect(report.warnings.some((w) => w.code === 'INVALID_PERMISSION_ENTRY')).toBe(true);
  });
});
