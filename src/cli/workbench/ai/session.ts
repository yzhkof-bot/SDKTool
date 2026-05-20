/**
 * 一次 AI 会话的封装：
 * 持有一个底层 @tencent-ai/agent-sdk 的 SessionImpl，提供：
 *  - sendAndStream(text)：发送用户消息 + 异步迭代器吐 SseEvent
 *  - interrupt()：打断当前轮
 *  - close()：销毁
 *
 * 工作目录始终锁在 jobDir，让 AI 通过 Read/Grep/Glob 访问 diff.json / report.json。
 *
 * 设计取舍：
 *  - includePartialMessages=false：避免 partial 消息组装复杂度，前端体验是"一段一段大块出"，
 *    可接受；后续要做"打字机"再切到 partial。
 *  - canUseTool 永远 allow：用户已经明确选了"完整 SDK 默认全套 tool"，不在这里做拦截。
 *  - permissionMode='bypassPermissions'：让 Bash/Write/Edit 无需弹窗，配合 canUseTool 双保险。
 */

import { unstable_v2_createSession } from '@tencent-ai/agent-sdk';
import type {
  AssistantMessage,
  Message,
  ResultMessage,
  Session as SdkSession,
  UserMessage,
} from '@tencent-ai/agent-sdk';

import { buildSystemPrompt, type BuildSystemPromptArgs } from './prompts.js';
import type { SseEvent } from './types.js';

export interface AiSessionOptions {
  jobDir: string;
  promptContext: BuildSystemPromptArgs;
  /** 模型 override；不传走 SDK 默认 */
  model?: string;
  /** 调试用：SDK 内部 stderr 日志（透传给 server log） */
  log?: (text: string) => void;
}

export interface AiSessionInfo {
  sessionId: string;
  jobDir: string;
  model?: string;
}

export class AiSession {
  private readonly sdk: SdkSession;
  private readonly jobDir: string;
  private readonly model?: string;
  private connected = false;
  private connectingPromise: Promise<void> | null = null;
  private closed = false;
  /** 当前是否有 turn 在进行；用于拒绝并发 send */
  private inFlight = false;
  /** 累计消息数；客户端 reconnect 时可以从这里恢复，但 MVP 不实现 */
  private turnCount = 0;

  constructor(opts: AiSessionOptions) {
    this.jobDir = opts.jobDir;
    this.model = opts.model;

    this.sdk = unstable_v2_createSession({
      cwd: opts.jobDir,
      ...(opts.model ? { model: opts.model } : {}),
      permissionMode: 'bypassPermissions',
      // 关键：所有工具一律放行，避免 SDK 等用户回复永远卡住
      canUseTool: async (_toolName, input) => ({
        behavior: 'allow' as const,
        updatedInput: input,
      }),
      systemPrompt: { append: buildSystemPrompt(opts.promptContext) },
      // settingSources 故意不传 → 不读用户/项目级配置，保证 workbench AI 行为纯由 server 控制
    });
    void opts.log; // SDK Session 暂不支持 stderr 透传；保留参数以便后续替换 provider 时复用
  }

  get info(): AiSessionInfo {
    return {
      sessionId: this.sdk.sessionId,
      jobDir: this.jobDir,
      ...(this.model ? { model: this.model } : {}),
    };
  }

  /** 幂等的 connect：多次调用合并到一个 Promise */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.connectingPromise) {
      this.connectingPromise = this.sdk.connect().then(
        () => {
          this.connected = true;
        },
        (err: unknown) => {
          this.connectingPromise = null;
          throw err;
        },
      );
    }
    await this.connectingPromise;
  }

  /**
   * 发送一条用户消息并流式返回 SseEvent。
   *
   * 用法：
   *   for await (const ev of session.sendAndStream(text)) writer.write(ev);
   *
   * 并发：调用方需保证同一时刻只有一个 sendAndStream 在跑；并发会抛错而不是排队，
   * 避免 SDK 内部状态被打乱（SDK 的 stream() 在一轮结束前不能再被 next()）。
   */
  async *sendAndStream(text: string): AsyncGenerator<SseEvent> {
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
    this.turnCount += 1;

    try {
      await this.connect();
    } catch (err) {
      this.inFlight = false;
      yield {
        type: 'error',
        message: `AI 初始化失败：${describeError(err)}`,
      };
      yield { type: 'done' };
      return;
    }

    yield { type: 'turn_start' };

    try {
      await this.sdk.send(text);
    } catch (err) {
      this.inFlight = false;
      yield { type: 'error', message: `发送失败：${describeError(err)}` };
      yield { type: 'done' };
      return;
    }

    try {
      for await (const msg of this.sdk.stream()) {
        const events = translateSdkMessage(msg);
        for (const ev of events) yield ev;
        // 一轮结束（result message）后 SDK 的 stream() 会自然结束
      }
    } catch (err) {
      yield { type: 'error', message: `推理异常：${describeError(err)}` };
    } finally {
      this.inFlight = false;
    }
  }

  async interrupt(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.sdk.interrupt();
    } catch {
      // SDK 文档说 interrupt 可能在某些状态下 reject；这里吞掉，上层只关心"尽力中断"
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.sdk.close();
    } catch {
      // ignore
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/* -------------------------------------------------------------------------- */
/* SDK Message → SseEvent 翻译                                                */
/* -------------------------------------------------------------------------- */

function translateSdkMessage(msg: Message): SseEvent[] {
  switch (msg.type) {
    case 'assistant':
      return translateAssistant(msg);
    case 'user':
      return translateUserToolResult(msg);
    case 'result':
      return [translateResult(msg)];
    case 'system':
      // SystemMessage(init) / CompactBoundaryMessage / StatusMessage 都走这里，
      // 但目前我们都不消费它们（前端只关心 assistant/tool/result）。
      return [];
    case 'error':
      return [{ type: 'error', message: msg.error }];
    default:
      // stream_event / tool_progress / topic / file-history-snapshot 等暂时静默
      return [];
  }
}

function translateAssistant(msg: AssistantMessage): SseEvent[] {
  const out: SseEvent[] = [];
  for (const block of msg.message.content) {
    if (block.type === 'text') {
      if (block.text) out.push({ type: 'text_delta', text: block.text });
    } else if (block.type === 'thinking') {
      if (block.thinking) out.push({ type: 'thinking', text: block.thinking });
    } else if (block.type === 'tool_use') {
      out.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      });
    }
    // tool_result / image / redacted_thinking 不在 assistant 里出现，忽略
  }
  return out;
}

/**
 * SDK 的 user message 主要两种来源：
 *  1. 工具执行结果（content 是 ContentBlock[]，里面含 tool_result）
 *  2. 用户输入回显（content 是 string）— 我们自己发的，前端已经显示过了，不再回显
 */
function translateUserToolResult(msg: UserMessage): SseEvent[] {
  const out: SseEvent[] = [];
  const content = msg.message.content;
  if (typeof content === 'string') return out;
  for (const block of content) {
    if (block.type === 'tool_result') {
      out.push({
        type: 'tool_result',
        id: block.tool_use_id,
        content: stringifyToolResultContent(block.content),
        isError: !!block.is_error,
      });
    }
  }
  return out;
}

function translateResult(msg: ResultMessage): SseEvent {
  if (msg.subtype === 'success') {
    return {
      type: 'turn_end',
      success: true,
      durationMs: msg.duration_ms,
      totalCostUsd: msg.total_cost_usd,
      numTurns: msg.num_turns,
    };
  }
  return {
    type: 'turn_end',
    success: false,
    durationMs: msg.duration_ms,
    totalCostUsd: msg.total_cost_usd,
    numTurns: msg.num_turns,
    errors: msg.errors,
  };
}

/** tool_result.content 可能是 string 或 ContentBlock[]，统一拍成 string 给前端 */
function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: string; text?: string };
      if (b.type === 'text' && typeof b.text === 'string') {
        parts.push(b.text);
      } else {
        // image / 其他：放个占位，前端能识别
        parts.push(`[${b.type ?? 'unknown'} block]`);
      }
    }
    return parts.join('\n');
  }
  if (content == null) return '';
  return String(content);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}
