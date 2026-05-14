import type { HapAbcStrings, HapReport } from '../../shared/schema.js';

import { badge, emptyState, formatBytes, h, shortHash, table } from '../helpers.js';

const STRING_PREVIEW_LIMIT = 200;

export function renderAbc(report: HapReport): HTMLElement {
  const a = report.abc;
  if (!a) return emptyState('无 abc 数据');

  return h(
    'div',
    null,
    h(
      'section',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, '主字节码 modules.abc'),
      a.modulesAbc
        ? h(
            'div',
            { class: 'card-grid' },
            statCard('体积', formatBytes(a.modulesAbc.bytes)),
            statCard(
              'SourceMap',
              a.modulesAbc.hasSourceMap ? '有' : '无',
              a.modulesAbc.hasSourceMap ? 'ets/sourceMaps.map' : '调试信息缺失',
            ),
          )
        : emptyState('未找到 ets/modules.abc'),
    ),
    h(
      'section',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, '其它 abc 文件'),
      a.extraAbcFiles.length
        ? table(
            ['路径', '体积'],
            a.extraAbcFiles.map((f) => [f.path, formatBytes(f.bytes)]),
            ['path', 'num'],
          )
        : emptyState('无额外 abc'),
    ),
    renderAbcDetails(report),
  ) as HTMLElement;
}

function renderAbcDetails(report: HapReport): HTMLElement | null {
  const det = report.abcDetails;
  if (!det || det.entries.length === 0) return null;

  const rows = det.entries.map((e) => [
    h('code', null, e.path),
    formatBytes(e.bytes),
    e.magic ? badge(e.magic, 'success') : badge('not PANDA', 'danger'),
    e.version ?? '—',
    e.headerFileSize !== null ? formatBytes(e.headerFileSize) : '—',
    e.numClasses !== null ? e.numClasses.toLocaleString() : '—',
    e.sha256 ? h('code', { title: e.sha256 }, shortHash(e.sha256)) : '—',
    e.error ? badge(e.error, 'danger') : '',
  ]);

  const stringPanels = det.entries
    .filter((e) => e.strings)
    .map((e) => renderAbcStringPanel(e.path, e.strings!));

  return h(
    'section',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, '可选深度分析 · ABC 头部细节'),
    table(
      ['路径', '体积', 'Magic', 'Version', 'Header file_size', '类数', 'SHA-256', '错误'],
      rows,
      ['path', 'num', undefined, undefined, 'num', 'num', undefined, undefined],
    ),
    stringPanels.length > 0 ? h('h3', { class: 'panel-title', style: 'margin-top:14px' }, 'ABC 字符串池（启发式抽取）') : null,
    ...stringPanels,
  ) as HTMLElement;
}

function renderAbcStringPanel(path: string, strs: HapAbcStrings): HTMLElement {
  return h(
    'details',
    { class: 'panel sub-panel' },
    h(
      'summary',
      null,
      h('strong', null, path),
      ' · 共抽出 ',
      strs.totalDistinct.toLocaleString(),
      ' 条；',
      `类 ${strs.classDescriptors.length} · 模块 ${strs.moduleRecords.length} · 文件 ${strs.sourceFiles.length} · 标识符 ${strs.identifiers.length}`,
      strs.truncated ? badge('已截断', 'warning') : null,
    ),
    renderStringGroup('类描述符 (L...;)', strs.classDescriptors),
    renderStringGroup('模块记录 (&...)', strs.moduleRecords),
    renderStringGroup('源文件 (.ets/.ts/.js)', strs.sourceFiles),
    renderStringGroup('方法/标识符', strs.identifiers),
    renderStringGroup('其它字面量', strs.other),
  ) as HTMLElement;
}

function renderStringGroup(label: string, list: string[]): HTMLElement | null {
  if (list.length === 0) return null;
  const preview = list.slice(0, STRING_PREVIEW_LIMIT);
  const more = list.length - preview.length;
  return h(
    'details',
    { class: 'panel sub-panel' },
    h(
      'summary',
      null,
      h('strong', null, label),
      ' · ',
      String(list.length),
      more > 0 ? `（页面仅显示前 ${STRING_PREVIEW_LIMIT}，全量见 JSON）` : '',
    ),
    h(
      'div',
      { class: 'string-list' },
      ...preview.map((s) => h('code', { class: 'string-item' }, s)),
    ),
  ) as HTMLElement;
}

function statCard(label: string, value: string, sub?: string): HTMLElement {
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-label' }, label),
    h('div', { class: 'card-value' }, value),
    sub ? h('div', { class: 'card-sub' }, sub) : null,
  ) as HTMLElement;
}
