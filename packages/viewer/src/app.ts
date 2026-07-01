import type { PackageReport, Platform } from '@kingsdk/shared/schema.js';

import { createAiPanel } from './ai-panel.js';
import { h } from './helpers.js';
import { renderAbc } from './sections/abc.js';
import { renderDependencies } from './sections/dependencies.js';
import { renderDex } from './sections/dex.js';
import { renderIl2cpp } from './sections/il2cpp.js';
import { renderManifest } from './sections/manifest.js';
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
  count?: (r: PackageReport) => number | string | undefined;
  render: (r: PackageReport) => HTMLElement;
  /**
   * 该 section 适用的平台白名单。缺省 = 所有平台都显示。
   *
   * 一期约定：HarmonyOS 专属维度（ets/abc、rawfile、HarmonyOS 的 hsp/har 依赖）
   * 只在 harmony 报告下显示；通用维度（size、native libs、签名、权限…）跨平台显示。
   * il2cpp 是 Unity 引擎产物，HarmonyOS / Android 都可能出现，按跨平台处理。
   */
  platforms?: Platform[];
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
    id: 'manifest',
    label: 'Manifest',
    count: (r) =>
      (r.androidManifest?.usesPermissions?.length ?? 0) +
      ((r.androidManifest?.components?.activities.length ?? 0) +
        (r.androidManifest?.components?.services.length ?? 0) +
        (r.androidManifest?.components?.receivers.length ?? 0) +
        (r.androidManifest?.components?.providers.length ?? 0)),
    render: renderManifest,
    platforms: ['android'],
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
    platforms: ['harmony'],
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
    platforms: ['harmony'],
  },
  {
    id: 'dex',
    label: 'DEX',
    count: (r) => r.dex?.fileCount,
    render: renderDex,
    platforms: ['android'],
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
    platforms: ['harmony'],
  },
  {
    id: 'warnings',
    label: '警告',
    count: (r) => r.warnings.length,
    render: renderWarnings,
  },
];

/**
 * 根据 report.platform 过滤 SECTIONS。
 * 未声明 platform 的老报告按 'harmony' 处理（向后兼容）。
 */
function pickSections(report: PackageReport): SectionDef[] {
  const p: Platform = report.platform ?? 'harmony';
  return SECTIONS.filter((s) => !s.platforms || s.platforms.includes(p));
}

export function mountApp(root: HTMLElement, report: PackageReport): void {
  root.innerHTML = '';

  const sections = pickSections(report);
  const ai = createAiPanel({ defaultPrompt: '帮我总结分析这个包的内容' });
  const sidebar = renderSidebar(report, sections);
  const main = renderMain(report, sections, ai.trigger);

  const app = h('div', { class: 'app' }, sidebar, main);
  root.appendChild(app);
  document.body.appendChild(ai.drawer);

  const initial = parseHash(sections) ?? 'overview';
  activateSection(initial);

  window.addEventListener('hashchange', () => {
    const id = parseHash(sections) ?? 'overview';
    activateSection(id);
  });
}

function renderSidebar(report: PackageReport, sections: SectionDef[]): HTMLElement {
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

  const navItems = sections.map((s) => {
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

function renderMain(
  report: PackageReport,
  sections: SectionDef[],
  aiTrigger: HTMLElement,
): HTMLElement {
  const platform: Platform = report.platform ?? 'harmony';
  const topbar = h(
    'div',
    { class: 'topbar' },
    h('h1', null, report.basic?.bundleName || '(unknown bundle)'),
    report.basic
      ? h('span', { class: 'badge primary' }, `${report.basic.versionName} (${report.basic.versionCode})`)
      : null,
    h('span', { class: `badge platform platform-${platform}` }, platformLabel(platform)),
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
    h('span', { class: 'topbar-spacer' }),
    aiTrigger,
  );

  const sectionEls = sections.map((s) =>
    h('section', { class: 'section', 'data-section': s.id, id: `section-${s.id}` }, s.render(report)),
  );

  return h('main', { class: 'main' }, topbar, ...sectionEls) as HTMLElement;
}

function activateSection(id: string): void {
  document.querySelectorAll('[data-section]').forEach((el) => {
    el.classList.toggle('active', el.getAttribute('data-section') === id);
  });
  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.classList.toggle('active', el.getAttribute('data-nav') === id);
  });
}

function parseHash(sections: SectionDef[]): string | null {
  const h = window.location.hash;
  if (!h || h.length < 2) return null;
  const id = h.slice(1);
  return sections.some((s) => s.id === id) ? id : null;
}

function platformLabel(p: Platform): string {
  switch (p) {
    case 'harmony':
      return 'HarmonyOS';
    case 'android':
      return 'Android';
    case 'ios':
      return 'iOS';
    default:
      return p;
  }
}
