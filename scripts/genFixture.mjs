// 生成一个本地 demo.hap 供 README/手动验证用。
// 不发布、不进 dist，仅供开发者和 AI 验证流程时使用。

import { mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFixtureHap } from '../tests/helpers/fixtureHap.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'tests', 'fixtures');
await mkdir(outDir, { recursive: true });

const tmp = await buildFixtureHap({ includePackInfo: true });

const { copyFile } = await import('node:fs/promises');
const dest = join(outDir, 'demo.hap');
await copyFile(tmp, dest);
console.log('[genFixture] wrote', dest);
