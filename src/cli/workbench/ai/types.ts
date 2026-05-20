/**
 * Workbench AI 对话模块的前后端共享协议类型。
 *
 * 这里只列**走线**的事件结构，不暴露 @tencent-ai/agent-sdk 内部类型。
 * server 把 SDK 流式消息归一成下面这几种 SseEvent，前端按事件名分支渲染。
 */

/** /api/ai/health 响应：告知前端 AI 功能是否可用 */
export interface AiHealthResponse {
  available: boolean;
  /** provider 名，目前固定为 'codebuddy' */
  provider: 'codebuddy';
  /** 当前后端选用的模型；未配置则 undefined */
  model?: string;
  /** 不可用时的原因（缺凭据、SDK 起不来等） */
  reason?: string;
}

/** /api/ai/conversations 请求体 */
export interface CreateConversationRequest {
  /** 必填：workbench job id，会话会落到 jobDir(jobId) 作为 cwd */
  jobId: string;
  /** 可选模型 override */
  model?: string;
}

/** /api/ai/conversations 响应 */
export interface CreateConversationResponse {
  conversationId: string;
  /** SDK 内部的 sessionId，便于 debug；前端一般用不到 */
  sessionId: string;
  jobId: string;
  cwd: string;
  model?: string;
}

/** POST /api/ai/conversations/:id/messages 请求体 */
export interface SendMessageRequest {
  text: string;
}

/**
 * 前后端约定的 SSE 事件协议。
 *
 * 每个事件按 SSE 标准编码为：
 *   event: <type>\n
 *   data: <json without "type" field>\n\n
 *
 * 详见 sse.ts。
 */
export type SseEvent =
  /** 一轮会话开始；前端可清掉上一轮的 thinking 状态 */
  | { type: 'turn_start' }
  /** 文本增量；前端追加到当前 assistant 气泡 */
  | { type: 'text_delta'; text: string }
  /** 完整的 thinking（推理）文本；前端可选展示 */
  | { type: 'thinking'; text: string }
  /** 工具开始执行 */
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  /** 工具结果（成功或失败） */
  | { type: 'tool_result'; id: string; content: string; isError: boolean }
  /** 一轮会话结束（含统计） */
  | {
      type: 'turn_end';
      success: boolean;
      durationMs: number;
      totalCostUsd: number;
      numTurns: number;
      errors?: string[];
    }
  /** 服务端异常（与 turn_end 的 success=false 不同：这是 transport 级问题） */
  | { type: 'error'; message: string }
  /** 关闭流（无论成功失败都会发） */
  | { type: 'done' };
