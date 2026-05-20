import { describe, expect, it } from 'vitest';

import {
  DEX_ENDIAN_CONSTANT,
  DEX_HEADER_SIZE,
  extractDexMethods,
  extractDexStringList,
  parseDexHeader,
  readUleb128,
} from '../../src/core/analyzers/android/_dex.js';
import { androidDexAnalyzer } from '../../src/core/analyzers/android/dex.js';
import { androidDexDetailsAnalyzer } from '../../src/core/analyzers/android/dexDetails.js';
import type { AnalyzerContext, VirtualPackage } from '../../src/shared/schema.js';

import {
  DEMO_DEX_STRINGS,
  buildDemoDex,
  buildDemoDexWithMethods,
  buildDex,
} from '../helpers/fixtureDex.js';

/* ------------------------------------------------------------------ */
/* 共用：内存版 VirtualPackage（不走 zip / 磁盘，纯单测）                */
/* ------------------------------------------------------------------ */

function makeMemoryPackage(files: Record<string, Buffer>): VirtualPackage {
  const entries = Object.entries(files).map(([path, content]) => ({
    path,
    isDirectory: false,
    uncompressedSize: content.length,
    compressedSize: content.length,
  }));
  return {
    filePath: 'memory://test.apk',
    fileSize: Object.values(files).reduce((s, b) => s + b.length, 0),
    sha256: 'a'.repeat(64),
    entries,
    readFile: async (p) => {
      const buf = files[p];
      if (!buf) throw new Error(`memory package: no entry ${p}`);
      return buf;
    },
    readText: async (p) => {
      const buf = files[p];
      if (!buf) throw new Error(`memory package: no entry ${p}`);
      return buf.toString('utf-8');
    },
    close: async () => {},
  };
}

function makeCtx(pkg: VirtualPackage, options: Partial<AnalyzerContext['options']> = {}): {
  ctx: AnalyzerContext;
  warnings: AnalyzerContext extends { addWarning: (w: infer W) => void } ? W[] : never;
} {
  const warnings: Parameters<AnalyzerContext['addWarning']>[0][] = [];
  return {
    ctx: {
      hap: pkg,
      options: { topFilesLimit: 5, toolVersion: 'test', ...options },
      platform: 'android',
      addWarning: (w) => warnings.push(w),
    },
    warnings: warnings as never,
  };
}

/* ================================================================== */
/* parseDexHeader / extractDexStringList                              */
/* ================================================================== */

describe('parseDexHeader', () => {
  it('解析合法 DEX header 的所有计数字段', () => {
    const buf = buildDemoDex();
    const header = parseDexHeader(buf);

    expect(header.magic).toBe('DEX');
    expect(header.version).toBe('035');
    expect(header.endianTag).toBe(DEX_ENDIAN_CONSTANT);
    expect(header.headerSize).toBe(DEX_HEADER_SIZE);
    expect(header.fileSize).toBe(buf.length);
    expect(header.stringIds?.size).toBe(DEMO_DEX_STRINGS.length);
    // fixture 里 type/proto/field/method/class 表都为空
    expect(header.typeIds?.size).toBe(0);
    expect(header.methodIds?.size).toBe(0);
    expect(header.classDefs?.size).toBe(0);
  });

  it('版本字符串支持 035 / 038 / 039', () => {
    for (const v of ['035', '038', '039']) {
      const buf = buildDex({ version: v, strings: [] });
      expect(parseDexHeader(buf).version).toBe(v);
    }
  });

  it('buf 太短 → magic=INVALID 且全部字段 null', () => {
    const header = parseDexHeader(Buffer.alloc(32));
    expect(header.magic).toBe('INVALID');
    expect(header.version).toBeNull();
    expect(header.stringIds).toBeNull();
  });

  it('magic 不识别 → INVALID', () => {
    const buf = Buffer.alloc(DEX_HEADER_SIZE);
    buf.write('XXXX', 0, 'ascii');
    expect(parseDexHeader(buf).magic).toBe('INVALID');
  });

  it('endian_tag 不是标准小端常量 → INVALID（但保留已识别的 magic/version）', () => {
    const buf = buildDemoDex();
    buf.writeUInt32LE(0xdeadbeef, 0x28); // 破坏 endian
    const header = parseDexHeader(buf);
    expect(header.magic).toBe('DEX');
    expect(header.version).toBe('035');
    // endian 失败后所有 size/off 应被置空
    expect(header.stringIds).toBeNull();
    expect(header.fileSize).toBeNull();
  });

  it('识别 Compact DEX (cdex)', () => {
    const buf = buildDemoDex();
    // 把前 4 字节改为 "cdex"
    Buffer.from('cdex', 'ascii').copy(buf, 0);
    expect(parseDexHeader(buf).magic).toBe('CDEX');
  });
});

describe('extractDexStringList', () => {
  it('按 string_ids 索引顺序返回原始字符串列表', () => {
    const buf = buildDemoDex();
    const header = parseDexHeader(buf);
    const strs = extractDexStringList(buf, header.stringIds!.size, header.stringIds!.off);
    expect(strs).toEqual(DEMO_DEX_STRINGS);
  });

  it('size=0 → 空数组（不读 string_ids 区）', () => {
    expect(extractDexStringList(Buffer.alloc(0x70), 0, 0x70)).toEqual([]);
  });

  it('string_ids 区超出 buffer → 空数组（防越界）', () => {
    const buf = Buffer.alloc(0x80);
    expect(extractDexStringList(buf, 100, 0x70)).toEqual([]);
  });
});

/* ================================================================== */
/* androidDexAnalyzer（default analyzer）                              */
/* ================================================================== */

describe('androidDexAnalyzer', () => {
  it('扫到 classes.dex / classes2.dex 并产出 DexInfo（按 path 排序）', async () => {
    const pkg = makeMemoryPackage({
      'classes.dex': buildDemoDex(),
      'classes2.dex': buildDex({ version: '038', strings: ['Lfoo;', 'Lbar;'] }),
      'AndroidManifest.xml': Buffer.alloc(8),
      'lib/arm64-v8a/libfoo.so': Buffer.alloc(16),
    });
    const { ctx, warnings } = makeCtx(pkg);
    const out = await androidDexAnalyzer.run(ctx);

    expect(out.dex?.fileCount).toBe(2);
    expect(out.dex?.totalBytes).toBeGreaterThan(0);
    expect(out.dex?.files.map((f) => f.path)).toEqual(['classes.dex', 'classes2.dex']);

    const c1 = out.dex!.files[0]!;
    expect(c1.magic).toBe('DEX');
    expect(c1.version).toBe('035');
    expect(c1.stringIds).toBe(DEMO_DEX_STRINGS.length);

    const c2 = out.dex!.files[1]!;
    expect(c2.version).toBe('038');
    expect(c2.stringIds).toBe(2);

    expect(warnings).toEqual([]);
  });

  it('没有 classes*.dex → 仍返回 fileCount=0 的空 DexInfo（不报警告）', async () => {
    const pkg = makeMemoryPackage({
      'AndroidManifest.xml': Buffer.alloc(8),
    });
    const { ctx, warnings } = makeCtx(pkg);
    const out = await androidDexAnalyzer.run(ctx);

    expect(out.dex).toEqual({ fileCount: 0, totalBytes: 0, files: [] });
    expect(warnings).toEqual([]);
  });

  it('classes.dex header 损坏 → 该 entry magic=INVALID + 警告', async () => {
    const pkg = makeMemoryPackage({
      'classes.dex': Buffer.alloc(0x70), // 全 0：magic 不识别
      'classes2.dex': buildDemoDex(),
    });
    const { ctx, warnings } = makeCtx(pkg);
    const out = await androidDexAnalyzer.run(ctx);

    expect(out.dex?.files).toHaveLength(2);
    const invalid = out.dex!.files.find((f) => f.path === 'classes.dex')!;
    expect(invalid.magic).toBe('INVALID');
    expect(invalid.version).toBeNull();
    expect(warnings.some((w) => w.code === 'DEX_HEADER_INVALID')).toBe(true);
  });

  it('不会把 META-INF/services/classes.dex 这种"非顶层 dex"当作 classes*.dex', async () => {
    const pkg = makeMemoryPackage({
      'META-INF/services/classes.dex': buildDemoDex(),
      'something/classes.dex': buildDemoDex(),
    });
    const { ctx } = makeCtx(pkg);
    const out = await androidDexAnalyzer.run(ctx);
    expect(out.dex?.fileCount).toBe(0);
  });
});

/* ================================================================== */
/* androidDexDetailsAnalyzer（extras analyzer）                        */
/* ================================================================== */

describe('androidDexDetailsAnalyzer', () => {
  it('字符串分桶覆盖 classDescriptors / methodSignatures / sourceFiles / identifiers / other', async () => {
    const pkg = makeMemoryPackage({ 'classes.dex': buildDemoDex() });
    const { ctx } = makeCtx(pkg);
    const out = await androidDexDetailsAnalyzer.run(ctx);

    expect(out.dexDetails?.scanned).toBe(1);
    const entry = out.dexDetails!.entries[0]!;
    expect(entry.path).toBe('classes.dex');
    expect(entry.bytes).toBe(buildDemoDex().length);
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);

    const s = entry.strings!;
    expect(s.totalDistinct).toBe(DEMO_DEX_STRINGS.length);
    expect(s.classDescriptors).toEqual([
      'Landroidx/core/app/ActivityCompat;',
      'Lcom/king/demo/MainActivity;',
    ]);
    expect(s.methodSignatures).toEqual([
      '(Landroid/os/Bundle;)V',
      '(Ljava/lang/String;I)Ljava/lang/Object;',
    ]);
    expect(s.sourceFiles).toEqual(['AndroidManifestParser.kt', 'MainActivity.java']);
    expect(s.identifiers).toEqual(['onCreate', 'requestPermissions']);
    // <init> / <clinit> 不匹配任何强规则，落入 other
    expect(s.other).toEqual(['<clinit>', '<init>']);
    expect(s.extractLimit).toBe(0);
    expect(s.truncated).toBe(false);
  });

  it('dexStringExtractLimit 截断每个分桶', async () => {
    const pkg = makeMemoryPackage({ 'classes.dex': buildDemoDex() });
    const { ctx } = makeCtx(pkg, { dexStringExtractLimit: 1 });
    const out = await androidDexDetailsAnalyzer.run(ctx);

    const s = out.dexDetails!.entries[0]!.strings!;
    expect(s.classDescriptors).toHaveLength(1);
    expect(s.methodSignatures).toHaveLength(1);
    expect(s.sourceFiles).toHaveLength(1);
    expect(s.identifiers).toHaveLength(1);
    expect(s.other).toHaveLength(1);
    expect(s.extractLimit).toBe(1);
    expect(s.truncated).toBe(true);
  });

  it('CDEX / INVALID magic 不抽 strings（只填 sha256 + bytes）', async () => {
    const cdex = buildDemoDex();
    Buffer.from('cdex', 'ascii').copy(cdex, 0);
    const pkg = makeMemoryPackage({ 'classes.dex': cdex });
    const { ctx } = makeCtx(pkg);
    const out = await androidDexDetailsAnalyzer.run(ctx);
    const entry = out.dexDetails!.entries[0]!;
    expect(entry.strings).toBeUndefined();
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* ================================================================== */
/* readUleb128（_dex.ts 抽出的 helper）                                */
/* ================================================================== */

describe('readUleb128', () => {
  it('单字节值 0 / 1 / 127 正常返回', () => {
    expect(readUleb128(Buffer.from([0x00]), 0)).toEqual({ value: 0, bytes: 1 });
    expect(readUleb128(Buffer.from([0x7f]), 0)).toEqual({ value: 127, bytes: 1 });
  });

  it('多字节值 128 / 16384 正常返回', () => {
    expect(readUleb128(Buffer.from([0x80, 0x01]), 0)).toEqual({ value: 128, bytes: 2 });
    expect(readUleb128(Buffer.from([0x80, 0x80, 0x01]), 0)).toEqual({ value: 16384, bytes: 3 });
  });

  it('超过 5 字节边界返回 null（避免无限累加损坏 dex）', () => {
    const bad = Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x01]);
    expect(readUleb128(bad, 0)).toBeNull();
  });
});

/* ================================================================== */
/* extractDexMethods + fixtureDex.buildDex round-trip                  */
/* ================================================================== */

describe('extractDexMethods + buildDex (method-level round-trip)', () => {
  it('buildDemoDexWithMethods → 解出 4 个方法，fullName/insnsSize/registers 全对', () => {
    const dex = buildDemoDexWithMethods();
    const header = parseDexHeader(dex);
    expect(header.magic).toBe('DEX');

    const { methods, truncated, warnings } = extractDexMethods(dex, header);
    expect(warnings).toEqual([]);
    expect(truncated).toBe(false);
    expect(methods).toHaveLength(4);

    const byFullName = new Map(methods.map((m) => [m.fullName, m]));

    const init = byFullName.get('Lcom/king/demo/MainActivity;-><init>()V')!;
    expect(init.hasCode).toBe(true);
    expect(init.insnsSize).toBe(2); // DEFAULT_INSNS = 4 字节 = 2 code units
    expect(init.registers).toBe(1);
    expect(init.classDescriptor).toBe('Lcom/king/demo/MainActivity;');
    expect(init.name).toBe('<init>');
    expect(init.proto).toBe('()V');

    const onCreate = byFullName.get(
      'Lcom/king/demo/MainActivity;->onCreate(Landroid/os/Bundle;)V',
    )!;
    expect(onCreate.insnsSize).toBe(4); // makeInsns(8) = 8 字节 = 4 code units
    expect(onCreate.registers).toBe(2);

    const add = byFullName.get('Lcom/king/demo/Utils;->add(II)I')!;
    expect(add.insnsSize).toBe(3); // makeInsns(6) = 6 字节 = 3 code units
    expect(add.registers).toBe(3);

    // noop 是 abstract（无 insnsBytes）→ hasCode=false / insnsSize=null / registers=null
    const noop = byFullName.get('Lcom/king/demo/Utils;->noop()V')!;
    expect(noop.hasCode).toBe(false);
    expect(noop.insnsSize).toBeNull();
    expect(noop.registers).toBeNull();
  });

  it('hashBodies=true 时 insnsBytes 段被填充（differ body-changed 信号基础）', () => {
    const dex = buildDemoDexWithMethods();
    const header = parseDexHeader(dex);
    const { methods } = extractDexMethods(dex, header, { hashBodies: true });
    const withCode = methods.filter((m) => m.hasCode);
    expect(withCode.length).toBe(3);
    for (const m of withCode) {
      expect(m.insnsBytes).not.toBeNull();
      expect(m.insnsBytes!.length).toBe((m.insnsSize ?? 0) * 2);
    }
    const abstract = methods.find((m) => !m.hasCode)!;
    expect(abstract.insnsBytes).toBeNull();
  });

  it('methodLimit 截断后 truncated=true 且仅返回前 N 个方法', () => {
    const dex = buildDemoDexWithMethods();
    const header = parseDexHeader(dex);
    const { methods, truncated } = extractDexMethods(dex, header, { methodLimit: 2 });
    expect(truncated).toBe(true);
    expect(methods).toHaveLength(2);
  });

  it('INVALID / CDEX magic：返回空列表 + warning，不抛异常', () => {
    const noheader = Buffer.alloc(0x70);
    const { methods, warnings } = extractDexMethods(noheader, parseDexHeader(noheader));
    expect(methods).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('classes-only 模式 buildDex 也能被 androidDexDetailsAnalyzer 抽出 methods', async () => {
    const dex = buildDemoDexWithMethods();
    const pkg = makeMemoryPackage({ 'classes.dex': dex });
    const { ctx } = makeCtx(pkg);
    const out = await androidDexDetailsAnalyzer.run(ctx);
    const entry = out.dexDetails!.entries[0]!;
    expect(entry.methods).toBeDefined();
    expect(entry.methods!.map((m) => m.fullName).sort()).toEqual([
      'Lcom/king/demo/MainActivity;-><init>()V',
      'Lcom/king/demo/MainActivity;->onCreate(Landroid/os/Bundle;)V',
      'Lcom/king/demo/Utils;->add(II)I',
      'Lcom/king/demo/Utils;->noop()V',
    ]);
    // 默认 hashBodies=false → insnsSha256 全 null
    for (const m of entry.methods!) {
      expect(m.insnsSha256).toBeNull();
    }
    expect(entry.methodsTruncated).toBeUndefined();
  });

  it('opt.dexHashMethodBodies=true 时 dexDetails 输出 insnsSha256（仅 hasCode 方法）', async () => {
    const pkg = makeMemoryPackage({ 'classes.dex': buildDemoDexWithMethods() });
    const { ctx } = makeCtx(pkg, { dexHashMethodBodies: true });
    const out = await androidDexDetailsAnalyzer.run(ctx);
    const methods = out.dexDetails!.entries[0]!.methods!;
    const withCode = methods.filter((m) => m.hasCode);
    expect(withCode.length).toBe(3);
    for (const m of withCode) expect(m.insnsSha256).toMatch(/^[0-9a-f]{64}$/);
    const abstract = methods.find((m) => !m.hasCode)!;
    expect(abstract.insnsSha256).toBeNull();
  });
});
