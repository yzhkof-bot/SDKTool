import type {
  HapNativeLibMitigations,
  HapNativeLibRodataStrings,
  HapNativeLibSection,
  HapNativeLibSymbols,
  HapReport,
} from '../../shared/schema.js';

import { badge, emptyState, formatBytes, h, kv, paginatedTable, table } from '../helpers.js';

const SYMBOLS_PAGE_SIZE = 50;
const SECTIONS_PAGE_SIZE = 50;
const STRING_PAGE_SIZE = 50;

export function renderNativeLibs(report: HapReport): HTMLElement {
  const n = report.nativeLibs;
  if (!n || n.libs.length === 0) return emptyState('无 Native 库');

  return h(
    'div',
    null,
    h(
      'section',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, '架构与汇总'),
      h(
        'div',
        { class: 'card-grid' },
        statCard('架构数', String(n.architectures.length), n.architectures.join(' / ')),
        statCard('so/lib 数量', String(n.libs.length)),
        statCard('总体积', formatBytes(n.totalBytes)),
      ),
    ),
    h(
      'section',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, '库列表'),
      table(
        ['Arch', 'Name', '体积'],
        n.libs.map((lib) => [
          h('span', { class: 'badge primary' }, lib.arch),
          h('code', null, lib.name),
          formatBytes(lib.bytes),
        ]),
        [undefined, 'path', 'num'],
      ),
    ),
    renderNativeSymbols(report),
  ) as HTMLElement;
}

function renderNativeSymbols(report: HapReport): HTMLElement | null {
  const sym = report.nativeLibSymbols;
  if (!sym || sym.perLib.length === 0) return null;

  const summaryRows = sym.perLib.map((lib) => [
    h('span', { class: 'badge primary' }, lib.arch),
    h('code', null, lib.name),
    lib.elfClass,
    lib.totalSymbols.toLocaleString(),
    lib.definedCount.toLocaleString(),
    lib.importedCount.toLocaleString(),
    lib.mitigations ? renderMitigationsBadges(lib.mitigations) : '—',
    lib.error ? badge(lib.error, 'danger') : badge('ok', 'success'),
  ]);

  const detailPanels = sym.perLib.map((l) => renderOneLibDeep(l));

  const symbolsLimitLabel = sym.maxSymbolsPerLib > 0
    ? `符号 Top ${sym.maxSymbolsPerLib}`
    : '符号全量';
  const rodataLimitLabel = sym.rodataStringLimit > 0
    ? `.rodata 字符串 / 分类 Top ${sym.rodataStringLimit}`
    : '.rodata 字符串 全量';

  return h(
    'section',
    { class: 'panel' },
    h(
      'h3',
      { class: 'panel-title' },
      `可选深度分析 · ELF 多维度（${symbolsLimitLabel}；${rodataLimitLabel}）`,
    ),
    table(
      ['Arch', 'Name', 'ELF', '总符号', '定义', '导入', 'Mitigations', '状态'],
      summaryRows,
      [undefined, 'path', undefined, 'num', 'num', 'num', undefined, undefined],
    ),
    ...detailPanels,
  ) as HTMLElement;
}

function renderMitigationsBadges(m: HapNativeLibMitigations): HTMLElement {
  return h(
    'span',
    null,
    badge(m.nx ? 'NX' : 'no-NX', m.nx ? 'success' : 'danger'),
    ' ',
    badge(
      `RELRO:${m.relro}`,
      m.relro === 'full' ? 'success' : m.relro === 'partial' ? 'warning' : 'danger',
    ),
    ' ',
    badge(m.pie ? 'PIE' : 'no-PIE', m.pie ? 'success' : 'danger'),
    ' ',
    badge(m.stackCanary ? 'Canary' : 'no-Canary', m.stackCanary ? 'success' : 'warning'),
    ' ',
    badge(m.fortify ? 'Fortify' : 'no-Fortify', m.fortify ? 'success' : 'warning'),
  ) as HTMLElement;
}

function renderOneLibDeep(lib: HapNativeLibSymbols): HTMLElement {
  const summaryParts: string[] = [];
  if (lib.sections) summaryParts.push(`sections=${lib.sections.length}`);
  if (lib.needed) summaryParts.push(`needed=${lib.needed.length}`);
  if (lib.glibcVersions) summaryParts.push(`glibc=${lib.glibcVersions.length}`);
  if (lib.symbols.length > 0) summaryParts.push(`symbols=${lib.totalSymbols.toLocaleString()}`);

  return h(
    'details',
    { class: 'panel sub-panel' },
    h(
      'summary',
      null,
      h('strong', null, `${lib.arch}/${lib.name}`),
      ' · ',
      summaryParts.join(' · ') || '无可用细节',
    ),
    renderBuildInfoPanel(lib),
    renderMitigationsPanel(lib.mitigations),
    renderNeededPanel(lib.needed),
    renderGlibcPanel(lib.glibcVersions),
    renderSectionsPanel(lib.sections),
    renderRodataPanel(lib.rodataStrings),
    renderSymbolsPanel(lib),
  ) as HTMLElement;
}

function renderBuildInfoPanel(lib: HapNativeLibSymbols): HTMLElement | null {
  if (!lib.buildId && !lib.comment) return null;
  const rows: Array<[string, HTMLElement | string]> = [];
  if (lib.buildId) rows.push(['Build-id', h('code', null, lib.buildId) as HTMLElement]);
  if (lib.comment) rows.push(['Compiler', h('code', null, lib.comment) as HTMLElement]);
  return h(
    'div',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, '构建信息'),
    kv(rows),
  ) as HTMLElement;
}

function renderMitigationsPanel(m: HapNativeLibMitigations | undefined): HTMLElement | null {
  if (!m) return null;
  return h(
    'div',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, '安全编译选项'),
    kv([
      ['NX (不可执行栈)', m.nx ? badge('启用', 'success') : badge('未启用', 'danger')],
      [
        'RELRO',
        m.relro === 'full'
          ? badge('full', 'success')
          : m.relro === 'partial'
            ? badge('partial', 'warning')
            : badge('none', 'danger'),
      ],
      ['PIE', m.pie ? badge('启用', 'success') : badge('未启用', 'danger')],
      ['Stack Canary', m.stackCanary ? badge('启用', 'success') : badge('未启用', 'warning')],
      ['FORTIFY_SOURCE', m.fortify ? badge('启用', 'success') : badge('未启用', 'warning')],
    ]),
  ) as HTMLElement;
}

function renderNeededPanel(needed: string[] | undefined): HTMLElement | null {
  if (!needed || needed.length === 0) return null;
  return h(
    'div',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, `动态依赖（DT_NEEDED，${needed.length}）`),
    h(
      'div',
      { class: 'string-list' },
      ...needed.map((n) => h('code', { class: 'string-item' }, n)),
    ),
  ) as HTMLElement;
}

function renderGlibcPanel(versions: string[] | undefined): HTMLElement | null {
  if (!versions || versions.length === 0) return null;
  return h(
    'div',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, `符号版本需求（.gnu.version_r，${versions.length}）`),
    h(
      'div',
      { class: 'string-list' },
      ...versions.map((v) => h('code', { class: 'string-item' }, v)),
    ),
  ) as HTMLElement;
}

function renderSectionsPanel(
  sections: HapNativeLibSection[] | undefined,
): HTMLElement | null {
  if (!sections || sections.length === 0) return null;
  const bySize = [...sections].sort((a, b) => b.size - a.size);
  const rows = bySize.map((s) => [
    h('code', null, s.name),
    s.type,
    s.flags || '—',
    formatBytes(s.size),
    `0x${s.offset.toString(16)}`,
  ]);
  return h(
    'div',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, `节区分布（${sections.length}，按 size 降序）`),
    paginatedTable(
      ['Section', 'Type', 'Flags', 'Size', 'Offset'],
      rows,
      ['path', undefined, undefined, 'num', 'num'],
      { pageSize: SECTIONS_PAGE_SIZE },
    ),
  ) as HTMLElement;
}

function renderRodataPanel(
  rod: HapNativeLibRodataStrings | undefined,
): HTMLElement | null {
  if (!rod) return null;
  const totalShown = rod.urls.length + rod.paths.length + rod.sqlLike.length + rod.other.length;
  if (totalShown === 0) return null;
  return h(
    'div',
    { class: 'panel' },
    h(
      'h3',
      { class: 'panel-title' },
      `.rodata 字符串池（${rod.totalDistinct.toLocaleString()} 个唯一${rod.truncated ? '，已截断' : ''}）`,
    ),
    renderRodataGroup('URL', rod.urls),
    renderRodataGroup('路径', rod.paths),
    renderRodataGroup('SQL 语句', rod.sqlLike),
    renderRodataGroup('其它', rod.other),
  ) as HTMLElement;
}

function renderRodataGroup(label: string, items: string[]): HTMLElement | null {
  if (items.length === 0) return null;
  const rows = items.map((s) => [h('code', { class: 'string-item' }, s)]);
  return h(
    'details',
    { class: 'panel sub-panel' },
    h(
      'summary',
      null,
      h('strong', null, label),
      ' · ',
      `${items.length} 条`,
    ),
    paginatedTable(['字符串'], rows, ['path'], { pageSize: STRING_PAGE_SIZE }),
  ) as HTMLElement;
}

function renderSymbolsPanel(lib: HapNativeLibSymbols): HTMLElement | null {
  if (lib.symbols.length === 0) return null;
  const rows = lib.symbols.map((s) => [
    h('code', null, s.name),
    s.type,
    s.bind,
    s.imported ? badge('UND', 'warning') : badge('def', 'success'),
    formatBytes(s.size),
  ]);
  const labelTotal = lib.totalSymbols.toLocaleString();
  const labelKept = lib.symbols.length.toLocaleString();
  const truncatedNote =
    lib.symbols.length < lib.totalSymbols ? `保留 ${labelKept} / 总 ${labelTotal}` : `共 ${labelTotal}`;
  return h(
    'div',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, `符号表（${truncatedNote}，按 size 降序）`),
    paginatedTable(
      ['符号', 'Type', 'Bind', '可见性', 'Size'],
      rows,
      ['path', undefined, undefined, undefined, 'num'],
      { pageSize: SYMBOLS_PAGE_SIZE },
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
