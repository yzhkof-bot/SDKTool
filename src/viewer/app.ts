import type { HapReport } from '../shared/schema.js';

import { h } from './helpers.js';
import { renderAbc } from './sections/abc.js';
import { renderDependencies } from './sections/dependencies.js';
import { renderIl2cpp } from './sections/il2cpp.js';
import { renderNativeLibs } from './sections/nativeLibs.js';
import { renderOverview } from './sections/overview.js';
import { renderPermissions } from './sections/permissions.js';
import { renderRawfile } from './sections/rawfile.js';
import { renderResources } from './sections/resources.js';
import { renderSignature } from './sections/signature.js';
import { renderSize } from './sections/size.js';
import { renderWarnings } from './sections/warnings.js';

interface SectionDef {
  id: string;
  label: string;
  count?: (r: HapReport) => number | string | undefined;
  render: (r: HapReport) => HTMLElement;
}

const SECTIONS: SectionDef[] = [
  { id: 'overview', label: '概览', render: renderOverview },
  {
    id: 'size',
    label: '体积',
    count: (r) => r.size?.fileCount,
    render: renderSize,
  },
  {
    id: 'permissions',
    label: '权限',
    count: (r) => r.permissions?.length,
    render: renderPermissions,
  },
  {
    id: 'resources',
    label: '资源',
    count: (r) => (r.resources?.images.count ?? 0) + (r.resources?.media.count ?? 0),
    render: renderResources,
  },
  {
    id: 'rawfile',
    label: 'Rawfile',
    count: (r) => r.rawfile?.fileCount,
    render: renderRawfile,
  },
  {
    id: 'nativeLibs',
    label: 'Native',
    count: (r) => r.nativeLibs?.libs.length,
    render: renderNativeLibs,
  },
  {
    id: 'abc',
    label: 'ABC',
    count: (r) => (r.abc?.modulesAbc ? 1 : 0) + (r.abc?.extraAbcFiles.length ?? 0),
    render: renderAbc,
  },
  {
    id: 'il2cpp',
    label: 'IL2CPP',
    count: (r) => r.il2cppMetadata?.files.length,
    render: renderIl2cpp,
  },
  {
    id: 'signature',
    label: '签名',
    count: (r) => (r.signature?.present ? '已签' : '未签'),
    render: renderSignature,
  },
  {
    id: 'dependencies',
    label: '依赖',
    count: (r) => (r.dependencies ? r.dependencies.hsp.length + r.dependencies.har.length : 0),
    render: renderDependencies,
  },
  {
    id: 'warnings',
    label: '警告',
    count: (r) => r.warnings.length,
    render: renderWarnings,
  },
];

export function mountApp(root: HTMLElement, report: HapReport): void {
  root.innerHTML = '';

  const sidebar = renderSidebar(report);
  const main = renderMain(report);

  const app = h('div', { class: 'app' }, sidebar, main);
  root.appendChild(app);

  const initial = parseHash() ?? 'overview';
  activateSection(initial);

  window.addEventListener('hashchange', () => {
    const id = parseHash() ?? 'overview';
    activateSection(id);
  });
}

function renderSidebar(report: HapReport): HTMLElement {
  const header = h(
    'div',
    { class: 'sidebar-header' },
    h('div', { class: 'title' }, report.basic?.bundleName || 'Hap Report'),
    h(
      'div',
      { class: 'subtitle' },
      report.basic
        ? `${report.basic.versionName} · code ${report.basic.versionCode}`
        : 'KingSDK Hap Viewer',
    ),
  );

  const navItems = SECTIONS.map((s) => {
    const c = s.count?.(report);
    const item = h(
      'a',
      { class: 'nav-item', href: `#${s.id}`, 'data-nav': s.id },
      h('span', null, s.label),
      c !== undefined && c !== null && c !== '' ? h('span', { class: 'count' }, String(c)) : null,
    );
    return item;
  });

  return h('aside', { class: 'sidebar' }, header, ...navItems) as HTMLElement;
}

function renderMain(report: HapReport): HTMLElement {
  const topbar = h(
    'div',
    { class: 'topbar' },
    h('h1', null, report.basic?.bundleName || '(unknown bundle)'),
    report.basic
      ? h('span', { class: 'badge primary' }, `${report.basic.versionName} (${report.basic.versionCode})`)
      : null,
    h(
      'span',
      { class: 'meta-chip' },
      'sha256: ',
      h('code', { title: report.meta.sha256 }, report.meta.sha256.slice(0, 12) + '…'),
    ),
    h(
      'span',
      { class: 'meta-chip' },
      'tool ',
      h('code', null, report.meta.toolVersion),
    ),
  );

  const sections = SECTIONS.map((s) =>
    h('section', { class: 'section', 'data-section': s.id, id: `section-${s.id}` }, s.render(report)),
  );

  return h('main', { class: 'main' }, topbar, ...sections) as HTMLElement;
}

function activateSection(id: string): void {
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
