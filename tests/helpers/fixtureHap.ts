import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { writeMiniZip, type ZipEntry } from './miniZip.js';

/** 默认 demo module.json 内容 —— 模拟 HarmonyOS 的真实结构 */
export const DEMO_MODULE_JSON = {
  app: {
    bundleName: 'com.king.demo',
    bundleType: 'app',
    versionCode: 1000000,
    versionName: '1.0.0',
    targetAPIVersion: 11,
    minAPIVersion: 9,
  },
  module: {
    name: 'entry',
    type: 'entry',
    deviceTypes: ['phone', 'tablet'],
    abilities: [
      { name: 'EntryAbility', type: 'page', visible: true },
      { name: 'BackgroundAbility', type: 'service', visible: false },
    ],
    requestPermissions: [
      // 敏感权限，应该被标记 sensitive=true
      {
        name: 'ohos.permission.LOCATION',
        reason: '$string:perm_reason_location',
        usedScene: { abilities: ['EntryAbility'], when: 'inuse' },
      },
      {
        name: 'ohos.permission.CAMERA',
        reason: '$string:perm_reason_camera',
      },
      // 普通权限
      { name: 'ohos.permission.INTERNET' },
      { name: 'ohos.permission.GET_NETWORK_INFO' }, // 也在敏感清单
    ],
    dependencies: [
      { bundleName: 'com.king.shared', moduleName: 'libcommon', versionCode: 100 },
      { moduleName: 'libutil', versionCode: 50 },
    ],
  },
};

/** 默认 pack.info：声明 entry 自己 + 一个 shared 模块（HSP）+ 一个 har 模块 */
export const DEMO_PACK_INFO = {
  summary: {
    app: { bundleName: 'com.king.demo', version: { code: 1000000, name: '1.0.0' } },
    modules: [
      { name: 'entry', type: 'entry' },
      { name: 'libcommon', type: 'shared' },
      { name: 'libutil', type: 'har' },
    ],
  },
};

export interface FixtureBuildOptions {
  /** 自定义 module.json 内容；不传则用 DEMO_MODULE_JSON */
  moduleJson?: unknown;
  /** 是否包含 module.json 文件 */
  includeModuleJson?: boolean;
  /** 是否包含 pack.info */
  includePackInfo?: boolean;
  /** 额外加入的 entry */
  extraEntries?: ZipEntry[];
}

/** 在临时目录创建一个 demo.hap，返回路径。测试结束后由 OS 清理 */
export async function buildFixtureHap(options: FixtureBuildOptions = {}): Promise<string> {
  const dir = join(tmpdir(), `kingsdk-${randomBytes(6).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, 'demo.hap');

  const entries: ZipEntry[] = [];

  if (options.includeModuleJson !== false) {
    entries.push({
      path: 'module.json',
      content: JSON.stringify(options.moduleJson ?? DEMO_MODULE_JSON, null, 2),
    });
  }

  if (options.includePackInfo) {
    entries.push({
      path: 'pack.info',
      content: JSON.stringify(DEMO_PACK_INFO),
    });
  }

  // 一些常见目录的伪文件，覆盖各 analyzer 路径
  entries.push({ path: 'ets/modules.abc', content: Buffer.alloc(2048, 1) });
  entries.push({ path: 'ets/sourceMaps.map', content: Buffer.alloc(512, 2) });
  entries.push({ path: 'ets/library/modules.abc', content: Buffer.alloc(256, 7) });
  entries.push({ path: 'resources.index', content: Buffer.alloc(128, 0) });
  entries.push({ path: 'resources/base/element/string.json', content: '{"strings":{}}' });
  entries.push({ path: 'resources/zh_CN/element/string.json', content: '{"strings":{}}' });
  entries.push({ path: 'resources/en_US/element/string.json', content: '{"strings":{}}' });
  entries.push({ path: 'resources/base/media/icon.png', content: Buffer.alloc(1024, 3) });
  entries.push({ path: 'resources/base/media/banner.jpg', content: Buffer.alloc(2048, 8) });
  entries.push({ path: 'resources/base/media/sound.mp3', content: Buffer.alloc(4096, 9) });
  entries.push({ path: 'libs/arm64-v8a/libfoo.so', content: Buffer.alloc(4096, 4) });
  entries.push({ path: 'libs/arm64-v8a/libbar.so', content: Buffer.alloc(8192, 5) });
  entries.push({ path: 'libs/x86_64/libfoo.so', content: Buffer.alloc(3072, 10) });
  entries.push({ path: 'META-INF/CERT.SF', content: 'fake signature manifest' });
  entries.push({ path: 'META-INF/CERT.RSA', content: Buffer.alloc(128, 6) });
  entries.push({ path: 'rawfile/manifest.txt', content: 'rawfile' });

  // 典型 QTS / Unity / il2cpp rawfile 布局（覆盖 rawfileAnalyzer 的所有识别规则）
  entries.push({
    path: 'resources/rawfile/Data/Managed/Metadata/global-metadata.dat',
    content: Buffer.alloc(16384, 11), // il2cpp-metadata
  });
  entries.push({
    path: 'resources/rawfile/Data/Package/builtin/9/9_0.db',
    content: Buffer.alloc(8192, 12), // qts-vfs, package id=9
  });
  entries.push({
    path: 'resources/rawfile/Data/Package/builtin/9/9_meta.json',
    content: '{"id":9}', // 也归到 package 9，但扩展名 .json，category=data
  });
  entries.push({
    path: 'resources/rawfile/Data/Package/builtin/3002/3002_0.db',
    content: Buffer.alloc(4096, 13), // qts-vfs, package id=3002
  });
  entries.push({
    path: 'resources/rawfile/Data/StreamingAssets/launcher_bg.png',
    content: Buffer.alloc(2048, 14), // streaming-asset（路径优先，比 image 高）
  });
  entries.push({
    path: 'resources/rawfile/asset/world.ab',
    content: Buffer.alloc(1024, 15), // asset-bundle
  });
  entries.push({
    path: 'resources/rawfile/asr/asr_model.dla',
    content: Buffer.alloc(2048, 16), // ai-model
  });
  entries.push({
    path: 'resources/rawfile/lua/main.lua',
    content: 'print("hi")', // script
  });
  entries.push({
    path: 'resources/rawfile/textures/skin01.pvr',
    content: Buffer.alloc(512, 17), // texture
  });
  entries.push({
    path: 'resources/rawfile/images/logo.png',
    content: Buffer.alloc(256, 18), // image（无 path 强特征，扩展名命中）
  });
  entries.push({
    path: 'resources/rawfile/audio/intro.mp3',
    content: Buffer.alloc(384, 19), // audio
  });
  entries.push({
    path: 'resources/rawfile/video/cinematic.mp4',
    content: Buffer.alloc(768, 20), // video
  });
  entries.push({
    path: 'resources/rawfile/config/global.json',
    content: '{"v":1}', // data
  });
  entries.push({
    path: 'resources/rawfile/etc/no_ext_file',
    content: 'no extension', // other / 扩展名 (none)
  });

  if (options.extraEntries) {
    entries.push(...options.extraEntries);
  }

  await mkdir(dirname(filePath), { recursive: true });
  await writeMiniZip(filePath, entries);

  return filePath;
}
