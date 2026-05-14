import { describe, expect, it } from 'vitest';

import { analyzeHap } from '../../src/core/index.js';

import { buildFixtureHap } from '../helpers/fixtureHap.js';

describe('SignatureAnalyzer', () => {
  it('META-INF 下存在签名文件时 present=true', async () => {
    const hap = await buildFixtureHap();
    const report = await analyzeHap(hap, { toolVersion: 't', only: ['signature'] });
    expect(report.signature!.present).toBe(true);
    // fixture 的 CERT.RSA 是假数据，无法解析为 X.509 → subject 缺失，warn
    expect(report.signature!.subject).toBeUndefined();
    expect(report.warnings.some((w) => w.code === 'CERT_DECODE_SKIPPED')).toBe(true);
  });

  it('无 META-INF 时 present=false', async () => {
    const { writeMiniZip } = await import('../helpers/miniZip.js');
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'kingsdk-sig-empty-'));
    const file = join(dir, 'demo.hap');
    await writeMiniZip(file, [
      { path: 'module.json', content: '{"app":{},"module":{}}' },
    ]);
    const report = await analyzeHap(file, { toolVersion: 't', only: ['signature'] });
    expect(report.signature!.present).toBe(false);
  });
});
