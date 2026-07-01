/**
 * @kingsdk/server 独立可执行入口。
 *
 * 供两类宿主拉起：
 *  1. Electron 主进程 spawn 本机子进程（mode=desktop）——见 @kingsdk/electron
 *  2. 远程部署（mode=web）——直接 `node dist/server/main.cjs --mode web --host 0.0.0.0`
 *
 * 与 CLI 的 `kingsdk workbench` 命令的区别：这是**独立进程入口**，不经 cac，
 * 就绪后向 stdout 打印一行机器可读标记 `KINGSDK_SERVER_READY <url>`，
 * 父进程（Electron）据此拿到实际监听地址再 loadURL，无需约定端口。
 *
 * 参数（手解析，零依赖）：
 *   --mode <desktop|web>   运行形态（缺省 desktop）
 *   --port <n>             监听端口（缺省 0 = OS 自分配，配合 READY 标记回传）
 *   --host <addr>          监听地址（缺省 127.0.0.1）
 *   --cache-dir <path>     历史/缓存目录（缺省按端口隔离，见 store.defaultCacheDir）
 */

import { startWorkbenchServer, type WorkbenchMode } from './server.js';

/** 就绪标记前缀：父进程按行匹配 `KINGSDK_SERVER_READY ` 取实际 URL。 */
export const READY_MARKER = 'KINGSDK_SERVER_READY';

interface ParsedArgs {
  mode?: WorkbenchMode;
  port?: number;
  host?: string;
  cacheDir?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | undefined => argv[++i];
    if (a === '--mode') {
      const v = next();
      if (v === 'desktop' || v === 'web') out.mode = v;
    } else if (a === '--port') {
      const v = Number.parseInt(next() ?? '', 10);
      if (Number.isInteger(v) && v >= 0 && v <= 65535) out.port = v;
    } else if (a === '--host') {
      out.host = next();
    } else if (a === '--cache-dir') {
      out.cacheDir = next();
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const handle = await startWorkbenchServer({
    mode: args.mode ?? 'desktop',
    port: args.port ?? 0,
    host: args.host ?? '127.0.0.1',
    cacheDir: args.cacheDir,
    toolVersion: process.env.KINGSDK_VERSION ?? 'server',
    log: (t) => process.stderr.write(t),
  });

  // 就绪标记：单独一行，父进程按前缀提取 URL。业务日志走 stderr，避免污染。
  process.stdout.write(`${READY_MARKER} ${handle.url}\n`);

  const shutdown = (): void => {
    handle.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  // 父进程（Electron）退出时 stdin 会关闭，据此兜底退出，避免子进程成孤儿
  process.stdin.on('close', shutdown);
  process.stdin.resume();
}

main().catch((err) => {
  process.stderr.write(`[server] 启动失败：${err?.stack ?? err}\n`);
  process.exit(1);
});
