/**
 * AI 功能健康检查：
 *  - 凭据看起来是否就绪：CODEBUDDY_API_KEY/CODEBUDDY_AUTH_TOKEN 或 ~/.codebuddy 登录态
 *
 * SDK 包是否装好不在这里检查：server.ts → ai/session.ts 顶层 import 已经依赖该包，
 * 如果包缺失，workbench 启动时就会立即报错，根本走不到这个接口。
 *
 * 真正的认证 / 网络失败由第一次 sendAndStream 抛出，前端在消息流里展示。
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getInternetEnvironment } from './env.js';
import type { AiHealthResponse } from './types.js';

export function checkAiHealth(opts: { model?: string } = {}): AiHealthResponse {
  // 凭据：以下三选一即可
  //   - 环境变量 CODEBUDDY_API_KEY / CODEBUDDY_AUTH_TOKEN
  //   - ~/.codebuddy 目录下有登录产物
  const hasEnvCreds =
    !!process.env.CODEBUDDY_API_KEY || !!process.env.CODEBUDDY_AUTH_TOKEN;
  const hasLoginDir = existsSync(join(homedir(), '.codebuddy'));
  const internetEnvironment = getInternetEnvironment();

  if (!hasEnvCreds && !hasLoginDir) {
    return {
      available: false,
      provider: 'codebuddy',
      internetEnvironment,
      reason:
        '未检测到 CodeBuddy 登录态：请在终端跑 `codebuddy` 完成一次登录，或设置 CODEBUDDY_API_KEY 环境变量后重启 workbench',
    };
  }

  return {
    available: true,
    provider: 'codebuddy',
    internetEnvironment,
    ...(opts.model ? { model: opts.model } : {}),
  };
}
