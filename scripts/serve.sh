#!/bin/bash
# shotlist-studio 服务管理（:8094）—— 脱会话常驻 + 崩溃自动重拉
# 用法: bash scripts/serve.sh {start|stop|status}
# ⚠️ 不要用 Hermes 后台进程方式跑：会话关闭时会被 SIGTERM 清掉（2026-09-19 实证）。
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8094}"
PIDFILE="$ROOT/data/serve.pid"
LOG="$ROOT/data/serve.log"
mkdir -p "$ROOT/data"
alive() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; }
healthy() { curl -sf -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; }
case "${1:-status}" in
  start)
    if healthy; then echo "已在运行（健康）"; exit 0; fi
    cd "$ROOT" || exit 1
    setsid bash -c 'echo $$ > '"$PIDFILE"'; while true; do
      echo "[$(date "+%F %T")] start" >> '"$LOG"'
      python3 -u server/app.py >> '"$LOG"' 2>&1
      echo "[$(date "+%F %T")] exited($?), retry in 2s" >> '"$LOG"'
      sleep 2
    done' < /dev/null > /dev/null 2>&1 &
    for i in $(seq 1 12); do sleep 0.5; healthy && break; done
    healthy && echo "已启动 → http://192.168.3.65:$PORT/" || { echo "启动异常，日志尾部："; tail -8 "$LOG"; exit 1; }
    ;;
  stop)
    alive && kill -- -"$(cat "$PIDFILE")" 2>/dev/null; sleep 0.5; rm -f "$PIDFILE"
    healthy && echo "警告: 端口 $PORT 仍通（其他进程？）" || echo "已停止"
    ;;
  status)
    healthy && echo "运行中（健康）pid=$(cat "$PIDFILE" 2>/dev/null)" || echo "未运行"
    ;;
  *) echo "用法: bash scripts/serve.sh {start|stop|status}"; exit 2;;
esac
