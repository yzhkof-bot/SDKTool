import type { PackageReport } from '../../shared/schema.js';

import { emptyState, h, table } from '../helpers.js';

export function renderDependencies(report: PackageReport): HTMLElement {
  const d = report.dependencies;
  if (!d) return emptyState('无 dependencies 数据');

  if (d.hsp.length === 0 && d.har.length === 0) return emptyState('未声明任何依赖');

  return h(
    'div',
    null,
    h(
      'section',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, '依赖列表'),
      table(
        ['类型', 'Name'],
        [
          ...d.hsp.map((id) => [h('span', { class: 'badge primary' }, 'HSP'), h('code', null, id)]),
          ...d.har.map((id) => [h('span', { class: 'badge info' }, 'HAR'), h('code', null, id)]),
        ],
        [undefined, 'path'],
      ),
    ),
    d.raw
      ? h(
          'section',
          { class: 'panel' },
          h('h3', { class: 'panel-title' }, '原始 dependencies (raw)'),
          h(
            'pre',
            { class: 'mono', style: 'background: var(--color-code-bg); padding: 12px; border-radius: 4px; overflow:auto; margin:0;' },
            JSON.stringify(d.raw, null, 2),
          ),
        )
      : null,
  ) as HTMLElement;
}
