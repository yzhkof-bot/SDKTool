import type {
  Il2cppLiterals,
  Il2cppMetadata,
  Il2cppNames,
  PackageReport,
} from '@kingsdk/shared/schema.js';

import {
  badge,
  emptyState,
  formatBytes,
  h,
  kv,
  paginated,
  paginatedTable,
  shortHash,
} from '../helpers.js';

const NAMES_PAGE_SIZE = 100;
const LITERALS_PAGE_SIZE = 100;

export function renderIl2cpp(report: PackageReport): HTMLElement {
  const info = report.il2cppMetadata;
  if (!info || info.files.length === 0) {
    return emptyState('未启用 IL2CPP 元数据深度分析（仅 Unity 游戏 hap 有意义；可在生成报告时勾选 "IL2CPP 元数据"）');
  }

  return h(
    'div',
    null,
    h(
      'section',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, 'IL2CPP global-metadata.dat 列表'),
      paginatedTable(
        ['路径', '体积', 'Magic', 'Metadata 版本', 'Unity 版本范围', 'SHA-256', '错误'],
        info.files.map((f) => [
          h('code', null, f.path),
          formatBytes(f.bytes),
          renderMagicBadge(f.magic),
          f.metadataVersion !== null
            ? h('code', null, `v${f.metadataVersion}`)
            : '—',
          f.unityVersionRange ?? '—',
          f.sha256 ? h('code', { title: f.sha256 }, shortHash(f.sha256)) : '—',
          f.error ? badge(f.error, 'danger') : '',
        ]),
        ['path', 'num', undefined, undefined, undefined, undefined, undefined],
        { pageSize: 50 },
      ),
    ),
    ...info.files.map((f) => renderOneFile(f)),
  ) as HTMLElement;
}

function renderMagicBadge(magic: Il2cppMetadata['magic']): HTMLElement {
  if (magic === 'IL2CPP') return badge('IL2CPP', 'success');
  if (magic === 'ENCRYPTED') return badge('已加密 / 非标准 sanity', 'warning');
  return badge('解析失败', 'danger');
}

function renderOneFile(f: Il2cppMetadata): HTMLElement {
  const head = h(
    'h3',
    { class: 'panel-title' },
    h('code', null, f.path),
    ' · ',
    formatBytes(f.bytes),
  );

  const summaryRows: Array<[string, HTMLElement | string]> = [
    ['Magic', renderMagicBadge(f.magic)],
    ['Sanity (LE)', h('code', null, `0x${f.sanityHex || '????????'}`) as HTMLElement],
    [
      'Metadata 版本',
      f.metadataVersion !== null
        ? (h('code', null, `v${f.metadataVersion}`) as HTMLElement)
        : '—',
    ],
    ['Unity 版本范围（推测）', f.unityVersionRange ?? '—'],
    ['SHA-256', f.sha256 ? (h('code', { title: f.sha256 }, shortHash(f.sha256)) as HTMLElement) : '—'],
  ];
  if (f.error) summaryRows.push(['错误', badge(f.error, 'danger') as HTMLElement]);

  return h(
    'section',
    { class: 'panel' },
    head,
    kv(summaryRows),
    f.names ? renderNamesPanel(f.names) : null,
    f.literals ? renderLiteralsPanel(f.literals) : null,
  ) as HTMLElement;
}

function renderNamesPanel(names: Il2cppNames): HTMLElement {
  return h(
    'div',
    { class: 'panel' },
    h(
      'h3',
      { class: 'panel-title' },
      `名字字符串池（${names.totalDistinct.toLocaleString()} 个去重 · 池 ${formatBytes(names.poolBytes)}）`,
    ),
    h(
      'p',
      { class: 'panel-hint' },
      '这是 type / method / field / parameter / namespace / assembly 名字的并集（IL2CPP metadata 在池里不区分）。按命名约定启发式分桶。',
    ),
    renderStringGroup(`类型名（Namespace.Class，${names.typeNames.length}）`, names.typeNames),
    renderStringGroup(`命名空间（${names.namespaces.length}）`, names.namespaces),
    renderStringGroup(`Assembly 名（${names.assemblies.length}）`, names.assemblies),
    renderStringGroup(`标识符（方法/字段名等，${names.identifiers.length}）`, names.identifiers),
    renderStringGroup(`其它（含编译器生成符号，${names.other.length}）`, names.other),
  ) as HTMLElement;
}

function renderLiteralsPanel(lit: Il2cppLiterals): HTMLElement {
  return h(
    'div',
    { class: 'panel' },
    h(
      'h3',
      { class: 'panel-title' },
      `字符串字面量池（${lit.totalDistinct.toLocaleString()} 个去重 / 共 ${lit.totalCount.toLocaleString()} 条 · ${formatBytes(lit.poolBytes)}）`,
    ),
    h(
      'p',
      { class: 'panel-hint' },
      'C# 代码里所有 "..." 字面量。常见包含：API URL、SQL、错误消息、配置常量、内嵌 token。',
    ),
    renderStringGroup(`URL（${lit.urls.length}）`, lit.urls, LITERALS_PAGE_SIZE),
    renderStringGroup(`路径（${lit.paths.length}）`, lit.paths, LITERALS_PAGE_SIZE),
    renderStringGroup(`SQL 语句（${lit.sqlLike.length}）`, lit.sqlLike, LITERALS_PAGE_SIZE),
    renderStringGroup(`其它（${lit.other.length}）`, lit.other, LITERALS_PAGE_SIZE),
  ) as HTMLElement;
}

function renderStringGroup(
  label: string,
  list: string[],
  pageSize = NAMES_PAGE_SIZE,
): HTMLElement | null {
  if (list.length === 0) return null;
  return h(
    'details',
    { class: 'panel sub-panel' },
    h('summary', null, h('strong', null, label)),
    paginated(
      list,
      (pageItems) =>
        h(
          'div',
          { class: 'string-list' },
          ...pageItems.map((s) => h('code', { class: 'string-item' }, s)),
        ) as HTMLElement,
      { pageSize },
    ),
  ) as HTMLElement;
}
