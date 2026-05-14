/**
 * Viewer helpers 单测（happy-dom 环境）。
 *
 * 这个套件存在的最大动机是 P0 级回归保护：
 * 之前 table() helper 把 cell 直接 append 到 <tr> 而没有包裹 <td>，导致浏览器把所有
 * cell 内容塞进首列。所以这里专门断言每个数据行 td 数量必须等于 headers 数量。
 */

import { describe, expect, it } from 'vitest';

import { badge, h, kv, ratioBar, table } from '../../src/viewer/helpers.js';

describe('viewer/helpers', () => {
  describe('h()', () => {
    it('创建普通 HTML 元素并应用 class / 属性 / children', () => {
      const el = h(
        'div',
        { class: 'foo', 'data-k': 'v' },
        'hello',
        h('span', null, 'world'),
      );
      expect(el.tagName).toBe('DIV');
      expect(el.className).toBe('foo');
      expect(el.getAttribute('data-k')).toBe('v');
      expect(el.textContent).toBe('helloworld');
      expect(el.querySelector('span')!.textContent).toBe('world');
    });

    it('SVG 标签使用 namespaced createElement', () => {
      const svg = h('svg', null, h('rect', null));
      expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    });

    it('过滤 null/undefined/false children，但保留 0 和 ""', () => {
      const el = h('p', null, null, undefined, false, 0, '');
      // 0 与 '' 都被转成文本节点
      expect(el.childNodes.length).toBe(2);
      expect(el.textContent).toBe('0');
    });
  });

  describe('table() — P0 回归保护', () => {
    it('每个 cell 必须被包裹成 <td>，且每行 td 数量等于 headers 数量', () => {
      const t = table(
        ['A', 'B', 'C'],
        [
          ['a1', 'b1', 'c1'],
          ['a2', 'b2', 'c2'],
        ],
      );
      const ths = t.querySelectorAll('thead th');
      const rows = t.querySelectorAll('tbody tr');
      expect(ths).toHaveLength(3);
      expect(rows).toHaveLength(2);

      for (const row of rows) {
        const tds = row.querySelectorAll('td');
        expect(tds).toHaveLength(3);
      }
    });

    it('混合的 string / Node child 都能正确变成 td 内容', () => {
      const t = table(
        ['Path', 'Bytes'],
        [['libs/a.so', 1024], [h('code', null, 'libs/b.so'), 2048]],
      );
      const tdMatrix = [...t.querySelectorAll('tbody tr')].map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => td.textContent),
      );
      expect(tdMatrix).toEqual([
        ['libs/a.so', '1024'],
        ['libs/b.so', '2048'],
      ]);
    });

    it('columnClasses 应同时作用于 th 和 td', () => {
      const t = table(
        ['Name', 'Bytes', ''],
        [['x', '100', 'bar']],
        [undefined, 'num', 'bar-col'],
      );
      const ths = [...t.querySelectorAll('thead th')];
      const tds = [...t.querySelectorAll('tbody td')];
      expect(ths[0]!.className).toBe('');
      expect(ths[1]!.className).toBe('num');
      expect(ths[2]!.className).toBe('bar-col');
      expect(tds[0]!.className).toBe('');
      expect(tds[1]!.className).toBe('num');
      expect(tds[2]!.className).toBe('bar-col');
    });

    it('table 根节点必须带 class="tbl"', () => {
      const t = table(['A'], [['a']]);
      expect(t.tagName).toBe('TABLE');
      expect(t.className).toBe('tbl');
    });

    it('空 rows 仅渲染表头', () => {
      const t = table(['A', 'B'], []);
      expect(t.querySelectorAll('tbody tr')).toHaveLength(0);
      expect(t.querySelectorAll('thead th')).toHaveLength(2);
    });
  });

  describe('badge / kv / ratioBar', () => {
    it('badge 默认无 variant', () => {
      const b = badge('hello');
      expect(b.tagName).toBe('SPAN');
      expect(b.className).toBe('badge');
      expect(b.textContent).toBe('hello');
    });

    it('badge variant 拼接到 class 上', () => {
      expect(badge('x', 'danger').className).toBe('badge danger');
      expect(badge('y', 'success').className).toBe('badge success');
    });

    it('kv 跳过 undefined / null / 空字符串值', () => {
      const dl = kv([
        ['A', 'a'],
        ['B', null],
        ['C', undefined],
        ['D', ''],
        ['E', 'e'],
      ]);
      const dts = dl.querySelectorAll('dt');
      const dds = dl.querySelectorAll('dd');
      expect(dts.length).toBe(2);
      expect(dds.length).toBe(2);
      expect([...dts].map((d) => d.textContent)).toEqual(['A', 'E']);
    });

    it('ratioBar 把比例 clamp 到 [0,1] 并写到 width style', () => {
      expect((ratioBar(0.5).querySelector('.fill') as HTMLElement).style.width).toBe(
        '50.00%',
      );
      // 越界值会被 clamp
      expect((ratioBar(1.5).querySelector('.fill') as HTMLElement).style.width).toBe(
        '100.00%',
      );
      expect((ratioBar(-1).querySelector('.fill') as HTMLElement).style.width).toBe(
        '0.00%',
      );
    });
  });
});
