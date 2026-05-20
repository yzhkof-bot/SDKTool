import type { PackageReport, RawfileCategory } from '../../shared/schema.js';

import { emptyState, formatBytes, formatPercent, h, ratioBar, table } from '../helpers.js';

/** 类别色板 + 中文标签 */
const CATEGORY_META: Record<RawfileCategory, { color: string; label: string }> = {
  'il2cpp-metadata': { color: '#ef4444', label: 'il2cpp 元数据' },
  'asset-bundle': { color: '#f59e0b', label: 'AssetBundle' },
  'qts-vfs': { color: '#5b8cff', label: 'QTS VFS 数据' },
  'streaming-asset': { color: '#10b981', label: 'StreamingAssets' },
  'ai-model': { color: '#8b5cf6', label: 'AI 模型' },
  script: { color: '#06b6d4', label: '脚本' },
  texture: { color: '#ec4899', label: '压缩纹理' },
  image: { color: '#84cc16', label: '通用图片' },
  audio: { color: '#fb923c', label: '音频' },
  video: { color: '#a855f7', label: '视频' },
  data: { color: '#6b7280', label: '通用数据' },
  other: { color: '#94a3b8', label: '其它' },
};

/** 顶层分组色板：按"游戏感"分配几种区分度高的色 */
const GROUP_COLORS = [
  '#5b8cff',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#8b5cf6',
  '#06b6d4',
  '#84cc16',
  '#fb923c',
  '#ef4444',
  '#a855f7',
  '#6b7280',
];

export function renderRawfile(report: PackageReport): HTMLElement {
  const rf = report.rawfile;
  if (!rf || rf.fileCount === 0) {
    return emptyState('hap 内未发现 resources/rawfile/ 资源') as HTMLElement;
  }

  // 顶部统计卡
  const summaryCards = h(
    'div',
    { class: 'card-grid' },
    statCard('Rawfile 文件数', String(rf.fileCount)),
    statCard('Rawfile 总体积', formatBytes(rf.totalBytes)),
    statCard('顶层分组数', String(rf.topLevelGroups.length)),
    statCard('类别数', String(rf.categories.length)),
    rf.packages
      ? statCard('配置包', String(rf.packages.length), 'Data/Package/* 聚合')
      : null,
  );

  // 顶层分组堆叠条 + 表
  const groupBar = h(
    'div',
    { class: 'stacked-bar' },
    ...rf.topLevelGroups.map((g, i) => {
      const pct = g.ratio * 100;
      const color = GROUP_COLORS[i % GROUP_COLORS.length]!;
      return h(
        'div',
        {
          class: 'seg',
          style: `width: ${pct.toFixed(2)}%; background: ${color}`,
          title: `${g.path}: ${formatBytes(g.bytes)} (${pct.toFixed(2)}%)`,
        },
        pct >= 8 ? g.path : '',
      );
    }),
  );

  const groupLegend = h(
    'div',
    { class: 'legend' },
    ...rf.topLevelGroups.map((g, i) =>
      h(
        'span',
        null,
        h('span', {
          class: 'swatch',
          style: `background: ${GROUP_COLORS[i % GROUP_COLORS.length]!}`,
        }),
        `${g.path} · ${formatBytes(g.bytes)} · ${formatPercent(g.ratio)}`,
      ),
    ),
  );

  const groupTable = table(
    ['顶层路径', '文件数', '体积', '占比', ''],
    rf.topLevelGroups.map((g) => [
      h('code', null, g.path),
      String(g.fileCount),
      formatBytes(g.bytes),
      formatPercent(g.ratio),
      ratioBar(g.ratio),
    ]),
    ['path', 'num', 'num', 'num', 'bar-col'],
  );

  // 类别卡片 + 表
  const categoryCards = h(
    'div',
    { class: 'card-grid' },
    ...rf.categories.map((c) => {
      const meta = CATEGORY_META[c.category] ?? CATEGORY_META.other;
      return h(
        'div',
        {
          class: 'card',
          style: `border-left: 4px solid ${meta.color};`,
        },
        h('div', { class: 'card-label' }, meta.label),
        h('div', { class: 'card-value' }, formatBytes(c.bytes)),
        h(
          'div',
          { class: 'card-sub' },
          `${c.fileCount} 个文件 · ${formatPercent(c.ratio)}`,
        ),
      );
    }),
  );

  // 扩展名分布表（前 20 项）
  const topExt = rf.byExtension.slice(0, 20);
  const extTable = table(
    ['扩展名', '文件数', '体积', '占比', ''],
    topExt.map((e) => [
      h('code', null, e.ext),
      String(e.fileCount),
      formatBytes(e.bytes),
      formatPercent(e.ratio),
      ratioBar(e.ratio),
    ]),
    [undefined, 'num', 'num', 'num', 'bar-col'],
  );

  // Top N 文件
  const topFiles = table(
    ['路径', '类别', '体积', '占比', ''],
    rf.topFiles.map((f) => {
      const meta = CATEGORY_META[f.category] ?? CATEGORY_META.other;
      return [
        f.path,
        h(
          'span',
          {
            class: 'badge',
            style: `background: ${meta.color}26; color: ${meta.color};`,
          },
          meta.label,
        ),
        formatBytes(f.bytes),
        formatPercent(f.ratio),
        ratioBar(f.ratio),
      ];
    }),
    ['path', undefined, 'num', 'num', 'bar-col'],
  );

  // 配置包聚合（如有）
  const packagesPanel = rf.packages
    ? h(
        'section',
        { class: 'panel' },
        h(
          'h3',
          { class: 'panel-title' },
          `Top ${rf.packages.length} 配置包（Data/Package/*）`,
        ),
        table(
          ['Package ID', '文件数', '体积'],
          rf.packages.map((p) => [
            h('code', null, p.packageId),
            String(p.fileCount),
            formatBytes(p.bytes),
          ]),
          [undefined, 'num', 'num'],
        ),
      )
    : null;

  return h(
    'div',
    null,
    h(
      'section',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, 'Rawfile 概览'),
      summaryCards,
    ),
    h(
      'section',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, '顶层分组'),
      groupBar,
      groupLegend,
      h('div', { style: 'margin-top: 12px;' }, groupTable),
    ),
    h(
      'section',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, '资源类别（启发式识别）'),
      categoryCards,
    ),
    h(
      'section',
      { class: 'panel' },
      h(
        'h3',
        { class: 'panel-title' },
        `扩展名分布（Top ${topExt.length}/${rf.byExtension.length}）`,
      ),
      extTable,
    ),
    h(
      'section',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, `Top ${rf.topFiles.length} 大文件`),
      topFiles,
    ),
    packagesPanel,
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
