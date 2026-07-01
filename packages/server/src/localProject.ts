/**
 * "配置本地工程"编排：从蓝盾构建拉取 il2cpp 产物，下载 → 解压 → 用 hap 内资源覆盖工程。
 *
 * 完整流程（对应前端进度面板的 5 个步骤）：
 *  1. locate   列出该构建制品，精确定位 `*il2cpp.shell.hap` 与 `*il2cpp.zips`
 *  2. zips     下载 `.zips`（约 1.2 GB）到目标目录
 *  3. hap      下载 `.shell.hap`（约 3.3 GB）到目标目录
 *  4. unzip    把 `.zips` 解压到目标目录
 *  5. overlay  把 hap 内 `resources/rawfile/Data/` 覆盖到解压后工程的
 *              `Project/TargetOpenHarmony/DevEcoProj/entry/src/main/resources/rawfile/Data/`
 *
 * 这些是 GB 级长任务，所以走"内存进度 store + 前端轮询"模式（不进 JobStore 历史，
 * 避免污染分析/对比历史列表）。进度信息在 server 进程内存里，重启即丢——本地工具足够。
 */

import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import yauzl, { type Entry, type ZipFile } from 'yauzl';

import { DevopsError, type DevopsArtifact, type DevopsClient } from './devops.js';

/* -------------------------------------------------------------------------- */
/* 类型                                                                        */
/* -------------------------------------------------------------------------- */

export type LocalProjectStatus = 'pending' | 'running' | 'done' | 'error';
export type StepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

export interface ProgressStep {
  key: 'locate' | 'zips' | 'hap' | 'unzip' | 'overlay';
  label: string;
  status: StepStatus;
  /** 0~100；不适用时为 null */
  percent: number | null;
  /** 附加说明（如已下载/总大小、文件数） */
  detail?: string;
}

export interface LocalProjectJob {
  id: string;
  status: LocalProjectStatus;
  /** 所属流水线 key（多流水线区分用） */
  pipelineKey: string;
  buildId: string;
  buildNum: number | null;
  targetDir: string;
  steps: ProgressStep[];
  createdAt: string;
  finishedAt?: string;
  error?: string;
  result?: {
    hapPath: string;
    zipsPath: string;
    overlayDir: string;
    copiedFiles: number;
  };
}

/* -------------------------------------------------------------------------- */
/* 进度 store（内存）                                                          */
/* -------------------------------------------------------------------------- */

const STEP_DEFS: ReadonlyArray<{ key: ProgressStep['key']; label: string }> = [
  { key: 'locate', label: '定位制品' },
  { key: 'zips', label: '下载资源包 (.zips)' },
  { key: 'hap', label: '下载安装包 (.shell.hap)' },
  { key: 'unzip', label: '解压资源包' },
  { key: 'overlay', label: '覆盖工程 Data 目录' },
];

export class LocalProjectStore {
  private readonly jobs = new Map<string, LocalProjectJob>();

  create(
    pipelineKey: string,
    buildId: string,
    buildNum: number | null,
    targetDir: string,
  ): LocalProjectJob {
    const id = randomBytes(8).toString('hex');
    const job: LocalProjectJob = {
      id,
      status: 'pending',
      pipelineKey,
      buildId,
      buildNum,
      targetDir,
      steps: STEP_DEFS.map((s) => ({ key: s.key, label: s.label, status: 'pending', percent: null })),
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(id, job);
    return job;
  }

  get(id: string): LocalProjectJob | undefined {
    return this.jobs.get(id);
  }

  patch(id: string, patch: Partial<LocalProjectJob>): void {
    const cur = this.jobs.get(id);
    if (!cur) return;
    this.jobs.set(id, { ...cur, ...patch });
  }

  patchStep(id: string, key: ProgressStep['key'], patch: Partial<ProgressStep>): void {
    const cur = this.jobs.get(id);
    if (!cur) return;
    const steps = cur.steps.map((s) => (s.key === key ? { ...s, ...patch } : s));
    this.jobs.set(id, { ...cur, steps });
  }
}

/* -------------------------------------------------------------------------- */
/* 启动入口                                                                    */
/* -------------------------------------------------------------------------- */

export interface LocalProjectDeps {
  store: LocalProjectStore;
  log: (text: string) => void;
}

export interface StartLocalProjectOptions {
  /** 该任务所属流水线的 client（决定产物匹配规则与下载凭据） */
  client: DevopsClient;
  buildId: string;
  buildNum?: number | null;
  targetDir: string;
}

/**
 * 启动一个"配置本地工程"任务，立即返回 jobId；实际下载/解压在后台进行。
 * targetDir 的存在性/合法性由调用方（server 路由）先校验。
 */
export function startLocalProjectJob(opts: StartLocalProjectOptions, deps: LocalProjectDeps): string {
  const job = deps.store.create(
    opts.client.key,
    opts.buildId.trim(),
    opts.buildNum ?? null,
    resolvePath(opts.targetDir),
  );
  void runLocalProjectAsync(job.id, opts.client, deps);
  return job.id;
}

async function runLocalProjectAsync(
  id: string,
  client: DevopsClient,
  deps: LocalProjectDeps,
): Promise<void> {
  const { store, log } = deps;
  const job = store.get(id);
  if (!job) return;
  const rule = client.localProjectRule;
  if (!rule) {
    store.patch(id, {
      status: 'error',
      error: `流水线「${client.key}」未配置 localProject，无法配置本地工程`,
      finishedAt: new Date().toISOString(),
    });
    return;
  }
  store.patch(id, { status: 'running' });
  log(`[local-project] start ${id} pipeline=${client.key} build=${job.buildId} dir=${job.targetDir}\n`);

  try {
    // ---- 1. 定位制品 ----
    store.patchStep(id, 'locate', { status: 'running' });
    const artifacts = await client.listArtifacts(job.buildId);
    const { hap, zips } = client.selectLocalProjectArtifacts(artifacts);
    if (!hap || !zips) {
      const missing = [!hap ? `*${rule.hapSuffix}` : null, !zips ? `*${rule.zipsSuffix}` : null]
        .filter(Boolean)
        .join(' / ');
      throw new DevopsError(`该构建未找到所需产物：${missing}`, 404);
    }
    store.patchStep(id, 'locate', {
      status: 'done',
      detail: `${hap.name} + ${zips.name}`,
    });

    const zipsDest = join(job.targetDir, zips.name);
    const hapDest = join(job.targetDir, hap.name);

    // ---- 2. 下载 .zips ----
    await downloadArtifactStep(id, client, deps, 'zips', zips, zipsDest);

    // ---- 3. 下载 .shell.hap ----
    await downloadArtifactStep(id, client, deps, 'hap', hap, hapDest);

    // ---- 4. 解压 .zips ----
    store.patchStep(id, 'unzip', { status: 'running', percent: 0 });
    let lastUnzipTick = 0;
    const extractedRoots = new Set<string>();
    const unzipCount = await extractZipToDir(zipsDest, job.targetDir, (done, total, topDir) => {
      if (topDir) extractedRoots.add(topDir);
      const now = Date.now();
      if (now - lastUnzipTick > 400 || done === total) {
        lastUnzipTick = now;
        store.patchStep(id, 'unzip', {
          percent: total > 0 ? Math.floor((done / total) * 100) : null,
          detail: `${done} / ${total} 项`,
        });
      }
    });
    store.patchStep(id, 'unzip', { status: 'done', percent: 100, detail: `${unzipCount} 项` });

    // ---- 5. 覆盖工程 Data 目录 ----
    store.patchStep(id, 'overlay', { status: 'running', percent: 0 });
    const overlayDir = await resolveProjectDataDir(job.targetDir, extractedRoots, rule.projectDataRel);
    if (!overlayDir) {
      throw new Error(
        `解压后未找到工程目录 ${rule.projectDataRel}（请确认 .zips 内含该路径）`,
      );
    }
    // 覆盖语义：先清空工程内 Data 目录，再用 hap 内 Data 全量写入，保证与 hap 完全一致
    await rm(overlayDir, { recursive: true, force: true });
    await mkdir(overlayDir, { recursive: true });
    let lastOverlayTick = 0;
    const copied = await overlayHapData(hapDest, overlayDir, rule.hapDataPrefix, (done, total) => {
      const now = Date.now();
      if (now - lastOverlayTick > 400 || done === total) {
        lastOverlayTick = now;
        store.patchStep(id, 'overlay', {
          percent: total > 0 ? Math.floor((done / total) * 100) : null,
          detail: `${done} / ${total} 文件`,
        });
      }
    });
    store.patchStep(id, 'overlay', { status: 'done', percent: 100, detail: `${copied} 文件` });

    store.patch(id, {
      status: 'done',
      finishedAt: new Date().toISOString(),
      result: { hapPath: hapDest, zipsPath: zipsDest, overlayDir, copiedFiles: copied },
    });
    log(`[local-project] done ${id} overlay=${overlayDir} copied=${copied}\n`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // 把当前 running 的步骤标 error
    const cur = store.get(id);
    if (cur) {
      const running = cur.steps.find((s) => s.status === 'running');
      if (running) store.patchStep(id, running.key, { status: 'error', detail: message });
    }
    store.patch(id, { status: 'error', error: message, finishedAt: new Date().toISOString() });
    log(`[local-project] error ${id} - ${message}\n`);
  }
}

/* -------------------------------------------------------------------------- */
/* 下载                                                                        */
/* -------------------------------------------------------------------------- */

async function downloadArtifactStep(
  id: string,
  client: DevopsClient,
  deps: LocalProjectDeps,
  key: 'zips' | 'hap',
  artifact: DevopsArtifact,
  dest: string,
): Promise<void> {
  const { store } = deps;
  store.patchStep(id, key, { status: 'running', percent: 0, detail: '准备下载…' });
  const { url, headers } = client.getArtifactDownload(artifact);
  await mkdir(dirname(dest), { recursive: true });

  let lastTick = 0;
  await downloadToFile(url, dest, headers, (received, total) => {
    const now = Date.now();
    if (now - lastTick > 400 || (total > 0 && received >= total)) {
      lastTick = now;
      store.patchStep(id, key, {
        percent: total > 0 ? Math.floor((received / total) * 100) : null,
        detail: total > 0 ? `${fmtBytes(received)} / ${fmtBytes(total)}` : fmtBytes(received),
      });
    }
  });
  store.patchStep(id, key, { status: 'done', percent: 100 });
}

async function downloadToFile(
  url: string,
  dest: string,
  headers: Record<string, string>,
  onProgress: (received: number, total: number) => void,
): Promise<void> {
  const resp = await fetch(url, { headers });
  if (!resp.ok || !resp.body) {
    throw new Error(`下载失败 HTTP ${resp.status}（${url.slice(0, 120)}）`);
  }
  // 鉴权失败时 BkRepo 不会报错，而是 302 到 passport 返回登录页 HTML（约 2KiB）。
  // 这里据 content-type 提前识别，避免把登录页当文件写盘后在解压阶段才暴雷。
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('text/html')) {
    throw new Error('下载鉴权失败：服务器返回登录页而非文件，请检查 BKREPO_TOKEN 是否过期（蓝盾→服务→制品库→个人中心→申请 Token）');
  }
  const total = Number(resp.headers.get('content-length')) || 0;
  let received = 0;
  const nodeStream = Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0]);
  nodeStream.on('data', (chunk: Buffer) => {
    received += chunk.length;
    onProgress(received, total);
  });
  await pipeline(nodeStream, createWriteStream(dest));
}

/* -------------------------------------------------------------------------- */
/* 解压 .zips 到磁盘                                                           */
/* -------------------------------------------------------------------------- */

/**
 * 把 zip 全量解压到 destRoot，保留内部目录结构。返回写出的条目数。
 * onProgress(done, total, topDir?) 中 topDir 为该条目的顶层目录名（用于后续定位工程根）。
 * 做了 zip-slip 防护：解析后路径必须仍在 destRoot 内。
 */
async function extractZipToDir(
  zipPath: string,
  destRoot: string,
  onProgress: (done: number, total: number, topDir?: string) => void,
): Promise<number> {
  const zip = await openZip(zipPath);
  const root = resolvePath(destRoot);
  try {
    const total = zip.entryCount;
    let done = 0;
    await new Promise<void>((resolveP, rejectP) => {
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          try {
            const rel = normalizePath(entry.fileName);
            const topDir = rel.split('/')[0] || '';
            const outPath = resolvePath(root, rel);
            if (outPath !== root && !outPath.startsWith(root + pathSep())) {
              throw new Error(`非法 zip 条目路径（越界）：${entry.fileName}`);
            }
            if (isDirectoryEntry(entry)) {
              await mkdir(outPath, { recursive: true });
            } else {
              await mkdir(dirname(outPath), { recursive: true });
              await writeEntryToFile(zip, entry, outPath);
            }
            done++;
            onProgress(done, total, topDir);
            zip.readEntry();
          } catch (err) {
            rejectP(err as Error);
          }
        })();
      });
      zip.on('end', () => resolveP());
      zip.on('error', rejectP);
      zip.readEntry();
    });
    return done;
  } finally {
    try {
      zip.close();
    } catch {
      /* ignore */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 用 hap 内 Data 覆盖工程                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 在 destRoot 下定位工程的 Data 目录（被覆盖目标）。projectDataRel 由流水线配置提供。
 * 先直接试 destRoot/projectDataRel；找不到再在解压出的顶层目录里逐个试
 * destRoot/<top>/projectDataRel，以兼容 .zips 把工程包在一层外壳目录里的情况。
 */
async function resolveProjectDataDir(
  destRoot: string,
  topDirs: Set<string>,
  projectDataRel: string,
): Promise<string | null> {
  const direct = join(destRoot, projectDataRel);
  if (await dirOrParentExists(direct)) return direct;
  for (const top of topDirs) {
    if (!top) continue;
    const candidate = join(destRoot, top, projectDataRel);
    if (await dirOrParentExists(candidate)) return candidate;
  }
  return null;
}

/**
 * 判断目标 Data 目录是否“可用”：目录本身存在，或其父目录（…/resources/rawfile）存在
 * （父在则说明工程结构匹配，Data 可能尚未建出来，我们随后会创建并写入）。
 */
async function dirOrParentExists(dir: string): Promise<boolean> {
  if (await isDir(dir)) return true;
  return isDir(dirname(dir));
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 从 hap（zip）中提取 hapDataPrefix 下的所有文件，写到 overlayDir，
 * 保留前缀之后的子路径。返回写出的文件数。hapDataPrefix 由流水线配置提供。
 */
async function overlayHapData(
  hapPath: string,
  overlayDir: string,
  hapDataPrefix: string,
  onProgress: (done: number, total: number) => void,
): Promise<number> {
  const zip = await openZip(hapPath);
  const root = resolvePath(overlayDir);
  try {
    // 先数一遍 Data 下的文件条目，便于报百分比
    const dataEntries: Entry[] = [];
    await new Promise<void>((resolveP, rejectP) => {
      zip.on('entry', (entry: Entry) => {
        const rel = normalizePath(entry.fileName);
        if (!isDirectoryEntry(entry) && startsWithCi(rel, hapDataPrefix)) {
          dataEntries.push(entry);
        }
        zip.readEntry();
      });
      zip.on('end', () => resolveP());
      zip.on('error', rejectP);
      zip.readEntry();
    });

    if (dataEntries.length === 0) {
      throw new Error(`hap 内未找到 ${hapDataPrefix} 目录，无法覆盖`);
    }

    const total = dataEntries.length;
    let done = 0;
    for (const entry of dataEntries) {
      const rel = normalizePath(entry.fileName);
      const sub = rel.slice(hapDataPrefix.length); // 前缀之后的子路径
      const outPath = resolvePath(root, sub);
      if (outPath !== root && !outPath.startsWith(root + pathSep())) {
        throw new Error(`非法 hap 条目路径（越界）：${entry.fileName}`);
      }
      await mkdir(dirname(outPath), { recursive: true });
      await writeEntryToFile(zip, entry, outPath);
      done++;
      onProgress(done, total);
    }
    return done;
  } finally {
    try {
      zip.close();
    } catch {
      /* ignore */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* zip / 文件 工具                                                             */
/* -------------------------------------------------------------------------- */

function openZip(filePath: string): Promise<ZipFile> {
  return new Promise((resolveP, rejectP) => {
    if (!existsSync(filePath)) {
      rejectP(new Error(`文件不存在: ${filePath}`));
      return;
    }
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (err, zipFile) => {
      if (err || !zipFile) {
        rejectP(err ?? new Error('打开 zip 失败'));
        return;
      }
      resolveP(zipFile);
    });
  });
}

function writeEntryToFile(zip: ZipFile, entry: Entry, outPath: string): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        rejectP(err ?? new Error('打开 zip entry 读流失败'));
        return;
      }
      pipeline(stream, createWriteStream(outPath)).then(resolveP, rejectP);
    });
  });
}

function isDirectoryEntry(entry: Entry): boolean {
  return /\/$/.test(entry.fileName);
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

function startsWithCi(s: string, prefix: string): boolean {
  return s.toLowerCase().startsWith(prefix.toLowerCase());
}

function pathSep(): string {
  return process.platform === 'win32' ? '\\' : '/';
}

function fmtBytes(b: number): string {
  if (!Number.isFinite(b) || b < 0) return '0 B';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return (i === 0 ? v.toFixed(0) : v.toFixed(2)) + ' ' + u[i];
}
