import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import {
  APK_SIG_KNOWN_IDS,
  parseApkSigningBlock,
} from '../../src/core/analyzers/android/_apkSignature.js';
import { androidApkSignatureAnalyzer } from '../../src/core/analyzers/android/apkSignature.js';
import { openZipPackage } from '../../src/core/loader/zipPackage.js';
import type { AnalyzerContext, ReportWarning } from '../../src/shared/schema.js';

import {
  APK_SIG_ID_PADDING,
  APK_SIG_ID_SOURCE_STAMP,
  APK_SIG_ID_V2,
  APK_SIG_ID_V3,
  APK_SIG_ID_V31,
  buildApkSigningBlock,
  buildDemoApkSigningBlock,
} from '../helpers/fixtureApkSigBlock.js';
import { buildFixtureApk } from '../helpers/fixtureApk.js';
import { buildMiniZip } from '../helpers/miniZip.js';

const tempDirs: string[] = [];

async function tempFile(name: string, content: Buffer): Promise<string> {
  const dir = join(tmpdir(), `kingsdk-apk-sig-${randomBytes(4).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  const p = join(dir, name);
  await writeFile(p, content);
  return p;
}

afterAll(async () => {
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true });
  }
});

function makeCtx(filePath: string, entries: ReturnType<typeof inferEntries>): {
  ctx: AnalyzerContext;
  warnings: Omit<ReportWarning, 'source'>[];
} {
  const warnings: Omit<ReportWarning, 'source'>[] = [];
  return {
    ctx: {
      hap: {
        filePath,
        fileSize: 0,
        sha256: 'a'.repeat(64),
        entries,
        readFile: async (p) => {
          const e = entries.find((x) => x.path === p);
          if (!e) throw new Error(`no entry ${p}`);
          // 单测不真正去 zip 解，apkSignature 只从 hap.readFile 读 META-INF/*.RSA
          // 这种容器用于抽证书。fixture 这里不提供真实证书，返回空 buffer 即可
          return Buffer.alloc(0);
        },
        readText: async () => '',
        close: async () => {},
      },
      options: { topFilesLimit: 5, toolVersion: 'test' },
      platform: 'android',
      addWarning: (w) => warnings.push(w),
    },
    warnings,
  };
}

function inferEntries(paths: string[]): { path: string; isDirectory: boolean; uncompressedSize: number; compressedSize: number }[] {
  return paths.map((p) => ({
    path: p,
    isDirectory: p.endsWith('/'),
    uncompressedSize: 0,
    compressedSize: 0,
  }));
}

/* ================================================================== */
/* 1) _apkSignature pure-binary tests                                  */
/* ================================================================== */

describe('parseApkSigningBlock (二进制解析)', () => {
  it('对一个 demo v2+v3+padding signing block，能正确识别 3 个 pair', async () => {
    // 用 miniZip 构造一个带 signing block 的最小 APK
    const apkBuf = buildMiniZip([{ path: 'classes.dex', content: Buffer.alloc(16, 1) }], {
      extraBeforeCentral: buildDemoApkSigningBlock(),
    });
    const { signingBlock, warnings } = parseApkSigningBlock(apkBuf);
    expect(warnings).toEqual([]);
    expect(signingBlock).toBeTruthy();
    expect(signingBlock!.entries.map((e) => e.idHex)).toEqual([
      '0x7109871a', // v2
      '0xf05368c0', // v3
      '0x504b4453', // padding
    ]);
    expect(signingBlock!.entries.map((e) => e.name)).toEqual([
      'V2 Signature',
      'V3 Signature',
      'Padding',
    ]);
    expect(signingBlock!.entries.every((e) => e.sizeBytes > 0)).toBe(true);
    expect(signingBlock!.totalBytes).toBeGreaterThan(64);
  });

  it('未知 ID 也能被识别，name="unknown"', () => {
    const apkBuf = buildMiniZip([{ path: 'a', content: Buffer.alloc(1) }], {
      extraBeforeCentral: buildApkSigningBlock([
        { id: 0xdeadbeef, value: Buffer.alloc(16, 0xff) },
      ]),
    });
    const { signingBlock } = parseApkSigningBlock(apkBuf);
    expect(signingBlock?.entries).toEqual([
      { idHex: '0xdeadbeef', name: 'unknown', sizeBytes: 16 },
    ]);
  });

  it('APK 没有 signing block → 返回 null + 不报警告（正常未签 v2 的情况）', () => {
    const apkBuf = buildMiniZip([{ path: 'classes.dex', content: Buffer.alloc(8) }]);
    const { signingBlock, warnings } = parseApkSigningBlock(apkBuf);
    expect(signingBlock).toBeNull();
    expect(warnings).toEqual([]);
  });

  it('完全坏的 buffer（无 EOCD）→ null + warning', () => {
    const { signingBlock, warnings } = parseApkSigningBlock(Buffer.alloc(64, 0x77));
    expect(signingBlock).toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('APK_SIG_KNOWN_IDS 覆盖 v2 / v3 / v3.1 / padding / source stamp', () => {
    expect(APK_SIG_KNOWN_IDS['0x7109871a']).toBe('V2 Signature');
    expect(APK_SIG_KNOWN_IDS['0xf05368c0']).toBe('V3 Signature');
    expect(APK_SIG_KNOWN_IDS['0x1b93ad61']).toBe('V3.1 Signature');
    expect(APK_SIG_KNOWN_IDS['0x504b4453']).toBe('Padding');
    expect(APK_SIG_KNOWN_IDS['0x42726577']).toBe('Source Stamp');
  });
});

/* ================================================================== */
/* 2) Analyzer-level（要真磁盘文件 + 真 fs.read）                       */
/* ================================================================== */

describe('androidApkSignatureAnalyzer', () => {
  it('fixture APK 默认有 v1 + v2 + v3：versions 三个都 true', async () => {
    const apkPath = await buildFixtureApk();
    const pkg = await openZipPackage(apkPath);
    try {
      const warnings: Omit<ReportWarning, 'source'>[] = [];
      const out = await androidApkSignatureAnalyzer.run({
        hap: pkg,
        options: { topFilesLimit: 5, toolVersion: 'test' },
        platform: 'android',
        addWarning: (w) => warnings.push(w),
      });
      const sig = out.signature!;
      expect(sig.present).toBe(true);
      expect(sig.versions).toEqual({ v1: true, v2: true, v3: true, v31: false });
      expect(sig.signingBlock).toBeTruthy();
      expect(sig.signingBlock!.entries.map((e) => e.idHex)).toEqual([
        '0x7109871a',
        '0xf05368c0',
        '0x504b4453',
      ]);
      // fixture 的 META-INF/CERT.RSA 是占位 buffer 不是真 PKCS#7，
      // 所以证书提取失败 → present=true，subject 缺省，应该有 info 级别 warning
      expect(sig.subject).toBeUndefined();
      expect(warnings.some((w) => w.code === 'APK_SIG_CERT_NOT_EXTRACTED')).toBe(true);
    } finally {
      await pkg.close();
    }
  });

  it('skipSigningBlock=true 时 versions.v2=v3=false（但 v1 仍 true）', async () => {
    const apkPath = await buildFixtureApk({ skipSigningBlock: true });
    const pkg = await openZipPackage(apkPath);
    try {
      const out = await androidApkSignatureAnalyzer.run({
        hap: pkg,
        options: { topFilesLimit: 5, toolVersion: 'test' },
        platform: 'android',
        addWarning: () => {},
      });
      const sig = out.signature!;
      expect(sig.present).toBe(true);
      expect(sig.versions).toEqual({ v1: true, v2: false, v3: false, v31: false });
      expect(sig.signingBlock).toBeUndefined();
    } finally {
      await pkg.close();
    }
  });

  it('自定义 signing block 含 v3.1 ID → versions.v31=true', async () => {
    const block = buildApkSigningBlock([
      { id: APK_SIG_ID_V2, value: Buffer.alloc(32, 1) },
      { id: APK_SIG_ID_V3, value: Buffer.alloc(32, 2) },
      { id: APK_SIG_ID_V31, value: Buffer.alloc(32, 3) },
      { id: APK_SIG_ID_SOURCE_STAMP, value: Buffer.alloc(8, 4) },
      { id: APK_SIG_ID_PADDING, value: Buffer.alloc(16) },
    ]);
    const apkPath = await buildFixtureApk({ signingBlock: block });
    const pkg = await openZipPackage(apkPath);
    try {
      const out = await androidApkSignatureAnalyzer.run({
        hap: pkg,
        options: { topFilesLimit: 5, toolVersion: 'test' },
        platform: 'android',
        addWarning: () => {},
      });
      const sig = out.signature!;
      expect(sig.versions).toEqual({ v1: true, v2: true, v3: true, v31: true });
      expect(sig.signingBlock!.entries).toHaveLength(5);
      expect(sig.signingBlock!.entries.find((e) => e.idHex === '0x42726577')?.name).toBe(
        'Source Stamp',
      );
    } finally {
      await pkg.close();
    }
  });

  it('in-memory VirtualPackage（filePath 不存在）→ versions.v2/v3 跳过，但 v1 仍能识别', async () => {
    const { ctx, warnings } = makeCtx(
      'memory://nonexistent.apk',
      inferEntries([
        'classes.dex',
        'META-INF/MANIFEST.MF',
        'META-INF/CERT.SF',
        'META-INF/CERT.RSA',
      ]),
    );
    const out = await androidApkSignatureAnalyzer.run(ctx);
    const sig = out.signature!;
    expect(sig.versions).toEqual({ v1: true, v2: false, v3: false, v31: false });
    expect(sig.signingBlock).toBeUndefined();
    // 应该有读 APK 末尾失败的 warning
    expect(warnings.some((w) => w.code === 'APK_SIG_TAIL_READ_FAILED')).toBe(true);
  });

  it('完全无签名包：present=false, versions 全 false', async () => {
    // 构造一个没有 META-INF 也没有 signing block 的最小 APK
    const apkBuf = buildMiniZip([
      { path: 'classes.dex', content: Buffer.alloc(64, 1) },
      { path: 'AndroidManifest.xml', content: Buffer.alloc(64, 2) },
    ]);
    const apkPath = await tempFile('unsigned.apk', apkBuf);
    const pkg = await openZipPackage(apkPath);
    try {
      const out = await androidApkSignatureAnalyzer.run({
        hap: pkg,
        options: { topFilesLimit: 5, toolVersion: 'test' },
        platform: 'android',
        addWarning: () => {},
      });
      const sig = out.signature!;
      expect(sig.present).toBe(false);
      expect(sig.versions).toEqual({ v1: false, v2: false, v3: false, v31: false });
      expect(sig.signingBlock).toBeUndefined();
    } finally {
      await pkg.close();
    }
  });
});
