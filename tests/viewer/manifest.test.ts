/**
 * Viewer Android manifest section 渲染回归。
 *
 * 关注点（避免之前 table() 那种"行/列错位"类回归）：
 *  - androidManifest 完整时：基础 kv / permissions table / 四大组件分组都能渲染
 *  - androidManifest 缺失时：emptyState 友好提示，不抛 null 引用
 *  - HarmonyOS report（无 androidManifest）也不能因为这个 section 报错
 */

import { describe, expect, it } from 'vitest';

import type { PackageReport } from '../../src/shared/schema.js';
import { renderManifest } from '../../src/viewer/sections/manifest.js';

function makeAndroidReport(
  overrides: Partial<PackageReport['androidManifest']> = {},
): PackageReport {
  return {
    schemaVersion: 1,
    platform: 'android',
    meta: {
      file: '/tmp/demo.apk',
      fileSize: 1,
      sha256: 'a'.repeat(64),
      analyzedAt: '2026-01-01T00:00:00.000Z',
      toolVersion: 'test',
    },
    warnings: [],
    androidManifest: {
      packageName: 'com.example.test',
      versionCode: 42,
      versionName: '1.0.0',
      usesSdk: { minSdkVersion: 21, targetSdkVersion: 33 },
      usesPermissions: ['android.permission.INTERNET'],
      components: {
        activities: ['com.example.test.Main'],
        services: [],
        receivers: ['com.example.test.Boot'],
        providers: [],
      },
      applicationLabel: 'Demo',
      debuggable: true,
      ...overrides,
    },
  };
}

describe('viewer/sections/manifest', () => {
  it('完整 manifest 渲染基础信息 / 权限 / 组件三块', () => {
    const el = renderManifest(makeAndroidReport());
    const text = el.textContent ?? '';
    expect(text).toContain('com.example.test');
    expect(text).toContain('1.0.0');
    expect(text).toContain('android.permission.INTERNET');
    expect(text).toContain('com.example.test.Main');
    expect(text).toContain('com.example.test.Boot');
    // debuggable=true 应该被渲染成 badge
    expect(text).toContain('true (debug)');
  });

  it('manifest.permissions 为空时给出 emptyState', () => {
    const el = renderManifest(makeAndroidReport({ usesPermissions: [] }));
    expect(el.textContent ?? '').toContain('未声明任何权限');
  });

  it('四大组件全为空时给出 emptyState', () => {
    const el = renderManifest(
      makeAndroidReport({
        components: { activities: [], services: [], receivers: [], providers: [] },
      }),
    );
    expect(el.textContent ?? '').toContain('manifest 内未声明');
  });

  it('androidManifest 缺失时给出整体 emptyState，不抛错', () => {
    const report: PackageReport = {
      schemaVersion: 1,
      platform: 'android',
      meta: {
        file: '/tmp/demo.apk',
        fileSize: 1,
        sha256: 'a'.repeat(64),
        analyzedAt: '2026-01-01T00:00:00.000Z',
        toolVersion: 'test',
      },
      warnings: [],
    };
    const el = renderManifest(report);
    expect(el.textContent ?? '').toContain('未解析到 AndroidManifest.xml');
  });
});
