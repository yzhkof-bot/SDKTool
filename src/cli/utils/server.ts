import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

import type { PackageReport } from '../../shared/schema.js';

import { renderReportHtml } from './render.js';

export interface ViewServerOptions {
  /** 端口；0 表示随机 */
  port?: number;
  /** 监听地址，默认 127.0.0.1 */
  host?: string;
  /** 自动在浏览器打开 / 路径 */
  openBrowser?: boolean;
}

export interface ViewServerHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * 启动一个最小的本地 HTTP 服务，把报告 HTML/JSON 暴露给浏览器。
 *
 * 路由：
 *   GET /              → 注入了报告数据的 HTML
 *   GET /api/report    → PackageReport JSON
 *   GET /healthz       → 简单存活检查
 *
 * 仅监听 127.0.0.1，不暴露公网；零外部依赖（Node 内置 http）。
 */
export async function startViewServer(
  report: PackageReport,
  options: ViewServerOptions = {},
): Promise<ViewServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 7788;
  const html = renderReportHtml(report);
  const json = JSON.stringify(report);

  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    if (url === '/' || url === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(html);
      return;
    }

    if (url === '/api/report' || url.startsWith('/api/report?')) {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(json);
      return;
    }

    if (url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort =
    address && typeof address === 'object' && 'port' in address ? address.port : port;
  const url = `http://${host}:${actualPort}/`;

  if (options.openBrowser) {
    openInBrowser(url);
  }

  return {
    url,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** 跨平台打开浏览器（fire-and-forget） */
export function openInBrowser(url: string): void {
  try {
    const p = platform();
    let cmd: string;
    let args: string[];
    if (p === 'win32') {
      // Windows 上 start 是 cmd 内置命令，需用 shell；start 第一个参数是窗口标题，传空串
      cmd = 'cmd';
      args = ['/c', 'start', '""', url];
    } else if (p === 'darwin') {
      cmd = 'open';
      args = [url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    // spawn 在命令不存在（如无桌面环境缺少 xdg-open）时会异步发出 'error' 事件，
    // 必须监听，否则会变成 uncaught exception 把进程搞崩。
    child.on('error', () => {
      // 静默失败：浏览器没打开不影响服务
    });
    child.unref();
  } catch {
    // 静默失败：浏览器没打开不影响服务
  }
}
