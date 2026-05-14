import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      'cli/index': 'src/cli/index.ts',
    },
    format: ['cjs'],
    target: 'node20',
    platform: 'node',
    outDir: 'dist',
    splitting: false,
    sourcemap: true,
    clean: true,
    dts: false,
    shims: false,
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  {
    entry: {
      'core/index': 'src/core/index.ts',
      'shared/index': 'src/shared/index.ts',
    },
    format: ['esm', 'cjs'],
    target: 'node20',
    platform: 'node',
    outDir: 'dist',
    splitting: false,
    sourcemap: true,
    clean: false,
    dts: true,
  },
  // Viewer (analyze)：浏览器端 IIFE bundle，最终被 buildViewerTemplate.mjs 内联到 templates/report.template.html
  {
    entry: {
      'viewer/main': 'src/viewer/main.ts',
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
  // Viewer (diff)：浏览器端 IIFE bundle，被内联到 templates/diff.template.html
  {
    entry: {
      'viewer/diff': 'src/viewer/diff/main.ts',
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
