import type { PackageReport, SizeCategory } from '@kingsdk/shared/schema.js';

import { emptyState, formatBytes, formatPercent, h, ratioBar, table } from '../helpers.js';

/** 各分类色板（CSS 不能 :root 引用动态变量名，这里直接给颜色） */
const CATEGORY_COLORS: Record<SizeCategory, string> = {
  ets: '#5b8cff',
  resources: '#10b981',
  libs: '#f59e0b',
  signature: '#8b5cf6',
  config: '#6b7280',
  // Android 专属：dex 走深蓝（与 ets 的浅蓝区分），assets 走青蓝（与 resources 区分）
  dex: '#3b82f6',
  assets: '#06b6d4',
  other: '#94a3b8',
};

export function renderSize(report: PackageReport): HTMLElement {
  const size = report.size;
  if (!size) return emptyState('无 size 数据');

  const total = size.total;

  // 堆叠条形图
  const stacked = h(
    'div',
    { class: 'stacked-bar' },
    ...size.breakdown.map((b) => {
      const pct = total > 0 ? (b.bytes / total) * 100 : 0;
      return h(
        'div',
        {
          class: 'seg',
          style: `width: ${pct.toFixed(2)}%; background: ${CATEGORY_COLORS[b.category] ?? '#999'}`,
          title: `${b.category}: ${formatBytes(b.bytes)} (${pct.toFixed(2)}%)`,
        },
        pct >= 8 ? b.category : '',
      );
    }),
  );

  const legend = h(
    'div',
    { class: 'legend' },
    ...size.breakdown.map((b) =>
      h(
        'span',
        null,
        h('span', {
          class: 'swatch',
          style: `background: ${CATEGORY_COLORS[b.category] ?? '#999'}`,
        }),
        `${b.category} · ${formatBytes(b.bytes)} · ${formatPercent(b.ratio)}`,
      ),
    ),
  );

  // breakdown 表
  const breakdownTable = table(
    ['分类', '文件数', '体积', '占比', ''],
    size.breakdown.map((b) => [
      h('strong', null, b.category),
      String(b.fileCount),
      formatBytes(b.bytes),
      formatPercent(b.ratio),
      ratioBar(b.ratio),
    ]),
    [undefined, 'num', 'num', 'num', 'bar-col'],
  );

  // topFiles 表
  const topRows = size.topFiles.length
    ? size.topFiles.map((f) => [
        f.path,
        h('span', { class: 'badge' }, f.category),
        formatBytes(f.bytes),
        formatPercent(f.ratio),
        ratioBar(f.ratio),
      ])
    : [];

  return h(
    'div',
    null,
    h(
      'section',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, '体积分布'),
      stacked,
      legend,
      h(
        'div',
        { class: 'card-grid', style: 'margin-top: 16px;' },
        statCard('总体积（解压）', formatBytes(size.total)),
        statCard('压缩后', formatBytes(size.compressed)),
        statCard(
          '压缩率',
          size.total > 0 ? formatPercent(size.compressed / size.total) : '—',
          'compressed / total',
        ),
        statCard('文件总数', String(size.fileCount)),
      ),
    ),
    h(
      'section',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, '分类汇总'),
      breakdownTable,
    ),
    h(
      'section',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, `Top ${size.topFiles.length} 大文件`),
      topRows.length
        ? table(
            ['路径', '分类', '体积', '占比', ''],
            topRows,
            ['path', undefined, 'num', 'num', 'bar-col'],
          )
        : emptyState('没有文件'),
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
