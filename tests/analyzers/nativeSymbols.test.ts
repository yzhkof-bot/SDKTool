import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { analyzePackage, diffPackageReports } from '@kingsdk/core/index.js';

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

describe('nativeSymbols + differ：函数体级 diff 信号', () => {
  it('wb smoke：size 变进 changed；size 一致即使 hash 不同也直接 unchanged，不再列名单（AI 噪声已清）', async () => {
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

    expect(libDiff.added.map((s) => s.name)).toEqual(expect.arrayContaining(['brand']));
    expect(libDiff.removed.map((s) => s.name)).toEqual(expect.arrayContaining(['gone']));

    // changed：只允许 size 变化的 bar
    const changedNames = libDiff.changed.map((c) => c.name);
    expect(changedNames).toContain('bar');
    expect(changedNames).not.toContain('foo'); // size 没变
    expect(changedNames).not.toContain('shared');

    const barChange = libDiff.changed.find((c) => c.name === 'bar')!;
    expect(barChange.delta).toBe(8);
    expect(barChange.fromSize).toBe(8);
    expect(barChange.toSize).toBe(16);
    expect(barChange.bodyChanged).toBe(true);

    // bodyHashOnly 名单已下线 → 输出里不能再有该字段，也不能有 totals.bodyHashOnly
    expect(libDiff.bodyHashOnly).toBeUndefined();
    expect((libDiff.totals as Record<string, unknown>).bodyHashOnly).toBeUndefined();
    // foo（size 一致 hash 不同）→ 算 unchanged
    expect(libDiff.totals.unchanged).toBeGreaterThanOrEqual(1);
  });

  it('两侧都没 codeSha256（nativeHashSymbolBodies=false）：同名同 size 直接 unchanged，diff 输出无 bodyHashOnly 字段', async () => {
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
    expect(changedNames).toContain('bar');
    expect(changedNames).not.toContain('foo');
    expect(libDiff.bodyHashOnly).toBeUndefined();
    const barChange = libDiff.changed.find((c) => c.name === 'bar')!;
    expect(barChange.bodyChanged).toBeUndefined();
  });

  it('单侧 codeSha256 缺失：size 变的进 changed.bodyChanged=null；size 不变直接 unchanged', async () => {
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
    expect(barChange.bodyChanged).toBeNull();
    expect(libDiff.bodyHashOnly).toBeUndefined();
  });
});

describe('nativeSymbols analyzer：.rela.* relocation mask（吸收重链接位移噪声）', () => {
  it('同一函数 body 字节因 reloc 字段不同 → 落入 mask 范围后 hash 完全一致', async () => {
    const { buildElf } = await import('../helpers/fixtureElf.js');
    // 两侧"代码"完全一样：foo 函数 12B
    //   - 前 4B 是真实指令（视作 mov），相同
    //   - 中 4B 是 R_AARCH64_CALL26 reloc 字段（mask 后置零）
    //   - 后 4B 是另一段相同的真实指令
    // 左侧 reloc 字段填 0xAA；右侧填 0xBB（模拟链接到不同位置）。
    // 没 mask 时两边 SHA-256 不同；有 mask 后必须一致。
    const left = buildElf({
      symbols: [
        {
          name: 'foo',
          body: Buffer.concat([
            Buffer.from([0x11, 0x22, 0x33, 0x44]),
            Buffer.alloc(4, 0xaa), // 待 mask
            Buffer.from([0x55, 0x66, 0x77, 0x88]),
          ]),
        },
      ],
      textRelocations: [{ textOffset: 4, type: 283 /* R_AARCH64_CALL26 */ }],
    });
    const right = buildElf({
      symbols: [
        {
          name: 'foo',
          body: Buffer.concat([
            Buffer.from([0x11, 0x22, 0x33, 0x44]),
            Buffer.alloc(4, 0xbb), // 同字节范围，链接位置不同 → 字节不同
            Buffer.from([0x55, 0x66, 0x77, 0x88]),
          ]),
        },
      ],
      textRelocations: [{ textOffset: 4, type: 283 }],
    });
    const leftHap = await newTmpHapWithSo([{ arch: 'arm64-v8a', name: 'librel.so', buf: left }]);
    const rightHap = await newTmpHapWithSo([{ arch: 'arm64-v8a', name: 'librel.so', buf: right }]);
    const leftRep = await analyzePackage(leftHap, { toolVersion: 't', extras: ['nativeSymbols'] });
    const rightRep = await analyzePackage(rightHap, { toolVersion: 't', extras: ['nativeSymbols'] });
    const lFoo = leftRep.nativeLibSymbols!.perLib[0]!.symbols.find((s) => s.name === 'foo')!;
    const rFoo = rightRep.nativeLibSymbols!.perLib[0]!.symbols.find((s) => s.name === 'foo')!;
    expect(lFoo.codeSha256).toBeDefined();
    expect(rFoo.codeSha256).toBeDefined();
    expect(lFoo.codeSha256).toBe(rFoo.codeSha256);

    // 经差分：foo 既不在 changed，diff 输出也没有 bodyHashOnly 字段
    const diff = diffPackageReports(leftRep, rightRep);
    const libDiff = diff.nativeLibSymbols!.perLib.find((l) => l.name === 'librel.so')!;
    expect(libDiff.changed.map((c) => c.name)).not.toContain('foo');
    expect(libDiff.bodyHashOnly).toBeUndefined();
  });

  it('没注入 reloc 时，相同位置不同字节 → analyzer 端 hash 不同；但 differ 因 size 一致仍判 unchanged，不列名单', async () => {
    const { buildElf } = await import('../helpers/fixtureElf.js');
    const left = buildElf({
      symbols: [{ name: 'foo', body: Buffer.alloc(8, 0xaa) }],
    });
    const right = buildElf({
      symbols: [{ name: 'foo', body: Buffer.alloc(8, 0xbb) }],
    });
    const leftHap = await newTmpHapWithSo([{ arch: 'arm64-v8a', name: 'libnorel.so', buf: left }]);
    const rightHap = await newTmpHapWithSo([{ arch: 'arm64-v8a', name: 'libnorel.so', buf: right }]);
    const leftRep = await analyzePackage(leftHap, { toolVersion: 't', extras: ['nativeSymbols'] });
    const rightRep = await analyzePackage(rightHap, { toolVersion: 't', extras: ['nativeSymbols'] });
    const lFoo = leftRep.nativeLibSymbols!.perLib[0]!.symbols.find((s) => s.name === 'foo')!;
    const rFoo = rightRep.nativeLibSymbols!.perLib[0]!.symbols.find((s) => s.name === 'foo')!;
    expect(lFoo.codeSha256).not.toBe(rFoo.codeSha256);
    const diff = diffPackageReports(leftRep, rightRep);
    const libDiff = diff.nativeLibSymbols!.perLib.find((l) => l.name === 'libnorel.so')!;
    expect(libDiff.changed.map((c) => c.name)).not.toContain('foo');
    expect(libDiff.bodyHashOnly).toBeUndefined();
    expect(libDiff.totals.unchanged).toBeGreaterThanOrEqual(1);
  });

  it('reloc 落在符号 A 区间内、不影响符号 B → 仅 A 被 mask', async () => {
    const { buildElf } = await import('../helpers/fixtureElf.js');
    const sharedBody = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
    const aLeft = Buffer.concat([
      Buffer.from([0x10, 0x20, 0x30, 0x40]),
      Buffer.alloc(4, 0x01),
    ]);
    const aRight = Buffer.concat([
      Buffer.from([0x10, 0x20, 0x30, 0x40]),
      Buffer.alloc(4, 0x02),
    ]);
    const left = buildElf({
      symbols: [
        { name: 'a', body: aLeft },
        { name: 'b', body: sharedBody },
      ],
      // a 在 .text 起始 offset=0；mask offset=4 → 只清掉 a 的后半
      textRelocations: [{ textOffset: 4, type: 283 }],
    });
    const right = buildElf({
      symbols: [
        { name: 'a', body: aRight },
        { name: 'b', body: sharedBody },
      ],
      textRelocations: [{ textOffset: 4, type: 283 }],
    });
    const leftHap = await newTmpHapWithSo([{ arch: 'arm64-v8a', name: 'libdual.so', buf: left }]);
    const rightHap = await newTmpHapWithSo([{ arch: 'arm64-v8a', name: 'libdual.so', buf: right }]);
    const leftRep = await analyzePackage(leftHap, { toolVersion: 't', extras: ['nativeSymbols'] });
    const rightRep = await analyzePackage(rightHap, { toolVersion: 't', extras: ['nativeSymbols'] });

    const lA = leftRep.nativeLibSymbols!.perLib[0]!.symbols.find((s) => s.name === 'a')!;
    const rA = rightRep.nativeLibSymbols!.perLib[0]!.symbols.find((s) => s.name === 'a')!;
    const lB = leftRep.nativeLibSymbols!.perLib[0]!.symbols.find((s) => s.name === 'b')!;
    const rB = rightRep.nativeLibSymbols!.perLib[0]!.symbols.find((s) => s.name === 'b')!;
    // a 被 mask → hash 相同；b 没被 mask 且 body 相同 → hash 也相同
    expect(lA.codeSha256).toBe(rA.codeSha256);
    expect(lB.codeSha256).toBe(rB.codeSha256);
  });
});
