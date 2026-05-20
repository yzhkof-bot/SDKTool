import type { PackageDiffReport } from '../../shared/schema.js';

import { h } from '../helpers.js';

import { createAiPanel } from './ai-panel.js';
import {
  renderAbc,
  renderBasic,
  renderDependencies,
  renderDex,
  renderFiles,
  renderIl2cpp,
  renderNativeLibs,
  renderOverview,
  renderPermissions,
  renderRawfile,
  renderResources,
  renderSignature,
  renderSize,
  renderWarnings,
} from './sections.js';

interface SectionDef {
  id: string;
  label: string;
  /** 侧栏右侧的简短计数文本，可选 */
  count?: (d: PackageDiffReport) => string | number | undefined;
  /** 该 section 是否需要警示样式（有显著变化时） */
  attention?: (d: PackageDiffReport) => boolean;
  render: (d: PackageDiffReport) => HTMLElement;
}

const SECTIONS: SectionDef[] = [
  { id: 'overview', label: '概览', render: renderOverview },
  {
    id: 'basic',
    label: 'Basic',
    count: (d) => d.basic?.changed.length,
    render: renderBasic,
  },
  {
    id: 'size',
    label: '体积',
    count: (d) => (d.size ? formatSignedBytes(d.size.total.delta) : undefined),
    render: renderSize,
  },
  {
    id: 'files',
    label: 'Files',
    count: (d) =>
      d.files
        ? `${d.files.totals.added}+/${d.files.totals.removed}−/${d.files.totals.changed}~`
        : undefined,
    render: renderFiles,
  },
  {
    id: 'permissions',
    label: '权限',
    count: (d) =>
      d.permissions
        ? `${d.permissions.added.length}+/${d.permissions.removed.length}−`
        : undefined,
    render: renderPermissions,
  },
  {
    id: 'resources',
    label: '资源',
    count: (d) => (d.resources ? formatSignedBytes(d.resources.images.bytes.delta + d.resources.media.bytes.delta) : undefined),
    render: renderResources,
  },
  {
    id: 'rawfile',
    label: 'Rawfile',
    count: (d) => (d.rawfile ? formatSignedBytes(d.rawfile.totalBytes.delta) : undefined),
    render: renderRawfile,
  },
  {
    id: 'nativeLibs',
    label: 'Native',
    count: (d) =>
      d.nativeLibs
        ? `${d.nativeLibs.added.length}+/${d.nativeLibs.removed.length}−/${d.nativeLibs.changed.length}~`
        : undefined,
    render: renderNativeLibs,
  },
  {
    id: 'abc',
    label: 'ABC',
    count: (d) => (d.abc?.modulesAbc.delta != null ? formatSignedBytes(d.abc.modulesAbc.delta) : undefined),
    render: renderAbc,
  },
  {
    id: 'il2cpp',
    label: 'IL2CPP',
    count: (d) =>
      d.il2cppMetadata
        ? `${d.il2cppMetadata.totals.changed}/${d.il2cppMetadata.totals.total}`
        : undefined,
    render: renderIl2cpp,
  },
  {
    id: 'dex',
    label: 'DEX',
    count: (d) => {
      if (!d.dex && !d.dexDetails) return undefined;
      const fileLevel = d.dex
        ? `${d.dex.added.length}+/${d.dex.removed.length}−/${d.dex.changed.length}~`
        : '';
      const methodLevel = d.dexDetails
        ? `m ${d.dexDetails.totals.methodsAdded}+/${d.dexDetails.totals.methodsRemoved}−/${d.dexDetails.totals.methodsChanged}~`
        : '';
      return [fileLevel, methodLevel].filter(Boolean).join(' · ') || undefined;
    },
    render: renderDex,
  },
  {
    id: 'signature',
    label: '签名',
    count: (d) =>
      d.signature
        ? d.signature.fields.some((f) => f.changed) || d.signature.presentChanged
          ? '⚠'
          : '✓'
        : undefined,
    render: renderSignature,
  },
  {
    id: 'dependencies',
    label: '依赖',
    count: (d) =>
      d.dependencies
        ? `${d.dependencies.hsp.added.length + d.dependencies.har.added.length}+/${
            d.dependencies.hsp.removed.length + d.dependencies.har.removed.length
          }−`
        : undefined,
    render: renderDependencies,
  },
  {
    id: 'warnings',
    label: '警告',
    count: (d) => d.warnings?.length || undefined,
    render: renderWarnings,
  },
];

export function mountDiffApp(root: HTMLElement, diff: PackageDiffReport): void {
  root.innerHTML = '';

  const ai = createAiPanel();

  const sidebar = renderSidebar(diff);
  const main = renderMain(diff, ai.trigger);
  root.appendChild(h('div', { class: 'app' }, sidebar, main));
  document.body.appendChild(ai.drawer);

  const initial = parseHash() ?? 'overview';
  activate(initial);

  window.addEventListener('hashchange', () => activate(parseHash() ?? 'overview'));
}

function renderSidebar(d: PackageDiffReport): HTMLElement {
  const header = h(
    'div',
    { class: 'sidebar-header' },
    h('div', { class: 'title' }, 'KingSDK Hap Diff'),
    h(
      'div',
      { class: 'subtitle' },
      d.summary.versionLine ?? `${shortFile(d.left.meta.file)} → ${shortFile(d.right.meta.file)}`,
    ),
  );

  const navItems = SECTIONS.map((s) => {
    const c = s.count?.(d);
    return h(
      'a',
      { class: 'nav-item', href: `#${s.id}`, 'data-nav': s.id },
      h('span', null, s.label),
      c !== undefined && c !== null && c !== '' ? h('span', { class: 'count' }, String(c)) : null,
    );
  });

  return h('aside', { class: 'sidebar' }, header, ...navItems) as HTMLElement;
}

function renderMain(d: PackageDiffReport, aiTrigger: HTMLElement): HTMLElement {
  const topbar = h(
    'div',
    { class: 'topbar' },
    h('h1', null, 'Hap 对比报告'),
    d.summary.versionLine ? h('span', { class: 'badge primary' }, d.summary.versionLine) : null,
    d.summary.identical ? h('span', { class: 'badge success' }, '✓ identical') : null,
    h('span', { class: 'meta-chip' }, 'tool ', h('code', null, d.toolVersion)),
    h('span', { class: 'topbar-spacer' }),
    aiTrigger,
  );

  const sections = SECTIONS.map((s) =>
    h('section', { class: 'section', 'data-section': s.id, id: `section-${s.id}` }, s.render(d)),
  );

  return h('main', { class: 'main' }, topbar, ...sections) as HTMLElement;
}

function activate(id: string): void {
  document.querySelectorAll('[data-section]').forEach((el) => {
    el.classList.toggle('active', el.getAttribute('data-section') === id);
  });
  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.classList.toggle('active', el.getAttribute('data-nav') === id);
  });
}

function parseHash(): string | null {
  const h = window.location.hash;
  if (!h || h.length < 2) return null;
  const id = h.slice(1);
  return SECTIONS.some((s) => s.id === id) ? id : null;
}

function shortFile(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function formatSignedBytes(bytes: number): string {
  const sign = bytes > 0 ? '+' : bytes < 0 ? '−' : '';
  const abs = Math.abs(bytes);
  if (abs === 0) return '0';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let v = abs;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${sign}${i === 0 ? v.toFixed(0) : v.toFixed(1)}${units[i]}`;
}
