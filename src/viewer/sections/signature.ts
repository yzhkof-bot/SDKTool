import type { HapReport } from '../../shared/schema.js';

import { emptyState, h, kv } from '../helpers.js';

export function renderSignature(report: HapReport): HTMLElement {
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
        h('span', { class: 'badge warning' }, '未签名'),
        ' 未在 META-INF/ 下检测到签名文件，通常是开发包。',
      ),
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
      h('span', { class: 'badge success' }, '已签名'),
      hasCert ? null : h('span', { style: 'margin-left: 8px;' }, h('span', { class: 'badge info' }, 'X.509 信息未解码')),
    ),
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
