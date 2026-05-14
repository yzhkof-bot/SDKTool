// 构建后处理：把 dist/viewer/{main,diff}.global.js 与 src/viewer/styles.css 内联到对应的 HTML shell，
// 产出 templates/{report,diff}.template.html。
//
// 这些模板包含 __DATA_PLACEHOLDER__ 占位符；CLI render.ts 在运行时把 HapReport / HapDiffReport JSON
// 注入进去，写出最终单文件 HTML，可双击直接在浏览器里打开，无需任何 HTTP 服务。

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** @type {Array<{ name: string, htmlShell: string, bundle: string, bundleFallback: string, out: string }>} */
const TARGETS = [
  {
    name: 'report',
    htmlShell: join(root, 'src/viewer/index.html'),
    bundle: join(root, 'dist/viewer/main.global.js'),
    bundleFallback: join(root, 'dist/viewer/main.js'),
    out: join(root, 'templates/report.template.html'),
  },
  {
    name: 'diff',
    htmlShell: join(root, 'src/viewer/diff/index.html'),
    bundle: join(root, 'dist/viewer/diff.global.js'),
    bundleFallback: join(root, 'dist/viewer/diff.js'),
    out: join(root, 'templates/diff.template.html'),
  },
];

const styles = await readFile(join(root, 'src/viewer/styles.css'), 'utf8');

async function readIfExists(p) {
  try {
    await stat(p);
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

await mkdir(join(root, 'templates'), { recursive: true });

for (const t of TARGETS) {
  const shell = await readFile(t.htmlShell, 'utf8');
  const bundle = (await readIfExists(t.bundle)) ?? (await readIfExists(t.bundleFallback));
  if (!bundle) {
    throw new Error(
      `[buildViewerTemplate] 未找到 ${t.name} viewer bundle (${t.bundle} 或 ${t.bundleFallback})，请先运行 tsup 构建`,
    );
  }
  // </script> 必须转义，避免内联 JS 中包含此序列时提前关闭外层 script 标签
  const safeBundle = bundle.replace(/<\/script>/gi, '<\\/script>');
  const html = shell
    .replace('<!-- __STYLES__ -->', `<style>\n${styles}\n</style>`)
    .replace('<!-- __SCRIPT__ -->', `<script>\n${safeBundle}\n</script>`);

  await writeFile(t.out, html, 'utf8');
  const sizeKB = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  console.log(`[buildViewerTemplate] wrote ${t.out} (${sizeKB} KiB)`);
}
