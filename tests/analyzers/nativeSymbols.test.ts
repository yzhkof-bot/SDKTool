import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { analyzePackage, diffPackageReports } from '../../src/core/index.js';

import { writeMiniZip } from '../helpers/miniZip.js';
import {
  buildElf,
  buildSmokeElfLeft,
  buildSmokeElfRight,
} from '../helpers/fixtureElf.js';

async function newTmpHapWithSo(elfBufs: Array<{ arch: string; name: string; buf: Buffer }>): Promise<string> {
  const dir = join(tmpdir(), `kingsdk-elfhap-${randomBytes(6).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, 'demo.hap');
  const entries = [
    { path: 'module.json', content: '{"app":{},"module":{}}' },
    ...elfBufs.map((e) => ({
      path: `libs/${e.arch}/${e.name}`,
      content: e.buf,
    })),
  ];
  await writeMiniZip(filePath, entries);
  return filePath;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('nativeSymbols analyzer：codeSha256 抽取', () => {
  it('FUNC 符号默认填 codeSha256，等于其 body 的 SHA-256', async () => {
    const fooBody = Buffer.alloc(16, 0xa1);
    const barBody = Buffer.alloc(32, 0xb2);
    const elf = buildElf({
      symbols: [
        { name: 'foo', body: fooBody },
        { name: 'bar', body: barBody },
      ],
    });
    const hap = await newTmpHapWithSo([{ arch: 'arm64-v8a', name: 'libsmoke.so', buf: elf }]);

    const report = await analyzePackage(hap, {
      toolVersion: 't',
      extras: ['nativeSymbols'],
    });

    const lib = report.nativeLibSymbols!.perLib.find((l) => l.name === 'libsmoke.so')!;
    const foo = lib.symbols.find((s) => s.name === 'foo')!;
    const bar = lib.symbols.find((s) => s.name === 'bar')!;
    expect(foo.codeSha256).toBe(sha256Hex(fooBody));
    expect(bar.codeSha256).toBe(sha256Hex(barBody));
  });

  it('imported 符号（SHN_UNDEF）不填 codeSha256', async () => {
    const elf = buildElf({
      symbols: [
        { name: 'foo', body: Buffer.alloc(8, 0xa1) },
        { name: 'malloc', body: undefined }, // imported, st_shndx=UNDEF
      ],
    });
    const hap = await newTmpHapWithSo([{ arch: 'arm64-v8a', name: 'libimp.so', buf: elf }]);

    const report = await analyzePackage(hap, {
      toolVersion: 't',
      extras: ['nativeSymbols'],
    });

    const lib = report.nativeLibSymbols!.perLib.find((l) => l.name === 'libimp.so')!;
    const malloc = lib.symbols.find((s) => s.name === 'malloc')!;
    expect(malloc.imported).toBe(true);
    expect(malloc.codeSha256).toBeUndefined();
    const foo = lib.symbols.find((s) => s.name === 'foo')!;
    expect(foo.codeSha256).toBeDefined();
  });

  it('OBJECT 类型符号不填 codeSha256（仅 FUNC）', async () => {
    const elf = buildElf({
      symbols: [
        { name: 'gVar', body: Buffer.alloc(4, 0x11), type: 'OBJECT' },
        { name: 'fnFoo', body: Buffer.alloc(4, 0x22), type: 'FUNC' },
      ],
    });
    const hap = await newTmpHapWithSo([{ arch: 'arm64-v8a', name: 'libtype.so', buf: elf }]);

    const report = await analyzePackage(hap, {
      toolVersion: 't',
      extras: ['nativeSymbols'],
    });

    const lib = report.nativeLibSymbols!.perLib.find((l) => l.name === 'libtype.so')!;
    const gVar = lib.symbols.find((s) => s.name === 'gVar')!;
    const fnFoo = lib.symbols.find((s) => s.name === 'fnFoo')!;
    expect(gVar.type).toBe('OBJECT');
    expect(gVar.codeSha256).toBeUndefined();
    expect(fnFoo.type).toBe('FUNC');
    expect(fnFoo.codeSha256).toBeDefined();
  });

  it('nativeHashSymbolBodies=false 时不填 codeSha256（向后兼容/省 CPU）', async () => {
    const elf = buildElf({
      symbols: [{ name: 'foo', body: Buffer.alloc(8, 0xa1) }],
    });
    const hap = await newTmpHapWithSo([{ arch: 'arm64-v8a', name: 'libnh.so', buf: elf }]);

    const report = await analyzePackage(hap, {
      toolVersion: 't',
      extras: ['nativeSymbols'],
      nativeHashSymbolBodies: false,
    });

    const lib = report.nativeLibSymbols!.perLib.find((l) => l.name === 'libnh.so')!;
    expect(lib.symbols.find((s) => s.name === 'foo')!.codeSha256).toBeUndefined();
  });
});

describe('nativeSymbols + differ：函数体级 diff 三种信号', () => {
  it('wb smoke：双 .so compare → bodyChanged（size 同 body 异）/ size 变 / removed / added 四种信号都出', async () => {
    const leftHap = await newTmpHapWithSo([
      { arch: 'arm64-v8a', name: 'libdemo.so', buf: buildSmokeElfLeft() },
    ]);
    const rightHap = await newTmpHapWithSo([
      { arch: 'arm64-v8a', name: 'libdemo.so', buf: buildSmokeElfRight() },
    ]);

    const opts = { toolVersion: 'smoke', extras: ['nativeSymbols'] };
    const left = await analyzePackage(leftHap, opts);
    const right = await analyzePackage(rightHap, opts);

    const diff = diffPackageReports(left, right);
    const libDiff = diff.nativeLibSymbols!.perLib.find((l) => l.name === 'libdemo.so')!;

    // added
    expect(libDiff.added.map((s) => s.name)).toEqual(expect.arrayContaining(['brand']));
    // removed
    expect(libDiff.removed.map((s) => s.name)).toEqual(expect.arrayContaining(['gone']));

    // changed：foo (size 同 body 异) + bar (size 变)
    const changedNames = libDiff.changed.map((c) => c.name);
    expect(changedNames).toEqual(expect.arrayContaining(['foo', 'bar']));

    const fooChange = libDiff.changed.find((c) => c.name === 'foo')!;
    expect(fooChange.delta).toBe(0);
    expect(fooChange.fromSize).toBe(8);
    expect(fooChange.toSize).toBe(8);
    expect(fooChange.bodyChanged).toBe(true); // 关键：仅靠 codeSha256 才能识别

    const barChange = libDiff.changed.find((c) => c.name === 'bar')!;
    expect(barChange.delta).toBe(8);
    expect(barChange.fromSize).toBe(8);
    expect(barChange.toSize).toBe(16);
    expect(barChange.bodyChanged).toBe(true);

    // shared 应该在 unchanged 里，不进 changed
    expect(changedNames).not.toContain('shared');
  });

  it('两侧都没 codeSha256（老 report 或 nativeHashSymbolBodies=false）时同名同 size 仍判 unchanged', async () => {
    const leftHap = await newTmpHapWithSo([
      { arch: 'arm64-v8a', name: 'libnohash.so', buf: buildSmokeElfLeft() },
    ]);
    const rightHap = await newTmpHapWithSo([
      { arch: 'arm64-v8a', name: 'libnohash.so', buf: buildSmokeElfRight() },
    ]);

    const opts = {
      toolVersion: 'nohash',
      extras: ['nativeSymbols'],
      nativeHashSymbolBodies: false,
    };
    const left = await analyzePackage(leftHap, opts);
    const right = await analyzePackage(rightHap, opts);

    const diff = diffPackageReports(left, right);
    const libDiff = diff.nativeLibSymbols!.perLib.find((l) => l.name === 'libnohash.so')!;
    const changedNames = libDiff.changed.map((c) => c.name);
    expect(changedNames).toContain('bar'); // size 变化，旧路径还能识别
    expect(changedNames).not.toContain('foo'); // size 同 body 异 → 没 hash 就漏掉
    const barChange = libDiff.changed.find((c) => c.name === 'bar')!;
    expect(barChange.bodyChanged).toBeUndefined(); // 字段缺省，向后兼容
  });

  it('单侧 codeSha256 缺失（一边新一边老）→ bodyChanged=null（unknown）', async () => {
    // 左侧不启用 hash，右侧启用
    const leftHap = await newTmpHapWithSo([
      { arch: 'arm64-v8a', name: 'libmix.so', buf: buildSmokeElfLeft() },
    ]);
    const rightHap = await newTmpHapWithSo([
      { arch: 'arm64-v8a', name: 'libmix.so', buf: buildSmokeElfRight() },
    ]);
    const left = await analyzePackage(leftHap, {
      toolVersion: 'mix-l',
      extras: ['nativeSymbols'],
      nativeHashSymbolBodies: false,
    });
    const right = await analyzePackage(rightHap, {
      toolVersion: 'mix-r',
      extras: ['nativeSymbols'],
      nativeHashSymbolBodies: true,
    });

    const diff = diffPackageReports(left, right);
    const libDiff = diff.nativeLibSymbols!.perLib.find((l) => l.name === 'libmix.so')!;
    const barChange = libDiff.changed.find((c) => c.name === 'bar')!;
    // size 变化进 changed；bodyChanged 因为一边没 hash → null
    expect(barChange.bodyChanged).toBeNull();
  });
});
