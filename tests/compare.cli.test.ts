import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runCompareCommand } from '../packages/cli/src/commands/compare.js';
import { UsageError } from '../packages/cli/src/errors.js';
import { analyzePackage } from '@kingsdk/core/index.js';
import { SCHEMA_VERSION } from '@kingsdk/shared/schema.js';

import { buildFixtureHap } from './helpers/fixtureHap.js';

let tmpDirs: string[] = [];

afterEach(async () => {
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true });
  }
  tmpDirs = [];
});

async function newTmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'kingsdk-cmp-'));
  tmpDirs.push(d);
  return d;
}

const stubDeps = (writes: string[]) => ({
  toolVersion: 'cmp-test',
  writeStdout: (t: string) => writes.push(t),
  writeStderr: () => {},
});

describe('CLI compare command (M4)', () => {
  it('两个相同 hap 时 summary.identical=true，stdout 直接是 JSON', async () => {
    const hap = await buildFixtureHap({ includePackInfo: true });
    const stdout: string[] = [];
    await runCompareCommand(hap, hap, {}, stubDeps(stdout));
    const out = stdout.join('');
    const diff = JSON.parse(out);
    expect(diff.schemaVersion).toBe(SCHEMA_VERSION);
    expect(diff.summary.identical).toBe(true);
    expect(diff.summary.totalSizeDelta).toBe(0);
    expect(diff.files.totals.added).toBe(0);
    expect(diff.files.totals.removed).toBe(0);
    expect(diff.files.totals.changed).toBe(0);
  });

  it('-o 写到文件，stdout 仅打确认信息', async () => {
    const hap = await buildFixtureHap();
    const dir = await newTmp();
    const outPath = join(dir, 'diff.json');
    const stdout: string[] = [];
    await runCompareCommand(hap, hap, { output: outPath, pretty: true }, stubDeps(stdout));
    const log = stdout.join('');
    expect(log.startsWith('[kingsdk]')).toBe(true);
    expect(log).toContain(outPath);
    const text = await readFile(outPath, 'utf8');
    expect(text).toContain('\n  "schemaVersion"'); // pretty
    const diff = JSON.parse(text);
    expect(diff.summary.identical).toBe(true);
  });

  it('支持 .json 报告作为输入（cross-format：左 JSON / 右 hap）', async () => {
    const hap = await buildFixtureHap();
    const report = await analyzePackage(hap, { toolVersion: '0.0.0-test' });

    const dir = await newTmp();
    const reportPath = join(dir, 'left.json');
    await writeFile(reportPath, JSON.stringify(report), 'utf8');

    const stdout: string[] = [];
    await runCompareCommand(reportPath, hap, {}, stubDeps(stdout));
    const diff = JSON.parse(stdout.join(''));
    // left 来自 .json（toolVersion=0.0.0-test），right 来自实时分析（toolVersion=cmp-test），
    // size/files 等内容应当相同 → identical 为 true
    expect(diff.summary.totalSizeDelta).toBe(0);
    expect(diff.files.totals.added).toBe(0);
  });

  it('JSON 缺少 schemaVersion / meta 时抛 UsageError', async () => {
    const dir = await newTmp();
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{"foo":1}', 'utf8');
    const hap = await buildFixtureHap();
    await expect(
      runCompareCommand(bad, hap, {}, stubDeps([])),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('JSON 内容非法时抛 UsageError 提示无法解析', async () => {
    const dir = await newTmp();
    const bad = join(dir, 'broken.json');
    await writeFile(bad, '{not json', 'utf8');
    const hap = await buildFixtureHap();
    await expect(
      runCompareCommand(bad, hap, {}, stubDeps([])),
    ).rejects.toThrow(/无法解析/);
  });

  it('缺少入参时抛 UsageError', async () => {
    await expect(
      runCompareCommand(undefined, undefined, {}, stubDeps([])),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('--html 产出包含 PackageDiffReport JSON 的单文件 HTML（依赖 build 过的 templates/diff.template.html）', async () => {
    if (!existsSync(resolve('packages/viewer/templates/diff.template.html'))) {
      console.warn('[skip] templates/diff.template.html 不存在，请先 npm run build');
      return;
    }
    const hap = await buildFixtureHap();
    const dir = await newTmp();
    const htmlPath = join(dir, 'diff.html');
    const stdout: string[] = [];
    await runCompareCommand(
      hap,
      hap,
      { html: htmlPath },
      stubDeps(stdout),
    );
    const log = stdout.join('');
    expect(log).toContain(htmlPath);
    const html = await readFile(htmlPath, 'utf8');
    expect(html).toContain('<html');
    expect(html).toContain('id="__DATA__"');
    expect(html).toContain('"identical":true');
  });
});
