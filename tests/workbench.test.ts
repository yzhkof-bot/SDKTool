import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { browseDirectory, BrowseError } from '@kingsdk/server/browse.js';
import { locateByMeta } from '@kingsdk/server/locate.js';
import { JobStore } from '@kingsdk/server/store.js';
import {
  startWorkbenchServer,
  type WorkbenchServerHandle,
} from '@kingsdk/server/server.js';

import { buildFixtureApk, DEMO_APK_PACKAGE } from './helpers/fixtureApk.js';
import { buildFixtureHap } from './helpers/fixtureHap.js';

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

async function newTmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'kingsdk-wb-'));
  tmpDirs.push(d);
  return d;
}

/* -------------------------------------------------------------------------- */
/* JobStore                                                                    */
/* -------------------------------------------------------------------------- */

describe('JobStore', () => {
  it('create / get / list / update 基本闭环', async () => {
    const dir = await newTmp();
    const store = new JobStore(dir);
    const j1 = store.create('analyze', ['/x/a.hap'], 'a.hap');
    const j2 = store.create('compare', ['/x/a.hap', '/x/b.hap'], 'a.hap vs b.hap');

    expect(store.list()).toHaveLength(2);
    expect(store.list()[0]!.id).toBe(j2.id); // 最新在前
    expect(store.get(j1.id)?.status).toBe('pending');

    const updated = store.update(j1.id, { status: 'done' });
    expect(updated?.status).toBe('done');
    expect(store.get(j1.id)?.status).toBe('done');
  });

  it('jobDir 创建并返回该 job 的产物目录', async () => {
    const dir = await newTmp();
    const store = new JobStore(dir);
    const j = store.create('analyze', ['/x/a.hap'], 'a.hap');
    const d = store.jobDir(j.id);
    const s = await stat(d);
    expect(s.isDirectory()).toBe(true);
    expect(d.startsWith(dir)).toBe(true);
  });

  it('remove(id)：done 状态可直接删，pending/running 需 force', async () => {
    const dir = await newTmp();
    const store = new JobStore(dir);
    const a = store.create('analyze', ['/x/a.hap'], 'a');
    const b = store.create('analyze', ['/x/b.hap'], 'b');
    store.update(a.id, { status: 'done' });
    store.update(b.id, { status: 'running' });

    expect(store.remove(a.id)).toBe('removed');
    expect(store.get(a.id)).toBeUndefined();
    await expect(stat(join(dir, a.id))).rejects.toThrow();

    expect(store.remove(b.id)).toBe('busy');
    expect(store.get(b.id)?.status).toBe('running');

    expect(store.remove(b.id, { force: true })).toBe('removed');
    expect(store.get(b.id)).toBeUndefined();

    expect(store.remove('nonexistent')).toBe('not_found');
  });

  it('持久化：create/update 后销毁 store，新 store 用同 cacheDir 能恢复历史', async () => {
    const dir = await newTmp();
    const s1 = new JobStore(dir);
    const a = s1.create('analyze', ['/x/a.hap'], 'a.hap');
    const b = s1.create('compare', ['/x/a.hap', '/x/b.hap'], 'a vs b');
    s1.update(a.id, { status: 'done', outputs: { htmlUrl: `/jobs/${a.id}/html`, jsonUrl: `/jobs/${a.id}/json` } });
    s1.update(b.id, { status: 'error', error: '示例失败' });

    // 模拟"重启"：构造新实例
    const s2 = new JobStore(dir);
    const list = s2.list();
    expect(list).toHaveLength(2);
    // 最近的在前（b 后建的）
    expect(list[0]!.id).toBe(b.id);
    expect(list[0]!.status).toBe('error');
    expect(list[0]!.error).toBe('示例失败');
    expect(list[1]!.id).toBe(a.id);
    expect(list[1]!.status).toBe('done');
    expect(list[1]!.outputs?.htmlUrl).toBe(`/jobs/${a.id}/html`);
  });

  it('持久化：上次未完成的 pending/running 在新进程重新加载时被修复为 error', async () => {
    const dir = await newTmp();
    const s1 = new JobStore(dir);
    const p = s1.create('analyze', ['/x/p.hap'], 'p.hap');
    const r = s1.create('analyze', ['/x/r.hap'], 'r.hap');
    s1.update(r.id, { status: 'running' });
    // 不显式标 done，模拟进程在这里被 kill

    const s2 = new JobStore(dir);
    const job1 = s2.get(p.id);
    const job2 = s2.get(r.id);
    expect(job1?.status).toBe('error');
    expect(job1?.error).toContain('服务中断');
    expect(job2?.status).toBe('error');
    expect(job2?.error).toContain('服务中断');
    expect(typeof job2?.finishedAt).toBe('string');

    // 再加载一次：状态保留为 error，不会再次"修复"
    const s3 = new JobStore(dir);
    expect(s3.get(r.id)?.status).toBe('error');
  });

  it('持久化：remove 真删 meta.json 后，再加载历史不应再出现这条 job', async () => {
    const dir = await newTmp();
    const s1 = new JobStore(dir);
    const a = s1.create('analyze', ['/x/a.hap'], 'a');
    s1.update(a.id, { status: 'done' });
    expect(s1.remove(a.id)).toBe('removed');

    const s2 = new JobStore(dir);
    expect(s2.list()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* browseDirectory                                                             */
/* -------------------------------------------------------------------------- */

describe('browseDirectory', () => {
  it('能列出真实目录的子项 + 计算父目录', async () => {
    const dir = await newTmp();
    await writeFile(join(dir, 'a.hap'), 'mock');
    await writeFile(join(dir, 'b.txt'), 'mock');

    const r = await browseDirectory(dir);
    expect(r.cwd).toBe(dir);
    expect(r.parent).not.toBe(null);
    expect(r.isRootList).toBe(false);
    const names = r.entries.map((e) => e.name);
    expect(names).toContain('a.hap');
    expect(names).toContain('b.txt');

    const hapEntry = r.entries.find((e) => e.name === 'a.hap');
    expect(hapEntry?.ext).toBe('.hap');
    expect(typeof hapEntry?.size).toBe('number');
  });

  it('空 / undefined → 返回根列表（Windows 列盘符，其它平台列 /）', async () => {
    const r = await browseDirectory();
    if (process.platform === 'win32') {
      expect(r.isRootList).toBe(true);
      expect(r.cwd).toBe('ROOT');
      expect(r.entries.length).toBeGreaterThan(0); // 至少有一个盘符
      for (const e of r.entries) expect(e.isDir).toBe(true);
    } else {
      expect(r.isRootList).toBe(false);
      expect(r.cwd).toBe('/');
    }
  });

  it('不存在的路径抛 BrowseError', async () => {
    await expect(browseDirectory('/this/path/does/not/exist/abc-xyz-12345')).rejects.toBeInstanceOf(
      BrowseError,
    );
  });

  it('非绝对路径抛 BrowseError', async () => {
    await expect(browseDirectory('relative/path')).rejects.toBeInstanceOf(BrowseError);
  });
});

/* -------------------------------------------------------------------------- */
/* locateByMeta                                                                */
/* -------------------------------------------------------------------------- */

describe('locateByMeta', () => {
  it('能在 root 子树里按 name+size 精确反查', async () => {
    const root = await newTmp();
    // 构造嵌套结构：root/sub1/sub2/found.hap
    const sub = join(root, 'sub1', 'sub2');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(sub, { recursive: true });
    const target = join(sub, 'found.hap');
    await writeFile(target, 'hello-1234567890');

    // 也加一个干扰项：同名但大小不同
    await writeFile(join(root, 'sub1', 'found.hap'), 'different');

    const r = await locateByMeta({
      name: 'found.hap',
      size: 'hello-1234567890'.length,
      roots: [root],
    });
    expect(r.matches).toContain(target);
    expect(r.matches).not.toContain(join(root, 'sub1', 'found.hap'));
  });

  it('未命中返回空 matches，不抛错', async () => {
    const root = await newTmp();
    const r = await locateByMeta({ name: 'nope.hap', size: 999, roots: [root] });
    expect(r.matches).toEqual([]);
  });

  it('size 不匹配会被过滤', async () => {
    const root = await newTmp();
    await writeFile(join(root, 'a.hap'), 'aaa');
    const r = await locateByMeta({ name: 'a.hap', size: 9999, roots: [root] });
    expect(r.matches).toEqual([]);
  });

  it('跳过 node_modules 等噪音目录', async () => {
    const root = await newTmp();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'a.hap'), 'aa');
    const r = await locateByMeta({ name: 'a.hap', size: 2, roots: [root] });
    expect(r.matches).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* HTTP server: smoke                                                          */
/* -------------------------------------------------------------------------- */

describe('startWorkbenchServer', () => {
  let handle: WorkbenchServerHandle;

  beforeEach(async () => {
    const cacheDir = await newTmp();
    handle = await startWorkbenchServer({
      port: 0,
      toolVersion: 'wb-test',
      cacheDir,
      log: () => {},
    });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('GET / 返回 workbench HTML 页面', async () => {
    const r = await fetch(handle.url);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(text).toContain('KingSDK Hap Workbench');
    expect(text).toContain('id="picker"');
  });

  it('GET / 页面里 drop 校验跟着 currentPlatform 走（不再硬编码 .hap / .json）', async () => {
    // 防回归：曾经 compare 页拖入 .apk 被拒 "只支持 .hap / .json"，因为 drop handler
    // 写死了正则。修复后 drop 改为读 platformDef(currentPlatform).fileFilter。
    const r = await fetch(handle.url);
    const text = await r.text();
    // 1) 三个平台的 fileFilter 都必须出现在注入的 PLATFORM_DEFS JSON 里
    expect(text).toContain('.hap,.json');
    expect(text).toContain('.apk,.aab,.json');
    expect(text).toContain('.ipa,.json');
    // 2) drop 校验已基于 platformDef(currentPlatform) + fileFilter
    expect(text).toContain('platformDef(currentPlatform)');
    expect(text).toContain('def.fileFilter');
    // 3) 旧的硬编码正则不应再出现
    expect(text).not.toMatch(/\/\\\.hap\$\|\\\.json\$\//);
  });

  it('GET /healthz → "ok"', async () => {
    const r = await fetch(`${handle.url}healthz`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('ok');
  });

  it('GET /api/browse 列出真实目录', async () => {
    const dir = await newTmp();
    await writeFile(join(dir, 'x.hap'), 'mock');

    const r = await fetch(`${handle.url}api/browse?dir=${encodeURIComponent(dir)}`);
    expect(r.status).toBe(200);
    const data = await r.json();
    expect(data.cwd).toBe(dir);
    expect(data.entries.find((e: { name: string }) => e.name === 'x.hap')).toBeDefined();
  });

  it('GET /api/browse 不存在路径返回 4xx + JSON error', async () => {
    const r = await fetch(`${handle.url}api/browse?dir=${encodeURIComponent('/nope/abc-xyz')}`);
    expect(r.status).toBeGreaterThanOrEqual(400);
    const data = await r.json();
    expect(data.error).toBe('BROWSE_FAILED');
  });

  it('GET /api/locate 缺参数 → 400', async () => {
    const r = await fetch(`${handle.url}api/locate`);
    expect(r.status).toBe(400);
    const data = await r.json();
    expect(data.error).toBe('BAD_REQUEST');
  });

  it('GET /api/locate 参数齐全 → 200 + matches/scanned/roots', async () => {
    const r = await fetch(`${handle.url}api/locate?name=__definitely_no_such_file__.hap&size=1`);
    expect(r.status).toBe(200);
    const data = await r.json();
    expect(Array.isArray(data.matches)).toBe(true);
    expect(typeof data.scanned).toBe('number');
    expect(Array.isArray(data.roots)).toBe(true);
  });

  it('POST /api/analyze 启动作业，轮询能拿到 done 状态', async () => {
    const hap = await buildFixtureHap();

    const startResp = await fetch(`${handle.url}api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: hap }),
    });
    expect(startResp.status).toBe(202);
    const { jobId } = await startResp.json();
    expect(typeof jobId).toBe('string');

    // 轮询直到 done 或 error
    const job = await pollUntilFinished(handle, jobId);
    expect(job.status).toBe('done');
    expect(job.outputs?.htmlUrl).toBe(`/jobs/${jobId}/html`);
    expect(job.outputs?.jsonUrl).toBe(`/jobs/${jobId}/json`);

    // GET 产物
    const htmlResp = await fetch(`${handle.url}jobs/${jobId}/html`);
    expect(htmlResp.status).toBe(200);
    expect(htmlResp.headers.get('content-type')).toContain('text/html');
    expect((await htmlResp.text()).startsWith('<!DOCTYPE html>')).toBe(true);

    const jsonResp = await fetch(`${handle.url}jobs/${jobId}/json`);
    expect(jsonResp.status).toBe(200);
    const report = await jsonResp.json();
    expect(report.schemaVersion).toBe('1.0');
  });

  it('上传 → 分析：POST /api/uploads 返回 uploadId，analyze 用 upload 来源跑通', async () => {
    const hap = await buildFixtureHap();
    const bytes = await readFile(hap);

    // 1) 流式上传原始字节
    const up = await fetch(`${handle.url}api/uploads?name=demo.hap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    expect(up.status).toBe(201);
    const { uploadId, size } = await up.json();
    expect(typeof uploadId).toBe('string');
    expect(size).toBe(bytes.length);

    // 2) 用 upload 来源分析
    const startResp = await fetch(`${handle.url}api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: { type: 'upload', uploadId, name: 'demo.hap' } }),
    });
    expect(startResp.status).toBe(202);
    const { jobId } = await startResp.json();

    const job = await pollUntilFinished(handle, jobId);
    expect(job.status).toBe('done');
    // 历史来源标记为上传
    expect(job.inputs?.[0]).toContain('[上传]');

    const report = await (await fetch(`${handle.url}jobs/${jobId}/json`)).json();
    expect(report.schemaVersion).toBe('1.0');
  });

  it('上传 → 对比：两侧都用 upload 来源，同包自比 identical=true', async () => {
    const hap = await buildFixtureHap();
    const bytes = await readFile(hap);

    async function upload(name: string): Promise<string> {
      const r = await fetch(`${handle.url}api/uploads?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes,
      });
      expect(r.status).toBe(201);
      return (await r.json()).uploadId;
    }
    const leftId = await upload('a.hap');
    const rightId = await upload('b.hap');

    const startResp = await fetch(`${handle.url}api/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        left: { type: 'upload', uploadId: leftId, name: 'a.hap' },
        right: { type: 'upload', uploadId: rightId, name: 'b.hap' },
      }),
    });
    expect(startResp.status).toBe(202);
    const { jobId } = await startResp.json();

    const job = await pollUntilFinished(handle, jobId);
    expect(job.status).toBe('done');

    const diff = await (await fetch(`${handle.url}jobs/${jobId}/json`)).json();
    expect(diff.summary.identical).toBe(true);
  });

  it('POST /api/uploads 缺 name → 400', async () => {
    const r = await fetch(`${handle.url}api/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('x'),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('BAD_REQUEST');
  });

  it('analyze 引用不存在的 uploadId → job 落 error', async () => {
    const startResp = await fetch(`${handle.url}api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: { type: 'upload', uploadId: '0123456789abcdef', name: 'x.hap' } }),
    });
    expect(startResp.status).toBe(202);
    const { jobId } = await startResp.json();
    const job = await pollUntilFinished(handle, jobId);
    expect(job.status).toBe('error');
  });

  it('POST /api/analyze 带 platform=android 跑通 .apk fixture，job + report 都标 android', async () => {
    const apk = await buildFixtureApk();

    const startResp = await fetch(`${handle.url}api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: apk, platform: 'android' }),
    });
    expect(startResp.status).toBe(202);
    const { jobId } = await startResp.json();

    const job = await pollUntilFinished(handle, jobId);
    expect(job.status).toBe('done');
    // job 元数据带 platform
    expect(job.platform).toBe('android');

    // 拉 json 产物：report.platform=android、androidManifest 解析正确
    const jsonResp = await fetch(`${handle.url}jobs/${jobId}/json`);
    expect(jsonResp.status).toBe(200);
    const report = await jsonResp.json();
    expect(report.platform).toBe('android');
    expect(report.androidManifest?.packageName).toBe(DEMO_APK_PACKAGE);
    // 跨平台字段照样填齐：basic 由 manifest 派生，nativeLibs 走 lib/ 前缀
    expect(report.basic?.bundleName).toBe(DEMO_APK_PACKAGE);
    expect(report.nativeLibs?.architectures.sort()).toEqual(['arm64-v8a', 'x86_64']);
  });

  it('POST /api/analyze 路径不存在 → 作业立刻 error', async () => {
    const r = await fetch(`${handle.url}api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/nope/abc-xyz-12345.hap' }),
    });
    const { jobId } = await r.json();
    const job = await pollUntilFinished(handle, jobId);
    expect(job.status).toBe('error');
    expect(job.error).toContain('文件不存在');
  });

  it('POST /api/analyze 缺 path 字段 → 400', async () => {
    const r = await fetch(`${handle.url}api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('BAD_REQUEST');
  });

  it('磁盘 diff.json 默认 pretty（含换行 + 2 空格缩进），但 viewer html 内嵌仍紧凑', async () => {
    const hap = await buildFixtureHap();
    const startResp = await fetch(`${handle.url}api/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leftPath: hap, rightPath: hap }),
    });
    const { jobId } = await startResp.json();
    await pollUntilFinished(handle, jobId);

    // /jobs/:id/json 走文件流：磁盘 pretty → 响应 body 含换行
    const rawDiff = await (await fetch(`${handle.url}jobs/${jobId}/json`)).text();
    expect(rawDiff.includes('\n')).toBe(true);
    expect(rawDiff.split('\n').length).toBeGreaterThan(10);
    // 2 空格缩进 anchor
    expect(rawDiff).toMatch(/\n {2}"schemaVersion"/);
    // 仍是合法 JSON
    expect(() => JSON.parse(rawDiff)).not.toThrow();

    // viewer html 模板内嵌的 __DATA__ 走独立的 serializeForHtml（紧凑），不受影响
    const rawHtml = await (await fetch(`${handle.url}jobs/${jobId}/html`)).text();
    const m = rawHtml.match(/<script id="__DATA__"[^>]*>([\s\S]*?)<\/script>/);
    expect(m).toBeTruthy();
    const embedded = m![1]!;
    // 内嵌 JSON 不含 \n（紧凑）；防回归：保证磁盘 pretty 没把模板路径污染掉
    expect(embedded.includes('\n')).toBe(false);

    // 单侧产物同样默认 pretty
    const leftRaw = await (await fetch(`${handle.url}jobs/${jobId}/sides/left/json`)).text();
    expect(leftRaw.includes('\n')).toBe(true);
    expect(leftRaw).toMatch(/\n {2}"schemaVersion"/);
  });

  it('显式 prettyJson=false → 磁盘 JSON 退回紧凑单行（极端关心磁盘体积场景）', async () => {
    const compactCacheDir = await newTmp();
    const compactHandle = await startWorkbenchServer({
      port: 0,
      toolVersion: 'wb-compact',
      cacheDir: compactCacheDir,
      log: () => {},
      prettyJson: false,
    });
    try {
      const hap = await buildFixtureHap();
      const startResp = await fetch(`${compactHandle.url}api/compare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leftPath: hap, rightPath: hap }),
      });
      const { jobId } = await startResp.json();
      await pollUntilFinished(compactHandle, jobId);

      const rawDiff = await (await fetch(`${compactHandle.url}jobs/${jobId}/json`)).text();
      // 紧凑：单行（除可能的最后一行尾空白外）
      expect(rawDiff.split('\n').length).toBeLessThan(3);
      expect(() => JSON.parse(rawDiff)).not.toThrow();
    } finally {
      await compactHandle.close();
    }
  });

  it('POST /api/compare 同 hap 自比 → identical=true', async () => {
    const hap = await buildFixtureHap();

    const startResp = await fetch(`${handle.url}api/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leftPath: hap, rightPath: hap }),
    });
    expect(startResp.status).toBe(202);
    const { jobId } = await startResp.json();

    const job = await pollUntilFinished(handle, jobId);
    expect(job.status).toBe('done');

    const diff = await (await fetch(`${handle.url}jobs/${jobId}/json`)).json();
    expect(diff.summary.identical).toBe(true);
  });

  it('compare job 完成后 outputs.sides 暴露左右两侧 URL，并能取到真实 PackageReport', async () => {
    const hap = await buildFixtureHap();
    const startResp = await fetch(`${handle.url}api/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leftPath: hap, rightPath: hap }),
    });
    const { jobId } = await startResp.json();
    const job = await pollUntilFinished(handle, jobId);
    expect(job.status).toBe('done');

    expect(job.outputs?.sides?.left.htmlUrl).toBe(`/jobs/${jobId}/sides/left/html`);
    expect(job.outputs?.sides?.left.jsonUrl).toBe(`/jobs/${jobId}/sides/left/json`);
    expect(job.outputs?.sides?.left.sourcePath).toBe(hap);
    expect(job.outputs?.sides?.right.htmlUrl).toBe(`/jobs/${jobId}/sides/right/html`);
    expect(job.outputs?.sides?.right.jsonUrl).toBe(`/jobs/${jobId}/sides/right/json`);
    expect(job.outputs?.sides?.right.sourcePath).toBe(hap);

    // 单侧 JSON 应该是完整的 PackageReport（带 schemaVersion + meta），而不是 diff
    const leftJson = await (await fetch(`${handle.url}jobs/${jobId}/sides/left/json`)).json();
    expect(leftJson.schemaVersion).toBe('1.0');
    expect(typeof leftJson.meta?.sha256).toBe('string');
    expect(leftJson.meta.file).toBe(hap);
    // diff JSON 不会有 basic / size / nativeLibs 顶层字段；PackageReport 会有
    expect(leftJson).not.toHaveProperty('summary');

    // 单侧 HTML 应该是 viewer 模板（带 #__DATA__ 注入），且不是 diff 模板
    const rightHtml = await (await fetch(`${handle.url}jobs/${jobId}/sides/right/html`)).text();
    expect(rightHtml.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(rightHtml).toContain('id="__DATA__"');
    // diff 模板里会含 'KingSDK Hap Diff'，单侧报告不会（标题来自 report 模板）
    expect(rightHtml).not.toContain('KingSDK Hap Diff');
  });

  it('analyze job 没有单侧产物，sides 路由返回 400', async () => {
    const hap = await buildFixtureHap();
    const startResp = await fetch(`${handle.url}api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: hap }),
    });
    const { jobId } = await startResp.json();
    const job = await pollUntilFinished(handle, jobId);
    expect(job.status).toBe('done');
    expect(job.outputs?.sides).toBeUndefined();

    const r = await fetch(`${handle.url}jobs/${jobId}/sides/left/json`);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('BAD_REQUEST');
  });

  it('老 compare job（磁盘没 left/right.report.* 文件）请求单侧产物 → 404 PRODUCT_MISSING', async () => {
    // 直接通过 store 接口构造一个"已完成但磁盘上没单侧产物"的 compare job，
    // 模拟工具升级前生成的历史
    const job = handle.store.create('compare', ['/x/a.hap', '/x/b.hap'], 'a vs b');
    handle.store.update(job.id, {
      status: 'done',
      finishedAt: new Date().toISOString(),
      outputs: {
        htmlUrl: `/jobs/${job.id}/html`,
        jsonUrl: `/jobs/${job.id}/json`,
      },
    });

    const r = await fetch(`${handle.url}jobs/${job.id}/sides/left/json`);
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe('PRODUCT_MISSING');
  });

  it('sides 路由对未完成 job 返回 409', async () => {
    const job = handle.store.create('compare', ['/x/a.hap', '/x/b.hap'], 'a vs b');
    handle.store.update(job.id, { status: 'running' });
    const r = await fetch(`${handle.url}jobs/${job.id}/sides/right/html`);
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe('NOT_READY');
  });

  it('sides 路由 side 必须是 left|right，其它形如 sides/middle 走通用 404', async () => {
    const job = handle.store.create('compare', ['/x/a.hap', '/x/b.hap'], 'a vs b');
    handle.store.update(job.id, { status: 'done', outputs: {
      htmlUrl: `/jobs/${job.id}/html`,
      jsonUrl: `/jobs/${job.id}/json`,
    } });
    const r = await fetch(`${handle.url}jobs/${job.id}/sides/middle/html`);
    expect(r.status).toBe(404);
  });

  it('GET /jobs/:id/html 在作业未完成时返回 409', async () => {
    // 用一个不存在路径让任务立刻 error；error 状态不是 done 也应 409
    const r = await fetch(`${handle.url}api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/nope/zzz.hap' }),
    });
    const { jobId } = await r.json();
    const job = await pollUntilFinished(handle, jobId);
    expect(job.status).toBe('error');

    const html = await fetch(`${handle.url}jobs/${jobId}/html`);
    expect(html.status).toBe(409);
  });

  it('DELETE /api/jobs/:id 删除已完成的 job', async () => {
    const hap = await buildFixtureHap();
    const startResp = await fetch(`${handle.url}api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: hap }),
    });
    const { jobId } = await startResp.json();
    const job = await pollUntilFinished(handle, jobId);
    expect(job.status).toBe('done');

    const delResp = await fetch(`${handle.url}api/jobs/${jobId}`, { method: 'DELETE' });
    expect(delResp.status).toBe(200);
    expect((await delResp.json()).removed).toBe(jobId);

    const after = await fetch(`${handle.url}api/jobs/${jobId}`);
    expect(after.status).toBe(404);
  });

  it('DELETE /api/jobs/:id 不带 force 时拒绝 active 状态，返回 409', async () => {
    // 直接通过 store 接口插入一个 running 状态来构造（绕过实际 analyze 完成的耗时）
    const job = handle.store.create('analyze', ['/dummy'], 'dummy');
    handle.store.update(job.id, { status: 'running' });

    const r1 = await fetch(`${handle.url}api/jobs/${job.id}`, { method: 'DELETE' });
    expect(r1.status).toBe(409);
    expect((await r1.json()).error).toBe('JOB_BUSY');

    const r2 = await fetch(`${handle.url}api/jobs/${job.id}?force=true`, { method: 'DELETE' });
    expect(r2.status).toBe(200);
    expect((await r2.json()).removed).toBe(job.id);
  });

  it('DELETE /api/jobs/:id 不存在的 id → 404', async () => {
    const r = await fetch(`${handle.url}api/jobs/abcdef0123456789`, { method: 'DELETE' });
    expect(r.status).toBe(404);
  });

  it('GET /api/jobs 列表里能看到 已结束作业', async () => {
    const hap = await buildFixtureHap();
    await fetch(`${handle.url}api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: hap }),
    });
    const list = await (await fetch(`${handle.url}api/jobs`)).json();
    expect(list.jobs.length).toBeGreaterThanOrEqual(1);
  });

  it('未知路径 → 404 JSON', async () => {
    const r = await fetch(`${handle.url}api/no-such-route`);
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe('NOT_FOUND');
  });
});

/* -------------------------------------------------------------------------- */
/* web 模式：屏蔽一切"碰服务器本机文件系统"的能力（远程部署安全）              */
/* -------------------------------------------------------------------------- */

describe('startWorkbenchServer web 模式', () => {
  let handle: WorkbenchServerHandle;

  beforeEach(async () => {
    const cacheDir = await newTmp();
    handle = await startWorkbenchServer({
      port: 0,
      toolVersion: 'wb-test',
      cacheDir,
      mode: 'web',
      log: () => {},
    });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('首页注入 mode=web 且 devopsOnly 别名为 true', async () => {
    const text = await (await fetch(handle.url)).text();
    expect(text).toContain('mode: "web"');
    expect(text).toContain('devopsOnly: true');
  });

  it('GET /api/browse → 403 WEB_MODE（不暴露服务器目录树）', async () => {
    const dir = await newTmp();
    const r = await fetch(`${handle.url}api/browse?dir=${encodeURIComponent(dir)}`);
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('WEB_MODE');
  });

  it('POST /api/open-cache-dir → 403 WEB_MODE（不在服务器弹窗）', async () => {
    const r = await fetch(`${handle.url}api/open-cache-dir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('WEB_MODE');
  });

  it('POST /api/local-project → 403 WEB_MODE（不往服务器磁盘写）', async () => {
    const r = await fetch(`${handle.url}api/local-project`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buildId: 'b1', targetDir: '/tmp' }),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('WEB_MODE');
  });

  it('POST /api/analyze 带本地路径 → 403（仅接受蓝盾制品来源）', async () => {
    const hap = await buildFixtureHap();
    const r = await fetch(`${handle.url}api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: hap }),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('DEVOPS_ONLY');
  });

  it('上传流在 web 模式同样放行（上传→分析跑通）', async () => {
    const hap = await buildFixtureHap();
    const bytes = await readFile(hap);
    const up = await fetch(`${handle.url}api/uploads?name=demo.hap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    expect(up.status).toBe(201);
    const { uploadId } = await up.json();

    const startResp = await fetch(`${handle.url}api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: { type: 'upload', uploadId, name: 'demo.hap' } }),
    });
    expect(startResp.status).toBe(202);
    const { jobId } = await startResp.json();
    const job = await pollUntilFinished(handle, jobId);
    expect(job.status).toBe('done');
  });
});

/* -------------------------------------------------------------------------- */

async function pollUntilFinished(
  handle: WorkbenchServerHandle,
  jobId: string,
  timeoutMs = 10_000,
): Promise<{
  status: string;
  error?: string;
  outputs?: {
    htmlUrl: string;
    jsonUrl: string;
    sides?: {
      left: { sourcePath: string; htmlUrl: string; jsonUrl: string };
      right: { sourcePath: string; htmlUrl: string; jsonUrl: string };
    };
  };
}> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${handle.url}api/jobs/${jobId}`);
    const job = await r.json();
    if (job.status === 'done' || job.status === 'error') return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job ${jobId} 在 ${timeoutMs}ms 内未结束`);
}
