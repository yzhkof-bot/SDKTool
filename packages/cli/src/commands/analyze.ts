import { existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { analyzePackage } from '@kingsdk/core/index.js';
import { UsageError } from '../errors.js';
import { renderReportHtml } from '@kingsdk/viewer/render.js';

export interface AnalyzeCommandOptions {
  output?: string;
  pretty?: boolean;
  only?: string;
  /** 在默认集合外额外开启的可选深度 analyzer id（逗号分隔） */
  extras?: string;
  topFiles?: number;
  html?: string;
}

export interface AnalyzeCommandDeps {
  toolVersion: string;
  /** 写到 stdout 的回调，便于测试 */
  writeStdout: (text: string) => void;
}

/**
 * `kingsdk analyze <hap>` 的实现。
 *
 * 行为：
 *  - 默认把 JSON 写到 stdout
 *  - --output 写到文件，stdout 仅打一行确认
 *  - --pretty 启用缩进
 *  - --only basic,size 限制 analyzer
 *  - --top-files N 控制 size analyzer 的 Top N
 */
export async function runAnalyzeCommand(
  hapPath: string | undefined,
  opts: AnalyzeCommandOptions,
  deps: AnalyzeCommandDeps,
): Promise<void> {
  if (!hapPath) {
    throw new UsageError('缺少必填参数 <hap>，用法: kingsdk analyze <path-to-hap>');
  }
  const absPath = resolve(hapPath);
  if (!existsSync(absPath)) {
    throw new UsageError(`文件不存在: ${absPath}`);
  }
  if (!statSync(absPath).isFile()) {
    throw new UsageError(`不是文件: ${absPath}`);
  }

  const only = parseOnly(opts.only);
  const extras = parseIdList(opts.extras, '--extras');
  const topFilesLimit = parseTopFiles(opts.topFiles);

  const report = await analyzePackage(absPath, {
    only,
    extras,
    topFilesLimit,
    toolVersion: deps.toolVersion,
  });

  const json = opts.pretty
    ? JSON.stringify(report, null, 2)
    : JSON.stringify(report);

  // --html: 写单文件 HTML 报告
  let htmlPath: string | undefined;
  if (opts.html) {
    htmlPath = resolve(opts.html);
    const html = renderReportHtml(report);
    await mkdir(dirname(htmlPath), { recursive: true });
    await writeFile(htmlPath, html, 'utf8');
  }

  if (opts.output) {
    const outPath = resolve(opts.output);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, json, 'utf8');
    deps.writeStdout(`[kingsdk] report written to ${outPath}\n`);
    if (htmlPath) deps.writeStdout(`[kingsdk] html report written to ${htmlPath}\n`);
    return;
  }

  if (htmlPath && !opts.output) {
    // 仅 --html 而无 -o 时，stdout 也只打确认信息（避免大段 JSON 与 html 路径混在一起）
    deps.writeStdout(`[kingsdk] html report written to ${htmlPath}\n`);
    return;
  }

  deps.writeStdout(json);
  if (!json.endsWith('\n')) deps.writeStdout('\n');
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
