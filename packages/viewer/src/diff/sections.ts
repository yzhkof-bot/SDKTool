/**
 * Diff viewer 的所有 section 渲染函数。
 *
 * 集中在一个文件以保持 IIFE bundle 紧凑，每个 export 都是 `(d: PackageDiffReport) => HTMLElement`。
 * 渲染原则：
 *  - 任意维度可能为 undefined（双方都没该数据时 differ 不输出），统一用 emptyState 占位
 *  - 表格优先使用 ../helpers.ts 中的 table()，传 columnClasses 让 num / path 列对齐
 */

import type {
  DiffApkSignatureVersions,
  DiffApkSigningBlock,
  DiffDex,
  DiffDexDetailEntry,
  DiffDexMethods,
  DiffDexStrings,
  HarmonyDiffAbcDetailEntry,
  HarmonyDiffAbcStringSet,
  HarmonyDiffAbcStrings,
  PackageDiffBasicChange,
  DiffIl2cppLiterals,
  DiffIl2cppMetadataEntry,
  DiffIl2cppNames,
  DiffNativeLibBuildInfo,
  DiffNativeLibMitigations,
  DiffNativeLibRodataStrings,
  DiffNativeLibSections,
  DiffNativeLibSymbolsItem,
  PackageDiffReport,
  DiffStringSet,
  DiffSymbolChanged,
  NativeSymbol,
} from '@kingsdk/shared/schema.js';

import type { Child } from '../helpers.js';
import {
  badge,
  emptyState,
  formatBytes,
  formatDate,
  h,
  kv,
  paginated,
  paginatedTable,
  shortHash,
  table,
} from '../helpers.js';

import {
  deltaBytes,
  deltaCount,
  deltaRatio,
  deltaText,
  deltaWithRatio,
  fromTo,
} from './helpers.js';

/* -------------------------------------------------------------------------- */
/* overview                                                                   */
/* -------------------------------------------------------------------------- */

export function renderOverview(d: PackageDiffReport): HTMLElement {
  const summary = d.summary;
  const cards = h(
    'div',
    { class: 'diff-summary' },
    summaryCard('总体积变化', summary.totalSizeDelta, formatBytes),
    summaryCard('压缩包变化', summary.compressedDelta, formatBytes),
    summaryCard('文件数变化', summary.fileCountDelta, (v) => v.toLocaleString()),
    summaryCard('文件新增', summary.filesAdded, (v) => v.toLocaleString(), 'count-only-pos'),
    summaryCard('文件删除', summary.filesRemoved, (v) => v.toLocaleString(), 'count-only-neg'),
    summaryCard('文件修改', summary.filesChanged, (v) => v.toLocaleString(), 'count-only'),
    summaryCard('权限新增', summary.permissionsAdded, (v) => v.toLocaleString(), 'count-only-pos'),
    summaryCard('权限删除', summary.permissionsRemoved, (v) => v.toLocaleString(), 'count-only-neg'),
  );

  const pair = h(
    'div',
    { class: 'diff-pair' },
    sideCard('Baseline (left)', d.left),
    sideCard('Candidate (right)', d.right),
  );

  const banner = summary.identical
    ? h(
        'div',
        { class: 'panel' },
        h('span', { class: 'badge success' }, '✓ identical'),
        ' ',
        h('span', { class: 'card-sub' }, '两侧 hap 在所有受监控维度均无差异'),
      )
    : null;

  return h(
    'div',
    null,
    h('h2', { class: 'section-title' }, '概览'),
    summary.versionLine
      ? h(
          'div',
          { class: 'panel' },
          h('span', { class: 'card-label' }, '版本'),
          h('div', { class: 'card-value' }, summary.versionLine),
        )
      : null,
    cards,
    banner,
    pair,
    h(
      'div',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, '元信息'),
      kv([
        ['对比时间', formatDate(d.generatedAt)],
        ['Tool 版本', d.toolVersion],
        ['Schema', d.schemaVersion],
      ]),
    ),
  ) as HTMLElement;
}

function summaryCard(
  label: string,
  value: number,
  fmt: (v: number) => string,
  variant?: 'count-only' | 'count-only-pos' | 'count-only-neg',
): HTMLElement {
  let valueNode: HTMLElement;
  if (variant === 'count-only-pos') {
    valueNode = (value === 0
      ? h('span', { class: 'delta-zero' }, '0')
      : h('span', { class: 'delta-pos' }, `+${fmt(value)}`)) as HTMLElement;
  } else if (variant === 'count-only-neg') {
    valueNode = (value === 0
      ? h('span', { class: 'delta-zero' }, '0')
      : h('span', { class: 'delta-neg' }, `−${fmt(value)}`)) as HTMLElement;
  } else if (variant === 'count-only') {
    valueNode = h('span', { class: 'delta-zero' }, fmt(value)) as HTMLElement;
  } else {
    valueNode = deltaText(value, { format: fmt });
  }
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-label' }, label),
    h('div', { class: 'card-value' }, valueNode),
  ) as HTMLElement;
}

function sideCard(label: string, side: PackageDiffReport['left']): HTMLElement {
  const file = side.meta.file;
  const fileName = file.split(/[\\/]/).pop() || file;
  const versionStr = side.basic
    ? `${side.basic.versionName} (${side.basic.versionCode})`
    : '—';
  return h(
    'div',
    { class: 'side' },
    h('div', { class: 'side-label' }, label),
    h('div', { class: 'side-title' }, fileName),
    h(
      'div',
      { class: 'side-meta' },
      `${formatBytes(side.meta.fileSize)} · sha256 ${shortHash(side.meta.sha256)} · ${versionStr}`,
    ),
  ) as HTMLElement;
}

/* -------------------------------------------------------------------------- */
/* basic                                                                       */
/* -------------------------------------------------------------------------- */

export function renderBasic(d: PackageDiffReport): HTMLElement {
  if (!d.basic) return shell('Basic Info', emptyState('两侧均无 basic 信息'));
  if (d.basic.changed.length === 0) {
    return shell('Basic Info', emptyState('basic 字段未发生变化'));
  }
  const rows = d.basic.changed.map((c: PackageDiffBasicChange) => [c.field, fromTo(c.from, c.to)]);
  return shell(
    'Basic Info',
    h(
      'div',
      { class: 'panel' },
      table(['字段', '变化'], rows, ['path', undefined]),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* size                                                                        */
/* -------------------------------------------------------------------------- */

export function renderSize(d: PackageDiffReport): HTMLElement {
  if (!d.size) return shell('体积', emptyState('两侧均无 size 信息'));
  const s = d.size;

  const summary = h(
    'div',
    { class: 'card-grid' },
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-label' }, '总体积'),
      h('div', { class: 'card-value' }, deltaWithRatio(s.total, formatBytes)),
    ),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-label' }, '压缩包大小'),
      h('div', { class: 'card-value' }, deltaWithRatio(s.compressed, formatBytes)),
    ),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-label' }, '文件数'),
      h(
        'div',
        { class: 'card-value' },
        deltaWithRatio(s.fileCount, (v) => v.toLocaleString()),
      ),
    ),
  );

  const breakdownRows = s.breakdown.map((b) => [
    h('strong', null, b.category),
    formatBytes(b.fromBytes),
    formatBytes(b.toBytes),
    deltaBytes(b.delta),
    deltaRatio(b.ratio),
  ]);

  return shell(
    '体积',
    summary,
    h(
      'div',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, '分类对比'),
      table(
        ['分类', 'Baseline', 'Candidate', 'Delta', 'Ratio'],
        breakdownRows,
        [undefined, 'num', 'num', 'num', 'num'],
      ),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* files                                                                       */
/* -------------------------------------------------------------------------- */

const FILE_TOP_LIMIT = 100;

export function renderFiles(d: PackageDiffReport): HTMLElement {
  if (!d.files) return shell('Files', emptyState('一侧报告未包含 files 列表，逐文件对比已跳过'));
  const f = d.files;
  const summary = h(
    'div',
    { class: 'card-grid' },
    countCard('新增文件', f.totals.added, 'pos'),
    countCard('删除文件', f.totals.removed, 'neg'),
    countCard('修改文件', f.totals.changed, 'warn'),
    countCard('未变化', f.totals.unchanged, 'mute'),
  );

  const addedRows = f.added.slice(0, FILE_TOP_LIMIT).map((x) => [
    x.path,
    h('span', { class: 'badge' }, x.category),
    formatBytes(x.bytes),
  ]);
  const removedRows = f.removed.slice(0, FILE_TOP_LIMIT).map((x) => [
    x.path,
    h('span', { class: 'badge' }, x.category),
    formatBytes(x.bytes),
  ]);
  const changedRows = f.changed.slice(0, FILE_TOP_LIMIT).map((x) => [
    x.path,
    h('span', { class: 'badge' }, x.category),
    formatBytes(x.fromBytes),
    formatBytes(x.toBytes),
    deltaBytes(x.delta),
  ]);

  return shell(
    'Files',
    summary,
    f.added.length === 0
      ? null
      : h(
          'div',
          { class: 'panel' },
          h(
            'h3',
            { class: 'panel-title' },
            `新增 (${f.totals.added})${truncatedSuffix(f.added.length, FILE_TOP_LIMIT)}`,
          ),
          table(
            ['路径', '分类', '体积'],
            addedRows,
            ['path', undefined, 'num'],
          ),
        ),
    f.removed.length === 0
      ? null
      : h(
          'div',
          { class: 'panel' },
          h(
            'h3',
            { class: 'panel-title' },
            `删除 (${f.totals.removed})${truncatedSuffix(f.removed.length, FILE_TOP_LIMIT)}`,
          ),
          table(
            ['路径', '分类', '体积'],
            removedRows,
            ['path', undefined, 'num'],
          ),
        ),
    f.changed.length === 0
      ? null
      : h(
          'div',
          { class: 'panel' },
          h(
            'h3',
            { class: 'panel-title' },
            `修改 (${f.totals.changed})${truncatedSuffix(f.changed.length, FILE_TOP_LIMIT)}`,
          ),
          table(
            ['路径', '分类', 'Baseline', 'Candidate', 'Delta'],
            changedRows,
            ['path', undefined, 'num', 'num', 'num'],
          ),
        ),
  );
}

/* -------------------------------------------------------------------------- */
/* permissions                                                                 */
/* -------------------------------------------------------------------------- */

export function renderPermissions(d: PackageDiffReport): HTMLElement {
  if (!d.permissions) return shell('权限', emptyState('两侧均无权限信息'));
  const p = d.permissions;
  const sensitiveAdded = p.added.filter((x) => x.sensitive).length;
  const sensitiveRemoved = p.removed.filter((x) => x.sensitive).length;

  const summary = h(
    'div',
    { class: 'card-grid' },
    countCard('新增权限', p.added.length, 'pos'),
    countCard('删除权限', p.removed.length, 'neg'),
    countCard('其中敏感(新增)', sensitiveAdded, sensitiveAdded > 0 ? 'warn' : 'mute'),
    countCard('其中敏感(删除)', sensitiveRemoved, 'mute'),
    countCard('未变化', p.unchanged, 'mute'),
  );

  const addedRows = p.added.map((perm) => [
    perm.name,
    perm.sensitive ? badge('sensitive', 'danger') : badge('普通', 'info'),
    perm.reason || '—',
  ]);
  const removedRows = p.removed.map((perm) => [
    perm.name,
    perm.sensitive ? badge('sensitive', 'danger') : badge('普通', 'info'),
    perm.reason || '—',
  ]);

  return shell(
    '权限',
    summary,
    addedRows.length === 0
      ? null
      : h(
          'div',
          { class: 'panel' },
          h('h3', { class: 'panel-title' }, `新增权限 (${p.added.length})`),
          table(['Permission', '类型', '理由'], addedRows, ['path', undefined, undefined]),
        ),
    removedRows.length === 0
      ? null
      : h(
          'div',
          { class: 'panel' },
          h('h3', { class: 'panel-title' }, `删除权限 (${p.removed.length})`),
          table(['Permission', '类型', '理由'], removedRows, ['path', undefined, undefined]),
        ),
    p.added.length === 0 && p.removed.length === 0 ? emptyState('权限集合无变化') : null,
  );
}

/* -------------------------------------------------------------------------- */
/* resources                                                                   */
/* -------------------------------------------------------------------------- */

export function renderResources(d: PackageDiffReport): HTMLElement {
  if (!d.resources) return shell('资源', emptyState('两侧均无 resources 信息'));
  const r = d.resources;

  const summary = h(
    'div',
    { class: 'panel' },
    table(
      ['维度', 'Baseline', 'Candidate', 'Delta', 'Ratio'],
      [
        ['图片张数', r.images.count.from, r.images.count.to, deltaCount(r.images.count.delta), deltaRatio(r.images.count.ratio)],
        ['图片体积', formatBytes(r.images.bytes.from), formatBytes(r.images.bytes.to), deltaBytes(r.images.bytes.delta), deltaRatio(r.images.bytes.ratio)],
        ['媒体张数', r.media.count.from, r.media.count.to, deltaCount(r.media.count.delta), deltaRatio(r.media.count.ratio)],
        ['媒体体积', formatBytes(r.media.bytes.from), formatBytes(r.media.bytes.to), deltaBytes(r.media.bytes.delta), deltaRatio(r.media.bytes.ratio)],
        ['字符串数', r.strings.count.from, r.strings.count.to, deltaCount(r.strings.count.delta), deltaRatio(r.strings.count.ratio)],
      ],
      [undefined, 'num', 'num', 'num', 'num'],
    ),
  );

  const localesPanel =
    r.strings.localesAdded.length === 0 && r.strings.localesRemoved.length === 0
      ? null
      : h(
          'div',
          { class: 'panel' },
          h('h3', { class: 'panel-title' }, 'Locale 变化'),
          h(
            'div',
            null,
            r.strings.localesAdded.length > 0
              ? h(
                  'div',
                  null,
                  h('span', { class: 'card-label' }, '新增'),
                  ' ',
                  ...r.strings.localesAdded.map((l) => h('span', { class: 'badge success' }, l)),
                )
              : null,
            r.strings.localesRemoved.length > 0
              ? h(
                  'div',
                  null,
                  h('span', { class: 'card-label' }, '删除'),
                  ' ',
                  ...r.strings.localesRemoved.map((l) => h('span', { class: 'badge danger' }, l)),
                )
              : null,
          ),
        );

  return shell('资源', summary, localesPanel);
}

/* -------------------------------------------------------------------------- */
/* rawfile                                                                     */
/* -------------------------------------------------------------------------- */

export function renderRawfile(d: PackageDiffReport): HTMLElement {
  if (!d.rawfile) return shell('Rawfile', emptyState('两侧均无 rawfile 信息'));
  const r = d.rawfile;

  const summary = h(
    'div',
    { class: 'card-grid' },
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-label' }, 'Rawfile 总体积'),
      h('div', { class: 'card-value' }, deltaWithRatio(r.totalBytes, formatBytes)),
    ),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-label' }, 'Rawfile 文件数'),
      h(
        'div',
        { class: 'card-value' },
        deltaWithRatio(r.fileCount, (v) => v.toLocaleString()),
      ),
    ),
  );

  const groupRows = r.topLevelGroups.map((g) => [
    h('code', null, g.path),
    formatBytes(g.fromBytes),
    formatBytes(g.toBytes),
    deltaBytes(g.delta),
    `${g.fromCount} → ${g.toCount}`,
  ]);

  const catRows = r.categories.map((c) => [
    h('strong', null, c.category),
    formatBytes(c.fromBytes),
    formatBytes(c.toBytes),
    deltaBytes(c.delta),
    `${c.fromCount} → ${c.toCount}`,
  ]);

  const packagesPanel = !r.packages || r.packages.length === 0
    ? null
    : h(
        'div',
        { class: 'panel' },
        h(
          'h3',
          { class: 'panel-title' },
          `配置包 Package 对比（${r.packages.length}）`,
        ),
        table(
          ['Package ID', 'Baseline', 'Candidate', 'Delta', '文件数 (B → C)'],
          r.packages.slice(0, 50).map((p) => [
            h('code', null, p.packageId),
            formatBytes(p.fromBytes),
            formatBytes(p.toBytes),
            deltaBytes(p.delta),
            `${p.fromCount} → ${p.toCount}`,
          ]),
          [undefined, 'num', 'num', 'num', 'num'],
        ),
      );

  return shell(
    'Rawfile',
    summary,
    h(
      'div',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, '顶层分组对比（按 |Δ| 降序）'),
      groupRows.length === 0
        ? emptyState('无 group 变化')
        : table(
            ['顶层路径', 'Baseline', 'Candidate', 'Delta', '文件数 (B → C)'],
            groupRows,
            ['path', 'num', 'num', 'num', 'num'],
          ),
    ),
    h(
      'div',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, '类别对比（按 |Δ| 降序）'),
      catRows.length === 0
        ? emptyState('无 category 变化')
        : table(
            ['类别', 'Baseline', 'Candidate', 'Delta', '文件数 (B → C)'],
            catRows,
            [undefined, 'num', 'num', 'num', 'num'],
          ),
    ),
    packagesPanel,
  );
}

/* -------------------------------------------------------------------------- */
/* nativeLibs                                                                  */
/* -------------------------------------------------------------------------- */

export function renderNativeLibs(d: PackageDiffReport): HTMLElement {
  if (!d.nativeLibs) return shell('Native', emptyState('两侧均无 nativeLibs 信息'));
  const n = d.nativeLibs;

  const summary = h(
    'div',
    { class: 'card-grid' },
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-label' }, 'Native 总体积'),
      h('div', { class: 'card-value' }, deltaWithRatio(n.totalBytes, formatBytes)),
    ),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-label' }, '架构变化'),
      h(
        'div',
        { class: 'card-value', style: 'font-size:14px;' },
        n.architectures.added.length > 0
          ? h('span', null, '+ ', ...n.architectures.added.map((a) => h('span', { class: 'badge success' }, a)), ' ')
          : null,
        n.architectures.removed.length > 0
          ? h('span', null, '− ', ...n.architectures.removed.map((a) => h('span', { class: 'badge danger' }, a)))
          : null,
        n.architectures.added.length === 0 && n.architectures.removed.length === 0
          ? h('span', { class: 'delta-zero' }, '无变化')
          : null,
      ),
    ),
  );

  const addedRows = n.added.map((l) => [l.arch, h('code', null, l.name), formatBytes(l.bytes)]);
  const removedRows = n.removed.map((l) => [l.arch, h('code', null, l.name), formatBytes(l.bytes)]);
  const changedRows = n.changed.map((l) => [
    l.arch,
    h('code', null, l.name),
    formatBytes(l.fromBytes),
    formatBytes(l.toBytes),
    deltaBytes(l.delta),
  ]);

  return shell(
    'Native',
    summary,
    n.added.length > 0
      ? h(
          'div',
          { class: 'panel' },
          h('h3', { class: 'panel-title' }, `新增 (${n.added.length})`),
          table(['Arch', 'Name', '体积'], addedRows, [undefined, 'path', 'num']),
        )
      : null,
    n.removed.length > 0
      ? h(
          'div',
          { class: 'panel' },
          h('h3', { class: 'panel-title' }, `删除 (${n.removed.length})`),
          table(['Arch', 'Name', '体积'], removedRows, [undefined, 'path', 'num']),
        )
      : null,
    n.changed.length > 0
      ? h(
          'div',
          { class: 'panel' },
          h('h3', { class: 'panel-title' }, `修改 (${n.changed.length})`),
          table(
            ['Arch', 'Name', 'Baseline', 'Candidate', 'Delta'],
            changedRows,
            [undefined, 'path', 'num', 'num', 'num'],
          ),
        )
      : null,
    n.added.length === 0 && n.removed.length === 0 && n.changed.length === 0
      ? emptyState('Native 库无变化')
      : null,
    renderNativeLibSymbolsDiff(d),
  );
}

const SYMBOL_DIFF_PAGE_SIZE = 50;
const SECTION_DIFF_PAGE_SIZE = 50;
const STRING_DIFF_PAGE_SIZE = 100;

function libHasDeepChange(l: DiffNativeLibSymbolsItem): boolean {
  return (
    l.totals.added + l.totals.removed + l.totals.changed > 0 ||
    (l.sectionsDiff?.anyChanged ?? false) ||
    (l.neededDiff !== undefined && l.neededDiff.added.length + l.neededDiff.removed.length > 0) ||
    (l.mitigationsDiff?.anyChanged ?? false) ||
    (l.glibcDiff !== undefined && l.glibcDiff.added.length + l.glibcDiff.removed.length > 0) ||
    (l.rodataDiff?.anyChanged ?? false) ||
    (l.buildInfoDiff?.anyChanged ?? false)
  );
}

function renderNativeLibSymbolsDiff(d: PackageDiffReport): HTMLElement | null {
  const sym = d.nativeLibSymbols;
  if (!sym || sym.perLib.length === 0) return null;

  const affected = sym.perLib.filter(libHasDeepChange);
  const summary = h(
    'div',
    { class: 'card-grid' },
    countCard('受影响 so', affected.length, 'warn'),
    countCard(
      '符号新增',
      sym.perLib.reduce((s, l) => s + l.totals.added, 0),
      'pos',
    ),
    countCard(
      '符号删除',
      sym.perLib.reduce((s, l) => s + l.totals.removed, 0),
      'neg',
    ),
    countCard(
      '符号修改',
      sym.perLib.reduce((s, l) => s + l.totals.changed, 0),
      'warn',
    ),
    countCard(
      '节区变化(总条目)',
      sym.perLib.reduce((s, l) => {
        const sd = l.sectionsDiff;
        return sd ? s + sd.added.length + sd.removed.length + sd.changed.length : s;
      }, 0),
      'warn',
    ),
    countCard(
      '依赖变化(总条目)',
      sym.perLib.reduce(
        (s, l) => (l.neededDiff ? s + l.neededDiff.added.length + l.neededDiff.removed.length : s),
        0,
      ),
      'warn',
    ),
    countCard(
      'Mitigations 退化 so',
      sym.perLib.filter((l) => l.mitigationsDiff?.anyChanged).length,
      'warn',
    ),
  );

  const overviewRows = sym.perLib.map((l) => [
    h('span', { class: 'badge primary' }, l.arch),
    h('code', null, l.name),
    l.fromMissing ? badge('新 so', 'success') : l.toMissing ? badge('删 so', 'danger') : badge('—', 'info'),
    l.totals.added.toLocaleString(),
    l.totals.removed.toLocaleString(),
    l.totals.changed.toLocaleString(),
    renderTinyFlags(l),
  ]);

  const perLibPanels = affected.map((l) => renderOneLibDeepDiff(l));

  return h(
    'div',
    null,
    h(
      'div',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, '可选深度差异 · Native ELF 多维度'),
      summary,
      h('h3', { class: 'panel-title', style: 'margin-top:12px' }, '逐 so 汇总'),
      table(
        ['Arch', 'Name', '存在性', '符号 +', '符号 −', '符号 ~', '其它变化标记'],
        overviewRows,
        [undefined, 'path', undefined, 'num', 'num', 'num', undefined],
      ),
    ),
    ...perLibPanels,
  ) as HTMLElement;
}

function renderTinyFlags(l: DiffNativeLibSymbolsItem): HTMLElement {
  const parts: HTMLElement[] = [];
  if (l.sectionsDiff?.anyChanged) parts.push(badge('sections', 'warning'));
  if (l.neededDiff && l.neededDiff.added.length + l.neededDiff.removed.length > 0) {
    parts.push(badge('needed', 'warning'));
  }
  if (l.mitigationsDiff?.anyChanged) parts.push(badge('mitigations', 'danger'));
  if (l.glibcDiff && l.glibcDiff.added.length + l.glibcDiff.removed.length > 0) {
    parts.push(badge('glibc', 'warning'));
  }
  if (l.rodataDiff?.anyChanged) parts.push(badge('rodata', 'info'));
  if (l.buildInfoDiff?.anyChanged) parts.push(badge('build', 'info'));
  if (parts.length === 0) return h('span', { class: 'delta-zero' }, '—') as HTMLElement;
  return h('span', null, ...parts.flatMap((b) => [b, ' '])) as HTMLElement;
}

function renderOneLibDeepDiff(lib: DiffNativeLibSymbolsItem): HTMLElement {
  return h(
    'details',
    { class: 'panel sub-panel' },
    h(
      'summary',
      null,
      h('strong', null, `${lib.arch}/${lib.name}`),
      ' · ',
      `符号 +${lib.totals.added} −${lib.totals.removed} ~${lib.totals.changed}`,
      ' · ',
      renderTinyFlags(lib),
    ),
    renderBuildInfoDiff(lib.buildInfoDiff),
    renderMitigationsDiff(lib.mitigationsDiff),
    renderNeededDiff(lib.neededDiff),
    renderGlibcDiff(lib.glibcDiff),
    renderSectionsDiff(lib.sectionsDiff),
    renderRodataDiff(lib.rodataDiff),
    renderSymbolsDiff(lib),
  ) as HTMLElement;
}

function renderBuildInfoDiff(bi: DiffNativeLibBuildInfo | undefined): HTMLElement | null {
  if (!bi || !bi.anyChanged) return null;
  return h(
    'div',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, '构建信息变化'),
    kv([
      ['Build-id (B)', bi.fromBuildId ? h('code', null, bi.fromBuildId) : '—'],
      ['Build-id (C)', bi.toBuildId ? h('code', null, bi.toBuildId) : '—'],
      [
        'Build-id 状态',
        bi.buildIdChanged ? badge('changed', 'warning') : badge('unchanged', 'success'),
      ],
      ['Compiler (B)', bi.fromComment ? h('code', null, bi.fromComment) : '—'],
      ['Compiler (C)', bi.toComment ? h('code', null, bi.toComment) : '—'],
      [
        'Compiler 状态',
        bi.commentChanged ? badge('changed', 'warning') : badge('unchanged', 'success'),
      ],
    ]),
  ) as HTMLElement;
}

function renderMitigationsDiff(m: DiffNativeLibMitigations | undefined): HTMLElement | null {
  if (!m || !m.anyChanged) return null;
  const flagRow = (
    label: string,
    pair: { from: boolean; to: boolean; changed: boolean },
  ): [string, HTMLElement] => [
    label,
    h(
      'span',
      null,
      pair.from ? badge('启用', 'success') : badge('未启用', 'danger'),
      h('span', { class: 'card-sub', style: 'margin: 0 4px;' }, '→'),
      pair.to ? badge('启用', 'success') : badge('未启用', 'danger'),
      ' ',
      pair.changed ? badge('changed', 'warning') : badge('unchanged', 'info'),
    ) as HTMLElement,
  ];

  return h(
    'div',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, '安全编译选项变化'),
    kv([
      flagRow('NX', m.nx),
      [
        'RELRO',
        h(
          'span',
          null,
          relroBadge(m.relro.from),
          h('span', { class: 'card-sub', style: 'margin: 0 4px;' }, '→'),
          relroBadge(m.relro.to),
          ' ',
          m.relro.changed ? badge('changed', 'warning') : badge('unchanged', 'info'),
        ) as HTMLElement,
      ],
      flagRow('PIE', m.pie),
      flagRow('Stack Canary', m.stackCanary),
      flagRow('FORTIFY_SOURCE', m.fortify),
    ]),
  ) as HTMLElement;
}

function relroBadge(v: 'full' | 'partial' | 'none'): HTMLElement {
  if (v === 'full') return badge('full', 'success');
  if (v === 'partial') return badge('partial', 'warning');
  return badge('none', 'danger');
}

function renderNeededDiff(nd: DiffStringSet | undefined): HTMLElement | null {
  if (!nd || nd.added.length + nd.removed.length === 0) return null;
  return h(
    'div',
    { class: 'panel' },
    h(
      'h3',
      { class: 'panel-title' },
      `动态依赖变化（DT_NEEDED）+${nd.added.length} −${nd.removed.length}`,
    ),
    renderStringDiffPair(nd),
  ) as HTMLElement;
}

function renderGlibcDiff(gd: DiffStringSet | undefined): HTMLElement | null {
  if (!gd || gd.added.length + gd.removed.length === 0) return null;
  return h(
    'div',
    { class: 'panel' },
    h(
      'h3',
      { class: 'panel-title' },
      `符号版本需求变化（GLIBC / GCC 等）+${gd.added.length} −${gd.removed.length}`,
    ),
    renderStringDiffPair(gd),
  ) as HTMLElement;
}

function renderSectionsDiff(sd: DiffNativeLibSections | undefined): HTMLElement | null {
  if (!sd || !sd.anyChanged) return null;
  const changedRows = sd.changed.map((s) => [
    h('code', null, s.name),
    formatBytes(s.fromSize),
    formatBytes(s.toSize),
    deltaBytes(s.delta),
  ]);
  const addedRows = sd.added.map((s) => [h('code', null, s.name), formatBytes(s.toSize)]);
  const removedRows = sd.removed.map((s) => [h('code', null, s.name), formatBytes(s.fromSize)]);

  return h(
    'div',
    { class: 'panel' },
    h(
      'h3',
      { class: 'panel-title' },
      `节区变化（${sd.changed.length} 修改 / ${sd.added.length} 新增 / ${sd.removed.length} 删除）`,
    ),
    sd.changed.length > 0
      ? h(
          'div',
          null,
          h('h3', { class: 'panel-title' }, `修改 (${sd.changed.length})（按 |Δ| 降序）`),
          paginatedTable(
            ['Section', 'Baseline', 'Candidate', 'Delta'],
            changedRows,
            ['path', 'num', 'num', 'num'],
            { pageSize: SECTION_DIFF_PAGE_SIZE },
          ),
        )
      : null,
    sd.added.length > 0
      ? h(
          'div',
          null,
          h('h3', { class: 'panel-title' }, `新增 (${sd.added.length})`),
          paginatedTable(['Section', 'Size'], addedRows, ['path', 'num'], {
            pageSize: SECTION_DIFF_PAGE_SIZE,
          }),
        )
      : null,
    sd.removed.length > 0
      ? h(
          'div',
          null,
          h('h3', { class: 'panel-title' }, `删除 (${sd.removed.length})`),
          paginatedTable(['Section', 'Size'], removedRows, ['path', 'num'], {
            pageSize: SECTION_DIFF_PAGE_SIZE,
          }),
        )
      : null,
  ) as HTMLElement;
}

function renderRodataDiff(rd: DiffNativeLibRodataStrings | undefined): HTMLElement | null {
  if (!rd || !rd.anyChanged) return null;
  return h(
    'div',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, '.rodata 字符串池变化'),
    renderRodataGroupDiff('URL', rd.urls),
    renderRodataGroupDiff('路径', rd.paths),
    renderRodataGroupDiff('SQL 语句', rd.sqlLike),
    renderRodataGroupDiff('其它', rd.other),
  ) as HTMLElement;
}

function renderRodataGroupDiff(label: string, set: DiffStringSet): HTMLElement | null {
  if (set.added.length + set.removed.length === 0) return null;
  return h(
    'details',
    { class: 'panel sub-panel' },
    h(
      'summary',
      null,
      h('strong', null, label),
      ' · ',
      `+${set.added.length} −${set.removed.length}`,
      set.unchanged > 0 ? `（不变 ${set.unchanged}）` : '',
    ),
    renderStringDiffPair(set),
  ) as HTMLElement;
}

/** 渲染一对 added/removed 字符串列表，每块独立分页（每页 100） */
function renderStringDiffPair(set: DiffStringSet): HTMLElement {
  return h(
    'div',
    null,
    set.added.length > 0
      ? h(
          'div',
          null,
          h('h3', { class: 'panel-title' }, `新增 (${set.added.length})`),
          paginated(
            set.added,
            (items) =>
              h(
                'div',
                { class: 'string-list' },
                ...items.map((s) => h('code', { class: 'string-item added' }, '+ ', s)),
              ) as HTMLElement,
            { pageSize: STRING_DIFF_PAGE_SIZE },
          ),
        )
      : null,
    set.removed.length > 0
      ? h(
          'div',
          null,
          h('h3', { class: 'panel-title' }, `删除 (${set.removed.length})`),
          paginated(
            set.removed,
            (items) =>
              h(
                'div',
                { class: 'string-list' },
                ...items.map((s) => h('code', { class: 'string-item removed' }, '− ', s)),
              ) as HTMLElement,
            { pageSize: STRING_DIFF_PAGE_SIZE },
          ),
        )
      : null,
  ) as HTMLElement;
}

function renderSymbolsDiff(lib: DiffNativeLibSymbolsItem): HTMLElement | null {
  if (lib.totals.added + lib.totals.removed + lib.totals.changed === 0) return null;
  const addedRows = lib.added.map((s: NativeSymbol) => [
    h('code', null, s.name),
    s.type,
    s.bind,
    s.imported ? 'UND' : 'def',
    formatBytes(s.size),
  ]);
  const removedRows = lib.removed.map((s: NativeSymbol) => [
    h('code', null, s.name),
    s.type,
    s.bind,
    s.imported ? 'UND' : 'def',
    formatBytes(s.size),
  ]);
  const changedRows = lib.changed.map((s: DiffSymbolChanged) => [
    h('code', null, s.name),
    s.type,
    s.bind,
    s.imported ? 'UND' : 'def',
    formatBytes(s.fromSize),
    formatBytes(s.toSize),
    deltaBytes(s.delta),
    // 只有当 size 确实有变时 body badge 才传递可读信号；differ 已经把
    // size 不变 + body 变 的项移到独立的 bodyHashOnly 面板，这里不会出现。
    s.bodyChanged === true
      ? badge('body changed', 'warning')
      : s.bodyChanged === false
        ? badge('body 不变', 'success')
        : badge('未计 sha256', 'info'),
  ]);

  return h(
    'div',
    { class: 'panel' },
    h(
      'h3',
      { class: 'panel-title' },
      `符号表变化（+${lib.totals.added} −${lib.totals.removed} ~${lib.totals.changed}）`,
    ),
    addedRows.length > 0
      ? h(
          'div',
          null,
          h('h3', { class: 'panel-title' }, `新增 (${lib.totals.added})`),
          paginatedTable(
            ['Symbol', 'Type', 'Bind', '可见性', 'Size'],
            addedRows,
            ['path', undefined, undefined, undefined, 'num'],
            { pageSize: SYMBOL_DIFF_PAGE_SIZE },
          ),
        )
      : null,
    removedRows.length > 0
      ? h(
          'div',
          null,
          h('h3', { class: 'panel-title' }, `删除 (${lib.totals.removed})`),
          paginatedTable(
            ['Symbol', 'Type', 'Bind', '可见性', 'Size'],
            removedRows,
            ['path', undefined, undefined, undefined, 'num'],
            { pageSize: SYMBOL_DIFF_PAGE_SIZE },
          ),
        )
      : null,
    changedRows.length > 0
      ? h(
          'div',
          null,
          h('h3', { class: 'panel-title' }, `修改 (${lib.totals.changed})（按 |Δ| 降序）`),
          paginatedTable(
            ['Symbol', 'Type', 'Bind', '可见性', 'Baseline', 'Candidate', 'Delta', 'Body'],
            changedRows,
            ['path', undefined, undefined, undefined, 'num', 'num', 'num', undefined],
            { pageSize: SYMBOL_DIFF_PAGE_SIZE },
          ),
        )
      : null,
  ) as HTMLElement;
}

/* -------------------------------------------------------------------------- */
/* abc                                                                         */
/* -------------------------------------------------------------------------- */

export function renderAbc(d: PackageDiffReport): HTMLElement {
  if (!d.abc) return shell('ABC', emptyState('两侧均无 abc 信息'));
  const a = d.abc;
  const fromS = a.modulesAbc.fromBytes !== null ? formatBytes(a.modulesAbc.fromBytes) : '∅';
  const toS = a.modulesAbc.toBytes !== null ? formatBytes(a.modulesAbc.toBytes) : '∅';
  const deltaNode = a.modulesAbc.delta === null
    ? h('span', { class: 'delta-zero' }, '—')
    : deltaBytes(a.modulesAbc.delta);

  const main = h(
    'div',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, 'ets/modules.abc'),
    kv([
      ['Baseline', fromS],
      ['Candidate', toS],
      ['Delta', deltaNode],
      ['SourceMap', a.modulesAbc.sourceMapChanged ? badge('changed', 'warning') : badge('unchanged', 'success')],
    ]),
  );

  const extraSummary = h(
    'div',
    { class: 'card-grid' },
    countCard('extra 新增', a.extra.added.length, 'pos'),
    countCard('extra 删除', a.extra.removed.length, 'neg'),
    countCard('extra 修改', a.extra.changed.length, 'warn'),
  );

  return shell(
    'ABC',
    main,
    extraSummary,
    a.extra.added.length > 0
      ? h(
          'div',
          { class: 'panel' },
          h('h3', { class: 'panel-title' }, '新增 abc'),
          table(['路径', '体积'], a.extra.added.map((x) => [x.path, formatBytes(x.bytes)]), ['path', 'num']),
        )
      : null,
    a.extra.removed.length > 0
      ? h(
          'div',
          { class: 'panel' },
          h('h3', { class: 'panel-title' }, '删除 abc'),
          table(['路径', '体积'], a.extra.removed.map((x) => [x.path, formatBytes(x.bytes)]), ['path', 'num']),
        )
      : null,
    a.extra.changed.length > 0
      ? h(
          'div',
          { class: 'panel' },
          h('h3', { class: 'panel-title' }, '修改 abc'),
          table(
            ['路径', 'Baseline', 'Candidate', 'Delta'],
            a.extra.changed.map((x) => [x.path, formatBytes(x.fromBytes), formatBytes(x.toBytes), deltaBytes(x.delta)]),
            ['path', 'num', 'num', 'num'],
          ),
        )
      : null,
    renderAbcDetailsDiff(d),
  );
}

function renderAbcDetailsDiff(d: PackageDiffReport): HTMLElement | null {
  const det = d.abcDetails;
  if (!det || det.entries.length === 0) return null;

  const summary = h(
    'div',
    { class: 'card-grid' },
    countCard('abc 总数', det.totals.total, 'mute'),
    countCard('内容/版本变化', det.totals.changed, 'warn'),
  );

  const rows = det.entries.map((e: HarmonyDiffAbcDetailEntry) => [
    h('code', null, e.path),
    e.changed ? badge('changed', 'warning') : badge('unchanged', 'success'),
    cellPair(e.fromBytes, e.toBytes, formatBytesOrDash),
    cellPair(e.fromVersion, e.toVersion, (v) => v ?? '—'),
    cellPair(e.fromNumClasses, e.toNumClasses, (v) => (v == null ? '—' : v.toLocaleString())),
    cellPair(e.fromSha256, e.toSha256, (v) => (v ? shortHash(v) : '—')),
  ]);

  // 仅对有 stringsDiff 且任一分类有变化的 abc 渲染明细
  const stringDiffPanels = det.entries
    .filter((e) => e.stringsDiff && e.stringsDiff.anyChanged)
    .map((e) => renderAbcStringsDiffPanel(e.path, e.stringsDiff!));

  return h(
    'div',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, '可选深度差异 · ABC 头部细节'),
    summary,
    table(
      ['路径', '状态', '体积 B → C', 'Version B → C', '类数 B → C', 'SHA-256 B → C'],
      rows,
      ['path', undefined, 'num', undefined, 'num', undefined],
    ),
    stringDiffPanels.length > 0
      ? h('h3', { class: 'panel-title', style: 'margin-top:14px' }, 'ABC 字符串池差异（按分类）')
      : null,
    ...stringDiffPanels,
  ) as HTMLElement;
}

function renderAbcStringsDiffPanel(path: string, sd: HarmonyDiffAbcStrings): HTMLElement {
  const totalAdded =
    sd.classDescriptors.added.length +
    sd.moduleRecords.added.length +
    sd.sourceFiles.added.length +
    sd.identifiers.added.length;
  const totalRemoved =
    sd.classDescriptors.removed.length +
    sd.moduleRecords.removed.length +
    sd.sourceFiles.removed.length +
    sd.identifiers.removed.length;

  return h(
    'details',
    { class: 'panel sub-panel' },
    h(
      'summary',
      null,
      h('strong', null, path),
      ' · ',
      `+${totalAdded} −${totalRemoved}`,
    ),
    renderStringDiffGroup('类描述符 (L...;)', sd.classDescriptors),
    renderStringDiffGroup('模块记录 (&...)', sd.moduleRecords),
    renderStringDiffGroup('源文件', sd.sourceFiles),
    renderStringDiffGroup('方法/标识符', sd.identifiers),
  ) as HTMLElement;
}

function renderStringDiffGroup(label: string, set: HarmonyDiffAbcStringSet): HTMLElement | null {
  if (set.added.length === 0 && set.removed.length === 0) return null;
  return h(
    'details',
    { class: 'panel sub-panel' },
    h(
      'summary',
      null,
      h('strong', null, label),
      ' · ',
      `+${set.added.length} −${set.removed.length}`,
      set.unchanged > 0 ? `（不变 ${set.unchanged}）` : '',
    ),
    renderStringDiffPair(set),
  ) as HTMLElement;
}

function formatBytesOrDash(v: number | null): string {
  return v == null ? '—' : formatBytes(v);
}

function cellPair<T>(a: T, b: T, fmt: (v: T) => string): HTMLElement {
  const same = a === b;
  return h(
    'span',
    null,
    fmt(a),
    h('span', { class: 'card-sub', style: 'margin: 0 4px;' }, '→'),
    h('span', { class: same ? 'delta-zero' : 'delta-pos' }, fmt(b)),
  ) as HTMLElement;
}

/* -------------------------------------------------------------------------- */
/* il2cpp metadata（Unity 游戏专用深度差异）                                   */
/* -------------------------------------------------------------------------- */

export function renderIl2cpp(d: PackageDiffReport): HTMLElement {
  if (!d.il2cppMetadata) {
    return shell(
      'IL2CPP 元数据',
      emptyState('两侧均未启用 IL2CPP 元数据深度分析（仅对 Unity 游戏 hap 有意义）'),
    );
  }
  const info = d.il2cppMetadata;
  if (info.entries.length === 0) {
    return shell('IL2CPP 元数据', emptyState('两侧都未发现 global-metadata.dat'));
  }

  const summary = h(
    'div',
    { class: 'card-grid' },
    countCard('文件总数', info.totals.total, 'mute'),
    countCard('内容/版本变化', info.totals.changed, 'warn'),
  );

  const overviewRows = info.entries.map((e) => [
    h('code', null, e.path),
    e.changed ? badge('changed', 'warning') : badge('unchanged', 'success'),
    cellPair(e.fromBytes, e.toBytes, formatBytesOrDash),
    cellPair(
      e.fromMetadataVersion,
      e.toMetadataVersion,
      (v) => (v == null ? '—' : `v${v}`),
    ),
    cellPair(e.fromSha256, e.toSha256, (v) => (v ? shortHash(v) : '—')),
    renderUnityRangeChange(e),
  ]);

  const perFilePanels = info.entries
    .filter((e) => e.changed && (e.namesDiff?.anyChanged || e.literalsDiff?.anyChanged))
    .map((e) => renderOneIl2cppDiffPanel(e));

  return shell(
    'IL2CPP 元数据',
    h(
      'div',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, '差异汇总'),
      summary,
      paginatedTable(
        ['路径', '状态', '体积 B → C', 'Metadata 版本 B → C', 'SHA-256 B → C', 'Unity 版本范围'],
        overviewRows,
        ['path', undefined, 'num', undefined, undefined, 'path'],
        { pageSize: 50 },
      ),
    ),
    perFilePanels.length > 0
      ? h(
          'div',
          { class: 'panel' },
          h('h3', { class: 'panel-title' }, '逐文件名字池 / 字面量池差异'),
          ...perFilePanels,
        )
      : null,
  );
}

function renderUnityRangeChange(e: DiffIl2cppMetadataEntry): HTMLElement {
  const same = (e.fromUnityVersionRange ?? '') === (e.toUnityVersionRange ?? '');
  if (same) return h('span', { class: 'delta-zero' }, e.fromUnityVersionRange ?? '—') as HTMLElement;
  return h(
    'span',
    null,
    e.fromUnityVersionRange ?? '—',
    h('span', { class: 'card-sub', style: 'margin: 0 4px;' }, '→'),
    h('span', { class: 'delta-pos' }, e.toUnityVersionRange ?? '—'),
  ) as HTMLElement;
}

function renderOneIl2cppDiffPanel(e: DiffIl2cppMetadataEntry): HTMLElement {
  const namesAdded = sumNamesAdded(e.namesDiff);
  const namesRemoved = sumNamesRemoved(e.namesDiff);
  const literalsAdded = sumLiteralsAdded(e.literalsDiff);
  const literalsRemoved = sumLiteralsRemoved(e.literalsDiff);

  return h(
    'details',
    { class: 'panel sub-panel', open: '' },
    h(
      'summary',
      null,
      h('strong', null, e.path),
      ' · ',
      `名字 +${namesAdded} −${namesRemoved}`,
      ' · ',
      `字面量 +${literalsAdded} −${literalsRemoved}`,
    ),
    e.namesDiff ? renderIl2cppNamesDiff(e.namesDiff) : null,
    e.literalsDiff ? renderIl2cppLiteralsDiff(e.literalsDiff) : null,
  ) as HTMLElement;
}

function renderIl2cppNamesDiff(nd: DiffIl2cppNames): HTMLElement | null {
  if (!nd.anyChanged) return null;
  return h(
    'div',
    { class: 'panel sub-panel' },
    h('h3', { class: 'panel-title' }, '名字池差异（启发式分桶）'),
    renderStringDiffGroupG('类型名（Namespace.Class）', nd.typeNames),
    renderStringDiffGroupG('命名空间', nd.namespaces),
    renderStringDiffGroupG('Assembly 名', nd.assemblies),
    renderStringDiffGroupG('标识符（方法/字段名等）', nd.identifiers),
    renderStringDiffGroupG('其它', nd.other),
  ) as HTMLElement;
}

function renderIl2cppLiteralsDiff(ld: DiffIl2cppLiterals): HTMLElement | null {
  if (!ld.anyChanged) return null;
  return h(
    'div',
    { class: 'panel sub-panel' },
    h('h3', { class: 'panel-title' }, 'C# 字符串字面量池差异'),
    renderStringDiffGroupG('URL', ld.urls),
    renderStringDiffGroupG('路径', ld.paths),
    renderStringDiffGroupG('SQL 语句', ld.sqlLike),
    renderStringDiffGroupG('其它', ld.other),
  ) as HTMLElement;
}

/** 通用 DiffStringSet 渲染（区别于 HarmonyDiffAbcStringSet 的 renderStringDiffGroup） */
function renderStringDiffGroupG(label: string, set: DiffStringSet): HTMLElement | null {
  if (set.added.length === 0 && set.removed.length === 0) return null;
  return h(
    'details',
    { class: 'panel sub-panel' },
    h(
      'summary',
      null,
      h('strong', null, label),
      ' · ',
      `+${set.added.length} −${set.removed.length}`,
      set.unchanged > 0 ? `（不变 ${set.unchanged}）` : '',
    ),
    renderStringDiffPair(set),
  ) as HTMLElement;
}

function sumNamesAdded(nd: DiffIl2cppNames | undefined): number {
  if (!nd) return 0;
  return (
    nd.typeNames.added.length +
    nd.namespaces.added.length +
    nd.assemblies.added.length +
    nd.identifiers.added.length +
    nd.other.added.length
  );
}
function sumNamesRemoved(nd: DiffIl2cppNames | undefined): number {
  if (!nd) return 0;
  return (
    nd.typeNames.removed.length +
    nd.namespaces.removed.length +
    nd.assemblies.removed.length +
    nd.identifiers.removed.length +
    nd.other.removed.length
  );
}
function sumLiteralsAdded(ld: DiffIl2cppLiterals | undefined): number {
  if (!ld) return 0;
  return ld.urls.added.length + ld.paths.added.length + ld.sqlLike.added.length + ld.other.added.length;
}
function sumLiteralsRemoved(ld: DiffIl2cppLiterals | undefined): number {
  if (!ld) return 0;
  return (
    ld.urls.removed.length +
    ld.paths.removed.length +
    ld.sqlLike.removed.length +
    ld.other.removed.length
  );
}

/* -------------------------------------------------------------------------- */
/* signature                                                                   */
/* -------------------------------------------------------------------------- */

export function renderSignature(d: PackageDiffReport): HTMLElement {
  if (!d.signature) return shell('签名', emptyState('两侧均无 signature 信息'));
  const s = d.signature;
  const presence = h(
    'div',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, '签名存在性'),
    kv([
      ['Baseline', s.fromPresent ? badge('已签', 'success') : badge('未签', 'danger')],
      ['Candidate', s.toPresent ? badge('已签', 'success') : badge('未签', 'danger')],
      ['是否变化', s.presentChanged ? badge('changed', 'warning') : badge('unchanged', 'success')],
    ]),
  );

  const fieldsRows = s.fields.map((f) => [
    f.field,
    f.from || '—',
    f.to || '—',
    f.changed ? badge('changed', 'warning') : badge('unchanged', 'success'),
  ]);

  return shell(
    '签名',
    presence,
    h(
      'div',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, '证书字段对比'),
      table(['字段', 'Baseline', 'Candidate', '状态'], fieldsRows, [undefined, 'path', 'path', undefined]),
    ),
    renderSignatureVersions(s.versions),
    renderSigningBlock(s.signingBlock),
  );
}

/**
 * Android：v1/v2/v3/v3.1 签名 scheme diff 渲染。
 * 双侧都无 versions 时调用方传 undefined，本函数直接返回 null（HarmonyOS 路径）。
 */
function renderSignatureVersions(v: DiffApkSignatureVersions | undefined): HTMLElement | null {
  if (!v) return null;
  const flagCell = (label: string, p: { from: boolean; to: boolean; changed: boolean }) => [
    label,
    p.from ? badge('有', 'success') : badge('无', 'info'),
    p.to ? badge('有', 'success') : badge('无', 'info'),
    p.changed ? badge('changed', 'warning') : badge('unchanged', 'info'),
  ];
  return h(
    'div',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, 'Android 签名 Scheme 对比 (v1 / v2 / v3 / v3.1)'),
    table(
      ['Scheme', 'Baseline', 'Candidate', '状态'],
      [flagCell('v1', v.v1), flagCell('v2', v.v2), flagCell('v3', v.v3), flagCell('v3.1', v.v31)],
      [undefined, undefined, undefined, undefined],
    ),
    h(
      'p',
      { class: 'panel-desc' },
      v.anyChanged
        ? badge('整体有变化', 'warning')
        : badge('整体未变化', 'success'),
    ),
  ) as HTMLElement;
}

/**
 * Android：APK Signing Block 内 ID-value pair 的 diff 渲染。
 * 列出 added / removed / 同 ID 但 value 大小变化的 changedSizes。
 */
function renderSigningBlock(sb: DiffApkSigningBlock | undefined): HTMLElement | null {
  if (!sb) return null;
  const totalRow = h(
    'div',
    { class: 'card-grid' },
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-label' }, 'Signing Block 总字节'),
      h(
        'div',
        { class: 'card-value' },
        sb.fromTotalBytes !== null ? formatBytes(sb.fromTotalBytes) : '—',
        h('span', { class: 'card-sub', style: 'margin: 0 4px;' }, '→'),
        sb.toTotalBytes !== null ? formatBytes(sb.toTotalBytes) : '—',
        ' ',
        sb.totalBytesDelta !== null ? deltaBytes(sb.totalBytesDelta) : badge('—', 'info'),
      ),
    ),
    countCard('新增 pair', sb.added.length, 'pos'),
    countCard('删除 pair', sb.removed.length, 'neg'),
    countCard('大小变化 pair', sb.changedSizes.length, 'warn'),
  );

  const addedRows = sb.added.map((e) => [h('code', null, e.idHex), e.name, formatBytes(e.sizeBytes)]);
  const removedRows = sb.removed.map((e) => [
    h('code', null, e.idHex),
    e.name,
    formatBytes(e.sizeBytes),
  ]);
  const changedRows = sb.changedSizes.map((e) => [
    h('code', null, e.idHex),
    e.name,
    formatBytes(e.fromSize),
    formatBytes(e.toSize),
    deltaBytes(e.delta),
  ]);

  return h(
    'div',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, 'APK Signing Block 对比'),
    totalRow,
    sb.added.length > 0
      ? h(
          'div',
          { class: 'panel sub-panel' },
          h('h3', { class: 'panel-title' }, `新增 pair (${sb.added.length})`),
          table(['ID (hex)', 'Name', 'Size'], addedRows, [undefined, undefined, 'num']),
        )
      : null,
    sb.removed.length > 0
      ? h(
          'div',
          { class: 'panel sub-panel' },
          h('h3', { class: 'panel-title' }, `删除 pair (${sb.removed.length})`),
          table(['ID (hex)', 'Name', 'Size'], removedRows, [undefined, undefined, 'num']),
        )
      : null,
    sb.changedSizes.length > 0
      ? h(
          'div',
          { class: 'panel sub-panel' },
          h('h3', { class: 'panel-title' }, `大小变化 pair (${sb.changedSizes.length})`),
          table(
            ['ID (hex)', 'Name', 'Baseline', 'Candidate', 'Delta'],
            changedRows,
            [undefined, undefined, 'num', 'num', 'num'],
          ),
        )
      : null,
  ) as HTMLElement;
}

/* -------------------------------------------------------------------------- */
/* dex（Android default analyzer 产物 + 可选 dexDetails 深度）                  */
/* -------------------------------------------------------------------------- */

const DEX_METHOD_DIFF_PAGE_SIZE = 50;

export function renderDex(d: PackageDiffReport): HTMLElement {
  if (!d.dex && !d.dexDetails) {
    return shell('DEX', emptyState('两侧均无 dex 信息（HarmonyOS 报告 / 非 Android 包）'));
  }
  return shell(
    'DEX',
    renderDexFileLevel(d.dex),
    renderDexDetailsDiff(d.dexDetails),
  );
}

function renderDexFileLevel(dx: DiffDex | undefined): HTMLElement | null {
  if (!dx) return null;
  const summary = h(
    'div',
    { class: 'card-grid' },
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-label' }, 'dex 文件数'),
      h('div', { class: 'card-value' }, deltaWithRatio(dx.totals.fileCount, (v) => v.toLocaleString())),
    ),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-label' }, 'dex 总字节'),
      h('div', { class: 'card-value' }, deltaWithRatio(dx.totals.totalBytes, formatBytes)),
    ),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-label' }, 'methodIds 总和'),
      h(
        'div',
        { class: 'card-value' },
        deltaWithRatio(dx.totals.methodIdsCount, (v) => v.toLocaleString()),
      ),
    ),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-label' }, 'classDefs 总和'),
      h(
        'div',
        { class: 'card-value' },
        deltaWithRatio(dx.totals.classDefsCount, (v) => v.toLocaleString()),
      ),
    ),
  );

  const addedRows = dx.added.map((f) => [h('code', null, f.path), formatBytes(f.bytes), f.magic, f.version ?? '—']);
  const removedRows = dx.removed.map((f) => [h('code', null, f.path), formatBytes(f.bytes), f.magic, f.version ?? '—']);
  const changedRows = dx.changed.map((f) => [
    h('code', null, f.path),
    formatBytes(f.fromBytes),
    formatBytes(f.toBytes),
    deltaBytes(f.bytesDelta),
    nullableCountDelta(f.methodIdsDelta),
    nullableCountDelta(f.classDefsDelta),
    nullableCountDelta(f.stringIdsDelta),
  ]);

  return h(
    'div',
    null,
    h(
      'div',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, 'dex 文件级汇总'),
      summary,
    ),
    dx.added.length > 0
      ? h(
          'div',
          { class: 'panel' },
          h('h3', { class: 'panel-title' }, `新增 dex (${dx.added.length})`),
          table(['路径', '体积', 'Magic', 'Version'], addedRows, ['path', 'num', undefined, undefined]),
        )
      : null,
    dx.removed.length > 0
      ? h(
          'div',
          { class: 'panel' },
          h('h3', { class: 'panel-title' }, `删除 dex (${dx.removed.length})`),
          table(['路径', '体积', 'Magic', 'Version'], removedRows, ['path', 'num', undefined, undefined]),
        )
      : null,
    dx.changed.length > 0
      ? h(
          'div',
          { class: 'panel' },
          h('h3', { class: 'panel-title' }, `修改 dex (${dx.changed.length})`),
          table(
            ['路径', 'Baseline', 'Candidate', 'Δ Bytes', 'Δ methodIds', 'Δ classDefs', 'Δ stringIds'],
            changedRows,
            ['path', 'num', 'num', 'num', 'num', 'num', 'num'],
          ),
        )
      : null,
    dx.added.length + dx.removed.length + dx.changed.length === 0
      ? emptyState('dex 文件级别无变化')
      : null,
  ) as HTMLElement;
}

function nullableCountDelta(d: number | null): HTMLElement {
  if (d === null) return badge('—', 'info') as HTMLElement;
  return deltaCount(d);
}

/**
 * dexDetails 深度差异：每个 dex 一行，展开后看 strings + methods 子 diff。
 * 仅当任一 dex 有 methodsDiff / stringsDiff 时渲染。
 */
function renderDexDetailsDiff(det: PackageDiffReport['dexDetails']): HTMLElement | null {
  if (!det || det.entries.length === 0) return null;
  const totals = det.totals;
  const summary = h(
    'div',
    { class: 'card-grid' },
    countCard('dex 总数', totals.total, 'mute'),
    countCard('内容变化 dex', totals.changed, 'warn'),
    countCard('方法新增', totals.methodsAdded, 'pos'),
    countCard('方法删除', totals.methodsRemoved, 'neg'),
    countCard('方法修改', totals.methodsChanged, 'warn'),
  );

  const overviewRows = det.entries.map((e) => [
    h('code', null, e.path),
    e.changed ? badge('changed', 'warning') : badge('unchanged', 'success'),
    cellPair(e.fromBytes, e.toBytes, formatBytesOrDash),
    cellPair(e.fromSha256, e.toSha256, (v) => (v ? shortHash(v) : '—')),
    methodsCountChip(e),
  ]);

  const perDexPanels = det.entries
    .filter((e) => (e.methodsDiff && hasMethodChange(e.methodsDiff)) || (e.stringsDiff && e.stringsDiff.anyChanged))
    .map((e) => renderOneDexDetailPanel(e));

  return h(
    'div',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, '可选深度差异 · DEX 字符串池 / 方法表'),
    summary,
    table(
      ['路径', '状态', '体积 B → C', 'SHA-256 B → C', '方法变化'],
      overviewRows,
      ['path', undefined, 'num', undefined, undefined],
    ),
    perDexPanels.length > 0
      ? h('h3', { class: 'panel-title', style: 'margin-top:14px' }, '逐 dex 方法 / 字符串差异')
      : null,
    ...perDexPanels,
  ) as HTMLElement;
}

function methodsCountChip(e: DiffDexDetailEntry): HTMLElement {
  if (!e.methodsDiff) return h('span', { class: 'delta-zero' }, '—') as HTMLElement;
  const t = e.methodsDiff.totals;
  if (t.added + t.removed + t.changed === 0) {
    return h('span', { class: 'delta-zero' }, '0+/0−/0~') as HTMLElement;
  }
  return h(
    'span',
    null,
    h('span', { class: 'delta-pos' }, `+${t.added}`),
    ' / ',
    h('span', { class: 'delta-neg' }, `−${t.removed}`),
    ' / ',
    h('span', { class: 'delta-zero' }, `~${t.changed}`),
  ) as HTMLElement;
}

function hasMethodChange(md: DiffDexMethods): boolean {
  return md.totals.added + md.totals.removed + md.totals.changed > 0;
}

function renderOneDexDetailPanel(e: DiffDexDetailEntry): HTMLElement {
  const md = e.methodsDiff;
  const sd = e.stringsDiff;
  const methodCounts = md
    ? `方法 +${md.totals.added} −${md.totals.removed} ~${md.totals.changed}`
    : '';
  const stringCounts =
    sd && sd.anyChanged
      ? `字符串 ` +
        `类+${sd.classDescriptors.added.length} 类−${sd.classDescriptors.removed.length} / ` +
        `签名+${sd.methodSignatures.added.length} 签名−${sd.methodSignatures.removed.length}`
      : '';

  return h(
    'details',
    { class: 'panel sub-panel', open: '' },
    h(
      'summary',
      null,
      h('strong', null, e.path),
      ' · ',
      methodCounts,
      methodCounts && stringCounts ? ' · ' : '',
      stringCounts,
    ),
    md ? renderDexMethodsDiff(md) : null,
    sd ? renderDexStringsDiff(sd) : null,
  ) as HTMLElement;
}

function renderDexMethodsDiff(md: DiffDexMethods): HTMLElement | null {
  if (!hasMethodChange(md)) return null;
  const addedRows = md.added.map((m) => [
    h('code', { title: m.fullName }, m.fullName),
    m.insnsSize !== null ? m.insnsSize.toLocaleString() : badge('abstract', 'info'),
  ]);
  const removedRows = md.removed.map((m) => [
    h('code', { title: m.fullName }, m.fullName),
    m.insnsSize !== null ? m.insnsSize.toLocaleString() : badge('abstract', 'info'),
  ]);
  const changedRows = md.changed.map((m) => [
    h('code', { title: m.fullName }, m.fullName),
    m.fromInsnsSize !== null ? m.fromInsnsSize.toLocaleString() : '—',
    m.toInsnsSize !== null ? m.toInsnsSize.toLocaleString() : '—',
    m.insnsSizeDelta !== null ? deltaCount(m.insnsSizeDelta) : badge('—', 'info'),
    m.bodyChanged === true
      ? badge('body changed', 'warning')
      : m.bodyChanged === false
        ? badge('body 不变', 'success')
        : badge('未计 sha256', 'info'),
    m.accessFlagsChanged
      ? badge(`flags 0x${m.fromAccessFlags.toString(16)}→0x${m.toAccessFlags.toString(16)}`, 'warning')
      : '—',
  ]);

  return h(
    'div',
    { class: 'panel sub-panel' },
    h('h3', { class: 'panel-title' }, '方法级差异'),
    md.added.length > 0
      ? h(
          'div',
          null,
          h('h3', { class: 'panel-title' }, `新增方法 (${md.added.length})`),
          paginatedTable(
            ['Method (fullName)', 'insns 大小'],
            addedRows,
            ['path', 'num'],
            { pageSize: DEX_METHOD_DIFF_PAGE_SIZE },
          ),
        )
      : null,
    md.removed.length > 0
      ? h(
          'div',
          null,
          h('h3', { class: 'panel-title' }, `删除方法 (${md.removed.length})`),
          paginatedTable(
            ['Method (fullName)', 'insns 大小'],
            removedRows,
            ['path', 'num'],
            { pageSize: DEX_METHOD_DIFF_PAGE_SIZE },
          ),
        )
      : null,
    md.changed.length > 0
      ? h(
          'div',
          null,
          h(
            'h3',
            { class: 'panel-title' },
            `修改方法 (${md.changed.length})（按 |insnsSize Δ| 降序）`,
          ),
          paginatedTable(
            ['Method (fullName)', 'B', 'C', 'Δ insns', 'Body', 'AccessFlags'],
            changedRows,
            ['path', 'num', 'num', 'num', undefined, undefined],
            { pageSize: DEX_METHOD_DIFF_PAGE_SIZE },
          ),
        )
      : null,
  ) as HTMLElement;
}

function renderDexStringsDiff(sd: DiffDexStrings): HTMLElement | null {
  if (!sd.anyChanged) return null;
  return h(
    'div',
    { class: 'panel sub-panel' },
    h('h3', { class: 'panel-title' }, 'DEX 字符串池差异（按分类）'),
    renderStringDiffGroupG('类描述符 (L...;)', sd.classDescriptors),
    renderStringDiffGroupG('方法签名 (...)..', sd.methodSignatures),
    renderStringDiffGroupG('源文件', sd.sourceFiles),
    renderStringDiffGroupG('标识符', sd.identifiers),
    renderStringDiffGroupG('其它', sd.other),
  ) as HTMLElement;
}

/* -------------------------------------------------------------------------- */
/* dependencies                                                                */
/* -------------------------------------------------------------------------- */

export function renderDependencies(d: PackageDiffReport): HTMLElement {
  if (!d.dependencies) return shell('依赖', emptyState('两侧均无 dependencies 信息'));
  const dep = d.dependencies;
  const empty = dep.hsp.added.length === 0 && dep.hsp.removed.length === 0 && dep.har.added.length === 0 && dep.har.removed.length === 0;
  if (empty) return shell('依赖', emptyState('依赖集合无变化'));

  const rows: Child[][] = [];
  for (const id of dep.hsp.added) rows.push([badge('HSP', 'primary'), badge('+ added', 'success'), h('code', null, id)]);
  for (const id of dep.hsp.removed) rows.push([badge('HSP', 'primary'), badge('− removed', 'danger'), h('code', null, id)]);
  for (const id of dep.har.added) rows.push([badge('HAR', 'info'), badge('+ added', 'success'), h('code', null, id)]);
  for (const id of dep.har.removed) rows.push([badge('HAR', 'info'), badge('− removed', 'danger'), h('code', null, id)]);

  return shell(
    '依赖',
    h(
      'div',
      { class: 'panel' },
      table(['类型', '状态', 'Name'], rows, [undefined, undefined, 'path']),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* warnings                                                                    */
/* -------------------------------------------------------------------------- */

export function renderWarnings(d: PackageDiffReport): HTMLElement {
  if (!d.warnings || d.warnings.length === 0) {
    return shell('警告', emptyState('差异计算过程未触发警告'));
  }
  return shell(
    '警告',
    h(
      'div',
      { class: 'panel' },
      table(
        ['Level', 'Code', 'Source', 'Message'],
        d.warnings.map((w) => [
          h('span', { class: `badge ${w.level === 'error' ? 'danger' : w.level === 'warn' ? 'warning' : 'info'}` }, w.level),
          h('code', null, w.code),
          w.source ? h('code', null, w.source) : '—',
          w.message,
        ]),
        [undefined, undefined, undefined, 'path'],
      ),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* utils                                                                       */
/* -------------------------------------------------------------------------- */

function shell(title: string, ...content: Array<Element | null>): HTMLElement {
  return h(
    'div',
    null,
    h('h2', { class: 'section-title' }, title),
    ...content.filter((x): x is Element => x !== null),
  ) as HTMLElement;
}

function countCard(
  label: string,
  count: number,
  variant: 'pos' | 'neg' | 'warn' | 'mute',
): HTMLElement {
  let value: HTMLElement;
  if (count === 0) value = h('span', { class: 'delta-zero' }, '0') as HTMLElement;
  else if (variant === 'pos') value = h('span', { class: 'delta-pos' }, `+${count.toLocaleString()}`) as HTMLElement;
  else if (variant === 'neg') value = h('span', { class: 'delta-neg' }, `−${count.toLocaleString()}`) as HTMLElement;
  else value = h('span', { class: variant === 'mute' ? 'delta-zero' : 'delta-pos' }, count.toLocaleString()) as HTMLElement;
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-label' }, label),
    h('div', { class: 'card-value' }, value),
  ) as HTMLElement;
}

function truncatedSuffix(actual: number, limit: number): string {
  return actual > limit ? `（已截断展示前 ${limit}，全量见 JSON）` : '';
}
