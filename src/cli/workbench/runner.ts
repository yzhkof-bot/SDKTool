import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

import { analyzePackage } from '../../core/index.js';
import { diffPackageReports } from '../../core/differ/index.js';
import {
  DEFAULT_PLATFORM,
  SCHEMA_VERSION,
  type PackageReport,
  type Platform,
} from '../../shared/schema.js';
import { renderDiffHtml, renderReportHtml } from '../utils/render.js';

import type { JobStore } from './store.js';

export interface RunnerDeps {
  store: JobStore;
  toolVersion: string;
  /** 写到 server 控制台的日志；测试可注入 noop */
  log: (text: string) => void;
  /** 可选深度分析 analyzer id 列表（参见 EXTRA_ANALYZERS） */
  extras?: string[];
  /** 应用包平台；未指定时按 'harmony' 处理 */
  platform?: Platform;
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
 *  2. 校验路径（不存在/非文件 → 直接置 error）
 *  3. 后台 analyzePackage，写产物到 store.jobDir(id) 下的 report.json / report.html
 *  4. 把产物 URL 回写 job.outputs
 */
export function startAnalyzeJob(absPath: string, deps: RunnerDeps): string {
  const label = baseName(absPath);
  const platform = deps.platform ?? DEFAULT_PLATFORM;
  const job = deps.store.create('analyze', [absPath], label, platform);

  // 同步快校验，错误直接落 error 状态，避免后台无人处理的 race
  if (!existsSync(absPath)) {
    deps.store.update(job.id, {
      status: 'error',
      error: `文件不存在: ${absPath}`,
      finishedAt: new Date().toISOString(),
    });
    return job.id;
  }
  if (!statSync(absPath).isFile()) {
    deps.store.update(job.id, {
      status: 'error',
      error: `不是文件: ${absPath}`,
      finishedAt: new Date().toISOString(),
    });
    return job.id;
  }

  // 异步执行
  void runAnalyzeAsync(job.id, absPath, deps);
  return job.id;
}

async function runAnalyzeAsync(id: string, absPath: string, deps: RunnerDeps): Promise<void> {
  const platform = deps.platform ?? DEFAULT_PLATFORM;
  deps.store.update(id, { status: 'running' });
  deps.log(`[workbench] analyze start ${id} [${platform}] ${absPath}${deps.extras?.length ? ` (extras=${deps.extras.join(',')})` : ''}\n`);
  try {
    const dir = deps.store.jobDir(id);
    await mkdir(dir, { recursive: true });
    const report = await analyzePackage(absPath, {
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
      error: (e as Error).message ?? String(e),
      finishedAt: new Date().toISOString(),
    });
    deps.log(`[workbench] analyze error ${id} - ${(e as Error).message}\n`);
  }
}

/* -------------------------------------------------------------------------- */
/* compare                                                                     */
/* -------------------------------------------------------------------------- */

export function startCompareJob(
  leftPath: string,
  rightPath: string,
  deps: RunnerDeps,
): string {
  const label = `${baseName(leftPath)} vs ${baseName(rightPath)}`;
  const platform = deps.platform ?? DEFAULT_PLATFORM;
  const job = deps.store.create('compare', [leftPath, rightPath], label, platform);

  for (const p of [leftPath, rightPath]) {
    if (!existsSync(p)) {
      deps.store.update(job.id, {
        status: 'error',
        error: `文件不存在: ${p}`,
        finishedAt: new Date().toISOString(),
      });
      return job.id;
    }
    if (!statSync(p).isFile()) {
      deps.store.update(job.id, {
        status: 'error',
        error: `不是文件: ${p}`,
        finishedAt: new Date().toISOString(),
      });
      return job.id;
    }
  }

  void runCompareAsync(job.id, leftPath, rightPath, deps);
  return job.id;
}

async function runCompareAsync(
  id: string,
  leftPath: string,
  rightPath: string,
  deps: RunnerDeps,
): Promise<void> {
  const platform = deps.platform ?? DEFAULT_PLATFORM;
  deps.store.update(id, { status: 'running' });
  deps.log(`[workbench] compare start ${id} [${platform}] ${leftPath} <-> ${rightPath}${deps.extras?.length ? ` (extras=${deps.extras.join(',')})` : ''}\n`);
  try {
    const dir = deps.store.jobDir(id);
    await mkdir(dir, { recursive: true });
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
      error: (e as Error).message ?? String(e),
      finishedAt: new Date().toISOString(),
    });
    deps.log(`[workbench] compare error ${id} - ${(e as Error).message}\n`);
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

/**
 * 统一磁盘 JSON 序列化：默认 pretty（2 空格缩进），便于 AI Read/Grep 按行切片
 * 与开发者本地查看；显式 `pretty=false` 时退回紧凑单行（极端关心磁盘体积时用）。
 */
function stringifyJson(value: unknown, pretty: boolean | undefined): string {
  return pretty === false ? JSON.stringify(value) : JSON.stringify(value, null, 2);
}
