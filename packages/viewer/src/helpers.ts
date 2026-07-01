/**
 * 视图层零依赖 DOM helper。
 *
 * 不引入 React / Vue / lit-html，原生 createElement + 函数组合即可，
 * 整个 viewer bundle 体积控制到 KB 级。
 */

export type Child =
  | string
  | number
  | Node
  | null
  | undefined
  | false
  | true
  | Child[];

export type Attrs = Record<
  string,
  string | number | boolean | null | undefined | EventListener
>;

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'g', 'rect', 'text', 'line', 'path', 'circle']);

/** 创建 DOM 元素，children 透传 string/number/Node/数组（递归扁平） */
export function h(tag: string, attrs?: Attrs | null, ...children: Child[]): HTMLElement | SVGElement {
  const el = SVG_TAGS.has(tag)
    ? document.createElementNS(SVG_NS, tag)
    : document.createElement(tag);

  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v === null || v === undefined) continue;
      if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'class') {
        (el as HTMLElement).className = String(v);
      } else if (v === true) {
        el.setAttribute(k, '');
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  appendChildren(el, children);
  return el;
}

export function appendChildren(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) {
      appendChildren(parent, child);
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
}

/* ------------------------------------------------------------------ */
/* 通用格式化                                                          */
/* ------------------------------------------------------------------ */

export function formatBytes(bytes: number, fractionDigits = 2): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const fixed = i === 0 ? value.toFixed(0) : value.toFixed(fractionDigits);
  return `${fixed} ${units[i]}`;
}

export function formatPercent(ratio: number, fractionDigits = 1): string {
  if (!Number.isFinite(ratio)) return '-';
  return `${(ratio * 100).toFixed(fractionDigits)}%`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function shortHash(hex: string, len = 12): string {
  if (typeof hex !== 'string' || hex.length <= len) return hex;
  return `${hex.slice(0, len)}…`;
}

/* ------------------------------------------------------------------ */
/* DOM 高阶 helper                                                     */
/* ------------------------------------------------------------------ */

/** 简易 key-value 列表 */
export function kv(pairs: Array<[string, Child]>): HTMLElement {
  const dl = h('dl', { class: 'kv' });
  for (const [k, v] of pairs) {
    if (v === undefined || v === null || v === '') continue;
    dl.appendChild(h('dt', null, k));
    dl.appendChild(h('dd', null, v));
  }
  return dl as HTMLElement;
}

export function badge(text: string, variant?: 'primary' | 'success' | 'warning' | 'danger' | 'info'): HTMLElement {
  return h('span', { class: variant ? `badge ${variant}` : 'badge' }, text) as HTMLElement;
}

export function ratioBar(ratio: number): HTMLElement {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  return h(
    'span',
    { class: 'bar', title: `${pct.toFixed(2)}%` },
    h('span', { class: 'fill', style: `width: ${pct.toFixed(2)}%` }),
  ) as HTMLElement;
}

export function emptyState(text: string): HTMLElement {
  return h('div', { class: 'empty' }, text) as HTMLElement;
}

/**
 * 简易表格构造器。
 *
 * 关键点：每个 cell 必须被包裹成 `<td>`（直接把 inline 节点 append 到 `<tr>` 浏览器会把所有内容
 * 错位塞进首列）。columnClasses 同时作用于对应列的 `<th>` 与 `<td>`，便于让数字列右对齐
 * （class="num"）或路径列等宽并允许换行（class="path"）。
 *
 * @param headers       表头文本数组
 * @param rows          每行的 cell 节点数组，长度建议与 headers 一致
 * @param columnClasses 可选列样式 class 数组（按列下标对应）
 */
export function table(
  headers: string[],
  rows: Child[][],
  columnClasses?: ReadonlyArray<string | undefined>,
): HTMLElement {
  const thead = h(
    'thead',
    null,
    h(
      'tr',
      null,
      ...headers.map((t, i) =>
        h('th', columnClasses?.[i] ? { class: columnClasses[i] } : null, t),
      ),
    ),
  );
  const tbody = h(
    'tbody',
    null,
    ...rows.map((r) =>
      h(
        'tr',
        null,
        ...r.map((cell, i) =>
          h('td', columnClasses?.[i] ? { class: columnClasses[i] } : null, cell),
        ),
      ),
    ),
  );
  return h('table', { class: 'tbl' }, thead, tbody) as HTMLElement;
}

/* ------------------------------------------------------------------ */
/* 分页表格                                                            */
/* ------------------------------------------------------------------ */

export interface PaginatedOpts {
  /** 每页行数，默认 50 */
  pageSize?: number;
  /** 初始页码（0 起），默认 0 */
  initialPage?: number;
  /** 行数为 0 时显示的空态文本；不传则不渲染空态而是返回 null wrapper */
  emptyMessage?: string;
}

/**
 * 通用分页容器：把任意 `items[]` 按 pageSize 切片后交给 `renderPage` 渲染，
 * 容器外层负责出"◀ 跳页输入 ▶"控件并在切页时只重渲染 body。
 *
 * 适合"全量符号 / 字符串列表 / section 列表"等纯客户端数据。
 */
export function paginated<T>(
  items: T[],
  renderPage: (pageItems: T[]) => HTMLElement,
  opts: PaginatedOpts = {},
): HTMLElement {
  const pageSize = opts.pageSize && opts.pageSize > 0 ? opts.pageSize : 50;
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  if (total === 0) {
    return emptyState(opts.emptyMessage ?? '无数据');
  }

  const wrapper = h('div', { class: 'paginated' }) as HTMLElement;
  const bodySlot = h('div', { class: 'paginated-body' }) as HTMLElement;
  let page = Math.min(Math.max(0, opts.initialPage ?? 0), totalPages - 1);

  function renderBody(): void {
    while (bodySlot.firstChild) bodySlot.removeChild(bodySlot.firstChild);
    const start = page * pageSize;
    const end = Math.min(total, start + pageSize);
    bodySlot.appendChild(renderPage(items.slice(start, end)));
  }

  wrapper.appendChild(bodySlot);

  if (totalPages > 1) {
    const controls = h('div', { class: 'paginated-controls' }) as HTMLElement;
    const prev = h('button', { class: 'page-btn', type: 'button' }, '◀') as HTMLButtonElement;
    const next = h('button', { class: 'page-btn', type: 'button' }, '▶') as HTMLButtonElement;
    const info = h('span', { class: 'page-info' }) as HTMLElement;
    const jumpInput = h('input', {
      class: 'page-jump',
      type: 'number',
      min: '1',
      max: String(totalPages),
      step: '1',
    }) as HTMLInputElement;
    const jumpLabel = h('span', { class: 'page-jump-label' }, ` / ${totalPages}`) as HTMLElement;

    function refreshControls(): void {
      const start = page * pageSize + 1;
      const end = Math.min(total, (page + 1) * pageSize);
      info.textContent = `第 ${start.toLocaleString()}–${end.toLocaleString()} 条 / 共 ${total.toLocaleString()}`;
      jumpInput.value = String(page + 1);
      prev.disabled = page === 0;
      next.disabled = page === totalPages - 1;
    }
    function goto(p: number): void {
      const target = Math.min(Math.max(0, p), totalPages - 1);
      if (target === page) return;
      page = target;
      renderBody();
      refreshControls();
    }

    prev.addEventListener('click', () => goto(page - 1));
    next.addEventListener('click', () => goto(page + 1));
    jumpInput.addEventListener('change', () => {
      const v = parseInt(jumpInput.value, 10);
      if (Number.isFinite(v)) goto(v - 1);
      else refreshControls();
    });
    jumpInput.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') {
        const v = parseInt(jumpInput.value, 10);
        if (Number.isFinite(v)) goto(v - 1);
      }
    });

    controls.appendChild(prev);
    controls.appendChild(h('span', { class: 'page-jump-wrap' }, '第 ', jumpInput, jumpLabel, ' 页'));
    controls.appendChild(next);
    controls.appendChild(info);
    wrapper.appendChild(controls);
    refreshControls();
  } else {
    const info = h('div', { class: 'paginated-controls' },
      h('span', { class: 'page-info' }, `共 ${total.toLocaleString()} 条`),
    );
    wrapper.appendChild(info);
  }

  renderBody();
  return wrapper;
}

/**
 * 分页表格：`paginated` 的特化，每页渲染一个 `<table>`。
 */
export function paginatedTable(
  headers: string[],
  rows: Child[][],
  columnClasses?: ReadonlyArray<string | undefined>,
  opts: PaginatedOpts = {},
): HTMLElement {
  return paginated(rows, (pageRows) => table(headers, pageRows, columnClasses), opts);
}
