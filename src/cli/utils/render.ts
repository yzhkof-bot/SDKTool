import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { HapDiffReport, HapReport } from '../../shared/schema.js';

/**
 * 把 HapReport / HapDiffReport JSON 注入到 viewer HTML 模板，产出可双击打开的单文件 HTML。
 *
 * 模板由 build 步骤产生（scripts/buildViewerTemplate.mjs），保存在 templates/ 下。
 * 模板内含 __DATA_PLACEHOLDER__ 占位符，本函数把它替换为 JSON.stringify(report)。
 *
 * 关键安全点：
 *  - JSON 内可能含 </script>，会破坏外层 <script type="application/json"> 边界，必须转义
 *  - 仅替换第一次出现：viewer bundle 中作为字面量出现的同字符串不能被破坏
 */
export const DATA_PLACEHOLDER = '__DATA_PLACEHOLDER__';

export type TemplateKind = 'report' | 'diff';

export interface RenderHtmlOptions {
  /** 直接传入模板字符串，便于测试 / view server；不传则从默认模板路径读取 */
  template?: string;
}

export function renderReportHtml(report: HapReport, options: RenderHtmlOptions = {}): string {
  const template = options.template ?? loadDefaultTemplate('report');
  return injectData(template, report);
}

export function renderDiffHtml(diff: HapDiffReport, options: RenderHtmlOptions = {}): string {
  const template = options.template ?? loadDefaultTemplate('diff');
  return injectData(template, diff);
}

function injectData(template: string, value: unknown): string {
  const safeJson = serializeForHtml(value);
  const idx = template.indexOf(DATA_PLACEHOLDER);
  if (idx < 0) {
    throw new Error(
      `viewer 模板缺少占位符 ${DATA_PLACEHOLDER}，请重新执行 npm run build`,
    );
  }
  return (
    template.slice(0, idx) + safeJson + template.slice(idx + DATA_PLACEHOLDER.length)
  );
}

/* ------------------------------------------------------------------ */

const cachedTemplates: Partial<Record<TemplateKind, string>> = {};

export function loadDefaultTemplate(kind: TemplateKind = 'report'): string {
  const cached = cachedTemplates[kind];
  if (cached !== undefined) return cached;

  const fileName = kind === 'report' ? 'report.template.html' : 'diff.template.html';
  const here = currentDir();
  const candidates = [
    // 构建产物运行场景：dist/cli/index.cjs → ../templates
    join(here, '..', 'templates', fileName),
    // tsx 直接跑场景：src/cli/utils → ../../../templates
    join(here, '..', '..', '..', 'templates', fileName),
    // 兜底：进程 cwd
    join(process.cwd(), 'templates', fileName),
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf8');
      cachedTemplates[kind] = content;
      return content;
    }
  }

  throw new Error(
    [
      `未找到 viewer HTML 模板 templates/${fileName}。`,
      '请先执行 `npm run build`（会自动生成）；',
      `已尝试以下路径:\n  - ${candidates.join('\n  - ')}`,
    ].join('\n'),
  );
}

/** 仅用于测试：清掉缓存 */
export function _resetTemplateCache(): void {
  delete cachedTemplates.report;
  delete cachedTemplates.diff;
}

/**
 * 把任意值序列化成可安全嵌入 <script type="application/json"> 的字符串。
 *
 * 关键转义（必须既是合法 JSON、又能避开 HTML 解析的关键 token）：
 *  - </script>  →  <\/script    `\/` 是合法 JSON 转义；防止外层 <script> 被提前关闭
 *  - <!--       →  <\u0021--    `\u0021` = '!'，避免 HTML5 script-data state 进入 escaped 模式
 *  - -->        →  --\u003e     `\u003e` = '>'，与上一条配对
 *  - U+2028/9   →  \u2028/9     旧浏览器把它当行结束符，会让 JS / JSON 解析炸
 *
 * 注意不能用 `\!` / `\>` 这种字面反斜杠——它们不是合法 JSON 转义字符，viewer
 * 端 JSON.parse 时会抛 "Bad escaped character"。HapReport 内含 .rodata / abc
 * 字符串池时，命中 `<!--` 或 `-->` 子串的概率很高，曾经的实现会在那一刻爆掉。
 */
export function serializeForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/<\/script/gi, '<\\/script')
    .replace(/<!--/g, '<\\u0021--')
    .replace(/-->/g, '--\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function currentDir(): string {
  if (typeof __dirname !== 'undefined') return __dirname;
  try {
    const meta = (Function('return import.meta')() as { url?: string } | undefined);
    if (meta?.url) return dirname(fileURLToPath(meta.url));
  } catch {
    /* ignore */
  }
  return process.cwd();
}
