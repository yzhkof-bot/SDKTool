import type {
  AndroidPermissionLevel,
  PackageReport,
} from '../../shared/schema.js';

import { badge, emptyState, h, table } from '../helpers.js';

export function renderPermissions(report: PackageReport): HTMLElement {
  const perms = report.permissions;
  if (!perms || perms.length === 0) return emptyState('未声明任何权限');

  const sensitiveCount = perms.filter((p) => p.sensitive).length;
  // 仅当任一条权限带 level 时（即 Android 报告），表头才包含 level 列
  const hasLevel = perms.some((p) => p.level !== undefined);

  // 各 level 在概览卡里的计数（仅 Android）
  const levelStats = hasLevel ? countLevels(perms.map((p) => p.level)) : null;

  const headers = ['Permission', '敏感', ...(hasLevel ? ['Level'] : []), '理由 (reason)', 'usedScene'];
  const columnClasses = ['path', undefined, ...(hasLevel ? [undefined] : []), undefined, 'path'];

  const rows = perms.map((p) => {
    const cells: (string | Node)[] = [
      h('code', null, p.name),
      p.sensitive ? badge('敏感', 'danger') : badge('一般', 'info'),
    ];
    if (hasLevel) cells.push(renderLevelBadge(p.level));
    cells.push(p.reason ? h('span', null, p.reason) : badge('—'));
    cells.push(p.usedScene ? h('code', { class: 'mono' }, JSON.stringify(p.usedScene)) : h('span', null, '—'));
    return cells;
  });

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
        statCard(
          '敏感权限',
          String(sensitiveCount),
          `${(perms.length === 0 ? 0 : (sensitiveCount / perms.length) * 100).toFixed(0)}%`,
        ),
        ...(levelStats
          ? [
              statCard('Dangerous', String(levelStats.dangerous)),
              statCard('Signature', String(levelStats.signature + levelStats.signatureOrSystem)),
              statCard('Normal', String(levelStats.normal)),
              statCard('Unknown', String(levelStats.unknown)),
            ]
          : []),
      ),
    ),
    h(
      'section',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, '权限明细'),
      table(headers, rows, columnClasses),
    ),
  ) as HTMLElement;
}

function countLevels(levels: Array<AndroidPermissionLevel | undefined>): Record<AndroidPermissionLevel, number> {
  const out: Record<AndroidPermissionLevel, number> = {
    dangerous: 0,
    signature: 0,
    signatureOrSystem: 0,
    normal: 0,
    unknown: 0,
  };
  for (const lv of levels) {
    if (lv === undefined) continue;
    out[lv] += 1;
  }
  return out;
}

function renderLevelBadge(level?: AndroidPermissionLevel): HTMLElement {
  if (level === 'dangerous') return badge('dangerous', 'danger');
  if (level === 'signature' || level === 'signatureOrSystem') return badge(level, 'warning');
  if (level === 'normal') return badge('normal', 'info');
  return badge('unknown');
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
