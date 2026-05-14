import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';

import { analyzeHap } from '../../core/index.js';
import { diffHapReports } from '../../core/differ/index.js';
import { SCHEMA_VERSION, type HapReport } from '../../shared/schema.js';
import { UsageError } from '../errors.js';
import { renderDiffHtml } from '../utils/render.js';

export interface CompareCommandOptions {
  output?: string;
  pretty?: boolean;
  only?: string;
  /** 在默认集合外额外开启的可选深度 analyzer id（逗号分隔，仅当输入是 .hap 时生效） */
  extras?: string;
  topFiles?: number;
  html?: string;
}

export interface CompareCommandDeps {
  toolVersion: string;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
}

/**
 * `kingsdk compare <a> <b>` 实现。
 *
 * 输入：每一侧可以是 `.hap`（现场分析）或 `.json`（已分析的报告）。两种可混用，
 * 例如基线 JSON 报告 + 新版本 hap，等价于把基线"快照"和当下产物对齐。
 *
 * 输出形态：
 *  - 默认 stdout JSON
 *  - --output 写文件，stdout 仅打路径
 *  - --html 同时产出可双击打开的 HTML diff 报告
 */
export async function runCompareCommand(
  leftInput: string | undefined,
  rightInput: string | undefined,
  opts: CompareCommandOptions,
  deps: CompareCommandDeps,
): Promise<void> {
  if (!leftInput || !rightInput) {
    throw new UsageError(
      '缺少必填参数 <a> <b>，用法: kingsdk compare <baseline.hap|json> <candidate.hap|json>',
    );
  }
  const only = parseOnly(opts.only);
  const extras = parseIdList(opts.extras, '--extras');
  const topFilesLimit = parseTopFiles(opts.topFiles);

  const leftReport = await loadOrAnalyze(leftInput, {
    only,
    extras,
    topFilesLimit,
    toolVersion: deps.toolVersion,
  });
  const rightReport = await loadOrAnalyze(rightInput, {
    only,
    extras,
    topFilesLimit,
    toolVersion: deps.toolVersion,
  });

  const diff = diffHapReports(leftReport, rightReport, {
    toolVersion: deps.toolVersion,
  });

  const json = opts.pretty ? JSON.stringify(diff, null, 2) : JSON.stringify(diff);

  let htmlPath: string | undefined;
  if (opts.html) {
    htmlPath = resolve(opts.html);
    const html = renderDiffHtml(diff);
    await mkdir(dirname(htmlPath), { recursive: true });
    await writeFile(htmlPath, html, 'utf8');
  }

  if (opts.output) {
    const outPath = resolve(opts.output);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, json, 'utf8');
    deps.writeStdout(`[kingsdk] diff written to ${outPath}\n`);
    if (htmlPath) deps.writeStdout(`[kingsdk] html diff written to ${htmlPath}\n`);
    return;
  }

  if (htmlPath && !opts.output) {
    deps.writeStdout(`[kingsdk] html diff written to ${htmlPath}\n`);
    return;
  }

  deps.writeStdout(json);
  if (!json.endsWith('\n')) deps.writeStdout('\n');
}

/* -------------------------------------------------------------------------- */

interface AnalyzeArgs {
  only?: string[];
  extras?: string[];
  topFilesLimit?: number;
  toolVersion: string;
}

/**
 * 接受 .hap / .json 任一种输入；对 .json 直接读取并校验 schemaVersion。
 *
 * 校验从宽：只要顶层是 object 且能 JSON.parse、含 meta 字段，就当成已分析报告处理；
 * 否则当作 .hap 走 analyzeHap。这样支持上游用 `kingsdk analyze ./a.hap -o a.json` 产物。
 */
async function loadOrAnalyze(input: string, args: AnalyzeArgs): Promise<HapReport> {
  const abs = resolve(input);
  if (!existsSync(abs)) {
    throw new UsageError(`文件不存在: ${abs}`);
  }
  if (!statSync(abs).isFile()) {
    throw new UsageError(`不是文件: ${abs}`);
  }

  const ext = extname(abs).toLowerCase();
  if (ext === '.json') {
    const text = await readFile(abs, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new UsageError(`无法解析 JSON 报告: ${abs} - ${(e as Error).message}`);
    }
    if (!isHapReport(parsed)) {
      throw new UsageError(
        `JSON 文件 ${abs} 缺少 meta / schemaVersion 字段，无法识别为 HapReport`,
      );
    }
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      // 不阻断，只警告（迁移期向后兼容）
      process.stderr.write(
        `[kingsdk] warning: ${abs} schemaVersion=${parsed.schemaVersion} 与当前工具 ${SCHEMA_VERSION} 不一致\n`,
      );
    }
    return parsed;
  }

  // 默认走 analyze
  return analyzeHap(abs, {
    only: args.only,
    extras: args.extras,
    topFilesLimit: args.topFilesLimit,
    toolVersion: args.toolVersion,
  });
}

function isHapReport(v: unknown): v is HapReport {
  return (
    typeof v === 'object' &&
    v !== null &&
    'schemaVersion' in v &&
    'meta' in v &&
    typeof (v as { meta?: unknown }).meta === 'object'
  );
}

function parseOnly(input: string | undefined): string[] | undefined {
  return parseIdList(input, '--only');
}

function parseIdList(input: string | undefined, flag: string): string[] | undefined {
  if (!input) return undefined;
  const ids = input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) {
    throw new UsageError(`${flag} 的值不能为空`);
  }
  return ids;
}

function parseTopFiles(input: number | undefined): number | undefined {
  if (input === undefined) return undefined;
  if (!Number.isFinite(input) || input < 0 || !Number.isInteger(input)) {
    throw new UsageError(`--top-files 必须是非负整数，收到: ${input}`);
  }
  return input;
}
