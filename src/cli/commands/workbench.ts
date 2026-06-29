import { startWorkbenchServer } from '../workbench/server.js';
import { openInBrowser, toBrowserUrl } from '../utils/server.js';
import { UsageError } from '../errors.js';

export interface WorkbenchCommandOptions {
  port?: number;
  host?: string;
  open?: boolean;
}

export interface WorkbenchCommandDeps {
  toolVersion: string;
  writeStdout: (text: string) => void;
}

/**
 * `kingsdk workbench` 实现：本地 GUI 工作台。
 *
 * 行为：
 *  - 启动 HTTP 服务（默认 127.0.0.1:7790）
 *  - 默认自动开浏览器到主页
 *  - 进程一直监听直到 Ctrl-C
 */
export async function runWorkbenchCommand(
  opts: WorkbenchCommandOptions,
  deps: WorkbenchCommandDeps,
): Promise<void> {
  if (opts.port !== undefined) {
    if (!Number.isFinite(opts.port) || !Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
      throw new UsageError(`--port 必须是 0~65535 的整数，收到: ${opts.port}`);
    }
  }

  const handle = await startWorkbenchServer({
    port: opts.port,
    host: opts.host,
    toolVersion: deps.toolVersion,
    log: (t) => deps.writeStdout(t),
  });

  deps.writeStdout(`[kingsdk] workbench: ${handle.url}\n`);
  deps.writeStdout(`[kingsdk] cache dir: ${handle.store.cacheDir}\n`);
  deps.writeStdout(`[kingsdk] press Ctrl+C to stop\n`);

  if (opts.open !== false) {
    // handle.url 里嵌的是绑定地址；绑 0.0.0.0 时浏览器直连会 ERR_ADDRESS_INVALID，
    // 这里转成局域网 IP / 127.0.0.1 再打开。
    openInBrowser(toBrowserUrl(handle.url));
  }

  // 阻塞主进程：等待 SIGINT
  await new Promise<void>((resolve) => {
    const stop = () => {
      handle.close().finally(() => resolve());
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
