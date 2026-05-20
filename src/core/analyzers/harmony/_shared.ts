import JSON5 from 'json5';

import type { AnalyzerContext, VirtualHap } from '../../shared/schema.js';

/**
 * analyzer 共享辅助：跨 analyzer 复用 module.json / pack.info 的解析结果。
 *
 * pipeline 把同一个 VirtualHap 实例并发派发给多个 analyzer，因此用 WeakMap 缓存
 * 同一 hap 上的解析 Promise，N 个 analyzer 只读 1 次。
 */

const moduleJsonCache = new WeakMap<VirtualHap, Promise<SharedReadResult<unknown>>>();
const packInfoCache = new WeakMap<VirtualHap, Promise<SharedReadResult<unknown>>>();

const MODULE_CANDIDATES = ['module.json', 'module.json5', 'config.json'];
const PACK_INFO_PATH = 'pack.info';

export interface SharedReadResult<T> {
  value: T | undefined;
  /** 哪个文件被实际读到（仅当 value !== undefined） */
  source?: string;
}

/** 读取并解析 module.json / module.json5 / config.json，按候选顺序尝试。失败仅记 warning 不抛错 */
export async function readModuleJson(ctx: AnalyzerContext): Promise<SharedReadResult<unknown>> {
  const cached = moduleJsonCache.get(ctx.hap);
  if (cached) return cached;

  const promise: Promise<SharedReadResult<unknown>> = (async () => {
    for (const path of MODULE_CANDIDATES) {
      const exists = ctx.hap.entries.find((e) => !e.isDirectory && e.path === path);
      if (!exists) continue;
      try {
        const text = await ctx.hap.readText(path);
        return { value: JSON5.parse(text) as unknown, source: path };
      } catch (err) {
        ctx.addWarning({
          code: 'MODULE_JSON_PARSE_FAILED',
          level: 'error',
          message: `${path} 解析失败: ${err instanceof Error ? err.message : String(err)}`,
        });
        return { value: undefined, source: path };
      }
    }
    return { value: undefined, source: undefined };
  })();

  moduleJsonCache.set(ctx.hap, promise);
  return promise;
}

/** 读取 pack.info（可能不存在，单 hap 通常没有；多 hap 的 .app 包内才有） */
export async function readPackInfo(ctx: AnalyzerContext): Promise<SharedReadResult<unknown>> {
  const cached = packInfoCache.get(ctx.hap);
  if (cached) return cached;

  const promise: Promise<SharedReadResult<unknown>> = (async () => {
    const exists = ctx.hap.entries.find((e) => !e.isDirectory && e.path === PACK_INFO_PATH);
    if (!exists) return { value: undefined, source: undefined };
    try {
      const text = await ctx.hap.readText(PACK_INFO_PATH);
      return { value: JSON5.parse(text) as unknown, source: PACK_INFO_PATH };
    } catch (err) {
      ctx.addWarning({
        code: 'PACK_INFO_PARSE_FAILED',
        level: 'warn',
        message: `pack.info 解析失败: ${err instanceof Error ? err.message : String(err)}`,
      });
      return { value: undefined, source: PACK_INFO_PATH };
    }
  })();

  packInfoCache.set(ctx.hap, promise);
  return promise;
}
