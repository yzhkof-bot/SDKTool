import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// 源码别名：@kingsdk/<pkg>/<path>.js → packages/<pkg>/src/<path>.ts
// 用 regex 显式把 .js 重写成 .ts 源码，避免 vitest 解析裸 .js 时找不到文件。
// entry 指定裸包名（@kingsdk/<pkg>）解析到的入口文件（相对 src/，不带扩展名）。
const pkgAlias = (name: string, dir: string, entry = 'index') => [
  { find: new RegExp(`^@kingsdk/${name}/(.*)\\.js$`), replacement: resolve(__dirname, `packages/${dir}/src/$1.ts`) },
  { find: new RegExp(`^@kingsdk/${name}$`), replacement: resolve(__dirname, `packages/${dir}/src/${entry}.ts`) },
];

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts'],
    testTimeout: 20000,
    // viewer 单测需要 DOM；通过 environmentMatchGlobs 让 viewer 测试用 happy-dom
    environmentMatchGlobs: [['tests/viewer/**/*.test.ts', 'happy-dom']],
  },
  resolve: {
    alias: [
      ...pkgAlias('shared', 'shared'),
      ...pkgAlias('core', 'core'),
      ...pkgAlias('viewer', 'viewer'),
      ...pkgAlias('server', 'server', 'server'),
    ],
  },
});
