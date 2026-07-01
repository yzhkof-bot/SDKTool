import type { DexMethodEntry, DexStrings, PackageReport } from '@kingsdk/shared/schema.js';

import { badge, emptyState, formatBytes, h, shortHash, table } from '../helpers.js';

const STRING_PREVIEW_LIMIT = 200;
const METHOD_PREVIEW_LIMIT = 200;

/**
 * Android 专属 section：classes*.dex 头部 + 可选的字符串池抽取。
 *
 * 数据来源：
 *   - report.dex          由 androidDexAnalyzer 填写（默认开），含 header 摘要
 *   - report.dexDetails   由 androidDexDetailsAnalyzer 填写（extras 才开），含 string_ids 抽取
 *
 * 渲染层级：
 *   1. 顶部统计卡：dex 个数 + 总字节
 *   2. 表格：每个 dex 一行（path / bytes / magic / version / 多个表的计数）
 *   3. 字符串池（仅当 dexDetails 存在）：与 abc section 同样的"按分桶折叠"UI
 */
export function renderDex(report: PackageReport): HTMLElement {
  const d = report.dex;
  if (!d || d.fileCount === 0) {
    return emptyState('未检测到 classes*.dex（apk 是否完整？也可能是 native-only 包）');
  }

  const rows = d.files.map((f) => [
    h('code', null, f.path),
    formatBytes(f.bytes),
    f.magic === 'DEX'
      ? badge('DEX', 'success')
      : f.magic === 'CDEX'
        ? badge('CDEX', 'info')
        : badge('INVALID', 'danger'),
    f.version ?? '—',
    f.stringIds !== null ? f.stringIds.toLocaleString() : '—',
    f.typeIds !== null ? f.typeIds.toLocaleString() : '—',
    f.methodIds !== null ? f.methodIds.toLocaleString() : '—',
    f.classDefs !== null ? f.classDefs.toLocaleString() : '—',
    f.fileSize !== null ? formatBytes(f.fileSize) : '—',
    f.error ? badge(f.error, 'danger') : '',
  ]);

  return h(
    'div',
    null,
    h(
      'section',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, 'DEX 概览'),
      h(
        'div',
        { class: 'card-grid' },
        statCard('文件数', String(d.fileCount)),
        statCard('总字节', formatBytes(d.totalBytes)),
      ),
    ),
    h(
      'section',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, 'DEX 头部明细'),
      table(
        ['路径', '体积', 'Magic', 'Version', 'Strings', 'Types', 'Methods', 'Classes', 'Header file_size', '错误'],
        rows,
        ['path', 'num', undefined, undefined, 'num', 'num', 'num', 'num', 'num', undefined],
      ),
    ),
    renderDexDetails(report),
  ) as HTMLElement;
}

function renderDexDetails(report: PackageReport): HTMLElement | null {
  const det = report.dexDetails;
  if (!det || det.entries.length === 0) return null;

  const stringPanels = det.entries
    .filter((e) => e.strings)
    .map((e) => renderDexStringPanel(e.path, e.strings!));

  const methodPanels = det.entries
    .filter((e) => e.methods && e.methods.length > 0)
    .map((e) => renderDexMethodsPanel(e.path, e.methods!, !!e.methodsTruncated));

  if (stringPanels.length === 0 && methodPanels.length === 0) return null;

  return h(
    'section',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, '可选深度分析 · DEX 字符串池 / 方法表'),
    h(
      'p',
      { class: 'panel-desc' },
      '字符串池：string_ids 抽出后按用途分桶。方法表：method_ids + class_data_item 还原，可作 method-level diff 基础。truncated 时仅展示前几项，全量见 JSON。',
    ),
    h(
      'table',
      { class: 'tbl' },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', null, '文件'),
          h('th', null, '体积'),
          h('th', null, 'SHA-256'),
          h('th', null, '字符串总数'),
          h('th', null, '方法总数'),
        ),
      ),
      h(
        'tbody',
        null,
        ...det.entries.map((e) =>
          h(
            'tr',
            null,
            h('td', { class: 'path' }, h('code', null, e.path)),
            h('td', { class: 'num' }, formatBytes(e.bytes)),
            h('td', null, e.sha256 ? h('code', { title: e.sha256 }, shortHash(e.sha256)) : '—'),
            h('td', { class: 'num' }, e.strings?.totalDistinct.toLocaleString() ?? '—'),
            h(
              'td',
              { class: 'num' },
              e.methods
                ? `${e.methods.length.toLocaleString()}${e.methodsTruncated ? ' (已截断)' : ''}`
                : '—',
            ),
          ),
        ),
      ),
    ),
    ...stringPanels,
    ...methodPanels,
  ) as HTMLElement;
}

/**
 * 单个 dex 的方法表展示（折叠面板）。
 *
 * 列：fullName / accessFlags（hex）/ insnsSize / registers / insnsSha256（短哈希）。
 * 截断时只渲染前 METHOD_PREVIEW_LIMIT 条；全量见 JSON。
 */
function renderDexMethodsPanel(
  path: string,
  methods: DexMethodEntry[],
  truncated: boolean,
): HTMLElement {
  const preview = methods.slice(0, METHOD_PREVIEW_LIMIT);
  const more = methods.length - preview.length;
  const rows = preview.map((m) => [
    h('code', { title: m.fullName }, m.fullName),
    h('code', null, `0x${m.accessFlags.toString(16).padStart(4, '0')}`),
    m.insnsSize !== null ? m.insnsSize.toLocaleString() : badge('abstract', 'info'),
    m.registers !== null ? String(m.registers) : '—',
    m.insnsSha256 ? h('code', { title: m.insnsSha256 }, shortHash(m.insnsSha256)) : '—',
  ]);

  return h(
    'details',
    { class: 'panel sub-panel' },
    h(
      'summary',
      null,
      h('strong', null, path),
      ' · 方法表 ',
      methods.length.toLocaleString(),
      more > 0 ? `（页面仅显示前 ${METHOD_PREVIEW_LIMIT}，全量见 JSON）` : '',
      truncated ? badge('analyzer 已截断', 'warning') : null,
    ),
    table(
      ['方法 (fullName)', 'accessFlags', 'insns 大小', 'registers', 'insns SHA-256'],
      rows,
      [undefined, undefined, 'num', 'num', undefined],
    ),
  ) as HTMLElement;
}

function renderDexStringPanel(path: string, strs: DexStrings): HTMLElement {
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
      `类 ${strs.classDescriptors.length} · 方法签名 ${strs.methodSignatures.length} · 文件 ${strs.sourceFiles.length} · 标识符 ${strs.identifiers.length}`,
      strs.truncated ? badge('已截断', 'warning') : null,
    ),
    renderStringGroup('类描述符 (L...;)', strs.classDescriptors),
    renderStringGroup('方法签名 (...)..', strs.methodSignatures),
    renderStringGroup('源文件 (.java/.kt)', strs.sourceFiles),
    renderStringGroup('标识符', strs.identifiers),
    renderStringGroup('其它字符串', strs.other),
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
