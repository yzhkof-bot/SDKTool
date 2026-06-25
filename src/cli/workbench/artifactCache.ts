/**
 * 蓝盾制品的本地下载缓存（独立目录，与 job 历史目录分开）。
 *
 * 设计目标（对应需求）：
 *  - "实际下载要点开始按钮后才下载"：本模块只在 acquire() 被调用时才发起下载；
 *    前端"加入对比/分析"阶段只记录引用，不触达这里。
 *  - "已经下载过的不要重复下载"：按 (projectId, buildId, 制品路径) 计算稳定 key，
 *    命中且文件仍在 → 直接复用，不再下载。
 *  - "单独目录 + 只保留 20G，多了按先后顺序清理"：所有缓存落在 dir 下，
 *    超过 maxBytes 时按 downloadedAt（下载先后）淘汰最老的；正在被作业使用的跳过。
 *
 * 落盘结构：
 *   <dir>/index.json            缓存索引（[{ key, name, size, downloadedAt, lastUsedAt }]）
 *   <dir>/<key>/<原始文件名>     缓存的制品文件（保留原始扩展名，analyzer 依赖扩展名判类型）
 *
 * 并发：单进程内用 in-flight Promise 合并同 key 的重复下载；用引用计数标记"使用中"
 * 防止淘汰正在分析的文件。多进程同目录不加锁（本地单用户工具，足够）。
 */

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const GiB = 1024 * 1024 * 1024;

/** 默认缓存目录：`~/.kingsdk/artifact-cache`（跨端口共享，避免重复下载大包）。 */
export function defaultArtifactCacheDir(): string {
  return join(homedir(), '.kingsdk', 'artifact-cache');
}

interface IndexEntry {
  key: string;
  name: string;
  size: number;
  /** 首次下载完成时间（FIFO 淘汰依据） */
  downloadedAt: string;
  /** 最近一次命中复用时间（仅供观察，不参与淘汰排序） */
  lastUsedAt: string;
}

export interface AcquireSpec {
  projectId: string;
  buildId: string;
  /** 制品在蓝盾里的路径（去重 key 的一部分） */
  artifactPath: string;
  /** 原始文件名（决定落盘文件名与扩展名） */
  name: string;
  /** 期望大小；命中缓存时若与索引不符则视为失效、重新下载 */
  expectedSize?: number | null;
  /** 惰性构造下载直链与鉴权头（命中缓存时根本不会调用） */
  getDownload: () => { url: string; headers: Record<string, string> };
}

export interface AcquiredArtifact {
  /** 本地文件绝对路径 */
  path: string;
  /** 是否命中缓存（false 表示本次新下载） */
  fromCache: boolean;
  /** 用完必须调用，释放"使用中"标记，使其可被后续淘汰 */
  release: () => void;
}

export type AcquireProgress = (received: number, total: number) => void;

export class ArtifactCache {
  private readonly index = new Map<string, IndexEntry>();
  /** key -> 引用计数（>0 表示使用中，淘汰时跳过） */
  private readonly inUse = new Map<string, number>();
  /** key -> 进行中的下载 Promise（合并并发重复下载） */
  private readonly inFlight = new Map<string, Promise<void>>();
  private loaded = false;

  constructor(
    readonly dir: string,
    readonly maxBytes: number = 20 * GiB,
  ) {}

  private indexPath(): string {
    return join(this.dir, 'index.json');
  }

  private fileDir(key: string): string {
    return join(this.dir, key);
  }

  private filePath(key: string, name: string): string {
    return join(this.fileDir(key), name);
  }

  private keyOf(spec: Pick<AcquireSpec, 'projectId' | 'buildId' | 'artifactPath'>): string {
    return createHash('sha1')
      .update(`${spec.projectId}\n${spec.buildId}\n${spec.artifactPath}`)
      .digest('hex');
  }

  /** 懒加载索引；丢弃文件已不存在的条目。 */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await mkdir(this.dir, { recursive: true });
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.indexPath(), 'utf8'));
    } catch {
      return; // 无索引或损坏 → 空缓存
    }
    const entries = Array.isArray(raw) ? raw : Array.isArray((raw as { entries?: unknown }).entries) ? (raw as { entries: unknown[] }).entries : [];
    for (const e of entries) {
      const o = e as Partial<IndexEntry>;
      if (!o || typeof o.key !== 'string' || typeof o.name !== 'string') continue;
      if (!existsSync(this.filePath(o.key, o.name))) continue; // 文件被手动删了 → 跳过
      this.index.set(o.key, {
        key: o.key,
        name: o.name,
        size: typeof o.size === 'number' ? o.size : 0,
        downloadedAt: typeof o.downloadedAt === 'string' ? o.downloadedAt : new Date(0).toISOString(),
        lastUsedAt: typeof o.lastUsedAt === 'string' ? o.lastUsedAt : new Date(0).toISOString(),
      });
    }
  }

  private async saveIndex(): Promise<void> {
    const entries = [...this.index.values()];
    await writeFile(this.indexPath(), JSON.stringify({ entries }, null, 2), 'utf8');
  }

  private retain(key: string): void {
    this.inUse.set(key, (this.inUse.get(key) ?? 0) + 1);
  }

  private releaseKey(key: string): void {
    const n = (this.inUse.get(key) ?? 0) - 1;
    if (n <= 0) this.inUse.delete(key);
    else this.inUse.set(key, n);
  }

  /**
   * 取得制品的本地文件路径：命中缓存直接返回；否则下载、入索引、触发淘汰。
   * 返回对象含 release()，调用方用完（分析结束）务必调用以解除"使用中"。
   */
  async acquire(spec: AcquireSpec, onProgress?: AcquireProgress): Promise<AcquiredArtifact> {
    await this.ensureLoaded();
    const key = this.keyOf(spec);
    const filePath = this.filePath(key, spec.name);

    const existing = this.index.get(key);
    const sizeOk = !existing || spec.expectedSize == null || existing.size === spec.expectedSize;
    if (existing && sizeOk && existsSync(filePath)) {
      existing.lastUsedAt = new Date().toISOString();
      this.retain(key);
      void this.saveIndex();
      return { path: filePath, fromCache: true, release: () => this.releaseKey(key) };
    }

    // 合并并发：同 key 已有下载在跑 → 等它，不重复下载
    const flight = this.inFlight.get(key);
    if (flight) {
      await flight;
      this.retain(key);
      return { path: filePath, fromCache: false, release: () => this.releaseKey(key) };
    }

    const p = this.download(key, spec, filePath, onProgress);
    this.inFlight.set(key, p);
    try {
      await p;
    } finally {
      this.inFlight.delete(key);
    }
    this.retain(key); // 先占用，避免淘汰把刚下完的删了
    await this.evict(key);
    return { path: filePath, fromCache: false, release: () => this.releaseKey(key) };
  }

  private async download(
    key: string,
    spec: AcquireSpec,
    filePath: string,
    onProgress?: AcquireProgress,
  ): Promise<void> {
    await mkdir(this.fileDir(key), { recursive: true });
    const tmp = filePath + '.part';
    const { url, headers } = spec.getDownload();
    const resp = await fetch(url, { headers });
    if (!resp.ok || !resp.body) {
      throw new Error(`下载失败 HTTP ${resp.status}（${url.slice(0, 120)}）`);
    }
    // 鉴权失败时 BkRepo 不报错而是 302 到 passport 返回登录页 HTML，这里提前识别。
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('text/html')) {
      throw new Error('下载鉴权失败：服务器返回登录页而非文件，请检查 BKREPO_TOKEN 是否过期（蓝盾→服务→制品库→个人中心→申请 Token）');
    }
    const total = Number(resp.headers.get('content-length')) || 0;
    let received = 0;
    const nodeStream = Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0]);
    nodeStream.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (onProgress) onProgress(received, total);
    });
    await pipeline(nodeStream, createWriteStream(tmp));

    const size = (await stat(tmp)).size;
    await rm(filePath, { force: true });
    await rename(tmp, filePath);
    const now = new Date().toISOString();
    this.index.set(key, { key, name: spec.name, size, downloadedAt: now, lastUsedAt: now });
    await this.saveIndex();
  }

  /**
   * 总量超过 maxBytes 时按 downloadedAt 升序（最老先）淘汰，直到不超限。
   * 跳过 protectKey（刚下完的）与所有"使用中"的条目。
   */
  private async evict(protectKey?: string): Promise<void> {
    let total = 0;
    for (const e of this.index.values()) total += e.size;
    if (total <= this.maxBytes) return;

    const candidates = [...this.index.values()].sort((a, b) =>
      a.downloadedAt.localeCompare(b.downloadedAt),
    );
    let changed = false;
    for (const e of candidates) {
      if (total <= this.maxBytes) break;
      if (e.key === protectKey) continue;
      if (this.inUse.has(e.key)) continue; // 正在被分析，别删
      try {
        await rm(this.fileDir(e.key), { recursive: true, force: true });
      } catch {
        continue; // 删不动（占用/权限）→ 留着下次再试，索引也先保留
      }
      this.index.delete(e.key);
      total -= e.size;
      changed = true;
    }
    if (changed) await this.saveIndex();
  }
}
