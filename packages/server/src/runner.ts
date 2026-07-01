import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

import { analyzePackage } from '@kingsdk/core/index.js';
import { diffPackageReports } from '@kingsdk/core/differ/index.js';
import {
  DEFAULT_PLATFORM,
  SCHEMA_VERSION,
  type PackageReport,
  type Platform,
} from '@kingsdk/shared/schema.js';
import { renderDiffHtml, renderReportHtml } from '@kingsdk/viewer/render.js';

import type { ArtifactCache } from './artifactCache.js';
import type { DevopsRegistry } from './devops.js';
import type { JobStore } from './store.js';
import type { UploadStore } from './uploadStore.js';

/**
 * analyze/compare 的一个输入来源：本地路径 / 上传件 / 一条蓝盾制品引用
 * （devops 引用阶段不下载，运行时由 runner 经 ArtifactCache 解析成本地路径；
 * upload 已由 UploadStore 落盘，运行时解析成临时路径并在分析后删除）。
 */
export type InputSource =
  | { kind: 'path'; path: string }
  | {
      kind: 'upload';
      /** UploadStore 返回的上传标识 */
      uploadId: string;
      /** 原始文件名（展示 / 历史用） */
      name: string;
    }
  | {
      kind: 'devops';
      /** 流水线 key；缺省用默认流水线 */
      pipeline?: string;
      buildId: string;
      buildNum?: number | null;
      /** 制品在蓝盾里的路径 */
      artifactPath: string;
      /** 原始文件名 */
      name: string;
      artifactoryType?: string;
      size?: number | null;
    };

export interface RunnerDeps {
  store: JobStore;
  toolVersion: string;
  /** 写到 server 控制台的日志；测试可注入 noop */
  log: (text: string) => void;
  /** 可选深度分析 analyzer id 列表（参见 EXTRA_ANALYZERS） */
  extras?: string[];
  /** 应用包平台；未指定时按 'harmony' 处理 */
  platform?: Platform;
  /** 解析蓝盾制品引用时用；仅当输入含 devops source 时必需 */
  devops?: DevopsRegistry;
  /** 蓝盾制品本地下载缓存；仅当输入含 devops source 时必需 */
  artifactCache?: ArtifactCache;
  /** 上传件存储；仅当输入含 upload source 时必需 */
  uploads?: UploadStore;
  /**
   * 磁盘 JSON 产物是否使用缩进（2 空格）。默认 true。
   *
   * Why default true：workbench 的 `*.json`（diff.json / report.json /
   * left.report.json / right.report.json）主要消费者是 AI session 与开发者本地浏览。
   * 紧凑单行 JSON 让 Read --offset --limit 和 Grep -A/-B/-C 失去意义；
   * 文件膨胀 2-3× 是值得付的代价。
   *
   * viewer html 内嵌的 JSON 走独立的 `serializeForHtml` 路径（紧凑），
   * 不受本开关影响；server 的 /jobs/:id/json 走文件流，则跟着磁盘一致。
   */
  prettyJson?: boolean;
}

/**
 * 启动一个 analyze 作业（异步执行，函数立即返回 jobId）。
 *
 * 逻辑：
 *  1. 立即创建 pending job
 *  2. path source 做同步快校验（不存在/非文件 → 直接置 error）；devops source 留到异步
 *  3. 后台先把 source 解析成本地路径（devops 需下载/命中缓存），再 analyzePackage
 *  4. 把产物 URL 回写 job.outputs
 */
export function startAnalyzeJob(source: InputSource, deps: RunnerDeps): string {
  const platform = deps.platform ?? DEFAULT_PLATFORM;
  const job = deps.store.create('analyze', [sourceInputLabel(source)], sourceTitle(source), platform);

  // path source：同步快校验，错误直接落 error，避免后台无人处理的 race
  if (source.kind === 'path') {
    if (!existsSync(source.path)) {
      deps.store.update(job.id, {
        status: 'error',
        error: `文件不存在: ${source.path}`,
        finishedAt: new Date().toISOString(),
      });
      return job.id;
    }
    if (!statSync(source.path).isFile()) {
      deps.store.update(job.id, {
        status: 'error',
        error: `不是文件: ${source.path}`,
        finishedAt: new Date().toISOString(),
      });
      return job.id;
    }
  }

  void runAnalyzeAsync(job.id, source, deps);
  return job.id;
}

async function runAnalyzeAsync(id: string, source: InputSource, deps: RunnerDeps): Promise<void> {
  const platform = deps.platform ?? DEFAULT_PLATFORM;
  deps.store.update(id, { status: 'running' });
  deps.log(`[workbench] analyze start ${id} [${platform}] ${sourceInputLabel(source)}${deps.extras?.length ? ` (extras=${deps.extras.join(',')})` : ''}\n`);
  let acquired: { path: string; release: () => void } | null = null;
  try {
    const dir = deps.store.jobDir(id);
    await mkdir(dir, { recursive: true });
    acquired = await resolveSource(source, deps, (note) => deps.store.update(id, { note }));
    deps.store.update(id, { note: '分析中…' });
    const report = await analyzePackage(acquired.path, {
      toolVersion: deps.toolVersion,
      extras: deps.extras,
      platform,
    });
    const jsonPath = join(dir, 'report.json');
    const htmlPath = join(dir, 'report.html');
    await writeFile(jsonPath, stringifyJson(report, deps.prettyJson), 'utf8');
    await writeFile(htmlPath, renderReportHtml(report), 'utf8');
    deps.store.update(id, {
      status: 'done',
      note: undefined,
      finishedAt: new Date().toISOString(),
      outputs: {
        htmlUrl: `/jobs/${id}/html`,
        jsonUrl: `/jobs/${id}/json`,
      },
    });
    deps.log(`[workbench] analyze done  ${id}\n`);
  } catch (e) {
    deps.store.update(id, {
      status: 'error',
      note: undefined,
      error: (e as Error).message ?? String(e),
      finishedAt: new Date().toISOString(),
    });
    deps.log(`[workbench] analyze error ${id} - ${(e as Error).message}\n`);
  } finally {
    acquired?.release();
  }
}

/* -------------------------------------------------------------------------- */
/* compare                                                                     */
/* -------------------------------------------------------------------------- */

export function startCompareJob(
  leftSource: InputSource,
  rightSource: InputSource,
  deps: RunnerDeps,
): string {
  const label = `${sourceTitle(leftSource)} vs ${sourceTitle(rightSource)}`;
  const platform = deps.platform ?? DEFAULT_PLATFORM;
  const job = deps.store.create(
    'compare',
    [sourceInputLabel(leftSource), sourceInputLabel(rightSource)],
    label,
    platform,
  );

  // 仅对 path source 做同步快校验；devops source 留到异步解析
  for (const s of [leftSource, rightSource]) {
    if (s.kind !== 'path') continue;
    if (!existsSync(s.path)) {
      deps.store.update(job.id, {
        status: 'error',
        error: `文件不存在: ${s.path}`,
        finishedAt: new Date().toISOString(),
      });
      return job.id;
    }
    if (!statSync(s.path).isFile()) {
      deps.store.update(job.id, {
        status: 'error',
        error: `不是文件: ${s.path}`,
        finishedAt: new Date().toISOString(),
      });
      return job.id;
    }
  }

  void runCompareAsync(job.id, leftSource, rightSource, deps);
  return job.id;
}

async function runCompareAsync(
  id: string,
  leftSource: InputSource,
  rightSource: InputSource,
  deps: RunnerDeps,
): Promise<void> {
  const platform = deps.platform ?? DEFAULT_PLATFORM;
  deps.store.update(id, { status: 'running' });
  deps.log(`[workbench] compare start ${id} [${platform}] ${sourceInputLabel(leftSource)} <-> ${sourceInputLabel(rightSource)}${deps.extras?.length ? ` (extras=${deps.extras.join(',')})` : ''}\n`);
  let acquiredLeft: { path: string; release: () => void } | null = null;
  let acquiredRight: { path: string; release: () => void } | null = null;
  try {
    const dir = deps.store.jobDir(id);
    await mkdir(dir, { recursive: true });
    // 顺序解析两侧（避免两个 GB 级下载同时打满带宽/磁盘）
    acquiredLeft = await resolveSource(leftSource, deps, (note) => deps.store.update(id, { note: `左：${note}` }));
    acquiredRight = await resolveSource(rightSource, deps, (note) => deps.store.update(id, { note: `右：${note}` }));
    deps.store.update(id, { note: '分析中…' });
    const leftPath = acquiredLeft.path;
    const rightPath = acquiredRight.path;
    const [left, right] = await Promise.all([
      loadOrAnalyze(leftPath, deps.toolVersion, deps.extras, platform),
      loadOrAnalyze(rightPath, deps.toolVersion, deps.extras, platform),
    ]);
    assertSamePlatform(left, right, platform);
    const diff = diffPackageReports(left, right, { toolVersion: deps.toolVersion });

    // 主产物：diff
    const jsonPath = join(dir, 'diff.json');
    const htmlPath = join(dir, 'diff.html');
    // 副产物：两侧单独分析报告（复用 analyze 的 PackageReport + viewer 模板，
    // 让前端可以从对比项点进去看单包结果，无需再单独跑一次 analyze）
    const leftJsonPath = join(dir, 'left.report.json');
    const leftHtmlPath = join(dir, 'left.report.html');
    const rightJsonPath = join(dir, 'right.report.json');
    const rightHtmlPath = join(dir, 'right.report.html');

    await Promise.all([
      writeFile(jsonPath, stringifyJson(diff, deps.prettyJson), 'utf8'),
      writeFile(htmlPath, renderDiffHtml(diff), 'utf8'),
      writeFile(leftJsonPath, stringifyJson(left, deps.prettyJson), 'utf8'),
      writeFile(leftHtmlPath, renderReportHtml(left), 'utf8'),
      writeFile(rightJsonPath, stringifyJson(right, deps.prettyJson), 'utf8'),
      writeFile(rightHtmlPath, renderReportHtml(right), 'utf8'),
    ]);

    deps.store.update(id, {
      status: 'done',
      note: undefined,
      finishedAt: new Date().toISOString(),
      outputs: {
        htmlUrl: `/jobs/${id}/html`,
        jsonUrl: `/jobs/${id}/json`,
        sides: {
          left: {
            sourcePath: leftPath,
            htmlUrl: `/jobs/${id}/sides/left/html`,
            jsonUrl: `/jobs/${id}/sides/left/json`,
          },
          right: {
            sourcePath: rightPath,
            htmlUrl: `/jobs/${id}/sides/right/html`,
            jsonUrl: `/jobs/${id}/sides/right/json`,
          },
        },
      },
    });
    deps.log(`[workbench] compare done  ${id}\n`);
  } catch (e) {
    deps.store.update(id, {
      status: 'error',
      note: undefined,
      error: (e as Error).message ?? String(e),
      finishedAt: new Date().toISOString(),
    });
    deps.log(`[workbench] compare error ${id} - ${(e as Error).message}\n`);
  } finally {
    acquiredLeft?.release();
    acquiredRight?.release();
  }
}

async function loadOrAnalyze(
  input: string,
  toolVersion: string,
  extras?: string[],
  platform?: Platform,
): Promise<PackageReport> {
  const ext = extname(input).toLowerCase();
  if (ext === '.json') {
    const text = await readFile(resolve(input), 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed?.schemaVersion || !parsed?.meta) {
      throw new Error(`JSON 文件 ${input} 不是有效 PackageReport（缺少 schemaVersion / meta）`);
    }
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      // 静默接受跨版本（与 compare 命令行为一致）
    }
    return parsed as PackageReport;
  }
  return analyzePackage(input, { toolVersion, extras, platform });
}

/**
 * 强校验两侧 platform 一致。允许的情况：
 *  - 两侧都 == 期望 platform
 *  - 一侧/两侧没声明 platform（老报告）→ 默认 'harmony'，再与期望平台比较
 *
 * 不一致直接抛错（runner 会捕获并落 error 状态），避免出现 "hap vs apk" 这种
 * 跨平台无意义对比。
 */
function assertSamePlatform(left: PackageReport, right: PackageReport, expected: Platform): void {
  const lp = left.platform ?? DEFAULT_PLATFORM;
  const rp = right.platform ?? DEFAULT_PLATFORM;
  if (lp !== expected || rp !== expected) {
    throw new Error(
      `compare 两侧 platform 不一致：left=${lp}, right=${rp}, expected=${expected}`,
    );
  }
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** 人类可读标题（用于 job.label）。 */
function sourceTitle(s: InputSource): string {
  if (s.kind === 'path') return baseName(s.path);
  if (s.kind === 'upload') return s.name;
  return s.name + (s.buildNum != null ? ` #${s.buildNum}` : '');
}

/** 写进 job.inputs 的描述串（历史里能看出来源）。 */
function sourceInputLabel(s: InputSource): string {
  if (s.kind === 'path') return s.path;
  if (s.kind === 'upload') return `[上传] ${s.name}`;
  const pipe = s.pipeline ? `${s.pipeline} ` : '';
  return `[蓝盾] ${pipe}${s.name}${s.buildNum != null ? ` #${s.buildNum}` : ''}`;
}

/**
 * 把一个 InputSource 解析成本地文件路径：
 *  - path：原样返回，release 为 no-op
 *  - devops：经 ArtifactCache 下载（或命中缓存）；onProgress 回传进度文本给作业 note
 *
 * 返回的 release() 必须在分析结束后调用，解除缓存"使用中"标记。
 */
async function resolveSource(
  source: InputSource,
  deps: RunnerDeps,
  onProgress: (note: string) => void,
): Promise<{ path: string; release: () => void }> {
  if (source.kind === 'path') {
    return { path: source.path, release: () => {} };
  }
  if (source.kind === 'upload') {
    if (!deps.uploads) throw new Error('服务未配置上传存储，无法解析上传件');
    // acquire 会校验 uploadId 存在；release 删除临时文件（一次性消费）
    return deps.uploads.acquire(source.uploadId);
  }
  if (!deps.devops) throw new Error('服务未配置蓝盾流水线，无法下载制品');
  if (!deps.artifactCache) throw new Error('服务未配置制品缓存目录，无法下载制品');
  const client = deps.devops.getClient(source.pipeline); // 未知流水线会抛 DevopsError
  const artifactPath = source.artifactPath;
  const artifactoryType = source.artifactoryType ?? 'PIPELINE';

  onProgress('准备下载制品…');
  let lastTick = 0;
  const acquired = await deps.artifactCache.acquire(
    {
      projectId: client.pipeline.projectId,
      buildId: source.buildId,
      artifactPath,
      name: source.name,
      expectedSize: source.size ?? undefined,
      getDownload: () => client.getArtifactDownload({ path: artifactPath, artifactoryType }),
    },
    (received, total) => {
      const now = Date.now();
      if (now - lastTick > 400 || (total > 0 && received >= total)) {
        lastTick = now;
        onProgress(`下载制品 ${fmtBytes(received)}${total > 0 ? ` / ${fmtBytes(total)}` : ''}`);
      }
    },
  );
  return { path: acquired.path, release: acquired.release };
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

/**
 * 统一磁盘 JSON 序列化：默认 pretty（2 空格缩进），便于 AI Read/Grep 按行切片
 * 与开发者本地查看；显式 `pretty=false` 时退回紧凑单行（极端关心磁盘体积时用）。
 */
function stringifyJson(value: unknown, pretty: boolean | undefined): string {
  return pretty === false ? JSON.stringify(value) : JSON.stringify(value, null, 2);
}
