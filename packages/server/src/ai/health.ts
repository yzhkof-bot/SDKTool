/**
 * AI 功能健康检查：
 *  - 凭据是否就绪：是否配置了 LLM_API_KEY 环境变量。
 *
 * SDK 包是否装好不在这里检查：server.ts → ai/session.ts 顶层 import 已经依赖该包，
 * 包缺失则 workbench 启动时立即报错，走不到这里。
 *
 * 真正的认证 / 网络失败由第一次 sendAndStream 抛出，前端在消息流里展示。
 */

import { getDefaultModel, hasLlmCredentials } from './env.js';
import type { AiHealthResponse } from './types.js';

export function checkAiHealth(opts: { model?: string } = {}): AiHealthResponse {
  if (!hasLlmCredentials()) {
    return {
      available: false,
      provider: 'sagent-sdk',
      reason: '未检测到 LLM_API_KEY：请设置 LLM_API_KEY 环境变量后重启 workbench（可选 LLM_BASE_URL / LLM_MODEL）',
    };
  }

  return {
    available: true,
    provider: 'sagent-sdk',
    model: opts.model ?? getDefaultModel(),
  };
}
