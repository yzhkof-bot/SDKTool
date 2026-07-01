// 构建后处理：把 @kingsdk/web 的 Vite 产物（packages/web/dist）拷到 dist/web，
// 使打包后与 dist/server、dist/electron 同级，electron 的 webDist() 能就地找到；
// 同时 server 的 SDKTOOL_STATIC_DIR 也可指向它。

import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const src = join(root, 'packages/web/dist');
const dest = join(root, 'dist/web');

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(src))) {
  console.error(`[collectWebDist] 未找到 ${src}，请先 npm run build:web`);
  process.exit(1);
}

await rm(dest, { recursive: true, force: true });
await mkdir(dirname(dest), { recursive: true });
await cp(src, dest, { recursive: true });
console.log(`[collectWebDist] copied ${src} → ${dest}`);
