import { defineConfig } from 'vite';

/**
 * @kingsdk/web 构建配置。
 *
 * - 产出到 dist/（供 @kingsdk/server 静态托管；SDKTOOL_STATIC_DIR 指向此目录）
 * - dev 模式把 /api、/jobs、/healthz 代理到本机 server（默认 7790），
 *   这样 `vite dev` 的热更新前端 + 真实后端联调。
 */
const SERVER_TARGET = process.env.KINGSDK_SERVER_URL ?? 'http://127.0.0.1:7790';

export default defineConfig({
  root: '.',
  base: './',
  server: {
    port: 5273,
    proxy: {
      '/api': { target: SERVER_TARGET, changeOrigin: true },
      '/jobs': { target: SERVER_TARGET, changeOrigin: true },
      '/healthz': { target: SERVER_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
  },
});
