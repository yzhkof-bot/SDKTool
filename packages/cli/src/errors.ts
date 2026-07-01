/**
 * 统一退出码语义：
 *   0 = 成功
 *   1 = 分析失败（解压、IO、schema 错误等运行时错误）
 *   2 = 入参错误（CLI 参数非法、文件不存在等）
 */
export const EXIT_OK = 0;
export const EXIT_RUNTIME_ERROR = 1;
export const EXIT_USAGE_ERROR = 2;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface CliErrorPayload {
  error: {
    code: string;
    message: string;
    stack?: string;
  };
}

export function buildErrorPayload(err: unknown, code = 'UNKNOWN_ERROR'): CliErrorPayload {
  if (err instanceof Error) {
    return {
      error: {
        code: err.name === 'UsageError' ? 'USAGE_ERROR' : code,
        message: err.message,
        stack: err.stack,
      },
    };
  }
  return {
    error: {
      code,
      message: String(err),
    },
  };
}
