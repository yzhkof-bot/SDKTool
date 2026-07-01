/**
 * AI 助手运行配置：完全来自工程内 `pipelines.config.json` 的 `ai` 段，
 * 不依赖任何环境变量，开箱即用（自闭环）。
 *
 * 在 pipelines.config.json 里配置：
 *   "ai": {
 *     "apiKey": "你的-claude-代理-key",
 *     "baseUrl": "http://api.timiai.woa.com/ai_api_manage/llmproxy",  // 可省，有默认
 *     "model": "claude-sonnet-4.6",                                    // 可省，有默认
 *     "thinkingBudget": 2048                                           // 可省，设了才开扩展思考
 *   }
 *
 * apiKey 为空即视为未配置，health 会返回不可用。
 */

import { loadDevopsConfig, type AiConfig } from '../devopsConfig.js';

export type LlmConfig = AiConfig;

/** 读取并校验 LLM 配置；缺 apiKey 时抛错。 */
export function buildLlmConfig(overrideModel?: string): LlmConfig {
  const ai = loadDevopsConfig().ai;
  if (!ai.apiKey) {
    throw new Error('未配置 AI：请在 pipelines.config.json 的 "ai" 段填写 apiKey');
  }
  return { ...ai, model: overrideModel || ai.model };
}

/** 是否已配置 apiKey（health 检查用，不抛错）。 */
export function hasLlmCredentials(): boolean {
  try {
    return !!loadDevopsConfig().ai.apiKey;
  } catch {
    return false;
  }
}

/** 当前默认模型（展示用）。 */
export function getDefaultModel(): string {
  try {
    return loadDevopsConfig().ai.model;
  } catch {
    return 'claude-sonnet-4.6';
  }
}
