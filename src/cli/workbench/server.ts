import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import { browseDirectory, BrowseError } from './browse.js';
import { locateByMeta } from './locate.js';
import { startAnalyzeJob, startCompareJob } from './runner.js';
import { JobStore, defaultCacheDir } from './store.js';
import { renderWorkbenchPage } from './page.js';

export interface WorkbenchServerOptions {
  port?: number;
  host?: string;
  toolVersion: string;
  cacheDir?: string;
  log?: (text: string) => void;
}

export interface WorkbenchServerHandle {
  url: string;
  port: number;
  store: JobStore;
  close: () => Promise<void>;
}

/**
 * 启动 workbench HTTP server。
 *
 * 路由：
 *   GET  /                              工作台 HTML 页面
 *   GET  /healthz                       存活检查
 *   GET  /api/browse?dir=...            服务端目录浏览（零拷贝选 hap）
 *   GET  /api/jobs                      job 列表
 *   GET  /api/jobs/:id                  单个 job
 *   POST /api/analyze                   { path } → 启动分析作业
 *   POST /api/compare                   { leftPath, rightPath } → 启动对比作业
 *   GET  /jobs/:id/html                 作业主产物 HTML（analyze=报告 / compare=diff）
 *   GET  /jobs/:id/json                 作业主产物 JSON
 *   GET  /jobs/:id/sides/:side/html     compare job 单侧 HapReport HTML（side ∈ left|right）
 *   GET  /jobs/:id/sides/:side/json     compare job 单侧 HapReport JSON
 *
 * 仅监听 127.0.0.1，零外部依赖。
 */
export async function startWorkbenchServer(
  options: WorkbenchServerOptions,
): Promise<WorkbenchServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 7790;
  const log = options.log ?? ((t) => process.stderr.write(t));
  const store = new JobStore(options.cacheDir ?? defaultCacheDir(port));

  const server: Server = createServer((req, res) => {
    handle(req, res, store, options.toolVersion, log).catch((err) => {
      log(`[workbench] handler error: ${err?.stack ?? err}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ error: 'INTERNAL', message: String(err?.message ?? err) }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = addr && typeof addr === 'object' && 'port' in addr ? addr.port : port;

  return {
    url: `http://${host}:${actualPort}/`,
    port: actualPort,
    store,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/* -------------------------------------------------------------------------- */
/* 路由分发                                                                    */
/* -------------------------------------------------------------------------- */

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: JobStore,
  toolVersion: string,
  log: (t: string) => void,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const method = req.method ?? 'GET';

  // 静态：工作台首页
  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    sendHtml(res, renderWorkbenchPage());
    return;
  }
  if (method === 'GET' && url.pathname === '/healthz') {
    sendText(res, 'ok');
    return;
  }

  // API
  if (method === 'GET' && url.pathname === '/api/browse') {
    try {
      const dir = url.searchParams.get('dir') ?? undefined;
      const result = await browseDirectory(dir || undefined);
      sendJson(res, 200, result);
    } catch (e) {
      if (e instanceof BrowseError) {
        sendJson(res, e.statusCode, { error: 'BROWSE_FAILED', message: e.message });
      } else {
        throw e;
      }
    }
    return;
  }

  if (method === 'GET' && url.pathname === '/api/locate') {
    const name = url.searchParams.get('name') ?? '';
    const sizeStr = url.searchParams.get('size') ?? '';
    const size = Number.parseInt(sizeStr, 10);
    if (!name || !Number.isFinite(size) || size < 0) {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: '需要 name + size 两个查询参数' });
      return;
    }
    const result = await locateByMeta({ name, size });
    sendJson(res, 200, result);
    return;
  }

  if (method === 'GET' && url.pathname === '/api/jobs') {
    sendJson(res, 200, { jobs: store.list(50) });
    return;
  }

  const jobMatch = /^\/api\/jobs\/([0-9a-f]+)$/.exec(url.pathname);
  if (method === 'GET' && jobMatch) {
    const job = store.get(jobMatch[1]!);
    if (!job) {
      sendJson(res, 404, { error: 'NOT_FOUND' });
      return;
    }
    sendJson(res, 200, job);
    return;
  }

  if (method === 'DELETE' && jobMatch) {
    const id = jobMatch[1]!;
    const force = url.searchParams.get('force') === 'true';
    const result = store.remove(id, { force });
    if (result === 'not_found') {
      sendJson(res, 404, { error: 'NOT_FOUND' });
    } else if (result === 'busy') {
      sendJson(res, 409, { error: 'JOB_BUSY', message: '任务进行中；要强制删除请加 ?force=true' });
    } else {
      sendJson(res, 200, { removed: id });
    }
    return;
  }

  if (method === 'POST' && url.pathname === '/api/analyze') {
    const body = await readJson(req).catch((e) => ({ __error: e }));
    if ('__error' in (body as object)) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String((body as { __error: Error }).__error.message) });
      return;
    }
    const path = (body as { path?: unknown }).path;
    if (typeof path !== 'string' || !path.trim()) {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: '缺少 path 字符串字段' });
      return;
    }
    const extras = parseExtras((body as { extras?: unknown }).extras);
    const id = startAnalyzeJob(path.trim(), { store, toolVersion, log, extras });
    sendJson(res, 202, { jobId: id });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/compare') {
    const body = await readJson(req).catch((e) => ({ __error: e }));
    if ('__error' in (body as object)) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String((body as { __error: Error }).__error.message) });
      return;
    }
    const { leftPath, rightPath } = body as { leftPath?: unknown; rightPath?: unknown };
    if (typeof leftPath !== 'string' || !leftPath.trim() || typeof rightPath !== 'string' || !rightPath.trim()) {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: '需要 leftPath / rightPath 两个字符串字段' });
      return;
    }
    const extras = parseExtras((body as { extras?: unknown }).extras);
    const id = startCompareJob(leftPath.trim(), rightPath.trim(), { store, toolVersion, log, extras });
    sendJson(res, 202, { jobId: id });
    return;
  }

  // compare job 单侧产物：必须放在通用 /jobs/:id/(html|json) 之前，避免被吞
  const sideMatch = /^\/jobs\/([0-9a-f]+)\/sides\/(left|right)\/(html|json)$/.exec(url.pathname);
  if (method === 'GET' && sideMatch) {
    const [, id, side, kind] = sideMatch;
    await serveJobSideProduct(res, store, id!, side! as 'left' | 'right', kind! as 'html' | 'json');
    return;
  }

  // 静态产物（主产物：analyze=report / compare=diff）
  const productMatch = /^\/jobs\/([0-9a-f]+)\/(html|json)$/.exec(url.pathname);
  if (method === 'GET' && productMatch) {
    const [, id, kind] = productMatch;
    await serveJobProduct(res, store, id!, kind! as 'html' | 'json');
    return;
  }

  sendJson(res, 404, { error: 'NOT_FOUND', path: url.pathname });
}

/* -------------------------------------------------------------------------- */
/* 工具函数                                                                    */
/* -------------------------------------------------------------------------- */

async function serveJobProduct(
  res: ServerResponse,
  store: JobStore,
  id: string,
  kind: 'html' | 'json',
): Promise<void> {
  const job = store.get(id);
  if (!job) {
    sendJson(res, 404, { error: 'NOT_FOUND' });
    return;
  }
  if (job.status !== 'done') {
    sendJson(res, 409, { error: 'NOT_READY', status: job.status, message: '作业未完成' });
    return;
  }
  const dir = store.jobDir(id);
  const fileName = job.kind === 'analyze' ? `report.${kind}` : `diff.${kind}`;
  const filePath = join(dir, fileName);
  await streamFileOr404(res, filePath, fileName, kind);
}

/**
 * compare job 的"单侧 HapReport"产物。
 *
 * - 仅对 kind='compare' 有效；analyze job → 400（语义不通）
 * - status≠'done' → 409
 * - 文件落盘是在 runner.runCompareAsync 完成时一并写的；老 compare job（升级前）
 *   不会有 left/right.report.* 文件，此时返回 404 PRODUCT_MISSING，
 *   提示用户重新跑一次对比即可。
 */
async function serveJobSideProduct(
  res: ServerResponse,
  store: JobStore,
  id: string,
  side: 'left' | 'right',
  kind: 'html' | 'json',
): Promise<void> {
  const job = store.get(id);
  if (!job) {
    sendJson(res, 404, { error: 'NOT_FOUND' });
    return;
  }
  if (job.kind !== 'compare') {
    sendJson(res, 400, { error: 'BAD_REQUEST', message: '单侧产物仅对 compare job 有效' });
    return;
  }
  if (job.status !== 'done') {
    sendJson(res, 409, { error: 'NOT_READY', status: job.status, message: '作业未完成' });
    return;
  }
  const dir = store.jobDir(id);
  const fileName = `${side}.report.${kind}`;
  const filePath = join(dir, fileName);
  await streamFileOr404(res, filePath, fileName, kind);
}

async function streamFileOr404(
  res: ServerResponse,
  filePath: string,
  fileName: string,
  kind: 'html' | 'json',
): Promise<void> {
  if (!existsSync(filePath)) {
    sendJson(res, 404, { error: 'PRODUCT_MISSING', file: fileName });
    return;
  }
  const stats = await stat(filePath);
  const ct = kind === 'html' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8';
  res.writeHead(200, {
    'Content-Type': ct,
    'Content-Length': stats.size,
    'Cache-Control': 'no-cache',
  });
  createReadStream(filePath).pipe(res);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(html);
}

function sendText(res: ServerResponse, text: string): void {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/**
 * 解析 body.extras，宽松模式：
 *  - undefined / null / 空数组 / 非数组 → undefined（runner 走默认）
 *  - 数组 → 过滤为 string[]，去重
 * 后端不在这里做 id 白名单校验：未知 id 进 pipeline 会被 pickEnabledAnalyzers 静默忽略，
 * 不影响其它默认 analyzer 运行。
 */
function parseExtras(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}

/** 安全读 JSON body，最大 256 KiB */
async function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > 256 * 1024) {
        reject(new Error('请求体超过 256 KiB 上限'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text) return resolve({});
        resolve(JSON.parse(text));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}
