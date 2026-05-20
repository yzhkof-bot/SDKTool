/**
 * Viewer permissions section 渲染回归。
 *
 * 关注点：
 *  - HarmonyOS 报告（无 level 字段）渲染老格式：Permission / 类型 / 理由 / usedScene
 *  - Android 报告（带 level）自动追加 Level 列 + 4 个 level 统计卡
 *  - sensitive=true 渲染 danger badge；dangerous level 渲染 danger badge
 */

import { describe, expect, it } from 'vitest';

import type { PackagePermission, PackageReport } from '../../src/shared/schema.js';
import { renderPermissions } from '../../src/viewer/sections/permissions.js';

function reportWithPermissions(
  platform: 'harmony' | 'android',
  perms: PackagePermission[],
): PackageReport {
  return {
    schemaVersion: '1.0',
    platform,
    meta: {
      file: '/tmp/x',
      fileSize: 1,
      sha256: 'a'.repeat(64),
      analyzedAt: '2026-01-01T00:00:00.000Z',
      toolVersion: 'test',
    },
    warnings: [],
    permissions: perms,
  };
}

describe('viewer/sections/permissions', () => {
  it('HarmonyOS（无 level）：表头不含 Level 列，渲染老格式', () => {
    const el = renderPermissions(
      reportWithPermissions('harmony', [
        { name: 'ohos.permission.CAMERA', sensitive: true, reason: '拍照' },
        { name: 'ohos.permission.INTERNET', sensitive: false },
      ]),
    );
    const headers = el.querySelectorAll('thead th');
    const headerTexts = Array.from(headers).map((th) => th.textContent ?? '');
    expect(headerTexts).toEqual(['Permission', '敏感', '理由 (reason)', 'usedScene']);

    const text = el.textContent ?? '';
    expect(text).toContain('ohos.permission.CAMERA');
    expect(text).toContain('敏感');
    expect(text).toContain('拍照');
  });

  it('Android（带 level）：表头追加 Level 列 + 概览卡含 dangerous/normal/signature/unknown 4 个统计', () => {
    const el = renderPermissions(
      reportWithPermissions('android', [
        { name: 'android.permission.CAMERA', sensitive: true, level: 'dangerous' },
        { name: 'android.permission.READ_VOICEMAIL', sensitive: false, level: 'signature' },
        { name: 'android.permission.INTERNET', sensitive: false, level: 'normal' },
        { name: 'com.custom.PERMISSION', sensitive: false, level: 'unknown' },
      ]),
    );
    const headers = el.querySelectorAll('thead th');
    const headerTexts = Array.from(headers).map((th) => th.textContent ?? '');
    expect(headerTexts).toEqual([
      'Permission',
      '敏感',
      'Level',
      '理由 (reason)',
      'usedScene',
    ]);

    const text = el.textContent ?? '';
    // 概览卡 4 个 level 统计
    expect(text).toContain('Dangerous');
    expect(text).toContain('Signature');
    expect(text).toContain('Normal');
    expect(text).toContain('Unknown');
    // 各 level badge 文本
    expect(text).toContain('dangerous');
    expect(text).toContain('signature');
    expect(text).toContain('normal');
    expect(text).toContain('unknown');
  });

  it('空 permissions：emptyState', () => {
    const el = renderPermissions(reportWithPermissions('android', []));
    expect(el.textContent ?? '').toContain('未声明任何权限');
  });
});
