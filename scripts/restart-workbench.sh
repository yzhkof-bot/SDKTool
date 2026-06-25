#!/usr/bin/env bash
#
# Linux 一键重启 / 启动 workbench（npm run wb 的交互式包装）。
#
# 干啥：
#   1. 交互式让你输入监听端口（直接回车用默认 8081）
#   2. 打 devops-only 标记（SDKTOOL_DEVOPS_ONLY=1）：脚本启动的实例只支持蓝盾包
#      对比方式，分析/对比界面禁用本地路径输入（业务逻辑读这个环境变量判断）
#   3. 调 `npm run wb -- --port <port> ...` 复用现有跨平台重启逻辑
#      （杀旧进程 → build → 起新进程 → 探活 /healthz，详见 scripts/restart-workbench.mjs）
#
# 用法：
#   ./scripts/restart-workbench.sh                 # 交互输入端口（默认 8081）+ build + 重启
#   ./scripts/restart-workbench.sh --port 9000     # 直接指定端口，跳过交互
#   ./scripts/restart-workbench.sh --no-build      # 跳过 build（透传给 npm run wb）
#   ./scripts/restart-workbench.sh --dev           # tsx 跑源码（透传）
#   ./scripts/restart-workbench.sh --kill-only     # 只杀旧进程（透传）
#   ./scripts/restart-workbench.sh --allow-local   # 临时关掉 devops-only，允许本地路径输入
#   其余参数一律原样透传给 `npm run wb`（如 --host / --no-open）。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DEFAULT_PORT=8081
PORT=""
DEVOPS_ONLY=1   # 脚本启动默认只支持蓝盾包；--allow-local 可关闭
PASS_ARGS=()

# 解析参数：--port / --allow-local 自己消费，其余原样透传给 npm run wb
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      PORT="${2:-}"
      shift 2
      ;;
    --port=*)
      PORT="${1#--port=}"
      shift
      ;;
    --allow-local)
      DEVOPS_ONLY=0
      shift
      ;;
    *)
      PASS_ARGS+=("$1")
      shift
      ;;
  esac
done

# 端口：未指定则交互输入（回车用默认）
if [[ -z "$PORT" ]]; then
  read -r -p "[wb] 请输入监听端口 (默认 ${DEFAULT_PORT}): " input_port || true
  PORT="${input_port:-$DEFAULT_PORT}"
fi

# 校验端口
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  printf '%s\n' "[wb] 非法端口: $PORT" >&2
  exit 2
fi

# devops-only 标记：业务逻辑（workbench server）读 SDKTOOL_DEVOPS_ONLY 判断
# 分析/对比界面是否支持本地路径输入。脚本启动默认只支持蓝盾包对比。
export SDKTOOL_DEVOPS_ONLY="$DEVOPS_ONLY"

if [[ "$DEVOPS_ONLY" == "1" ]]; then
  printf '%s\n' "[wb] devops-only 模式：仅支持蓝盾包对比（加 --allow-local 可放开本地路径）"
else
  printf '%s\n' "[wb] --allow-local：已放开本地路径输入"
fi
printf '%s\n' "[wb] 启动: npm run wb -- --port ${PORT} ${PASS_ARGS[*]:-}"

cd "$ROOT"
exec npm run wb -- --port "$PORT" ${PASS_ARGS[@]+"${PASS_ARGS[@]}"}
