import type { PackageReport } from '../../shared/schema.js';

import { formatBytes, formatDate, h, kv, shortHash } from '../helpers.js';

/** 概览页：基础信息 + 关键体积/权限/警告卡片 */
export function renderOverview(report: PackageReport): HTMLElement {
  const cards = h(
    'div',
    { class: 'card-grid' },
    statCard('体积（解压）', report.size ? formatBytes(report.size.total) : '—', report.size ? `${report.size.fileCount} 个文件` : ''),
    statCard('体积（压缩）', formatBytes(report.meta.fileSize), packageLabel(report)),
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
      ? kv(buildBasicRows(report))
      : h(
          'div',
          { class: 'empty' },
          report.platform === 'android'
            ? 'AndroidManifest.xml 未读取到，basic 信息缺失'
            : 'module.json 未读取到，basic 信息缺失',
        ),
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

/**
 * 构造 basic 面板的 kv 行列表。
 *
 * 只渲染"有值"的字段：避免 Android 报告把"Module: ' · '"、"Device Types: '—'"、
 * "Abilities: 0"这种 HarmonyOS 专有字段挂在 overview 上显得空洞。HarmonyOS 报告
 * 字段都填齐，行为不变。
 *
 * 平台差异：
 *   - HarmonyOS basic 必填 moduleName / moduleType / deviceTypes / abilities，
 *     全部展示。
 *   - Android basic 由 manifest analyzer 派生，moduleName/moduleType=''、
 *     deviceTypes/abilities=[]，这些行会被自动隐藏。Android 专属的 packageName
 *     / version 已经覆盖在 bundleName/version 行里。
 */
function buildBasicRows(report: PackageReport): Array<[string, string | Node]> {
  const basic = report.basic!;
  const rows: Array<[string, string | Node]> = [];
  rows.push(['Bundle Name', h('code', null, basic.bundleName || '—')]);
  if (basic.bundleType) rows.push(['Bundle Type', basic.bundleType]);
  rows.push([
    'Version',
    `${basic.versionName || '—'} (code: ${basic.versionCode ?? '—'})`,
  ]);
  if (basic.moduleName || basic.moduleType) {
    rows.push(['Module', `${basic.moduleName || '—'} · ${basic.moduleType || '—'}`]);
  }
  if (basic.deviceTypes && basic.deviceTypes.length > 0) {
    rows.push(['Device Types', basic.deviceTypes.join(', ')]);
  }
  if (basic.minAPIVersion !== undefined || basic.targetAPIVersion !== undefined) {
    rows.push([
      'API Range',
      `${basic.minAPIVersion ?? '—'} → ${basic.targetAPIVersion ?? '—'}`,
    ]);
  }
  if (basic.abilities && basic.abilities.length > 0) {
    rows.push(['Abilities', String(basic.abilities.length)]);
  }
  return rows;
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

function countSensitive(report: PackageReport): number {
  return report.permissions?.filter((p) => p.sensitive).length ?? 0;
}

function warningSummary(report: PackageReport): string {
  const errors = report.warnings.filter((w) => w.level === 'error').length;
  const warns = report.warnings.filter((w) => w.level === 'warn').length;
  if (errors === 0 && warns === 0) return 'no warning';
  return `${errors} error · ${warns} warn`;
}

function packageLabel(report: PackageReport): string {
  switch (report.platform) {
    case 'android':
      return 'apk 文件本身';
    case 'ios':
      return 'ipa 文件本身';
    case 'harmony':
    default:
      return 'hap 文件本身';
  }
}
