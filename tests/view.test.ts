import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runViewCommand } from '../packages/cli/src/commands/view.js';
import { UsageError } from '../packages/cli/src/errors.js';
import type { PackageReport } from '@kingsdk/shared/schema.js';

const SAMPLE_REPORT: PackageReport = {
  schemaVersion: '1.0',
  meta: {
    file: '/tmp/foo.hap',
    fileSize: 1,
    sha256: 'c'.repeat(64),
    analyzedAt: '2026-01-01T00:00:00Z',
    toolVersion: 't',
  },
  warnings: [],
};

let tmpDirs: string[] = [];

afterEach(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  tmpDirs = [];
});

describe('CLI view command', () => {
  it('合法 report.json 时调用 startServer 并写入提示', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kingsdk-view-'));
    tmpDirs.push(dir);
    const file = join(dir, 'report.json');
    await writeFile(file, JSON.stringify(SAMPLE_REPORT), 'utf8');

    let started = false;
    const stdout: string[] = [];
    const fakeServer = async () => {
      started = true;
      return { url: 'http://127.0.0.1:9999/', port: 9999, close: async () => {} };
    };

    // runViewCommand 内部最后会 await SIGINT；测试中我们短路：close 被立即 resolve
    // 但 awaitInterrupt 会一直挂起。我们用 Promise.race + 超时跳过，验证启动期行为。
    const promise = runViewCommand(
      file,
      { port: 0, open: false },
      { writeStdout: (t) => stdout.push(t), startServer: fakeServer },
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(started).toBe(true);
    expect(stdout.join('')).toContain('view server: http://127.0.0.1:9999/');

    // 触发 SIGINT 让命令退出
    process.emit('SIGINT', 'SIGINT' as NodeJS.Signals);
    await promise;
  });

  it('文件不存在时抛 UsageError', async () => {
    await expect(
      runViewCommand(
        '/non/existent/file.json',
        {},
        { writeStdout: () => {} },
      ),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('JSON 非法时抛 UsageError', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kingsdk-view-'));
    tmpDirs.push(dir);
    const file = join(dir, 'bad.json');
    await writeFile(file, 'not-json', 'utf8');

    await expect(
      runViewCommand(file, {}, { writeStdout: () => {} }),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('JSON 缺 schemaVersion 时抛 UsageError', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kingsdk-view-'));
    tmpDirs.push(dir);
    const file = join(dir, 'shape.json');
    await writeFile(file, JSON.stringify({ foo: 1 }), 'utf8');

    await expect(
      runViewCommand(file, {}, { writeStdout: () => {} }),
    ).rejects.toBeInstanceOf(UsageError);
  });
});
