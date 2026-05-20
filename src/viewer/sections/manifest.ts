import type { PackageReport } from '../../shared/schema.js';

import { emptyState, h, kv, table } from '../helpers.js';

/**
 * Android 专属 section：AndroidManifest.xml 解析结果。
 *
 * 一期渲染：
 *  - 顶部 kv 面板：package / version / SDK / label / icon / debuggable
 *  - uses-permissions 列表
 *  - 四大组件列表（按类型分页面板）
 *  - AXML 解析阶段产生的非致命 warning（仅当存在时显示）
 *
 * 二期会扩：解析 manifest 内 <queries>、<permission>（自定义权限）、application 内 meta-data 等。
 */
export function renderManifest(report: PackageReport): HTMLElement {
  const m = report.androidManifest;
  if (!m) return emptyState('未解析到 AndroidManifest.xml（可能 platform 不是 android，或 manifest 缺失/损坏）');

  const basicPanel = h(
    'section',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, '清单基础信息'),
    kv(buildBasicRows(m)),
  );

  const permsPanel = renderPermissionsPanel(m.usesPermissions ?? []);
  const compsPanel = renderComponentsPanel(m.components);
  const warnPanel = renderWarningsPanel(m.warnings ?? []);

  return h('div', null, basicPanel, permsPanel, compsPanel, warnPanel) as HTMLElement;
}

function buildBasicRows(
  m: NonNullable<PackageReport['androidManifest']>,
): Array<[string, string | Node]> {
  const rows: Array<[string, string | Node]> = [];
  rows.push(['Package', m.packageName ? h('code', null, m.packageName) : '—']);
  rows.push([
    'Version',
    `${m.versionName ?? '—'} (code: ${m.versionCode ?? '—'})`,
  ]);
  if (m.usesSdk) {
    const sdk = m.usesSdk;
    rows.push([
      'SDK',
      `min ${sdk.minSdkVersion ?? '—'} · target ${sdk.targetSdkVersion ?? '—'} · max ${sdk.maxSdkVersion ?? '—'}`,
    ]);
  }
  if (m.applicationLabel) rows.push(['Application Label', m.applicationLabel]);
  if (m.applicationIcon) rows.push(['Application Icon', h('code', null, m.applicationIcon)]);
  if (m.debuggable !== undefined) {
    rows.push([
      'Debuggable',
      m.debuggable
        ? h('span', { class: 'badge danger' }, 'true (debug)')
        : h('span', { class: 'badge' }, 'false'),
    ]);
  }
  return rows;
}

function renderPermissionsPanel(perms: string[]): HTMLElement {
  return h(
    'section',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, `<uses-permission> · ${perms.length} 条`),
    perms.length === 0
      ? emptyState('未声明任何权限')
      : table(
          ['Permission'],
          perms.map((p) => [h('code', null, p)]),
          ['path'],
        ),
  ) as HTMLElement;
}

function renderComponentsPanel(
  components: NonNullable<PackageReport['androidManifest']>['components'],
): HTMLElement {
  const total = components
    ? components.activities.length +
      components.services.length +
      components.receivers.length +
      components.providers.length
    : 0;
  if (!components || total === 0) {
    return h(
      'section',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, '四大组件'),
      emptyState('manifest 内未声明 activity / service / receiver / provider'),
    ) as HTMLElement;
  }

  const groups: Array<[string, string[]]> = [
    [`Activities · ${components.activities.length}`, components.activities],
    [`Services · ${components.services.length}`, components.services],
    [`Receivers · ${components.receivers.length}`, components.receivers],
    [`Providers · ${components.providers.length}`, components.providers],
  ];

  return h(
    'section',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, `四大组件 · 共 ${total} 个`),
    ...groups.flatMap(([title, list]) =>
      list.length === 0
        ? []
        : [
            h('h4', { class: 'subpanel-title' }, title),
            table(['Class'], list.map((c) => [h('code', null, c)]), ['path']),
          ],
    ),
  ) as HTMLElement;
}

function renderWarningsPanel(warnings: string[]): HTMLElement | null {
  if (warnings.length === 0) return null;
  return h(
    'section',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, `解析警告 · ${warnings.length} 条`),
    table(['Warning'], warnings.map((w) => [w])),
  ) as HTMLElement;
}
