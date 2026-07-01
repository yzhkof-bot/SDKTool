import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { platform } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { getExtraAnalyzerMeta } from '@kingsdk/core/analyzers/index.js';
import { DEFAULT_PLATFORM, type Platform } from '@kingsdk/shared/schema.js';

import { browseDirectory, BrowseError } from './browse.js';
import {
  DEVOPS_BUILD_STATUSES,
  DevopsError,
  loadDevopsRegistry,
  type DevopsBuildStatus,
  type DevopsRegistry,
} from './devops.js';
import { DevopsConfigError, loadDevopsConfig } from './devopsConfig.js';
import { ArtifactCache } from './artifactCache.js';
import { UploadStore, UploadError } from './uploadStore.js';
import { WeworkBotManager, WEWORK_REPLY_MODES } from './wework.js';
import type { WeworkReplyMode, WeworkSendRequest } from './wework.js';
import { locateByMeta } from './locate.js';
import { LocalProjectStore, startLocalProjectJob } from './localProject.js';
import { startAnalyzeJob, startCompareJob, type InputSource } from './runner.js';
import { JobStore, defaultCacheDir } from './store.js';
import { renderWorkbenchPage } from './page.js';
import {
  checkAiHealth,
  ConversationError,
  ConversationManager,
  SseWriter,
} from './ai/index.js';
import type { InlineImage, InlineImageMediaType } from './ai/types.js';

/**
 * workbench 运行形态：
 *  - 'desktop'：本机（CLI / Electron 内嵌 server）。全功能，允许本地路径输入、
 *    服务端目录浏览、配置本地工程、打开缓存目录。
 *  - 'web'：远程部署（server 跑在别的机器）。所有"碰服务器本机文件系统"的能力
 *    都屏蔽，只接受蓝盾制品来源——因为对远程用户来说服务器磁盘既无意义又危险。
 *
 * 旧的 devopsOnly 语义是本模式的一个子集，'web' 完整覆盖它。
 */
export type WorkbenchMode = 'desktop' | 'web';

export interface WorkbenchServerOptions {
  port?: number;
  host?: string;
  toolVersion: string;
  cacheDir?: string;
  log?: (text: string) => void;
  /**
   * 磁盘 JSON 产物是否使用 2 空格缩进。默认 true（方便 AI Read/Grep 按行切片
   * 与开发者本地查看）；显式 false 时退回紧凑单行。
   */
  prettyJson?: boolean;
  /**
   * 运行形态，见 {@link WorkbenchMode}。缺省按以下优先级解析：
   * options.mode > options.devopsOnly(true→web) > 环境变量 SDKTOOL_DEVOPS_ONLY > 'desktop'。
   */
  mode?: WorkbenchMode;
  /**
   * @deprecated 用 {@link mode} 代替。等价于 mode:'web'；仅为兼容既有 Linux 部署脚本保留。
   * devops-only（仅蓝盾包）模式：开启后分析/对比界面禁用本地路径输入，只接受蓝盾制品来源。
   * 缺省读环境变量 SDKTOOL_DEVOPS_ONLY（由启动脚本设置）。
   */
  devopsOnly?: boolean;
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
 *   GET  /api/extras?platform=          按平台返回可选深度 analyzer 元信息
 *   GET  /api/browse?dir=...            服务端目录浏览（零拷贝选 hap）
 *   GET  /api/devops/builds?page&pageSize&status   蓝盾流水线构建历史
 *   GET  /api/devops/artifacts?buildId  蓝盾某次构建的制品列表
 *   GET  /api/jobs                      job 列表
 *   GET  /api/jobs/:id                  单个 job
 *   POST /api/analyze                   { path | source, platform?, extras? } → 启动分析作业
 *   POST /api/compare                   { leftPath|left, rightPath|right, platform?, extras? } → 启动对比作业
 *                                       source/left/right 可为 { type:'devops', pipeline?, buildId, buildNum?, artifactPath, name, artifactoryType?, size? }
 *                                       （蓝盾制品引用，运行时才下载到独立缓存目录，已下载则复用）
 *   GET  /jobs/:id/html                 作业主产物 HTML（analyze=报告 / compare=diff）
 *   GET  /jobs/:id/json                 作业主产物 JSON
 *   GET  /jobs/:id/sides/:side/html     compare job 单侧 PackageReport HTML（side ∈ left|right）
 *   GET  /jobs/:id/sides/:side/json     compare job 单侧 PackageReport JSON
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
  const conversations = new ConversationManager({ store, log });
  const localProjects = new LocalProjectStore();
  // 上传件临时存储（分析/对比的本地文件来源统一走上传，边收边写盘）
  const uploads = new UploadStore(store.cacheDir);

  // 蓝盾流水线注册表（来自 pipelines.config.json）。配置错误时给出清晰报错而非静默。
  let devops: DevopsRegistry;
  try {
    devops = loadDevopsRegistry();
  } catch (e) {
    if (e instanceof DevopsConfigError) {
      log(`[workbench] 蓝盾流水线配置错误：${e.message}\n`);
    }
    throw e;
  }

  // 蓝盾制品下载缓存（目录/上限来自同一份配置；超量按下载先后清理）
  const artifactCache = new ArtifactCache(devops.artifactCache.dir, devops.artifactCache.maxBytes);
  log(`[workbench] 制品缓存目录 ${devops.artifactCache.dir}（上限 ${(devops.artifactCache.maxBytes / (1024 ** 3)).toFixed(0)} GiB）\n`);

  // 企业微信智能机器人长连接管理器（仅供「企业微信机器人」测试界面用，进程内单例）。
  // 收到的图片/文件/视频会下载解密落盘到缓存目录下的 wework-media/。
  const wework = new WeworkBotManager(
    loadDevopsConfig().wework,
    log,
    join(store.cacheDir, 'wework-media'),
  );
  if (wework.configured) {
    log('[workbench] 企业微信机器人：已读取 wework 配置，可在「企业微信机器人」标签页连接测试\n');
  } else {
    log('[workbench] 企业微信机器人：未配置 wework.botId/secret（测试界面会提示）\n');
  }

  const prettyJson = options.prettyJson;
  // 运行形态解析：mode 显式最高优先，其次兼容旧 devopsOnly / 环境变量。
  // webMode 为内部统一的布尔视图，贯穿路由门控与前端注入。
  const mode = resolveMode(options);
  const webMode = mode === 'web';
  if (webMode) log('[workbench] web 模式：仅支持蓝盾包对比，已禁用本地路径 / 目录浏览 / 配置本地工程 / 打开缓存目录\n');
  const server: Server = createServer((req, res) => {
    handle(req, res, store, conversations, localProjects, devops, artifactCache, uploads, wework, options.toolVersion, log, prettyJson, webMode).catch((err) => {
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
    close: () =>
      new Promise<void>((resolve) => {
        conversations.closeAll();
        wework.dispose();
        server.close(() => resolve());
      }),
  };
}

/* -------------------------------------------------------------------------- */
/* 路由分发                                                                    */
/* -------------------------------------------------------------------------- */

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: JobStore,
  conversations: ConversationManager,
  localProjects: LocalProjectStore,
  devops: DevopsRegistry,
  artifactCache: ArtifactCache,
  uploads: UploadStore,
  wework: WeworkBotManager,
  toolVersion: string,
  log: (t: string) => void,
  prettyJson: boolean | undefined,
  webMode: boolean,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const method = req.method ?? 'GET';

  // 静态：工作台首页
  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    sendHtml(res, renderWorkbenchPage(store.cacheDir, webMode ? 'web' : 'desktop'));
    return;
  }
  if (method === 'GET' && url.pathname === '/healthz') {
    sendText(res, 'ok');
    return;
  }

  // API
  if (method === 'POST' && url.pathname === '/api/open-cache-dir') {
    // web 模式：缓存目录在远程服务器上，"打开"无意义且会在服务器弹窗，直接拒绝
    if (webMode) {
      sendJson(res, 403, { error: 'WEB_MODE', message: 'web 模式不支持打开服务器本机目录' });
      return;
    }
    const cacheDir = store.cacheDir;
    openInExplorer(cacheDir, log);
    sendJson(res, 200, { opened: cacheDir });
    return;
  }

  // 上传本地文件（分析/对比的"本地文件"来源统一走这里，两模式都放行）。
  // 原始字节直接流式落盘（不占内存），文件名走 ?name= 查询参数；返回 uploadId。
  if (method === 'POST' && url.pathname === '/api/uploads') {
    const name = url.searchParams.get('name') ?? '';
    if (!name.trim()) {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: '缺少 name 查询参数（原始文件名）' });
      return;
    }
    try {
      const rec = await uploads.saveFromRequest(req, name.trim());
      sendJson(res, 201, { uploadId: rec.uploadId, name: rec.name, size: rec.size });
    } catch (e) {
      if (e instanceof UploadError) {
        sendJson(res, e.statusCode, { error: 'UPLOAD_FAILED', message: e.message });
      } else {
        throw e;
      }
    }
    return;
  }

  if (method === 'GET' && url.pathname === '/api/extras') {
    const p = parsePlatformQuery(url.searchParams.get('platform'));
    if (p === 'INVALID') {
      sendJson(res, 400, {
        error: 'BAD_PLATFORM',
        message: `platform 取值非法，允许：harmony | android | ios`,
      });
      return;
    }
    sendJson(res, 200, { platform: p, extras: getExtraAnalyzerMeta(p) });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/browse') {
    // web 模式：屏蔽服务端目录浏览，避免暴露远程服务器文件系统
    if (webMode) {
      sendJson(res, 403, { error: 'WEB_MODE', message: 'web 模式不支持浏览服务器目录' });
      return;
    }
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

  // 蓝盾流水线清单（前端侧栏下拉用）
  if (method === 'GET' && url.pathname === '/api/devops/pipelines') {
    sendJson(res, 200, { pipelines: devops.listPipelines(), defaultKey: devops.defaultKey });
    return;
  }

  // 蓝盾构建历史（首页左侧栏）
  if (method === 'GET' && url.pathname === '/api/devops/builds') {
    const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
    const pageSize = Number.parseInt(url.searchParams.get('pageSize') ?? '20', 10);
    const statusRaw = url.searchParams.get('status');
    let status: DevopsBuildStatus | undefined;
    if (statusRaw) {
      if (!(DEVOPS_BUILD_STATUSES as readonly string[]).includes(statusRaw)) {
        sendJson(res, 400, {
          error: 'BAD_REQUEST',
          message: `status 取值非法，允许：${DEVOPS_BUILD_STATUSES.join(' | ')}`,
        });
        return;
      }
      status = statusRaw as DevopsBuildStatus;
    }
    try {
      const client = devops.getClient(url.searchParams.get('pipeline'));
      const result = await client.listBuilds({
        page: Number.isFinite(page) ? page : 1,
        pageSize: Number.isFinite(pageSize) ? pageSize : 20,
        status,
      });
      sendJson(res, 200, { pipeline: client.key, ...result });
    } catch (e) {
      handleDevopsError(res, e);
    }
    return;
  }

  // 蓝盾某次构建的制品列表
  if (method === 'GET' && url.pathname === '/api/devops/artifacts') {
    const buildId = url.searchParams.get('buildId') ?? '';
    if (!buildId.trim()) {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: '缺少 buildId 查询参数' });
      return;
    }
    try {
      const client = devops.getClient(url.searchParams.get('pipeline'));
      const artifacts = await client.listArtifacts(buildId);
      sendJson(res, 200, { pipeline: client.key, buildId: buildId.trim(), artifacts });
    } catch (e) {
      handleDevopsError(res, e);
    }
    return;
  }

  // 配置本地工程：下载 il2cpp 产物 → 解压 → 覆盖工程 Data
  if (method === 'POST' && url.pathname === '/api/local-project') {
    // web 模式：会往服务器磁盘写并要求本地目标目录，远程无意义且危险，屏蔽
    if (webMode) {
      sendJson(res, 403, { error: 'WEB_MODE', message: 'web 模式不支持配置本地工程' });
      return;
    }
    const body = await readJson(req).catch((e) => ({ __error: e }));
    if ('__error' in (body as object)) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String((body as { __error: Error }).__error.message) });
      return;
    }
    const b = body as { pipeline?: unknown; buildId?: unknown; buildNum?: unknown; targetDir?: unknown };
    const buildId = typeof b.buildId === 'string' ? b.buildId.trim() : '';
    const targetDir = typeof b.targetDir === 'string' ? b.targetDir.trim() : '';
    if (!buildId) {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: '缺少 buildId 字符串字段' });
      return;
    }
    if (!targetDir) {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: '缺少 targetDir 字符串字段' });
      return;
    }
    let client;
    try {
      client = devops.getClient(typeof b.pipeline === 'string' ? b.pipeline : null);
    } catch (e) {
      handleDevopsError(res, e);
      return;
    }
    if (!client.localProjectRule) {
      sendJson(res, 400, {
        error: 'BAD_REQUEST',
        message: `流水线「${client.key}」未配置 localProject，不支持配置本地工程`,
      });
      return;
    }
    let dirStat;
    try {
      dirStat = await stat(targetDir);
    } catch {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: `目标目录不存在: ${targetDir}` });
      return;
    }
    if (!dirStat.isDirectory()) {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: `目标路径不是目录: ${targetDir}` });
      return;
    }
    const buildNum = typeof b.buildNum === 'number' ? b.buildNum : null;
    const jobId = startLocalProjectJob({ client, buildId, buildNum, targetDir }, { store: localProjects, log });
    sendJson(res, 202, { jobId });
    return;
  }

  const lpMatch = /^\/api\/local-project\/([0-9a-f]+)$/.exec(url.pathname);
  if (method === 'GET' && lpMatch) {
    const job = localProjects.get(lpMatch[1]!);
    if (!job) {
      sendJson(res, 404, { error: 'NOT_FOUND' });
      return;
    }
    sendJson(res, 200, job);
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
    const src = toInputSource((body as { source?: unknown }).source, (body as { path?: unknown }).path);
    if (src === 'EMPTY') {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: '缺少 path 字符串字段' });
      return;
    }
    if (src === 'INVALID') {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: '制品来源参数不完整（需要 buildId / artifactPath / name）' });
      return;
    }
    if (webMode && src.kind === 'path') {
      sendJson(res, 403, { error: 'DEVOPS_ONLY', message: '当前为蓝盾包模式，仅支持蓝盾制品来源，不接受本地路径' });
      return;
    }
    const platform = parsePlatformField((body as { platform?: unknown }).platform);
    if (platform === 'INVALID') {
      sendJson(res, 400, {
        error: 'BAD_PLATFORM',
        message: `platform 取值非法，允许：harmony | android | ios`,
      });
      return;
    }
    const extras = parseExtras((body as { extras?: unknown }).extras);
    const id = startAnalyzeJob(src, {
      store,
      toolVersion,
      log,
      extras,
      platform,
      prettyJson,
      devops,
      artifactCache,
      uploads,
    });
    sendJson(res, 202, { jobId: id });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/compare') {
    const body = await readJson(req).catch((e) => ({ __error: e }));
    if ('__error' in (body as object)) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String((body as { __error: Error }).__error.message) });
      return;
    }
    const b = body as { left?: unknown; right?: unknown; leftPath?: unknown; rightPath?: unknown };
    const left = toInputSource(b.left, b.leftPath);
    const right = toInputSource(b.right, b.rightPath);
    if (left === 'EMPTY' || right === 'EMPTY') {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: '需要 leftPath / rightPath 两个字符串字段（或 left / right 制品引用）' });
      return;
    }
    if (left === 'INVALID' || right === 'INVALID') {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: '制品来源参数不完整（需要 buildId / artifactPath / name）' });
      return;
    }
    if (webMode && (left.kind === 'path' || right.kind === 'path')) {
      sendJson(res, 403, { error: 'DEVOPS_ONLY', message: '当前为蓝盾包模式，仅支持蓝盾制品来源，不接受本地路径' });
      return;
    }
    const platform = parsePlatformField((body as { platform?: unknown }).platform);
    if (platform === 'INVALID') {
      sendJson(res, 400, {
        error: 'BAD_PLATFORM',
        message: `platform 取值非法，允许：harmony | android | ios`,
      });
      return;
    }
    const extras = parseExtras((body as { extras?: unknown }).extras);
    const id = startCompareJob(left, right, {
      store,
      toolVersion,
      log,
      extras,
      platform,
      prettyJson,
      devops,
      artifactCache,
      uploads,
    });
    sendJson(res, 202, { jobId: id });
    return;
  }

  // -------------------- AI 对话 API --------------------

  if (method === 'GET' && url.pathname === '/api/ai/health') {
    sendJson(res, 200, checkAiHealth());
    return;
  }

  if (method === 'GET' && url.pathname === '/api/ai/models') {
    try {
      const force = url.searchParams.get('refresh') === '1';
      const result = await conversations.getModels(force);
      sendJson(res, 200, result);
    } catch (err) {
      handleConversationError(res, err);
    }
    return;
  }

  if (method === 'POST' && url.pathname === '/api/ai/conversations') {
    const body = (await readJson(req).catch((e) => ({ __error: e }))) as
      | { jobId?: unknown; model?: unknown; __error?: Error };
    if (body.__error) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(body.__error.message) });
      return;
    }
    const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : '';
    if (!jobId) {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: '缺少 jobId 字符串字段' });
      return;
    }
    const model =
      typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
    try {
      const { id, session, job } = conversations.create(jobId, model ? { model } : {});
      sendJson(res, 201, {
        conversationId: id,
        sessionId: session.info.sessionId,
        jobId: job.id,
        cwd: session.info.jobDir,
        ...(session.info.model ? { model: session.info.model } : {}),
      });
    } catch (err) {
      handleConversationError(res, err);
    }
    return;
  }

  const convMessages = /^\/api\/ai\/conversations\/([a-z0-9_]+)\/messages$/i.exec(url.pathname);
  if (method === 'POST' && convMessages) {
    const cid = convMessages[1]!;
    const body = (await readJson(req, MESSAGE_BODY_MAX_BYTES).catch((e) => ({ __error: e }))) as
      | { text?: unknown; images?: unknown; __error?: Error };
    if (body.__error) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(body.__error.message) });
      return;
    }
    const text = typeof body.text === 'string' ? body.text : '';
    const imagesResult = parseInlineImages(body.images);
    if (imagesResult.error) {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: imagesResult.error });
      return;
    }
    const images = imagesResult.images;
    // 文本可空，前提是带了图片；纯空 + 无图直接拒掉
    if (!text.trim() && images.length === 0) {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: 'text 不能为空（或必须附带图片）' });
      return;
    }
    await streamConversationSse(req, res, conversations, cid, text, images, log);
    return;
  }

  const convInterrupt = /^\/api\/ai\/conversations\/([a-z0-9_]+)\/interrupt$/i.exec(url.pathname);
  if (method === 'POST' && convInterrupt) {
    const cid = convInterrupt[1]!;
    try {
      await conversations.interrupt(cid);
      sendJson(res, 200, { interrupted: cid });
    } catch (err) {
      handleConversationError(res, err);
    }
    return;
  }

  const convModel = /^\/api\/ai\/conversations\/([a-z0-9_]+)\/model$/i.exec(url.pathname);
  if (method === 'PATCH' && convModel) {
    const cid = convModel[1]!;
    const body = (await readJson(req).catch((e) => ({ __error: e }))) as
      | { model?: unknown; __error?: Error };
    if (body.__error) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(body.__error.message) });
      return;
    }
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: 'model 不能为空' });
      return;
    }
    try {
      await conversations.setModel(cid, model);
      sendJson(res, 200, { conversationId: cid, model });
    } catch (err) {
      handleConversationError(res, err);
    }
    return;
  }

  const convId = /^\/api\/ai\/conversations\/([a-z0-9_]+)$/i.exec(url.pathname);
  if (method === 'DELETE' && convId) {
    const ok = conversations.close(convId[1]!);
    if (!ok) sendJson(res, 404, { error: 'NOT_FOUND' });
    else sendJson(res, 200, { closed: convId[1] });
    return;
  }

  // -------------------- 企业微信机器人长连接（测试界面） --------------------

  if (method === 'GET' && url.pathname === '/api/wework/state') {
    const sinceRaw = url.searchParams.get('since');
    const since = sinceRaw ? Number.parseInt(sinceRaw, 10) : 0;
    sendJson(res, 200, wework.getState(Number.isFinite(since) && since > 0 ? since : 0));
    return;
  }

  if (method === 'POST' && url.pathname === '/api/wework/connect') {
    const result = wework.connect();
    if (!result.ok) {
      sendJson(res, 400, { error: 'WEWORK_CONNECT_FAILED', message: result.message ?? '连接失败' });
      return;
    }
    sendJson(res, 200, { ...wework.getState() });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/wework/disconnect') {
    wework.disconnect();
    sendJson(res, 200, { ...wework.getState() });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/wework/auto-reply') {
    const body = (await readJson(req).catch((e) => ({ __error: e }))) as
      | { enabled?: unknown; __error?: Error };
    if (body.__error) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(body.__error.message) });
      return;
    }
    wework.setAutoReply(Boolean(body.enabled));
    sendJson(res, 200, { ...wework.getState() });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/wework/reply-mode') {
    const body = (await readJson(req).catch((e) => ({ __error: e }))) as
      | { mode?: unknown; __error?: Error };
    if (body.__error) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(body.__error.message) });
      return;
    }
    const mode = body.mode;
    if (typeof mode !== 'string' || !(WEWORK_REPLY_MODES as readonly string[]).includes(mode)) {
      sendJson(res, 400, {
        error: 'BAD_REQUEST',
        message: `mode 取值非法，允许：${WEWORK_REPLY_MODES.join(' | ')}`,
      });
      return;
    }
    wework.setReplyMode(mode as WeworkReplyMode);
    sendJson(res, 200, { ...wework.getState() });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/wework/clear-log') {
    wework.clearLog();
    sendJson(res, 200, { ...wework.getState() });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/wework/upload-media') {
    const body = (await readJson(req, MESSAGE_BODY_MAX_BYTES).catch((e) => ({ __error: e }))) as
      | { type?: unknown; filename?: unknown; dataBase64?: unknown; __error?: Error };
    if (body.__error) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(body.__error.message) });
      return;
    }
    const type = body.type;
    if (type !== 'file' && type !== 'image' && type !== 'voice' && type !== 'video') {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: 'type 必须是 file | image | voice | video' });
      return;
    }
    const filename = typeof body.filename === 'string' ? body.filename : '';
    const dataBase64 = typeof body.dataBase64 === 'string' ? body.dataBase64 : '';
    if (!dataBase64) {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: 'dataBase64 不能为空' });
      return;
    }
    const result = await wework.uploadMedia(type, filename, dataBase64);
    if (!result.ok) {
      sendJson(res, 400, { error: 'WEWORK_UPLOAD_FAILED', message: result.message ?? '上传失败' });
      return;
    }
    sendJson(res, 200, { item: result.item, ...wework.getState() });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/wework/send') {
    const body = (await readJson(req).catch((e) => ({ __error: e }))) as {
      kind?: unknown;
      chatid?: unknown;
      content?: unknown;
      mediaType?: unknown;
      mediaId?: unknown;
      title?: unknown;
      description?: unknown;
      __error?: Error;
    };
    if (body.__error) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(body.__error.message) });
      return;
    }
    const chatid = typeof body.chatid === 'string' ? body.chatid : '';
    // 兼容旧前端：不带 kind 视为 markdown
    const kind = typeof body.kind === 'string' ? body.kind : 'markdown';
    let request: WeworkSendRequest;
    if (kind === 'markdown') {
      request = { kind: 'markdown', chatid, content: typeof body.content === 'string' ? body.content : '' };
    } else if (kind === 'card') {
      request = { kind: 'card', chatid };
    } else if (kind === 'media') {
      const mediaType = body.mediaType;
      if (mediaType !== 'file' && mediaType !== 'image' && mediaType !== 'voice' && mediaType !== 'video') {
        sendJson(res, 400, { error: 'BAD_REQUEST', message: 'mediaType 必须是 file | image | voice | video' });
        return;
      }
      request = {
        kind: 'media',
        chatid,
        mediaType,
        mediaId: typeof body.mediaId === 'string' ? body.mediaId : '',
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
      };
    } else {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: 'kind 必须是 markdown | card | media' });
      return;
    }
    const result = await wework.send(request);
    if (!result.ok) {
      sendJson(res, 400, { error: 'WEWORK_SEND_FAILED', message: result.message ?? '发送失败' });
      return;
    }
    sendJson(res, 200, { ...wework.getState() });
    return;
  }

  // -------------------- 静态产物 --------------------

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
/* AI 路由辅助                                                                 */
/* -------------------------------------------------------------------------- */

function handleConversationError(res: ServerResponse, err: unknown): void {
  if (err instanceof ConversationError) {
    sendJson(res, err.statusCode, { error: err.code, message: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, { error: 'INTERNAL', message });
}

function handleDevopsError(res: ServerResponse, err: unknown): void {
  if (err instanceof DevopsError) {
    sendJson(res, err.statusCode, { error: 'DEVOPS_FAILED', message: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, { error: 'INTERNAL', message });
}

/**
 * SSE 处理：把 ConversationManager.acquire(cid) → sendAndStream(text, images?) 的事件流
 * 转写到 HTTP 响应。客户端断开时尽力中断 SDK 会话以省 token。
 */
async function streamConversationSse(
  req: IncomingMessage,
  res: ServerResponse,
  conversations: ConversationManager,
  cid: string,
  text: string,
  images: InlineImage[],
  log: (t: string) => void,
): Promise<void> {
  let entry;
  try {
    entry = conversations.acquire(cid);
  } catch (err) {
    handleConversationError(res, err);
    return;
  }

  const writer = new SseWriter(res);
  const onClose = (): void => {
    if (!writer.isClosed) {
      writer.markClosed();
      // 客户端断开 → 尽力中断 SDK 推理
      entry.session.interrupt().catch(() => {});
    }
  };
  req.on('close', onClose);

  try {
    const imgArg = images.length > 0 ? images : undefined;
    for await (const ev of entry.session.sendAndStream(text, imgArg)) {
      if (writer.isClosed) break;
      writer.write(ev);
    }
  } catch (err) {
    log(`[ai] sse error ${cid}: ${err instanceof Error ? err.stack ?? err.message : err}\n`);
    if (!writer.isClosed) {
      writer.write({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    req.off('close', onClose);
    conversations.release(cid);
    writer.end();
  }
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
  // 通过 workbench 访问 HTML 产物时（无论 analyze 的 report.html 还是 compare 的 diff.html），
  // 都塞 AI 启用标记，让 viewer 知道当前是"workbench 模式 + 当前 jobId"，"AI 分析"按钮才可用。
  if (kind === 'html') {
    await serveHtmlWithAi(res, filePath, fileName, id);
    return;
  }
  await streamFileOr404(res, filePath, fileName, kind);
}

/**
 * 给 workbench 模式下的 viewer HTML（report.html / diff.html）注入 `window.__KINGSDK_AI__`：
 * viewer 启动时据此显示并启用 "AI 分析" 按钮，否则按钮置灰提示"workbench 才能用"。
 *
 * 注入点：放在原 `<script id="__DATA__">...</script>` 之前，保证 viewer bootstrap 时已可读。
 * 失败时降级回普通 stream（不阻断报告渲染）。
 */
async function serveHtmlWithAi(
  res: ServerResponse,
  filePath: string,
  fileName: string,
  jobId: string,
): Promise<void> {
  if (!existsSync(filePath)) {
    sendJson(res, 404, { error: 'PRODUCT_MISSING', file: fileName });
    return;
  }
  try {
    const html = readFileSync(filePath, 'utf8');
    const injection =
      '<script>window.__KINGSDK_AI__=' +
      JSON.stringify({ jobId, apiBase: '/api/ai' }) +
      ';</script>';
    const marker = '<script id="__DATA__"';
    const idx = html.indexOf(marker);
    const patched =
      idx >= 0
        ? html.slice(0, idx) + injection + '\n    ' + html.slice(idx)
        : html.replace('</head>', `  ${injection}\n  </head>`);
    const body = Buffer.from(patched, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    // 注入异常 → 退回到普通流式
    await streamFileOr404(res, filePath, fileName, 'html');
  }
}

/**
 * compare job 的"单侧 PackageReport"产物。
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

const PLATFORM_WHITELIST: ReadonlySet<string> = new Set<Platform>(['harmony', 'android', 'ios']);

/**
 * 解析查询参数 `?platform=`：
 *  - null / 空串 → 兜底 DEFAULT_PLATFORM（也就是 'harmony'），便于老客户端不传时正常工作
 *  - 合法 Platform → 直接返回
 *  - 其它 → 返回字面量 'INVALID'，由 caller 产出 400
 */
function parsePlatformQuery(raw: string | null): Platform | 'INVALID' {
  if (raw === null || raw === '') return DEFAULT_PLATFORM;
  return PLATFORM_WHITELIST.has(raw) ? (raw as Platform) : 'INVALID';
}

/**
 * 解析 body.platform 字段（同 query 但出现位置不同）：
 *  - undefined / null → 兜底 DEFAULT_PLATFORM
 *  - 合法字符串 → 返回
 *  - 其它 → 'INVALID'
 */
function parsePlatformField(raw: unknown): Platform | 'INVALID' {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PLATFORM;
  if (typeof raw !== 'string') return 'INVALID';
  return PLATFORM_WHITELIST.has(raw) ? (raw as Platform) : 'INVALID';
}

/**
 * 解析 body.extras，宽松模式：
 *  - undefined / null / 空数组 / 非数组 → undefined（runner 走默认）
 *  - 数组 → 过滤为 string[]，去重
 * 后端不在这里做 id 白名单校验：未知 id 进 pipeline 会被 pickEnabledAnalyzers 静默忽略，
 * 不影响其它默认 analyzer 运行。
 */
/**
 * 把 analyze/compare 的一个输入解析成 InputSource：
 *  - sourceRaw 是对象且 type==='devops' → 蓝盾制品引用（校验 buildId/artifactPath/name）
 *  - sourceRaw 是对象且 type==='path' → 本地路径
 *  - 否则回退看 legacyPath（旧 body 的 path / leftPath / rightPath 字符串）
 *
 * 返回 'EMPTY'（两者都没有）/ 'INVALID'（来源对象字段不全）由路由分别映射 400。
 */
function toInputSource(sourceRaw: unknown, legacyPath: unknown): InputSource | 'EMPTY' | 'INVALID' {
  if (sourceRaw && typeof sourceRaw === 'object') {
    const s = sourceRaw as Record<string, unknown>;
    const type = s.type ?? s.kind;
    if (type === 'devops') {
      const buildId = typeof s.buildId === 'string' ? s.buildId.trim() : '';
      const artifactPath = typeof s.artifactPath === 'string' ? s.artifactPath.trim() : '';
      const name = typeof s.name === 'string' ? s.name.trim() : '';
      if (!buildId || !artifactPath || !name) return 'INVALID';
      return {
        kind: 'devops',
        pipeline: typeof s.pipeline === 'string' && s.pipeline.trim() ? s.pipeline.trim() : undefined,
        buildId,
        buildNum: typeof s.buildNum === 'number' ? s.buildNum : null,
        artifactPath,
        name,
        artifactoryType: typeof s.artifactoryType === 'string' ? s.artifactoryType : undefined,
        size: typeof s.size === 'number' ? s.size : null,
      };
    }
    if (type === 'path') {
      const p = typeof s.path === 'string' ? s.path.trim() : '';
      if (!p) return 'INVALID';
      return { kind: 'path', path: p };
    }
    if (type === 'upload') {
      const uploadId = typeof s.uploadId === 'string' ? s.uploadId.trim() : '';
      const name = typeof s.name === 'string' ? s.name.trim() : '';
      if (!uploadId || !name) return 'INVALID';
      return { kind: 'upload', uploadId, name };
    }
    return 'INVALID';
  }
  if (typeof legacyPath === 'string' && legacyPath.trim()) {
    return { kind: 'path', path: legacyPath.trim() };
  }
  return 'EMPTY';
}

/**
 * 解析运行形态，优先级：
 *   1. options.mode 显式指定
 *   2. options.devopsOnly === true → 'web'（兼容旧调用方）
 *   3. 环境变量 SDKTOOL_DEVOPS_ONLY 为真 → 'web'（兼容旧部署脚本）
 *   4. 兜底 'desktop'
 */
function resolveMode(options: WorkbenchServerOptions): WorkbenchMode {
  if (options.mode) return options.mode;
  if (options.devopsOnly) return 'web';
  return readDevopsOnlyEnv() ? 'web' : 'desktop';
}

/**
 * 读 SDKTOOL_DEVOPS_ONLY 环境变量并解析成布尔。
 * 视 `1 / true / yes / on`（忽略大小写、去空白）为开启；其余（含未设置）为关闭。
 */
function readDevopsOnlyEnv(): boolean {
  const v = (process.env.SDKTOOL_DEVOPS_ONLY ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

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

const DEFAULT_BODY_MAX_BYTES = 256 * 1024;
/** AI 消息接口要带 base64 图片，放宽到 20 MiB 上限（足够 ~15MiB 原图） */
const MESSAGE_BODY_MAX_BYTES = 20 * 1024 * 1024;
/** 单张图片 base64 后最大 8 MiB；约 6 MiB 原图 */
const MAX_IMAGE_BASE64_BYTES = 8 * 1024 * 1024;
/** 每条消息最多 6 张图 */
const MAX_IMAGES_PER_MESSAGE = 6;
const ALLOWED_IMAGE_MEDIA_TYPES: ReadonlySet<InlineImageMediaType> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/**
 * 校验客户端传来的 images 字段，逐张过滤；返回 [{ images, error? }]。
 * 不抛异常，把错误归类放进 error 字段，方便调用方一次性 4xx。
 */
function parseInlineImages(raw: unknown): { images: InlineImage[]; error?: string } {
  if (raw == null) return { images: [] };
  if (!Array.isArray(raw)) return { images: [], error: 'images 必须是数组' };
  if (raw.length > MAX_IMAGES_PER_MESSAGE) {
    return { images: [], error: `单条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图片` };
  }
  const out: InlineImage[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') {
      return { images: [], error: `images[${i}] 不是对象` };
    }
    const obj = item as { mediaType?: unknown; dataBase64?: unknown; name?: unknown };
    if (typeof obj.mediaType !== 'string' || !ALLOWED_IMAGE_MEDIA_TYPES.has(obj.mediaType as InlineImageMediaType)) {
      return {
        images: [],
        error: `images[${i}].mediaType 必须是 ${[...ALLOWED_IMAGE_MEDIA_TYPES].join(' / ')}`,
      };
    }
    if (typeof obj.dataBase64 !== 'string' || obj.dataBase64.length === 0) {
      return { images: [], error: `images[${i}].dataBase64 必须是非空字符串` };
    }
    if (obj.dataBase64.length > MAX_IMAGE_BASE64_BYTES) {
      const mb = (MAX_IMAGE_BASE64_BYTES / (1024 * 1024)).toFixed(0);
      return { images: [], error: `images[${i}] 超过 ${mb} MiB（base64 字符数）上限` };
    }
    const inline: InlineImage = {
      mediaType: obj.mediaType as InlineImageMediaType,
      dataBase64: obj.dataBase64,
    };
    if (typeof obj.name === 'string' && obj.name) inline.name = obj.name;
    out.push(inline);
  }
  return { images: out };
}

/** 安全读 JSON body，默认 256 KiB；可按路由 override */
async function readJson(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_BODY_MAX_BYTES,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        const mb = (maxBytes / (1024 * 1024)).toFixed(1);
        reject(new Error(`请求体超过 ${mb} MiB 上限`));
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

/**
 * 用系统文件管理器打开指定目录。
 * Windows → explorer.exe，macOS → open，Linux → xdg-open。
 * 仅本地工具使用，fire-and-forget，不等待结果。
 */
function openInExplorer(dir: string, log: (t: string) => void): void {
  const os = platform();
  let cmd: string;
  let args: string[];
  if (os === 'win32') {
    cmd = 'explorer.exe';
    args = [dir];
  } else if (os === 'darwin') {
    cmd = 'open';
    args = [dir];
  } else {
    cmd = 'xdg-open';
    args = [dir];
  }
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
  child.on('error', (e) => log(`[workbench] open-cache-dir failed: ${e.message}\n`));
}
