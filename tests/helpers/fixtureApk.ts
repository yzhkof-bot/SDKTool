/**
 * Android APK fixture builder：构造一个最小可分析的 .apk 文件。
 *
 * 内容覆盖：
 *  - 真实 AXML 二进制的 AndroidManifest.xml（用 fixtureAxml 生成）
 *  - lib/<abi>/*.so      → nativeLib analyzer
 *  - res/raw/*           → size analyzer 的 resources 分类
 *  - assets/*            → size analyzer 的 assets 分类
 *  - classes*.dex 占位   → size analyzer 的 dex 分类
 *  - META-INF/CERT.RSA   → size analyzer 的 signature 分类
 *  - resources.arsc      → size analyzer 的 config 分类（特例）
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { writeMiniZip, type ZipEntry } from './miniZip.js';
import { buildAxml } from './fixtureAxml.js';
import { buildDemoDex, buildDex } from './fixtureDex.js';
import { buildDemoApkSigningBlock } from './fixtureApkSigBlock.js';

const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

export interface FixtureApkOptions {
  /** 自定义 manifest buffer；不传则用 demo manifest */
  manifestBuffer?: Buffer;
  /** 不写 AndroidManifest.xml（测 analyzer 缺失场景） */
  skipManifest?: boolean;
  /** 额外加入的 entry */
  extraEntries?: ZipEntry[];
  /**
   * 不写 APK Signing Block（仅 v1 签名场景）。默认会用 buildDemoApkSigningBlock 注入 v2+v3+padding。
   */
  skipSigningBlock?: boolean;
  /**
   * 自定义 signing block buffer；不传则用 buildDemoApkSigningBlock。
   */
  signingBlock?: Buffer;
  /**
   * 自定义 DEX entries（path + content）。不传则使用默认 classes.dex + classes2.dex demo。
   * 传入数组时完全替换默认 DEX（用来做 method-level diff smoke）。
   */
  dexEntries?: Array<{ path: string; content: Buffer }>;
}

/**
 * 用 fixtureAxml 构造一个 demo manifest（package=com.king.demo.android）。
 * 单独导出方便测试断言里直接对比预期值。
 */
export const DEMO_APK_PACKAGE = 'com.king.demo.android';
export const DEMO_APK_VERSION_CODE = 1234;
export const DEMO_APK_VERSION_NAME = '1.2.3';
export const DEMO_APK_PERMISSIONS = [
  'android.permission.INTERNET',
  'android.permission.CAMERA',
];

export function buildDemoApkManifest(): Buffer {
  return buildAxml({
    namespaces: [{ prefix: 'android', uri: ANDROID_NS }],
    root: {
      name: 'manifest',
      attributes: [
        { name: 'package', value: { kind: 'string', value: DEMO_APK_PACKAGE } },
        { ns: ANDROID_NS, name: 'versionCode', value: { kind: 'int', value: DEMO_APK_VERSION_CODE } },
        { ns: ANDROID_NS, name: 'versionName', value: { kind: 'string', value: DEMO_APK_VERSION_NAME } },
      ],
      children: [
        {
          name: 'uses-sdk',
          attributes: [
            { ns: ANDROID_NS, name: 'minSdkVersion', value: { kind: 'int', value: 21 } },
            { ns: ANDROID_NS, name: 'targetSdkVersion', value: { kind: 'int', value: 33 } },
          ],
        },
        ...DEMO_APK_PERMISSIONS.map((name) => ({
          name: 'uses-permission',
          attributes: [{ ns: ANDROID_NS, name: 'name', value: { kind: 'string', value: name } as const }],
        })),
        {
          name: 'application',
          attributes: [
            { ns: ANDROID_NS, name: 'label', value: { kind: 'string', value: 'Demo' } },
          ],
          children: [
            {
              name: 'activity',
              attributes: [
                { ns: ANDROID_NS, name: 'name', value: { kind: 'string', value: '.MainActivity' } },
              ],
            },
          ],
        },
      ],
    },
  });
}

/** 在临时目录创建一个 demo.apk，返回路径 */
export async function buildFixtureApk(options: FixtureApkOptions = {}): Promise<string> {
  const dir = join(tmpdir(), `kingsdk-apk-${randomBytes(6).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, 'demo.apk');

  const entries: ZipEntry[] = [];

  if (!options.skipManifest) {
    entries.push({
      path: 'AndroidManifest.xml',
      content: options.manifestBuffer ?? buildDemoApkManifest(),
    });
  }

  // 经典 Android 包内文件，覆盖 size analyzer 的各分类。
  // classes.dex 用 fixtureDex 构造一个合法 DEX（demo 字符串集），
  // classes2.dex 用一组不同字符串，便于 dexDetails 区分两个 dex 的字符串集。
  if (options.dexEntries && options.dexEntries.length > 0) {
    for (const e of options.dexEntries) {
      entries.push({ path: e.path, content: e.content });
    }
  } else {
    entries.push({ path: 'classes.dex', content: buildDemoDex() });
    entries.push({
      path: 'classes2.dex',
      content: buildDex({
        version: '038',
        strings: ['Lcom/king/demo/Secondary;', 'helperFunction', 'helper.kt'],
      }),
    });
  }
  entries.push({ path: 'resources.arsc', content: Buffer.alloc(2048, 3) });
  entries.push({ path: 'res/drawable-hdpi/ic_launcher.png', content: Buffer.alloc(1024, 4) });
  entries.push({ path: 'res/values/strings.xml', content: '<resources/>' });
  entries.push({ path: 'assets/config.json', content: '{"v":1}' });
  entries.push({ path: 'assets/world/level1.json', content: '{}' });
  entries.push({ path: 'lib/arm64-v8a/libfoo.so', content: Buffer.alloc(4096, 5) });
  entries.push({ path: 'lib/arm64-v8a/libbar.so', content: Buffer.alloc(2048, 6) });
  entries.push({ path: 'lib/x86_64/libfoo.so', content: Buffer.alloc(3072, 7) });
  entries.push({ path: 'META-INF/MANIFEST.MF', content: 'Manifest-Version: 1.0\n' });
  entries.push({ path: 'META-INF/CERT.SF', content: 'fake signature\n' });
  entries.push({ path: 'META-INF/CERT.RSA', content: Buffer.alloc(256, 8) });

  if (options.extraEntries) entries.push(...options.extraEntries);

  await mkdir(dirname(filePath), { recursive: true });
  const signingBlock = options.skipSigningBlock
    ? undefined
    : (options.signingBlock ?? buildDemoApkSigningBlock());
  await writeMiniZip(filePath, entries, {
    extraBeforeCentral: signingBlock,
  });
  return filePath;
}
