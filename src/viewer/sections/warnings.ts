import type { PackageReport, WarningLevel } from '../../shared/schema.js';

import { emptyState, h, table } from '../helpers.js';

const LEVEL_BADGE: Record<WarningLevel, 'danger' | 'warning' | 'info'> = {
  error: 'danger',
  warn: 'warning',
  info: 'info',
};

export function renderWarnings(report: PackageReport): HTMLElement {
  const ws = report.warnings;
  if (!ws || ws.length === 0) return emptyState('一切正常，没有任何 warning');

  return h(
    'section',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, `Warnings (${ws.length})`),
    table(
      ['Level', 'Code', 'Source', 'Message'],
      ws.map((w) => [
        h('span', { class: `badge ${LEVEL_BADGE[w.level]}` }, w.level),
        h('code', null, w.code),
        w.source ? h('code', null, w.source) : '—',
        w.message,
      ]),
      [undefined, undefined, undefined, 'path'],
    ),
  ) as HTMLElement;
}
