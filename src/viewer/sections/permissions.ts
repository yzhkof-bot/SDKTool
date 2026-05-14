import type { HapReport } from '../../shared/schema.js';

import { emptyState, h, table } from '../helpers.js';

export function renderPermissions(report: HapReport): HTMLElement {
  const perms = report.permissions;
  if (!perms || perms.length === 0) return emptyState('未声明任何权限');

  const sensitiveCount = perms.filter((p) => p.sensitive).length;

  const rows = perms.map((p) => [
    h('code', null, p.name),
    p.sensitive ? h('span', { class: 'badge danger' }, '敏感') : h('span', { class: 'badge info' }, '一般'),
    p.reason ? h('span', null, p.reason) : h('span', { class: 'badge' }, '—'),
    p.usedScene ? h('code', { class: 'mono' }, JSON.stringify(p.usedScene)) : h('span', null, '—'),
  ]);

  return h(
    'div',
    null,
    h(
      'section',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, '权限概览'),
      h(
        'div',
        { class: 'card-grid' },
        statCard('权限总数', String(perms.length)),
        statCard('敏感权限', String(sensitiveCount), `${(perms.length === 0 ? 0 : (sensitiveCount / perms.length) * 100).toFixed(0)}%`),
      ),
    ),
    h(
      'section',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, '权限明细'),
      table(
        ['Permission', '类型', '理由 (reason)', 'usedScene'],
        rows,
        ['path', undefined, undefined, 'path'],
      ),
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
