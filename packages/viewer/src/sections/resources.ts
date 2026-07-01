import type { PackageReport } from '@kingsdk/shared/schema.js';

import { emptyState, formatBytes, h, table } from '../helpers.js';

export function renderResources(report: PackageReport): HTMLElement {
  const r = report.resources;
  if (!r) return emptyState('无 resource 数据');

  const cards = h(
    'div',
    { class: 'card-grid' },
    statCard('图片', String(r.images.count), formatBytes(r.images.bytes)),
    statCard('媒体', String(r.media.count), formatBytes(r.media.bytes)),
    statCard('字符串文件', String(r.strings.count)),
    r.rawResIndex ? statCard('resources.index', formatBytes(r.rawResIndex.bytes)) : null,
  );

  const localesPanel = h(
    'section',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, '语言/locale 列表'),
    r.strings.locales.length
      ? h(
          'div',
          { class: 'legend' },
          ...r.strings.locales.map((l) => h('span', { class: 'badge primary' }, l)),
        )
      : emptyState('未识别到任何 locale'),
  );

  const imagesPanel = h(
    'section',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, `Top ${r.images.topLargest.length} 大图片`),
    r.images.topLargest.length
      ? table(
          ['路径', '体积'],
          r.images.topLargest.map((img) => [img.path, formatBytes(img.bytes)]),
          ['path', 'num'],
        )
      : emptyState('没有图片资源'),
  );

  return h('div', null, cards, localesPanel, imagesPanel) as HTMLElement;
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
