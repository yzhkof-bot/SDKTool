import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 20000,
    // viewer 单测需要 DOM；通过 environmentMatchGlobs 让 viewer 测试用 happy-dom
    environmentMatchGlobs: [['tests/viewer/**/*.test.ts', 'happy-dom']],
  },
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@cli': resolve(__dirname, 'src/cli'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@viewer': resolve(__dirname, 'src/viewer'),
    },
  },
});
