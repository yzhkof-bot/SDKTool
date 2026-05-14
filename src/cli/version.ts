import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 读取自身 package.json 的 version。
 *
 * 兼容三种产物形态：
 *  1) tsx 直接跑 src/cli/index.ts        → __dirname = src/cli
 *  2) tsup 打包后 dist/cli/index.cjs    → __dirname = dist/cli
 *  3) 运行时被 require 时（极少见）     → 退化到 cwd 寻找
 *
 * 找不到时返回 'unknown'，绝不抛错，确保 CLI 主流程不被版本读取阻塞。
 */
export function readToolVersion(): string {
  try {
    const here = currentDir();
    const candidates = [
      join(here, '..', '..', 'package.json'), // dist/cli/.. -> dist -> ../package.json (when published)
      join(here, '..', '..', '..', 'package.json'), // src/cli/.. -> src -> ../package.json (dev)
    ];
    for (const p of candidates) {
      try {
        const raw = readFileSync(p, 'utf8');
        const pkg = JSON.parse(raw) as { version?: string };
        if (pkg.version) return pkg.version;
      } catch {
        // try next
      }
    }
  } catch {
    /* ignore */
  }
  return 'unknown';
}

function currentDir(): string {
  if (typeof __dirname !== 'undefined') return __dirname;
  try {
    // ESM fallback：在 CJS 产物里 import.meta 不存在，所以包在 try 里
    const meta = (Function('return import.meta')() as { url?: string } | undefined);
    if (meta?.url) return dirname(fileURLToPath(meta.url));
  } catch {
    /* ignore */
  }
  return process.cwd();
}
