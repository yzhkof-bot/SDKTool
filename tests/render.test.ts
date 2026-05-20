import { describe, expect, it } from 'vitest';

import {
  DATA_PLACEHOLDER,
  renderReportHtml,
  serializeForHtml,
} from '../src/cli/utils/render.js';
import type { PackageReport } from '../src/shared/schema.js';

const SAMPLE_REPORT: PackageReport = {
  schemaVersion: '1.0',
  meta: {
    file: '/tmp/demo.hap',
    fileSize: 12345,
    sha256: 'a'.repeat(64),
    analyzedAt: '2026-01-01T00:00:00.000Z',
    toolVersion: '0.1.0',
  },
  warnings: [],
};

const MINI_TEMPLATE =
  `<html><head><title>X</title></head><body><script id="__DATA__" type="application/json">${DATA_PLACEHOLDER}</script></body></html>`;

describe('renderReportHtml', () => {
  it('用注入数据替换占位符', () => {
    const html = renderReportHtml(SAMPLE_REPORT, { template: MINI_TEMPLATE });
    expect(html).not.toContain(DATA_PLACEHOLDER);
    expect(html).toContain('"schemaVersion":"1.0"');
    expect(html).toContain(SAMPLE_REPORT.meta.file);
  });

  it('当 JSON 中含有 </script> 时仍安全', () => {
    const evil = {
      ...SAMPLE_REPORT,
      meta: {
        ...SAMPLE_REPORT.meta,
        file: '</script><script>alert(1)</script>',
      },
    };
    const html = renderReportHtml(evil, { template: MINI_TEMPLATE });
    // 不应出现一个未被转义的 </script> 把外层 script 提前关闭
    // 提取 __DATA__ 占位附近后第一个 </script>
    const dataStart = html.indexOf('id="__DATA__"');
    const dataEnd = html.indexOf('</script>', dataStart);
    expect(dataEnd).toBeGreaterThan(dataStart);
    // dataEnd 之间不应再含有未转义 </script>
    const between = html.slice(dataStart, dataEnd);
    expect(between.match(/<\/script/gi)).toBeNull();
  });

  it('U+2028 / U+2029 等行分隔符被转义', () => {
    const fancy = { ...SAMPLE_REPORT };
    fancy.meta = { ...fancy.meta, file: 'a\u2028b\u2029c' };
    const html = renderReportHtml(fancy, { template: MINI_TEMPLATE });
    expect(html).not.toContain('\u2028');
    expect(html).not.toContain('\u2029');
    expect(html).toContain('\\u2028');
    expect(html).toContain('\\u2029');
  });

  it('默认模板（构建后）含 __DATA__ 占位且替换后可解析为 PackageReport', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const tplPath = resolve('templates/report.template.html');
    if (!existsSync(tplPath)) {
      console.warn('[skip] templates/report.template.html 不存在，请先 npm run build');
      return;
    }
    const html = renderReportHtml(SAMPLE_REPORT);
    expect(html).toContain('id="__DATA__"');

    // 提取 __DATA__ 节点内容，反向解析回 JSON：必须能 JSON.parse 成功
    const m = html.match(/id="__DATA__"[^>]*>([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    const parsed = JSON.parse(m![1]!);
    expect(parsed.schemaVersion).toBe('1.0');
    expect(parsed.meta.file).toBe(SAMPLE_REPORT.meta.file);

    // viewer JS bundle 中可能仍出现 placeholder 字面量（main.ts 中的运行时检测代码）
    // 但 __DATA__ 节点内不应再含未替换的 placeholder
    expect(m![1]!).not.toContain(DATA_PLACEHOLDER);
  });

  it('模板缺占位符时抛错', () => {
    expect(() => renderReportHtml(SAMPLE_REPORT, { template: '<html></html>' })).toThrow(
      /占位符/,
    );
  });

  it('回归：viewer JS bundle 内部出现的 placeholder 字面量不应被替换', () => {
    // 构造一个模板，含两段 placeholder：第一段是注入点，第二段模拟 viewer JS 中的字面量比对
    const tpl =
      `<html><body>` +
      `<script id="__DATA__" type="application/json">${DATA_PLACEHOLDER}</script>` +
      `<script>if(text===\"${DATA_PLACEHOLDER}\"){alert(1);}</script>` +
      `</body></html>`;
    const html = renderReportHtml(SAMPLE_REPORT, { template: tpl });
    // 第一处应该被替换，第二处仍保留
    expect(html.indexOf(DATA_PLACEHOLDER)).toBeGreaterThan(0);
    // 全文中应只剩 1 个 placeholder（第二段那个）
    expect(html.split(DATA_PLACEHOLDER).length - 1).toBe(1);
    // 注入数据出现在第一段
    expect(html.indexOf('"schemaVersion":"1.0"')).toBeLessThan(html.indexOf('alert(1)'));
  });

  it('JSON 包含 $ / `$1` 等模式时不被当作 replace 的 backreference', () => {
    const r: PackageReport = {
      ...SAMPLE_REPORT,
      meta: { ...SAMPLE_REPORT.meta, file: '$1$&$$/foo' },
    };
    const html = renderReportHtml(r, { template: MINI_TEMPLATE });
    expect(html).toContain('$1$&$$/foo');
  });
});

describe('serializeForHtml', () => {
  it('转义 </script>', () => {
    expect(serializeForHtml({ x: '</script>' })).not.toContain('</script>');
    expect(serializeForHtml({ x: '</script>' })).toContain('<\\/script');
  });

  it('转义 HTML 注释序列：使用合法 JSON unicode 转义而不是 \\! / \\>', () => {
    const out = serializeForHtml({ x: '<!-- y -->' });
    // HTML 解析层面：原始 `<!--` 和 `-->` 子串都消失
    expect(out).not.toMatch(/<!--/);
    expect(out).not.toMatch(/-->/);
    // JSON 层面：用 \u0021 (!) 和 \u003e (>) 这种合法 unicode 转义
    expect(out).toContain('<\\u0021--');
    expect(out).toContain('--\\u003e');
    // 关键回归点：输出必须能被 JSON.parse 正确反序列化回原值
    // 历史 bug：用过 `\!` / `\>` 这种非法 JSON 转义，viewer 端 JSON.parse 直接抛
    // "Bad escaped character"，导致大体积报告（含 .rodata / abc 字符串池命中
    // `<!--` / `-->` 子串时）打不开
    const parsed = JSON.parse(out);
    expect(parsed.x).toBe('<!-- y -->');
  });

  it('回归：PackageReport 含大量含 `-->` / `<!--` 的字符串时整份 JSON 仍可被 viewer 端 JSON.parse', () => {
    // 模拟从 .rodata / abc 字符串池里抽出来、恰好含 HTML 注释 token 的字符串集合
    const hostile = {
      strings: [
        'foo --> bar',
        '<!-- some inline comment -->',
        'mix1 --> <!-- mix2 -->',
        '</script><!-- combo -->',
        '\u2028 line sep \u2029',
      ],
    };
    const out = serializeForHtml(hostile);
    expect(out).not.toMatch(/<!--/);
    expect(out).not.toMatch(/-->/);
    expect(out).not.toMatch(/<\/script/i);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out)).toEqual(hostile);
  });
});
