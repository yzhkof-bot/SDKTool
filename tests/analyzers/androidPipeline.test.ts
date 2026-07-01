import { describe, expect, it } from 'vitest';

import { analyzePackage, diffPackageReports } from '@kingsdk/core/index.js';
import {
  buildFixtureApk,
  DEMO_APK_PACKAGE,
  DEMO_APK_PERMISSIONS,
  DEMO_APK_VERSION_CODE,
  DEMO_APK_VERSION_NAME,
} from '../helpers/fixtureApk.js';
import { buildSmokeDexLeft, buildSmokeDexRight } from '../helpers/fixtureDex.js';

describe('analyzePackage(platform=android) 端到端', () => {
  it('能跑完完整管线并产出带 platform=android 的 PackageReport', async () => {
    const apkPath = await buildFixtureApk();
    const report = await analyzePackage(apkPath, {
      toolVersion: 'test',
      platform: 'android',
    });

    expect(report.platform).toBe('android');
    expect(report.meta.file).toBe(apkPath);
  });

  it('androidManifest 字段被填充：package / version / permissions / components', async () => {
    const apkPath = await buildFixtureApk();
    const report = await analyzePackage(apkPath, {
      toolVersion: 'test',
      platform: 'android',
    });

    expect(report.androidManifest).toBeDefined();
    const m = report.androidManifest!;
    expect(m.packageName).toBe(DEMO_APK_PACKAGE);
    expect(m.versionCode).toBe(DEMO_APK_VERSION_CODE);
    expect(m.versionName).toBe(DEMO_APK_VERSION_NAME);
    expect(m.usesSdk).toEqual({ minSdkVersion: 21, targetSdkVersion: 33 });
    expect(m.usesPermissions).toEqual(DEMO_APK_PERMISSIONS);
    expect(m.components?.activities).toEqual([`${DEMO_APK_PACKAGE}.MainActivity`]);
    expect(m.applicationLabel).toBe('Demo');
  });

  it('basic 是从 manifest 派生的跨平台字段，bundleName=packageName', async () => {
    const apkPath = await buildFixtureApk();
    const report = await analyzePackage(apkPath, {
      toolVersion: 'test',
      platform: 'android',
    });

    expect(report.basic).toBeDefined();
    expect(report.basic!.bundleName).toBe(DEMO_APK_PACKAGE);
    expect(report.basic!.versionCode).toBe(DEMO_APK_VERSION_CODE);
    expect(report.basic!.versionName).toBe(DEMO_APK_VERSION_NAME);
    expect(report.basic!.targetAPIVersion).toBe(33);
    expect(report.basic!.minAPIVersion).toBe(21);
  });

  it('permissions 由 permission analyzer 派生：带 level + sensitive，CAMERA 是 dangerous', async () => {
    const apkPath = await buildFixtureApk();
    const report = await analyzePackage(apkPath, {
      toolVersion: 'test',
      platform: 'android',
    });

    expect(report.permissions).toBeDefined();
    expect(report.permissions!.map((p) => p.name).sort()).toEqual([...DEMO_APK_PERMISSIONS].sort());

    const camera = report.permissions!.find((p) => p.name === 'android.permission.CAMERA')!;
    expect(camera.sensitive).toBe(true);
    expect(camera.level).toBe('dangerous');

    const internet = report.permissions!.find((p) => p.name === 'android.permission.INTERNET')!;
    expect(internet.sensitive).toBe(false);
    expect(internet.level).toBe('normal');

    // 排序：dangerous 优先 → normal 在后
    expect(report.permissions![0]!.name).toBe('android.permission.CAMERA');
  });

  it('nativeLibs 扫描 lib/<abi>/*.so，覆盖 arm64 + x86_64', async () => {
    const apkPath = await buildFixtureApk();
    const report = await analyzePackage(apkPath, {
      toolVersion: 'test',
      platform: 'android',
    });

    expect(report.nativeLibs).toBeDefined();
    expect(report.nativeLibs!.architectures.sort()).toEqual(['arm64-v8a', 'x86_64']);
    expect(report.nativeLibs!.libs.map((l) => `${l.arch}/${l.name}`).sort()).toEqual(
      ['arm64-v8a/libbar.so', 'arm64-v8a/libfoo.so', 'x86_64/libfoo.so'],
    );
  });

  it('size analyzer 按 Android 规则归类：dex / assets / resources / libs / signature / config', async () => {
    const apkPath = await buildFixtureApk();
    const report = await analyzePackage(apkPath, {
      toolVersion: 'test',
      platform: 'android',
    });

    expect(report.size).toBeDefined();
    const categories = new Set(report.size!.breakdown.map((b) => b.category));
    expect(categories.has('dex')).toBe(true);
    expect(categories.has('assets')).toBe(true);
    expect(categories.has('resources')).toBe(true);
    expect(categories.has('libs')).toBe(true);
    expect(categories.has('signature')).toBe(true);
    expect(categories.has('config')).toBe(true);
  });

  it('dex 字段：fileCount=2 (classes.dex/classes2.dex)，header 信息完整', async () => {
    const apkPath = await buildFixtureApk();
    const report = await analyzePackage(apkPath, {
      toolVersion: 'test',
      platform: 'android',
    });

    expect(report.dex).toBeDefined();
    expect(report.dex!.fileCount).toBe(2);
    expect(report.dex!.totalBytes).toBeGreaterThan(0);
    expect(report.dex!.files.map((f) => f.path)).toEqual(['classes.dex', 'classes2.dex']);
    const c1 = report.dex!.files[0]!;
    expect(c1.magic).toBe('DEX');
    expect(c1.version).toBe('035');
    expect(c1.stringIds).toBeGreaterThan(0);
    const c2 = report.dex!.files[1]!;
    expect(c2.version).toBe('038');
  });

  it('apkSignature 字段：fixture APK 自带 v1 + v2 + v3，versions 三项全 true', async () => {
    const apkPath = await buildFixtureApk();
    const report = await analyzePackage(apkPath, {
      toolVersion: 'test',
      platform: 'android',
    });

    expect(report.signature).toBeDefined();
    expect(report.signature!.present).toBe(true);
    expect(report.signature!.versions).toEqual({
      v1: true,
      v2: true,
      v3: true,
      v31: false,
    });
    expect(report.signature!.signingBlock).toBeDefined();
    expect(report.signature!.signingBlock!.entries.map((e) => e.name)).toEqual([
      'V2 Signature',
      'V3 Signature',
      'Padding',
    ]);
  });

  it('dexDetails 默认关闭；通过 extras 显式开启后能抽出字符串分桶', async () => {
    const apkPath = await buildFixtureApk();

    // 默认运行 → 不开 extras
    const r1 = await analyzePackage(apkPath, {
      toolVersion: 'test',
      platform: 'android',
    });
    expect(r1.dexDetails).toBeUndefined();

    // 显式 extras 开启 → 有数
    const r2 = await analyzePackage(apkPath, {
      toolVersion: 'test',
      platform: 'android',
      extras: ['androidDexDetails'],
    });
    expect(r2.dexDetails).toBeDefined();
    expect(r2.dexDetails!.scanned).toBe(2);
    const classes1 = r2.dexDetails!.entries.find((e) => e.path === 'classes.dex')!;
    expect(classes1.strings?.totalDistinct).toBeGreaterThan(0);
    expect(classes1.strings?.classDescriptors).toContain('Lcom/king/demo/MainActivity;');
  });

  it('wb smoke：双 APK fixture compare → method add/remove/insns-changed/body-changed 四种信号都出', async () => {
    const leftApk = await buildFixtureApk({
      dexEntries: [{ path: 'classes.dex', content: buildSmokeDexLeft() }],
    });
    const rightApk = await buildFixtureApk({
      dexEntries: [{ path: 'classes.dex', content: buildSmokeDexRight() }],
    });

    const baseOptions = {
      toolVersion: 'smoke',
      platform: 'android' as const,
      extras: ['androidDexDetails'],
      dexHashMethodBodies: true,
    };
    const left = await analyzePackage(leftApk, baseOptions);
    const right = await analyzePackage(rightApk, baseOptions);

    const diff = diffPackageReports(left, right);

    expect(diff.dex).toBeDefined();
    expect(diff.dex!.changed.length).toBeGreaterThanOrEqual(1);

    expect(diff.dexDetails).toBeDefined();
    const dd = diff.dexDetails!;
    expect(dd.totals.methodsAdded).toBeGreaterThanOrEqual(1);
    expect(dd.totals.methodsRemoved).toBeGreaterThanOrEqual(1);
    expect(dd.totals.methodsChanged).toBeGreaterThanOrEqual(2);

    const classesEntry = dd.entries.find((e) => e.path === 'classes.dex');
    expect(classesEntry).toBeDefined();
    expect(classesEntry!.methodsDiff).toBeDefined();

    const md = classesEntry!.methodsDiff!;
    expect(md.added.map((m) => m.fullName)).toEqual(
      expect.arrayContaining(['Lcom/king/Util;->brandNew(Ljava/lang/String;)V']),
    );
    expect(md.removed.map((m) => m.fullName)).toEqual(
      expect.arrayContaining(['Lcom/king/Util;->oldMethod()V']),
    );
    const growChange = md.changed.find((c) => c.fullName === 'Lcom/king/Util;->grow(I)V');
    expect(growChange).toBeDefined();
    expect(growChange!.insnsSizeDelta).not.toBe(0);

    const commonChange = md.changed.find((c) => c.fullName === 'Lcom/king/Util;->common()V');
    expect(commonChange).toBeDefined();
    expect(commonChange!.bodyChanged).toBe(true);
    expect(commonChange!.insnsSizeDelta).toBe(0);
  });

  it('AndroidManifest.xml 缺失时 manifest analyzer 写 error warning 但其它 analyzer 仍继续跑', async () => {
    const apkPath = await buildFixtureApk({ skipManifest: true });
    const report = await analyzePackage(apkPath, {
      toolVersion: 'test',
      platform: 'android',
    });

    expect(report.androidManifest).toBeUndefined();
    expect(report.basic).toBeUndefined();
    // size / nativeLibs 仍然有数据
    expect(report.size).toBeDefined();
    expect(report.nativeLibs).toBeDefined();
    const errWarn = report.warnings.find((w) => w.code === 'ANDROID_MANIFEST_MISSING');
    expect(errWarn).toBeDefined();
    expect(errWarn!.level).toBe('error');
  });
});
