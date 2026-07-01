import type { ServerResponse } from 'node:http';

import type { SseEvent } from './types.js';

/**
 * Server-Sent Events 写入工具。
 *
 * 一次 write 输出一个 event：
 *   event: <type>
 *   data: <json without type>
 *   <blank line>
 *
 * 注意：
 *  - data 内不能含裸 `\n`，否则 SSE 解析时会被切成多个 data 行；用 JSON.stringify 天然安全。
 *  - flushHeaders + 关闭 'Cache-Control' 缓存，避免代理把整段缓存到结束再吐。
 */
export class SseWriter {
  private closed = false;

  constructor(private readonly res: ServerResponse) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    // 初始 padding：某些客户端在拿到第一个字节前不会把响应交给业务回调
    res.write(`: kingsdk-ai ready\n\n`);
  }

  write(event: SseEvent): void {
    if (this.closed) return;
    const { type, ...rest } = event;
    // 优化：empty payload 仍要写 `data: {}`，避免某些 SSE polyfill 解析失败
    const payload = JSON.stringify(rest);
    this.res.write(`event: ${type}\ndata: ${payload}\n\n`);
  }

  /** 发 `done` 并 end()。重复调用安全。 */
  end(): void {
    if (this.closed) return;
    this.write({ type: 'done' });
    this.closed = true;
    try {
      this.res.end();
    } catch {
      // socket 已关，忽略
    }
  }

  /** 客户端断开时调用，标记为 closed 但不再写。 */
  markClosed(): void {
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
