/**
 * 一次 AI 会话的封装（基于 sagent-sdk 重写）。
 *
 * 替换前：持有 @tencent-ai/agent-sdk 的 CLI 子进程 Session。
 * 替换后：用 sagent-sdk 的 Agent 直接调用 Claude 代理接口，工具用内置文件工具集
 * （read/write/edit/list/glob/grep/shell），工作根目录锁在 jobDir。
 *
 * 对外接口保持不变（sendAndStream / interrupt / setModel / listAvailableModels /
 * close / info / isClosed），所以 manager.ts、server.ts、前端都无需改动。
 *
 * 设计取舍：
 *  - 无外部子进程、无 connect 概念：connect() 保留为兼容空实现。
 *  - 多轮上下文保存在本实例的 history 里，每轮用完整消息回填。
 *  - canUseTool 全放行的语义 → 内置工具默认全开（含 shell），cwd 锁 jobDir。
 *  - 流式 text/thinking 增量直接转成 SSE，沿用原打字机协议。
 */

import { randomUUID } from 'node:crypto';
import {
  Agent,
  createAnthropicProvider,
  createBuiltinTools,
  imageBase64,
  LLMError,
  type AgentEvent,
  type Message as SdkMessage,
} from '@yzhkof-bot/sagent-sdk';

import { buildLlmConfig } from './env.js';
import { buildSystemPrompt, type BuildSystemPromptArgs } from './prompts.js';
import type { InlineImage, SseEvent } from './types.js';

export interface AiSessionOptions {
  jobDir: string;
  promptContext: BuildSystemPromptArgs;
  /** 模型 override；不传走默认（LLM_MODEL 或内置默认）。 */
  model?: string;
  /** 调试日志透传。 */
  log?: (text: string) => void;
}

export interface AiSessionInfo {
  sessionId: string;
  jobDir: string;
  model?: string;
}

/** 平台支持的 Claude 模型（静态列表；平台无运行时模型发现接口）。 */
const AVAILABLE_MODELS: Array<{ modelId: string; name: string; description?: string }> = [
  { modelId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', description: '默认，速度与质量均衡' },
  { modelId: 'claude-opus-4.7', name: 'Claude Opus 4.7', description: '更强推理，支持扩展思考' },
];

export class AiSession {
  private readonly jobDir: string;
  private readonly systemPrompt: string;
  private readonly sessionId = `sess_${randomUUID()}`;
  private readonly log: (text: string) => void;

  private model?: string;
  /** 懒加载：第一次发消息时才构建（避免缺 API Key 时构造即抛错，保留原懒加载语义）。 */
  private agent: Agent | null = null;
  private history: SdkMessage[] = [];
  private closed = false;
  private inFlight = false;
  /** 当前轮的中断控制器。 */
  private abort: AbortController | null = null;

  constructor(opts: AiSessionOptions) {
    this.jobDir = opts.jobDir;
    this.model = opts.model;
    this.log = opts.log ?? (() => {});
    this.systemPrompt = buildSystemPrompt(opts.promptContext);
  }

  private ensureAgent(): Agent {
    if (!this.agent) this.agent = this.buildAgent();
    return this.agent;
  }

  private buildAgent(): Agent {
    const cfg = buildLlmConfig(this.model);
    const provider = createAnthropicProvider({
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      maxTokens: 8192,
      sessionId: this.sessionId, // 同会话固定，提升上游 cache 命中率
      ...(cfg.thinkingBudget
        ? { thinking: { type: 'enabled', budgetTokens: cfg.thinkingBudget } }
        : {}),
    });
    // 工具锁在 jobDir，开启 shell（等价于原方案 bypassPermissions + 全放行）
    const tools = createBuiltinTools({ rootDir: this.jobDir, includeShell: true });
    return new Agent({
      provider,
      tools,
      systemPrompt: this.systemPrompt,
      maxSteps: 50,
      // 上下文自动压缩（对齐 Claude Code）：参数来自 pipelines.config.json 的 ai 段，缺省走默认。
      compaction: {
        contextWindow: cfg.contextWindow,
        threshold: cfg.compactThreshold,
        keepRecentRatio: cfg.keepRecentRatio,
      },
    });
  }

  get info(): AiSessionInfo {
    return {
      sessionId: this.sessionId,
      jobDir: this.jobDir,
      ...(this.model ? { model: this.model } : {}),
    };
  }

  /** 兼容旧接口：本实现无外部连接，空操作。 */
  async connect(): Promise<void> {
    /* no-op */
  }

  /**
   * 发送一条用户消息并流式返回 SseEvent。
   * 并发保护：同一时刻只允许一个 sendAndStream。
   */
  async *sendAndStream(text: string, images?: InlineImage[]): AsyncGenerator<SseEvent> {
    if (this.closed) {
      yield { type: 'error', message: '会话已关闭，请新建一个对话' };
      yield { type: 'done' };
      return;
    }
    if (this.inFlight) {
      yield { type: 'error', message: '上一轮还在进行中，先中断再发送' };
      yield { type: 'done' };
      return;
    }
    this.inFlight = true;
    this.abort = new AbortController();

    yield { type: 'turn_start' };

    const startedAt = Date.now();
    const input = this.buildInput(text, images);

    let agent: Agent;
    try {
      agent = this.ensureAgent();
    } catch (err) {
      this.inFlight = false;
      this.abort = null;
      yield { type: 'error', message: `AI 初始化失败：${describeError(err)}` };
      yield { type: 'done' };
      return;
    }

    try {
      let steps = 0;
      for await (const ev of agent.runStream(input, {
        history: this.history,
        signal: this.abort.signal,
      })) {
        const out = translateEvent(ev);
        if (out) yield out;
        if (ev.type === 'done') {
          steps = ev.result.steps;
          // 用本轮完整消息（去掉 system）替换历史，支持多轮上下文
          this.history = ev.result.messages.filter((m) => m.role !== 'system');
        }
      }
      yield {
        type: 'turn_end',
        success: true,
        durationMs: Date.now() - startedAt,
        totalCostUsd: 0,
        numTurns: steps,
      };
    } catch (err) {
      if (this.abort?.signal.aborted) {
        yield {
          type: 'turn_end',
          success: false,
          durationMs: Date.now() - startedAt,
          totalCostUsd: 0,
          numTurns: 0,
          errors: ['已中断'],
        };
      } else {
        yield { type: 'error', message: `推理异常：${describeError(err)}` };
      }
    } finally {
      this.inFlight = false;
      this.abort = null;
      yield { type: 'done' };
    }
  }

  async interrupt(): Promise<void> {
    this.abort?.abort();
  }

  /** 切换模型：丢弃当前 Agent，下一轮 send 时按新模型重建。 */
  async setModel(model: string): Promise<void> {
    // 空字符串 = 恢复默认
    this.model = model.trim() ? model : undefined;
    this.agent = null;
    this.log(`[ai] session model → ${this.model ?? '(default)'}\n`);
  }

  /** 返回平台支持的模型列表（静态）。 */
  async listAvailableModels(): Promise<
    Array<{ modelId: string; name: string; description?: string }>
  > {
    return AVAILABLE_MODELS;
  }

  /** 构造输入：纯文本直接传字符串；带图片用内容块数组。 */
  private buildInput(text: string, images?: InlineImage[]): string | SdkMessage[] {
    if (!images || images.length === 0) return text;
    return [
      {
        role: 'user',
        content: [
          { type: 'text', text: text || '请基于附图作答。' },
          ...images.map((img) => imageBase64(img.dataBase64, img.mediaType)),
        ],
      },
    ];
  }

  close(): void {
    this.closed = true;
    this.abort?.abort();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/* -------------------------------------------------------------------------- */
/* AgentEvent → SseEvent 翻译                                                 */
/* -------------------------------------------------------------------------- */

function translateEvent(ev: AgentEvent): SseEvent | null {
  switch (ev.type) {
    case 'text':
      return ev.delta ? { type: 'text_delta', text: ev.delta } : null;
    case 'thinking':
      return ev.delta ? { type: 'thinking', text: ev.delta } : null;
    case 'tool_call':
      return { type: 'tool_use', id: ev.call.id, name: ev.call.name, input: ev.call.arguments };
    case 'tool_result':
      return {
        type: 'tool_result',
        id: ev.result.callId,
        content: ev.result.output,
        isError: ev.result.isError,
      };
    case 'compaction_end': {
      const k = (n: number) => `${Math.round(n / 1000)}k`;
      return {
        type: 'notice',
        level: 'info',
        text: `已自动压缩上下文（约 ${k(ev.beforeTokens)} → ${k(ev.afterTokens)} token）`,
      };
    }
    // step_start / message / compaction_start / done 不直接转发
    default:
      return null;
  }
}

function describeError(err: unknown): string {
  if (err instanceof LLMError) {
    return `${err.message}${err.type ? ` [${err.type}]` : ''}`;
  }
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}
