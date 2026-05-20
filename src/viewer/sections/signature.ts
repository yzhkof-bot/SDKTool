import type { PackageReport, PackageSignatureInfo } from '../../shared/schema.js';

import { badge, emptyState, formatBytes, h, kv, table } from '../helpers.js';

export function renderSignature(report: PackageReport): HTMLElement {
  const s = report.signature;
  if (!s) return emptyState('无 signature 数据');

  if (!s.present) {
    return h(
      'section',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, '签名状态'),
      h(
        'div',
        null,
        badge('未签名', 'warning'),
        ' 未在 META-INF/ 下检测到签名文件，通常是开发包。',
      ),
      // Android 未签也展示 versions（如果有），便于在 viewer 顶部直接看到"4 个 false"
      s.versions ? renderAndroidVersions(s) : null,
    ) as HTMLElement;
  }

  const hasCert = !!s.subject;

  return h(
    'div',
    null,
    h(
      'section',
      { class: 'panel' },
      h('h3', { class: 'panel-title' }, '签名状态'),
      badge('已签名', 'success'),
      hasCert
        ? null
        : h('span', { style: 'margin-left: 8px;' }, badge('X.509 信息未解码', 'info')),
    ),
    // Android 多签名方案概览（v1/v2/v3/v3.1）
    s.versions ? renderAndroidVersions(s) : null,
    // APK Signing Block 内 ID-value 表（仅 Android 且存在 block 时）
    s.signingBlock ? renderSigningBlock(s) : null,
    hasCert
      ? h(
          'section',
          { class: 'panel' },
          h('h3', { class: 'panel-title' }, '叶子证书（启发式提取）'),
          kv([
            ['Subject', s.subject ? h('code', null, s.subject) : '—'],
            ['Issuer', s.issuer ? h('code', null, s.issuer) : '—'],
            ['Valid From', s.notBefore ?? '—'],
            ['Valid To', s.notAfter ?? '—'],
          ]),
        )
      : null,
  ) as HTMLElement;
}

/**
 * Android 多版本签名 scheme 命中概览（v1/v2/v3/v3.1）。
 *
 * 每个 scheme 用一个 badge：命中=success 绿、未命中=灰 default。
 */
function renderAndroidVersions(s: PackageSignatureInfo): HTMLElement {
  const v = s.versions!;
  const tag = (label: string, on: boolean) =>
    h('span', { style: 'margin-right: 6px;' }, badge(label, on ? 'success' : undefined));
  return h(
    'section',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, 'Android 签名方案'),
    h(
      'div',
      null,
      tag('v1 (META-INF)', v.v1),
      tag('v2', v.v2),
      tag('v3', v.v3),
      tag('v3.1', v.v31),
    ),
    h(
      'p',
      { class: 'panel-desc' },
      'v1 来自 META-INF/*.RSA + .SF，v2/v3/v3.1 来自 APK Signing Block 内对应 ID-pair。',
    ),
  ) as HTMLElement;
}

function renderSigningBlock(s: PackageSignatureInfo): HTMLElement {
  const block = s.signingBlock!;
  const rows = block.entries.map((e) => [
    h('code', null, e.idHex),
    e.name === 'unknown' ? badge(e.name, 'info') : badge(e.name, 'primary'),
    formatBytes(e.sizeBytes),
  ]);
  return h(
    'section',
    { class: 'panel' },
    h('h3', { class: 'panel-title' }, 'APK Signing Block'),
    h(
      'div',
      { class: 'card-grid' },
      statCard('总大小', formatBytes(block.totalBytes)),
      statCard('偏移 (file)', '0x' + block.offset.toString(16)),
      statCard('Pair 数', String(block.entries.length)),
    ),
    table(
      ['Pair ID', '名称', 'Value 字节'],
      rows,
      [undefined, undefined, 'num'],
    ),
  ) as HTMLElement;
}

function statCard(label: string, value: string): HTMLElement {
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-label' }, label),
    h('div', { class: 'card-value' }, value),
  ) as HTMLElement;
}
