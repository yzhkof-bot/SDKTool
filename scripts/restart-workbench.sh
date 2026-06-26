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
#   4. 默认在后台常驻运行（setsid+nohup 脱离终端会话）：终端断开(SIGHUP)也不会结束，
#      日志写到 .wb-logs/workbench-<port>.log，PID 记到 .wb-logs/workbench-<port>.pid
#
# 用法：
#   ./scripts/restart-workbench.sh                 # 交互输入端口（默认 8081）+ build + 后台启动
#   ./scripts/restart-workbench.sh --port 9000     # 直接指定端口，跳过交互
#   ./scripts/restart-workbench.sh --no-build      # 跳过 build（透传给 npm run wb）
#   ./scripts/restart-workbench.sh --dev           # tsx 跑源码（透传）
#   ./scripts/restart-workbench.sh --kill-only     # 只杀旧进程（前台执行，跑完即退）
#   ./scripts/restart-workbench.sh --foreground    # 前台运行（绑终端，Ctrl+C 即停，旧行为）
#   ./scripts/restart-workbench.sh --allow-local   # 临时关掉 devops-only，允许本地路径输入
#   其余参数一律原样透传给 `npm run wb`（如 --host / --no-open）。
#
#   查看日志: tail -f .wb-logs/workbench-<port>.log
#   停止服务: ./scripts/restart-workbench.sh --port <port> --kill-only
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DEFAULT_PORT=8081
PORT=""
DEVOPS_ONLY=1   # 脚本启动默认只支持蓝盾包；--allow-local 可关闭
BACKGROUND=1    # 默认后台常驻；--foreground 可改回前台
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
    --foreground|--fg)
      BACKGROUND=0
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

# 组装最终命令；后台服务无终端/桌面，强制 --no-open 避免无意义的开浏览器尝试
CMD=(npm run wb -- --port "$PORT" --no-open ${PASS_ARGS[@]+"${PASS_ARGS[@]}"})

# --kill-only（停止服务）只是杀进程后立刻结束，无需后台化，直接前台跑完即退。
# 用户显式 --foreground 时也走前台（旧行为：绑终端，Ctrl+C 即停）。
if [[ " ${PASS_ARGS[*]:-} " == *" --kill-only "* || "$BACKGROUND" == "0" ]]; then
  exec "${CMD[@]}"
fi

# ---------- 后台常驻 ----------
LOG_DIR="$ROOT/.wb-logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/workbench-${PORT}.log"
PID_FILE="$LOG_DIR/workbench-${PORT}.pid"

# setsid 让进程脱离当前终端会话（成为新会话首进程），终端断开发出的 SIGHUP 不会传到它；
# nohup 再兜底忽略 SIGHUP；stdin 接 /dev/null 防止后台读终端被挂起。
if command -v setsid >/dev/null 2>&1; then
  setsid nohup "${CMD[@]}" >"$LOG_FILE" 2>&1 </dev/null &
else
  nohup "${CMD[@]}" >"$LOG_FILE" 2>&1 </dev/null &
fi
BG_PID=$!
disown "$BG_PID" 2>/dev/null || true
printf '%s\n' "$BG_PID" >"$PID_FILE"

printf '%s\n' "[wb] 已在后台运行 (PID ${BG_PID})，终端断开也不会结束"
printf '%s\n' "[wb] 查看日志: tail -f ${LOG_FILE}"
printf '%s\n' "[wb] 停止服务: $0 --port ${PORT} --kill-only"

# 后台进程的探活/地址输出进了日志文件，这里短暂轮询日志，把访问地址回显到终端。
# 最多等约 15s（30 次 × 0.5s）。
printf '%s' "[wb] 等待服务就绪 "
WB_URL=""
for ((i = 0; i < 30; i++)); do
  # 后台进程提前退出 = 启动失败
  if ! kill -0 "$BG_PID" 2>/dev/null; then
    printf '\n%s\n' "[wb] ✗ 后台进程已退出，启动可能失败，详见日志: ${LOG_FILE}" >&2
    break
  fi
  # 探活成功行：[wb] ✓ healthz OK · 打开 http://...
  line="$(grep -aE 'healthz OK · 打开 ' "$LOG_FILE" 2>/dev/null | tail -n 1 || true)"
  if [[ -n "$line" ]]; then
    WB_URL="${line##*打开 }"
    WB_URL="${WB_URL%$'\r'}"
    break
  fi
  # 探活失败行
  if grep -aqE 'healthz 探活失败' "$LOG_FILE" 2>/dev/null; then
    printf '\n%s\n' "[wb] ✗ healthz 探活失败，详见日志: ${LOG_FILE}" >&2
    break
  fi
  printf '.'
  sleep 0.5
done
printf '\n'

if [[ -n "$WB_URL" ]]; then
  printf '%s\n' "[wb] ✓ 已就绪 · 访问地址: ${WB_URL}"
fi
