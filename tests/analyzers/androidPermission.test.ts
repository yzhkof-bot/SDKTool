import { describe, expect, it } from 'vitest';

import { androidPermissionAnalyzer, derivePermissions } from '../../src/core/analyzers/android/permission.js';
import {
  ANDROID_PERMISSION_LEVELS,
  ANDROID_SENSITIVE_PERMISSIONS,
} from '../../src/shared/constants.js';
import type { AnalyzerContext, ReportWarning, VirtualPackage } from '../../src/shared/schema.js';

import { buildAxml } from '../helpers/fixtureAxml.js';

const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

function makeAndroidManifest(permissions: string[]): Buffer {
  return buildAxml({
    namespaces: [{ prefix: 'android', uri: ANDROID_NS }],
    root: {
      name: 'manifest',
      attributes: [{ name: 'package', value: { kind: 'string', value: 'com.demo' } }],
      children: permissions.map((name) => ({
        name: 'uses-permission',
        attributes: [
          { ns: ANDROID_NS, name: 'name', value: { kind: 'string', value: name } as const },
        ],
      })),
    },
  });
}

function makeCtx(manifest: Buffer | null): {
  ctx: AnalyzerContext;
  warnings: Omit<ReportWarning, 'source'>[];
} {
  const warnings: Omit<ReportWarning, 'source'>[] = [];
  const entries: VirtualPackage['entries'] = manifest
    ? [
        {
          path: 'AndroidManifest.xml',
          isDirectory: false,
          uncompressedSize: manifest.length,
          compressedSize: manifest.length,
        },
      ]
    : [];
  const pkg: VirtualPackage = {
    filePath: 'memory://demo.apk',
    fileSize: manifest?.length ?? 0,
    sha256: 'a'.repeat(64),
    entries,
    readFile: async (p) => {
      if (p === 'AndroidManifest.xml' && manifest) return manifest;
      throw new Error(`no entry ${p}`);
    },
    readText: async () => '',
    close: async () => {},
  };
  return {
    ctx: {
      hap: pkg,
      options: { topFilesLimit: 5, toolVersion: 'test' },
      platform: 'android',
      addWarning: (w) => warnings.push(w),
    },
    warnings,
  };
}

/* ================================================================== */
/* derivePermissions（纯函数）                                          */
/* ================================================================== */

describe('derivePermissions', () => {
  it('每条权限带 sensitive + level，dangerous 优先 → signature → unknown → normal', () => {
    const out = derivePermissions([
      'android.permission.INTERNET', // normal
      'android.permission.CAMERA', // dangerous → sensitive
      'android.permission.READ_VOICEMAIL', // signature
      'com.custom.PERMISSION', // unknown
      'android.permission.RECORD_AUDIO', // dangerous → sensitive
      'android.permission.ACCESS_NETWORK_STATE', // normal
    ]);

    expect(out.map((p) => p.name)).toEqual([
      'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO',
      'android.permission.READ_VOICEMAIL',
      'com.custom.PERMISSION',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.INTERNET',
    ]);

    expect(out[0]).toEqual({
      name: 'android.permission.CAMERA',
      sensitive: true,
      level: 'dangerous',
    });
    expect(out[2]).toEqual({
      name: 'android.permission.READ_VOICEMAIL',
      sensitive: false,
      level: 'signature',
    });
    expect(out[3]).toEqual({
      name: 'com.custom.PERMISSION',
      sensitive: false,
      level: 'unknown',
    });
    expect(out[5]).toEqual({
      name: 'android.permission.INTERNET',
      sensitive: false,
      level: 'normal',
    });
  });

  it('重复 / 空名字会被去重和过滤', () => {
    const out = derivePermissions([
      'android.permission.INTERNET',
      'android.permission.INTERNET',
      '',
      'android.permission.CAMERA',
    ]);
    expect(out.map((p) => p.name)).toEqual([
      'android.permission.CAMERA',
      'android.permission.INTERNET',
    ]);
  });

  it('空数组 → 空结果', () => {
    expect(derivePermissions([])).toEqual([]);
  });

  it('ANDROID_SENSITIVE_PERMISSIONS 是 LEVELS 的 dangerous 子集，自动派生', () => {
    for (const name of ANDROID_SENSITIVE_PERMISSIONS) {
      expect(ANDROID_PERMISSION_LEVELS[name]).toBe('dangerous');
    }
    // 至少包含 Camera / Microphone / Location 这种最常见的 dangerous
    expect(ANDROID_SENSITIVE_PERMISSIONS.has('android.permission.CAMERA')).toBe(true);
    expect(ANDROID_SENSITIVE_PERMISSIONS.has('android.permission.RECORD_AUDIO')).toBe(true);
    expect(ANDROID_SENSITIVE_PERMISSIONS.has('android.permission.ACCESS_FINE_LOCATION')).toBe(true);
  });
});

/* ================================================================== */
/* androidPermissionAnalyzer                                          */
/* ================================================================== */

describe('androidPermissionAnalyzer', () => {
  it('从真实 AXML 中抽出 permissions，带 level + sensitive', async () => {
    const manifest = makeAndroidManifest([
      'android.permission.INTERNET',
      'android.permission.CAMERA',
      'android.permission.ACCESS_FINE_LOCATION',
    ]);
    const { ctx, warnings } = makeCtx(manifest);
    const out = await androidPermissionAnalyzer.run(ctx);

    expect(out.permissions).toHaveLength(3);
    expect(out.permissions!.filter((p) => p.sensitive).map((p) => p.name).sort()).toEqual([
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.CAMERA',
    ]);
    const internet = out.permissions!.find((p) => p.name === 'android.permission.INTERNET')!;
    expect(internet.level).toBe('normal');
    expect(internet.sensitive).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('AndroidManifest.xml 缺失 → permissions=[] 且不重复报警告（manifest analyzer 已报）', async () => {
    const { ctx, warnings } = makeCtx(null);
    const out = await androidPermissionAnalyzer.run(ctx);
    expect(out.permissions).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('AXML 损坏 → permissions=[] + ANDROID_PERM_AXML_FAILED warning', async () => {
    const { ctx, warnings } = makeCtx(Buffer.alloc(16, 0xff));
    const out = await androidPermissionAnalyzer.run(ctx);
    expect(out.permissions).toEqual([]);
    expect(warnings.some((w) => w.code === 'ANDROID_PERM_AXML_FAILED')).toBe(true);
  });
});
