#!/bin/bash
# shotlist-studio 服务管理（:8094）—— 脱会话常驻 + 崩溃自动重拉
# 用法: bash scripts/serve.sh {start|stop|status}
# ⚠️ 不要用 Hermes 后台进程方式跑：会话关闭时会被 SIGTERM 清掉（2026-09-19 实证）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8094}"
PIDFILE="$ROOT/data/serve.pid"
LOG="$ROOT/data/serve.log"

# pidfile：第 1 行 pid、第 2 行启动时刻（ps lstart；防 PID 复用误杀；兼容旧单行格式）
alive() {
  local p st now
  p="$(head -n1 "$PIDFILE" 2>/dev/null || true)"
  [ -n "$p" ] || return 1
  kill -0 "$p" 2>/dev/null || return 1
  st="$(sed -n '2p' "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$st" ]; then
    now="$(ps -o lstart= -p "$p" 2>/dev/null | sed 's/^ *//' || true)"
    [ -z "$now" ] || [ "$now" = "$st" ] || return 1
  fi
  return 0
}
healthy() { curl -sf -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; }

case "${1:-status}" in
  start)
    if healthy; then echo "已在运行（健康）"; exit 0; fi
    mkdir -p "$ROOT/data"
    cd "$ROOT" || exit 1
    setsid bash -c 'echo $$ > '"$PIDFILE"'; ps -o lstart= -p $$ | sed "s/^ *//" >> '"$PIDFILE"'; d=2; while true; do
      sz=$(wc -c < '"$LOG"' 2>/dev/null || echo 0)
      [ "$sz" -gt 2097152 ] && mv -f '"$LOG"' '"$LOG"'.1 2>/dev/null || true
      echo "[$(date "+%F %T")] start" >> '"$LOG"'
      t0=$(date +%s)
      python3 -u server/app.py --port '"$PORT"' >> '"$LOG"' 2>&1
      rc=$?; ran=$(( $(date +%s) - t0 ))
      echo "[$(date "+%F %T")] exited($rc) after ${ran}s, retry in ${d}s" >> '"$LOG"'
      [ "$ran" -ge 30 ] && d=2
      sleep "$d"
      [ "$d" -lt 60 ] && d=$((d * 2))
    done' < /dev/null > /dev/null 2>&1 &
    for i in $(seq 1 60); do sleep 0.5; if healthy; then break; fi; done   # 30s（P2·S4-C5：冷启动更慢不误报）
    if healthy; then
      echo "已启动 → http://127.0.0.1:$PORT/"
    else
      echo "启动异常，日志尾部："; tail -8 "$LOG"; exit 1
    fi
    ;;
  stop)
    if ! alive; then
      if healthy; then
        echo "警告：pidfile 无效，但端口 $PORT 仍在响应（孤儿进程？未做处理）" >&2
        exit 1
      fi
      rm -f "$PIDFILE"
      echo "未在运行"
      exit 0
    fi
    p="$(head -n1 "$PIDFILE")"
    kill -- -"$p" 2>/dev/null || true
    for i in $(seq 1 20); do sleep 0.25; if ! alive; then break; fi; done
    if alive; then
      echo "停止失败：进程组仍在（pidfile 已保留，可重试）" >&2
      exit 1
    fi
    rm -f "$PIDFILE"
    if healthy; then
      echo "警告: 端口 $PORT 仍通（其他进程？）" >&2
      exit 1
    fi
    echo "已停止"
    ;;
  status)
    if healthy; then
      echo "运行中（健康）pid=$(head -n1 "$PIDFILE" 2>/dev/null || true)"
    else
      echo "未运行"
    fi
    ;;
  *)
    echo "用法: bash scripts/serve.sh {start|stop|status}" >&2
    exit 2
    ;;
esac
