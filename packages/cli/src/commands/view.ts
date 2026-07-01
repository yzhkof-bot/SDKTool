import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { PackageReport } from '@kingsdk/shared/schema.js';
import { UsageError } from '../errors.js';
import { startViewServer } from '../utils/server.js';

export interface ViewCommandOptions {
  port?: number;
  host?: string;
  open?: boolean;
}

export interface ViewCommandDeps {
  writeStdout: (text: string) => void;
  /** 仅供测试注入：用 startViewServer 的简化版来避免真起监听 */
  startServer?: typeof startViewServer;
}

/**
 * `kingsdk view <report.json>` 实现：
 *   - 读取已有的 PackageReport JSON
 *   - 起本地 HTTP 服务，提供 / 与 /api/report
 *   - 默认自动开浏览器（--no-open 关闭）
 *   - 阻塞等待 SIGINT/SIGTERM 退出
 */
export async function runViewCommand(
  reportPath: string | undefined,
  opts: ViewCommandOptions,
  deps: ViewCommandDeps,
): Promise<void> {
  if (!reportPath) {
    throw new UsageError('缺少必填参数 <report>，用法: kingsdk view <path-to-report.json>');
  }
  const absPath = resolve(reportPath);
  if (!existsSync(absPath)) {
    throw new UsageError(`文件不存在: ${absPath}`);
  }
  if (!statSync(absPath).isFile()) {
    throw new UsageError(`不是文件: ${absPath}`);
  }

  let report: PackageReport;
  try {
    const text = await readFile(absPath, 'utf8');
    report = JSON.parse(text) as PackageReport;
  } catch (err) {
    throw new UsageError(
      `解析 JSON 失败 (${absPath}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!report || typeof report !== 'object' || !('schemaVersion' in report)) {
    throw new UsageError(`${absPath} 不是合法的 PackageReport（缺少 schemaVersion）`);
  }

  const start = deps.startServer ?? startViewServer;
  const handle = await start(report, {
    port: opts.port,
    host: opts.host,
    openBrowser: opts.open !== false,
  });

  deps.writeStdout(`[kingsdk] view server: ${handle.url}\n`);
  deps.writeStdout('[kingsdk] press Ctrl+C to stop\n');

  // 测试场景下不会进入 awaitInterrupt（test 通过 startServer 注入提前 close）
  await awaitInterrupt(handle.close);
}

function awaitInterrupt(onClose: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = async () => {
      try {
        await onClose();
      } finally {
        resolve();
      }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
