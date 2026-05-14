import type { HapReport } from '../../shared/schema.js';

import { formatBytes, formatDate, h, kv, shortHash } from '../helpers.js';

/** 概览页：基础信息 + 关键体积/权限/警告卡片 */
export function renderOverview(report: HapReport): HTMLElement {
  const cards = h(
    'div',
    { class: 'card-grid' },
    statCard('体积（解压）', report.size ? formatBytes(report.size.total) : '—', report.size ? `${report.size.fileCount} 个文件` : ''),
    statCard('体积（压缩）', formatBytes(report.meta.fileSize), 'hap 文件本身'),
    statCard('权限数', String(report.permissions?.length ?? 0), `敏感 ${countSensitive(report)} 项`),
    statCard('架构', report.nativeLibs?.architectures.join(' / ') || '—', `${report.nativeLibs?.libs.length ?? 0} 个 so`),
    statCard('Native 体积', report.nativeLibs ? formatBytes(report.nativeLibs.totalBytes) : '—'),
    statCard('警告', String(report.warnings.length), warningSummary(report)),
  );

  const basicPanel = h(
    'section',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, '基础信息'),
    report.basic
      ? kv([
          ['Bundle Name', h('code', null, report.basic.bundleName || '—')],
          ['Bundle Type', report.basic.bundleType ?? '—'],
          ['Version', `${report.basic.versionName} (code: ${report.basic.versionCode})`],
          ['Module', `${report.basic.moduleName} · ${report.basic.moduleType}`],
          ['Device Types', report.basic.deviceTypes.join(', ') || '—'],
          [
            'API Range',
            `${report.basic.minAPIVersion ?? '—'} → ${report.basic.targetAPIVersion ?? '—'}`,
          ],
          ['Abilities', String(report.basic.abilities.length)],
        ])
      : h('div', { class: 'empty' }, 'module.json 未读取到，basic 信息缺失'),
  );

  const metaPanel = h(
    'section',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, '报告元信息'),
    kv([
      ['File', h('code', null, report.meta.file)],
      ['SHA-256', h('code', { title: report.meta.sha256 }, shortHash(report.meta.sha256, 16))],
      ['Analyzed At', formatDate(report.meta.analyzedAt)],
      ['Tool Version', report.meta.toolVersion],
      ['Schema', report.schemaVersion],
    ]),
  );

  return h('div', null, cards, basicPanel, metaPanel) as HTMLElement;
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

function countSensitive(report: HapReport): number {
  return report.permissions?.filter((p) => p.sensitive).length ?? 0;
}

function warningSummary(report: HapReport): string {
  const errors = report.warnings.filter((w) => w.level === 'error').length;
  const warns = report.warnings.filter((w) => w.level === 'warn').length;
  if (errors === 0 && warns === 0) return 'no warning';
  return `${errors} error · ${warns} warn`;
}
