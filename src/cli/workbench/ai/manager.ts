/**
 * AI 会话管理器：跨 HTTP 请求维护多条 AiSession 实例。
 *
 * 设计：
 *  - 进程内存 Map<conversationId, Entry>，不落盘（重启即丢，对话历史保留在 SDK 内部 sessionId）
 *  - TTL：每个会话最近一次活动后 30min 未触达 → 自动 close + 移除
 *  - lazy connect：创建时只 new AiSession，第一次 sendAndStream 时才真正 spawn CLI 子进程
 *
 * 当前不实现：
 *  - 重启后通过 SDK 的 resumeSession 恢复（需要 jobDir 还在 + 记 sessionId）。后续如果有需求再加。
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

import { AiSession } from './session.js';
import type { BuildSystemPromptArgs } from './prompts.js';
import type { JobStore } from '../store.js';
import type { WorkbenchJob } from '../../../shared/schema.js';

interface Entry {
  id: string;
  session: AiSession;
  jobId: string;
  lastTouchedAt: number;
  /** 该会话目前是否有 in-flight SSE 流；用于禁止并发 send */
  busy: boolean;
}

export interface ConversationManagerOptions {
  store: JobStore;
  /** 调试日志 */
  log?: (text: string) => void;
  /** TTL（毫秒）；默认 30 分钟 */
  ttlMs?: number;
  /** 一进程最多同时活跃的会话数；超过则 LRU 关掉最旧的 */
  maxConcurrent?: number;
}

export class ConversationManager {
  private readonly map = new Map<string, Entry>();
  private readonly store: JobStore;
  private readonly log: (text: string) => void;
  private readonly ttlMs: number;
  private readonly maxConcurrent: number;
  private gcTimer: NodeJS.Timeout | null = null;

  constructor(opts: ConversationManagerOptions) {
    this.store = opts.store;
    this.log = opts.log ?? (() => {});
    this.ttlMs = opts.ttlMs ?? 30 * 60 * 1000;
    this.maxConcurrent = opts.maxConcurrent ?? 8;
    this.gcTimer = setInterval(() => this.sweep(), 60 * 1000);
    if (typeof this.gcTimer.unref === 'function') this.gcTimer.unref();
  }

  /**
   * 创建一个新会话。会自动绑定 jobDir，校验对应 job 是否存在且产物完整。
   */
  create(jobId: string, opts: { model?: string } = {}): {
    id: string;
    session: AiSession;
    job: WorkbenchJob;
  } {
    const job = this.store.get(jobId);
    if (!job) throw new ConversationError('NOT_FOUND', `job ${jobId} 不存在`, 404);
    if (job.status !== 'done') {
      throw new ConversationError(
        'JOB_NOT_READY',
        `job ${jobId} 状态为 ${job.status}，AI 分析需要已完成的任务`,
        409,
      );
    }
    const dir = this.store.jobDir(jobId);
    if (!existsSync(dir)) {
      throw new ConversationError('JOB_DIR_MISSING', `job 产物目录不存在: ${dir}`, 500);
    }

    this.enforceCapacity();

    const id = `conv_${randomBytes(8).toString('hex')}`;
    const promptContext: BuildSystemPromptArgs = {
      jobDir: dir,
      jobKind: job.kind,
      jobLabel: job.label,
      jobInputs: job.inputs,
      ...(job.platform ? { platform: job.platform } : {}),
    };
    const session = new AiSession({
      jobDir: dir,
      promptContext,
      ...(opts.model ? { model: opts.model } : {}),
      log: this.log,
    });

    const entry: Entry = {
      id,
      session,
      jobId,
      lastTouchedAt: Date.now(),
      busy: false,
    };
    this.map.set(id, entry);
    this.log(`[ai] conversation created ${id} → job ${jobId}\n`);
    return { id, session, job };
  }

  get(id: string): Entry | undefined {
    const entry = this.map.get(id);
    if (!entry) return undefined;
    entry.lastTouchedAt = Date.now();
    return entry;
  }

  /** 锁定会话准备开始 SSE；调用方在 finally 里必须 release */
  acquire(id: string): Entry {
    const entry = this.map.get(id);
    if (!entry) throw new ConversationError('NOT_FOUND', `conversation ${id} 不存在`, 404);
    if (entry.session.isClosed) {
      this.map.delete(id);
      throw new ConversationError('CLOSED', `conversation ${id} 已关闭`, 410);
    }
    if (entry.busy) {
      throw new ConversationError(
        'BUSY',
        `conversation ${id} 正在处理上一轮，请等待或先中断`,
        409,
      );
    }
    entry.busy = true;
    entry.lastTouchedAt = Date.now();
    return entry;
  }

  release(id: string): void {
    const entry = this.map.get(id);
    if (!entry) return;
    entry.busy = false;
    entry.lastTouchedAt = Date.now();
  }

  async interrupt(id: string): Promise<void> {
    const entry = this.map.get(id);
    if (!entry) throw new ConversationError('NOT_FOUND', `conversation ${id} 不存在`, 404);
    await entry.session.interrupt();
  }

  close(id: string): boolean {
    const entry = this.map.get(id);
    if (!entry) return false;
    entry.session.close();
    this.map.delete(id);
    this.log(`[ai] conversation closed ${id}\n`);
    return true;
  }

  closeAll(): void {
    for (const id of [...this.map.keys()]) this.close(id);
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  /** 移除超过 TTL 的空闲会话 */
  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.map) {
      if (entry.busy) continue;
      if (now - entry.lastTouchedAt > this.ttlMs) {
        this.log(`[ai] conversation idle gc ${id}\n`);
        entry.session.close();
        this.map.delete(id);
      }
    }
  }

  /** 容量上限：超额时 LRU 关掉最空闲的一条非 busy 会话 */
  private enforceCapacity(): void {
    if (this.map.size < this.maxConcurrent) return;
    let oldest: Entry | null = null;
    for (const entry of this.map.values()) {
      if (entry.busy) continue;
      if (!oldest || entry.lastTouchedAt < oldest.lastTouchedAt) oldest = entry;
    }
    if (oldest) {
      this.log(`[ai] capacity reached, evicting ${oldest.id}\n`);
      this.close(oldest.id);
    }
    // 全部 busy 时不强制关，让 caller 知道（实际罕见）
  }
}

export class ConversationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ConversationError';
  }
}
