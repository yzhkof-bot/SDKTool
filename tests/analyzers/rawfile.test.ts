import { describe, expect, it } from 'vitest';

import { analyzePackage } from '../../src/core/index.js';

import { buildFixtureHap } from '../helpers/fixtureHap.js';

describe('RawfileAnalyzer', () => {
  it('生成顶层分组、扩展名、类别、Top N、Package 聚合', async () => {
    const hap = await buildFixtureHap();
    const report = await analyzePackage(hap, { toolVersion: 't', only: ['rawfile'] });

    expect(report.rawfile).toBeDefined();
    const rf = report.rawfile!;

    // fixture 总共注入了 14 个 resources/rawfile/* 条目
    expect(rf.fileCount).toBe(14);
    expect(rf.totalBytes).toBeGreaterThan(0);
    // 总字节 = 16384 + 8192 + 8 + 4096 + 2048 + 1024 + 2048 + 11 + 512 + 256 + 384 + 768 + 7 + 12
    expect(rf.totalBytes).toBe(35750);

    // 顶层分组：Data/* 抓两段，其它一段
    const groupMap = new Map(rf.topLevelGroups.map((g) => [g.path, g]));
    expect(groupMap.has('Data/Managed')).toBe(true);
    expect(groupMap.has('Data/Package')).toBe(true);
    expect(groupMap.has('Data/StreamingAssets')).toBe(true);
    expect(groupMap.has('asset')).toBe(true);
    expect(groupMap.has('lua')).toBe(true);
    expect(groupMap.has('textures')).toBe(true);
    expect(groupMap.has('images')).toBe(true);
    // Data/Package 下 fileCount=3 (9_0.db + 9_meta.json + 3002_0.db)
    expect(groupMap.get('Data/Package')!.fileCount).toBe(3);

    // 顶层分组按 bytes 降序：Data/Managed 16KB > Data/Package 12KB+
    expect(rf.topLevelGroups[0]!.path).toBe('Data/Managed');

    // 比例和 ≈ 1（浮点容差）
    const sumRatio = rf.topLevelGroups.reduce((s, g) => s + g.ratio, 0);
    expect(sumRatio).toBeCloseTo(1, 5);

    // 扩展名分布：'.db' / '.dat' / '.png' / '.json' / '.dla' / '.lua' / '.pvr' / '.mp3' / '.mp4' / '.ab' / '(none)'
    const extMap = new Map(rf.byExtension.map((e) => [e.ext, e]));
    expect(extMap.has('.db')).toBe(true);
    expect(extMap.has('.dat')).toBe(true);
    expect(extMap.has('.lua')).toBe(true);
    expect(extMap.has('.pvr')).toBe(true);
    expect(extMap.has('.dla')).toBe(true);
    expect(extMap.has('.ab')).toBe(true);
    expect(extMap.has('(none)')).toBe(true);

    // .db 命中 2 个文件
    expect(extMap.get('.db')!.fileCount).toBe(2);

    // 类别识别
    const catMap = new Map(rf.categories.map((c) => [c.category, c]));
    expect(catMap.get('il2cpp-metadata')!.fileCount).toBe(1);
    expect(catMap.get('qts-vfs')!.fileCount).toBe(2);
    expect(catMap.get('streaming-asset')!.fileCount).toBe(1);
    expect(catMap.get('asset-bundle')!.fileCount).toBe(1);
    expect(catMap.get('ai-model')!.fileCount).toBe(1);
    expect(catMap.get('script')!.fileCount).toBe(1);
    expect(catMap.get('texture')!.fileCount).toBe(1);
    expect(catMap.get('image')!.fileCount).toBe(1);
    expect(catMap.get('audio')!.fileCount).toBe(1);
    expect(catMap.get('video')!.fileCount).toBe(1);
    expect(catMap.get('data')!.fileCount).toBe(2); // 9_meta.json + config/global.json
    expect(catMap.get('other')!.fileCount).toBe(1); // no_ext_file

    // 路径强特征 > 扩展名规则：launcher_bg.png 命中 streaming-asset 而不是 image
    const launcher = rf.topFiles.find((f) => f.path.endsWith('launcher_bg.png'));
    expect(launcher?.category).toBe('streaming-asset');

    // global-metadata.dat 命中 il2cpp-metadata 而不是 data
    const meta = rf.topFiles.find((f) => f.path.endsWith('global-metadata.dat'));
    expect(meta?.category).toBe('il2cpp-metadata');

    // Top N 排序
    expect(rf.topFiles[0]!.path).toBe('Data/Managed/Metadata/global-metadata.dat');
    expect(rf.topFiles[0]!.bytes).toBe(16384);

    // Package 聚合：仅 Data/Package/builtin/<id>/* 命中
    expect(rf.packages).toBeDefined();
    const pkgMap = new Map(rf.packages!.map((p) => [p.packageId, p]));
    expect(pkgMap.get('9')!.fileCount).toBe(2); // 9_0.db + 9_meta.json
    expect(pkgMap.get('9')!.bytes).toBe(8192 + 8);
    expect(pkgMap.get('3002')!.fileCount).toBe(1);
    expect(pkgMap.get('3002')!.bytes).toBe(4096);
  });

  it('topFilesLimit 控制 Top N 数量', async () => {
    const hap = await buildFixtureHap();
    const report = await analyzePackage(hap, {
      toolVersion: 't',
      only: ['rawfile'],
      topFilesLimit: 3,
    });
    expect(report.rawfile!.topFiles).toHaveLength(3);
  });

  it('rawfile 为空时不返回 rawfile 字段', async () => {
    // 通过 includeModuleJson:false 不影响 rawfile 维度，
    // 但我们没有专门的"空 rawfile fixture"——所以这里通过 only:[] + 自定义 analyzer 测不到位。
    // 改为：直接在 analyzer 上跑没有 resources/rawfile/ 的 fixture：
    //   buildFixtureHap 默认会写 14 个 rawfile 条目，因此这个 case 走 unit-style，
    //   通过 mock 一个空 entries 的 VirtualPackage。
    const { rawfileAnalyzer } = await import('../../src/core/analyzers/harmony/rawfile.js');
    const ctx = {
      hap: {
        filePath: '/tmp/empty.hap',
        fileSize: 0,
        sha256: '',
        entries: [],
        readFile: async () => Buffer.alloc(0),
        readText: async () => '',
        close: async () => {},
      },
      options: { toolVersion: 't' },
      addWarning: () => {},
    };
    const out = await rawfileAnalyzer.run(ctx);
    expect(out.rawfile).toBeUndefined();
  });

  it('未命中 builtin/<id>/* 时 packages 字段省略', async () => {
    const { rawfileAnalyzer } = await import('../../src/core/analyzers/harmony/rawfile.js');
    const ctx = {
      hap: {
        filePath: '/tmp/x.hap',
        fileSize: 0,
        sha256: '',
        entries: [
          {
            path: 'resources/rawfile/foo/bar.png',
            isDirectory: false,
            uncompressedSize: 100,
            compressedSize: 50,
          },
        ],
        readFile: async () => Buffer.alloc(0),
        readText: async () => '',
        close: async () => {},
      },
      options: { toolVersion: 't' },
      addWarning: () => {},
    };
    const out = await rawfileAnalyzer.run(ctx);
    expect(out.rawfile).toBeDefined();
    expect(out.rawfile!.packages).toBeUndefined();
  });
});
