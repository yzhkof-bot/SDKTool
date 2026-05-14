import type { DeltaNumber } from '../../shared/schema.js';

import { formatBytes, formatPercent, h } from '../helpers.js';

/**
 * 把 number 渲染为带颜色与符号的 delta 文本节点。
 *
 * - delta = 0 → muted "0"
 * - delta > 0 → 红色 "+1.23"
 * - delta < 0 → 绿色 "-1.23"
 *
 * 视觉惯例：增加 = 危险（包变大）红、减少 = 好（瘦身）绿。
 */
export function deltaText(value: number, opts: { format?: (v: number) => string } = {}): HTMLElement {
  const fmt = opts.format ?? ((v) => String(v));
  if (value === 0) return h('span', { class: 'delta-zero' }, fmt(0)) as HTMLElement;
  const sign = value > 0 ? '+' : '−';
  const abs = Math.abs(value);
  return h(
    'span',
    { class: value > 0 ? 'delta-pos' : 'delta-neg' },
    `${sign}${fmt(abs)}`,
  ) as HTMLElement;
}

export function deltaBytes(value: number): HTMLElement {
  return deltaText(value, { format: (v) => formatBytes(v) });
}

export function deltaCount(value: number): HTMLElement {
  return deltaText(value, { format: (v) => v.toLocaleString() });
}

export function deltaRatio(ratio: number | null): HTMLElement {
  if (ratio === null) return h('span', { class: 'delta-zero' }, '—') as HTMLElement;
  if (ratio === 0) return h('span', { class: 'delta-zero' }, '0%') as HTMLElement;
  const cls = ratio > 0 ? 'delta-pos' : 'delta-neg';
  const sign = ratio > 0 ? '+' : '−';
  return h('span', { class: cls }, `${sign}${formatPercent(Math.abs(ratio))}`) as HTMLElement;
}

/** From → To 文本（用于普通字段对比，不染色） */
export function fromTo(from: unknown, to: unknown): HTMLElement {
  return h(
    'span',
    null,
    h('code', null, formatScalar(from)),
    h('span', { class: 'delta-zero' }, ' → '),
    h('code', null, formatScalar(to)),
  ) as HTMLElement;
}

export function formatScalar(v: unknown): string {
  if (v === undefined || v === null) return '∅';
  if (Array.isArray(v)) return v.length === 0 ? '[]' : `[${v.join(', ')}]`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/* 整数标量 + 比例条 */
export function deltaWithRatio(d: DeltaNumber, fmt: (v: number) => string = formatBytes): HTMLElement {
  return h(
    'span',
    null,
    h('code', null, fmt(d.from)),
    h('span', { class: 'delta-zero' }, ' → '),
    h('code', null, fmt(d.to)),
    '  ',
    deltaText(d.delta, { format: fmt }),
    '  ',
    deltaRatio(d.ratio),
  ) as HTMLElement;
}
