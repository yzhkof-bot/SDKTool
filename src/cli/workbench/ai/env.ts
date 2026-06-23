/**
 * 给 @tencent-ai/agent-sdk 子进程组装环境变量。
 *
 * 背景（与 QuickTool commit 4c67073 同源问题）：
 *  SDK 会 spawn 一个 codebuddy CLI 子进程。当 workbench 不是从「已经
 *  `export CODEBUDDY_INTERNET_ENVIRONMENT=ioa` 的终端」启动时（比如 IDE / 桌面快捷方式
 *  拉起、或被别的进程间接 spawn），子进程拿不到这个变量 → iOA 登录态失效 →
 *  `getAvailableModels()` 探测失败 → 模型列表只剩一个 fallback「Auto」。
 *
 *  因此这里显式把 CodeBuddy 相关变量透传给子进程，并对
 *  `CODEBUDDY_INTERNET_ENVIRONMENT` 兜底默认 `ioa`（可用同名环境变量覆盖）。
 */

/** 需要透传给 SDK 子进程的 CodeBuddy 环境变量 */
const CODEBUDDY_ENV_KEYS = [
  'CODEBUDDY_API_KEY',
  'CODEBUDDY_AUTH_TOKEN',
  'CODEBUDDY_CODE_PATH',
  'CODEBUDDY_INTERNET_ENVIRONMENT',
] as const;

/** 默认上网环境；iOA 内网登录态需要这个值 */
const DEFAULT_INTERNET_ENVIRONMENT = 'ioa';

/**
 * 组装 SDK 子进程环境变量。
 * 只挑选出 CodeBuddy 相关项，避免把整个 process.env 倒进去。
 * `CODEBUDDY_INTERNET_ENVIRONMENT` 缺省时兜底为 `ioa`。
 */
export function buildSdkEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of CODEBUDDY_ENV_KEYS) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  if (!env.CODEBUDDY_INTERNET_ENVIRONMENT) {
    env.CODEBUDDY_INTERNET_ENVIRONMENT = DEFAULT_INTERNET_ENVIRONMENT;
  }
  return env;
}

/** 当前实际生效的上网环境（给 health / 状态栏展示用） */
export function getInternetEnvironment(): string {
  return process.env.CODEBUDDY_INTERNET_ENVIRONMENT || DEFAULT_INTERNET_ENVIRONMENT;
}
