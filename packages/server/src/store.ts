import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Platform, WorkbenchJob, WorkbenchJobKind } from '@kingsdk/shared/schema.js';

/**
 * 持久化任务存储。
 *
 * - 元信息：内存 Map + 每个 job 一个 `<cacheDir>/<jobId>/meta.json` 的同步落盘
 * - 产物：每个 job 同目录下的 `report.json` / `report.html` / `diff.json` / `diff.html`
 * - 启动时扫描 cacheDir 自动恢复历史；上一次进程被强杀留下的 pending/running 被修复为 error
 * - clearAll 同步删元信息 + 子目录
 *
 * 多 server 实例的并发：cacheDir 默认按端口隔离（不同端口 → 不同目录），
 * 同端口同时跑两个进程目前不支持（无文件锁，会出现 race 写坏 meta.json）。
 * 单用户本地工具足够。
 */
export class JobStore {
  private readonly jobs = new Map<string, WorkbenchJob>();
  private readonly order: string[] = []; // 维持插入顺序，配合 list() 用
  /** 上一次发出的 createdAt（毫秒时间戳），保证严格递增，避免同毫秒创建的 job 在重启后排序歧义 */
  private lastCreatedMs = 0;

  constructor(public readonly cacheDir: string) {
    mkdirSync(cacheDir, { recursive: true });
    this.loadFromDisk();
  }

  /**
   * 创建一个 pending job 并返回。调用方拿到 id 后异步 update。
   *
   * `platform` 可省略：老调用方（一期重构前）不传，未来历史里也允许缺失，
   * 消费方一律按 'harmony' 兜底。
   */
  create(
    kind: WorkbenchJobKind,
    inputs: string[],
    label: string,
    platform?: Platform,
  ): WorkbenchJob {
    const id = randomBytes(8).toString('hex');
    const job: WorkbenchJob = {
      id,
      kind,
      status: 'pending',
      label,
      inputs,
      createdAt: this.nextCreatedAt(),
      ...(platform ? { platform } : {}),
    };
    this.jobs.set(id, job);
    this.order.unshift(id); // 最近的排前面
    this.persist(job);
    return job;
  }

  /**
   * 生成严格递增的 createdAt ISO 串。
   *
   * Why：loadFromDisk 靠 createdAt 排序恢复历史顺序；若两个 job 落在同一毫秒，
   * ISO 串相等 → 排序歧义 → 重启后顺序可能与创建序不一致（且随机翻转）。
   * 这里保证每次至少 +1ms，让 createdAt 成为可靠的顺序键。
   */
  private nextCreatedAt(): string {
    const now = Date.now();
    const ms = now > this.lastCreatedMs ? now : this.lastCreatedMs + 1;
    this.lastCreatedMs = ms;
    return new Date(ms).toISOString();
  }

  get(id: string): WorkbenchJob | undefined {
    return this.jobs.get(id);
  }

  /** 返回最近的若干 job，最新在前 */
  list(limit = 50): WorkbenchJob[] {
    const result: WorkbenchJob[] = [];
    for (const id of this.order) {
      const j = this.jobs.get(id);
      if (j) result.push(j);
      if (result.length >= limit) break;
    }
    return result;
  }

  /** 在原 job 上做局部更新，返回新引用 */
  update(id: string, patch: Partial<WorkbenchJob>): WorkbenchJob | undefined {
    const cur = this.jobs.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    this.jobs.set(id, next);
    this.persist(next);
    return next;
  }

  /** 该 job 的产物目录，保证目录已存在 */
  jobDir(id: string): string {
    const dir = join(this.cacheDir, id);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 把单个 job 的 meta.json 同步写到磁盘 */
  private persist(job: WorkbenchJob): void {
    const dir = join(this.cacheDir, job.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(job, null, 2), 'utf8');
  }

  /**
   * 启动时从 cacheDir 加载所有 job：
   * - 读每个子目录下的 meta.json
   * - 把 status='pending' / 'running' 的强制改成 'error'（上次进程被中断的孤儿任务）
   * - 按 createdAt 倒序排列
   */
  private loadFromDisk(): void {
    let dirents: Dirent[];
    try {
      dirents = readdirSync(this.cacheDir, { withFileTypes: true });
    } catch {
      return;
    }
    const loaded: WorkbenchJob[] = [];
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      const metaPath = join(this.cacheDir, d.name, 'meta.json');
      let job: WorkbenchJob;
      try {
        const text = readFileSync(metaPath, 'utf8');
        job = JSON.parse(text) as WorkbenchJob;
      } catch {
        continue; // 没 meta 或损坏，跳过
      }
      if (typeof job?.id !== 'string' || job.id !== d.name) continue;

      let healed = false;
      if (job.status === 'pending' || job.status === 'running') {
        job = {
          ...job,
          status: 'error',
          error: job.error ?? '服务中断，上次启动时未完成',
          finishedAt: job.finishedAt ?? new Date().toISOString(),
        };
        healed = true;
      }
      loaded.push(job);
      if (healed) {
        try {
          writeFileSync(metaPath, JSON.stringify(job, null, 2), 'utf8');
        } catch {
          // 写不动就算了，下次启动还会再尝试
        }
      }
    }
    loaded.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    for (const j of loaded) {
      this.jobs.set(j.id, j);
      this.order.push(j.id);
    }
  }

  /**
   * 删除单条 job：把元信息从 store 摘掉，并把对应磁盘子目录递归删除。
   *
   * 默认拒绝删除 pending / running（防止误删正在写入的产物）；调用方可传 force=true 绕过。
   *
   * 返回值：
   *  - 'removed'    成功删除
   *  - 'not_found'  没有这个 id
   *  - 'busy'       状态是 pending/running 且未指定 force
   */
  remove(id: string, opts: { force?: boolean } = {}): 'removed' | 'not_found' | 'busy' {
    const job = this.jobs.get(id);
    if (!job) return 'not_found';
    const isActive = job.status === 'pending' || job.status === 'running';
    if (isActive && opts.force !== true) return 'busy';

    this.jobs.delete(id);
    const idx = this.order.indexOf(id);
    if (idx >= 0) this.order.splice(idx, 1);
    try {
      rmSync(join(this.cacheDir, id), { recursive: true, force: true });
    } catch {
      // 容忍：文件被占用 / 权限不足等，让用户下次再试
    }
    return 'removed';
  }

}

/**
 * 默认 cacheDir：用户主目录 `~/.kingsdk/workbench-<port>/`。
 * 按端口隔离：相同端口的多次启动共享历史，不同端口的 server 各自独立。
 *
 * `port=0`（OS 自分配测试端口）时退回到不带后缀的 `~/.kingsdk/workbench/`，
 * 避免出现 `workbench-0` 这种古怪目录。
 */
export function defaultCacheDir(port?: number): string {
  const suffix = port && port > 0 ? `workbench-${port}` : 'workbench';
  return join(homedir(), '.kingsdk', suffix);
}
