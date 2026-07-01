import { defineConfig } from 'tsup';

// monorepo：包间通过 tsconfig.base.json 的 @kingsdk/* 路径别名指向源码，
// esbuild 读取 tsconfig 的 paths 完成解析（.js 说明符会回退解析到同名 .ts 源）。
export default defineConfig([
  // CLI：自包含 cjs bundle（把 core/shared/viewer/server 全部内联打进来）
  {
    entry: {
      index: 'packages/cli/src/index.ts',
    },
    format: ['cjs'],
    target: 'node20',
    platform: 'node',
    outDir: 'dist/cli',
    splitting: false,
    sourcemap: true,
    clean: true,
    dts: false,
    shims: false,
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  // Viewer (analyze)：浏览器端 IIFE bundle，被 buildViewerTemplate.mjs 内联到 report.template.html
  {
    entry: {
      'viewer/main': 'packages/viewer/src/main.ts',
    },
    format: ['iife'],
    globalName: 'KingsdkViewer',
    target: 'es2020',
    platform: 'browser',
    outDir: 'dist',
    splitting: false,
    sourcemap: false,
    clean: false,
    dts: false,
    minify: true,
  },
  // Viewer (diff)：浏览器端 IIFE bundle，被内联到 diff.template.html
  {
    entry: {
      'viewer/diff': 'packages/viewer/src/diff/main.ts',
    },
    format: ['iife'],
    globalName: 'KingsdkDiffViewer',
    target: 'es2020',
    platform: 'browser',
    outDir: 'dist',
    splitting: false,
    sourcemap: false,
    clean: false,
    dts: false,
    minify: true,
  },
]);
