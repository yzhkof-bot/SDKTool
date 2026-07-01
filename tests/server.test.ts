import { afterAll, describe, expect, it } from 'vitest';

import { startViewServer } from '../packages/cli/src/utils/server.js';
import type { PackageReport } from '@kingsdk/shared/schema.js';

const SAMPLE_REPORT: PackageReport = {
  schemaVersion: '1.0',
  meta: {
    file: '/tmp/test.hap',
    fileSize: 1,
    sha256: 'b'.repeat(64),
    analyzedAt: '2026-01-01T00:00:00.000Z',
    toolVersion: 'test',
  },
  warnings: [],
};

const handles: Array<{ close: () => Promise<void> }> = [];

afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
});

describe('startViewServer', () => {
  it('GET / 返回 HTML 含 <script id="__DATA__"', async () => {
    const handle = await startViewServer(SAMPLE_REPORT, { port: 0, openBrowser: false });
    handles.push(handle);

    const res = await fetch(handle.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('id="__DATA__"');
    expect(html).toContain(SAMPLE_REPORT.meta.file);
  });

  it('GET /api/report 返回 PackageReport JSON', async () => {
    const handle = await startViewServer(SAMPLE_REPORT, { port: 0, openBrowser: false });
    handles.push(handle);

    const res = await fetch(`${handle.url}api/report`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.schemaVersion).toBe('1.0');
    expect(body.meta.sha256).toBe(SAMPLE_REPORT.meta.sha256);
  });

  it('GET /healthz 返回 ok', async () => {
    const handle = await startViewServer(SAMPLE_REPORT, { port: 0, openBrowser: false });
    handles.push(handle);

    const res = await fetch(`${handle.url}healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('GET 不存在的路径返回 404', async () => {
    const handle = await startViewServer(SAMPLE_REPORT, { port: 0, openBrowser: false });
    handles.push(handle);

    const res = await fetch(`${handle.url}no-such-path`);
    expect(res.status).toBe(404);
  });

  it('POST 返回 405', async () => {
    const handle = await startViewServer(SAMPLE_REPORT, { port: 0, openBrowser: false });
    handles.push(handle);

    const res = await fetch(handle.url, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});
