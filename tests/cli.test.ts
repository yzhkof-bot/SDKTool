import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runAnalyzeCommand } from '../src/cli/commands/analyze.js';
import { UsageError } from '../src/cli/errors.js';

import { buildFixtureHap } from './helpers/fixtureHap.js';

let tmpDirs: string[] = [];

afterEach(async () => {
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('CLI analyze command (M1)', () => {
  it('默认把 JSON 写到 stdout', async () => {
    const hapPath = await buildFixtureHap();
    const chunks: string[] = [];
    await runAnalyzeCommand(
      hapPath,
      {},
      {
        toolVersion: 'cli-test',
        writeStdout: (text) => chunks.push(text),
      },
    );
    const out = chunks.join('');
    expect(out.trim().startsWith('{')).toBe(true);
    const parsed = JSON.parse(out);
    expect(parsed.schemaVersion).toBe('1.0');
    expect(parsed.meta.toolVersion).toBe('cli-test');
    expect(parsed.basic.bundleName).toBe('com.king.demo');
  });

  it('-o 写到文件，stdout 仅打确认信息', async () => {
    const hapPath = await buildFixtureHap();
    const dir = await mkdtemp(join(tmpdir(), 'kingsdk-cli-'));
    tmpDirs.push(dir);
    const outPath = join(dir, 'report.json');

    const chunks: string[] = [];
    await runAnalyzeCommand(
      hapPath,
      { output: outPath, pretty: true },
      {
        toolVersion: 'cli-test',
        writeStdout: (text) => chunks.push(text),
      },
    );

    const stdout = chunks.join('');
    expect(stdout).toContain(outPath);
    expect(stdout.startsWith('[kingsdk]')).toBe(true);

    const fileContent = await readFile(outPath, 'utf8');
    expect(fileContent).toContain('\n  "schemaVersion"'); // pretty
    const parsed = JSON.parse(fileContent);
    expect(parsed.size.fileCount).toBeGreaterThan(0);
  });

  it('文件不存在时抛 UsageError', async () => {
    await expect(
      runAnalyzeCommand(
        '/non/existent/path.hap',
        {},
        { toolVersion: 't', writeStdout: () => {} },
      ),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('缺少 hap 入参时抛 UsageError', async () => {
    await expect(
      runAnalyzeCommand(undefined, {}, { toolVersion: 't', writeStdout: () => {} }),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('--only 非法值（找不到对应 analyzer）会被 pipeline 拒绝', async () => {
    const hapPath = await buildFixtureHap();
    await expect(
      runAnalyzeCommand(
        hapPath,
        { only: 'no-such-analyzer' },
        { toolVersion: 't', writeStdout: () => {} },
      ),
    ).rejects.toThrowError(/--only/);
  });

  it('--html 写入单文件 HTML 报告', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    if (!existsSync(resolve('templates/report.template.html'))) {
      console.warn('[skip] templates/report.template.html 不存在，请先 npm run build');
      return;
    }

    const hapPath = await buildFixtureHap();
    const dir = await mkdtemp(join(tmpdir(), 'kingsdk-html-'));
    tmpDirs.push(dir);
    const htmlPath = join(dir, 'report.html');

    const stdout: string[] = [];
    await runAnalyzeCommand(
      hapPath,
      { html: htmlPath },
      { toolVersion: 'cli-html', writeStdout: (t) => stdout.push(t) },
    );

    expect(stdout.join('')).toContain(htmlPath);
    const html = await readFile(htmlPath, 'utf8');
    expect(html).toContain('<html');
    expect(html).toContain('id="__DATA__"');
    expect(html).toContain('"bundleName":"com.king.demo"');
  });
});
