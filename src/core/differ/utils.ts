import type { DeltaNumber } from '../../shared/schema.js';

/**
 * 构造标量 delta 结构。
 *
 * - `delta = to - from`
 * - `ratio = (to - from) / from`，from === 0 时定义为 null（对应 +∞ 增长，前端渲染时显示为 "—"）
 */
export function numberDelta(from: number, to: number): DeltaNumber {
  const delta = to - from;
  let ratio: number | null;
  if (from === 0) {
    ratio = to === 0 ? 0 : null;
  } else {
    ratio = delta / from;
  }
  return { from, to, delta, ratio };
}

/**
 * 列表差集（按字符串 key）。返回不变 / 新增 / 删除三段，**保持输入顺序**。
 */
export function listDiff(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): { added: string[]; removed: string[]; unchanged: string[] } {
  const ls = new Set(left);
  const rs = new Set(right);
  const added: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  for (const v of left) if (!rs.has(v)) removed.push(v);
  for (const v of right) if (!ls.has(v)) added.push(v);
  for (const v of left) if (rs.has(v)) unchanged.push(v);
  return { added, removed, unchanged };
}

/** 把数组按 key 函数变成 Map，重复 key 取后者覆盖前者（与 lodash.keyBy 行为一致） */
export function keyBy<T>(arr: ReadonlyArray<T>, key: (item: T) => string): Map<string, T> {
  const m = new Map<string, T>();
  for (const item of arr) m.set(key(item), item);
  return m;
}
