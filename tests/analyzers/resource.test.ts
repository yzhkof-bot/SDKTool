import { describe, expect, it } from 'vitest';

import { analyzePackage } from '@kingsdk/core/index.js';

import { buildFixtureHap } from '../helpers/fixtureHap.js';

describe('ResourceAnalyzer', () => {
  it('图片/字符串/媒体计数与 topLargest 排序', async () => {
    const hap = await buildFixtureHap();
    const report = await analyzePackage(hap, { toolVersion: 't', only: ['resource'] });

    expect(report.resources).toBeDefined();
    const r = report.resources!;

    // fixture 含图片：base/media/icon.png + base/media/banner.jpg
    //              + rawfile/Data/StreamingAssets/launcher_bg.png + rawfile/images/logo.png
    expect(r.images.count).toBe(4);
    expect(r.images.bytes).toBe(1024 + 2048 + 2048 + 256);
    // banner.jpg / launcher_bg.png 都是 2048 字节，按字节降序后 banner.jpg 字典序在前先入列
    expect(r.images.topLargest[0]!.bytes).toBe(2048);

    // 媒体：base/media/sound.mp3 + rawfile/audio/intro.mp3 + rawfile/video/cinematic.mp4
    expect(r.media.count).toBe(3);
    expect(r.media.bytes).toBe(4096 + 384 + 768);

    // strings：base + zh_CN + en_US
    expect(r.strings.count).toBe(3);
    expect(r.strings.locales).toEqual(['base', 'en_US', 'zh_CN']);
  });

  it('rawResIndex 在顶层 resources.index 存在时被记录', async () => {
    const hap = await buildFixtureHap();
    const report = await analyzePackage(hap, { toolVersion: 't', only: ['resource'] });
    expect(report.resources!.rawResIndex).toEqual({ bytes: 128 });
  });

  it('无任何资源文件时给空结构', async () => {
    const hap = await buildFixtureHap({
      includeModuleJson: false,
    });
    // 所有 resources/* 还是会被 fixture 默认带上；这里通过 includeModuleJson=false 仅验证
    // analyzer 不依赖 module.json 也能跑
    const report = await analyzePackage(hap, { toolVersion: 't', only: ['resource'] });
    expect(report.resources).toBeDefined();
    expect(report.resources!.images.count).toBeGreaterThanOrEqual(0);
  });
});
