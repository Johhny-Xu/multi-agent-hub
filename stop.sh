#!/usr/bin/env bash
# ==============================================================
# Multi-Agent Hub 一键停止脚本 / Stopper
# ==============================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SILENT=0
if [ "${1:-}" = "--silent" ]; then
  SILENT=1
fi

[ $SILENT -eq 0 ] && echo "正在停止 Multi-Agent Hub 服务..."

# 1. 按 PID 停止
if [ -f "$ROOT_DIR/.run/console.pid" ]; then
  CPID=$(cat "$ROOT_DIR/.run/console.pid" 2>/dev/null || true)
  if [ -n "$CPID" ] && kill -0 "$CPID" 2>/dev/null; then
    kill "$CPID" 2>/dev/null || true
    [ $SILENT -eq 0 ] && echo "  - 已停止 Web Console (PID: $CPID)"
  fi
  rm -f "$ROOT_DIR/.run/console.pid"
fi

if [ -f "$ROOT_DIR/.run/hub.pid" ]; then
  HPID=$(cat "$ROOT_DIR/.run/hub.pid" 2>/dev/null || true)
  if [ -n "$HPID" ] && kill -0 "$HPID" 2>/dev/null; then
    kill "$HPID" 2>/dev/null || true
    [ $SILENT -eq 0 ] && echo "  - 已停止 Task Bus (PID: $HPID)"
  fi
  rm -f "$ROOT_DIR/.run/hub.pid"
fi

# 2. 兜底清理残留 (仅匹配本仓库启动特征)
pkill -f "agent_hub.py.*--http" 2>/dev/null || true

[ $SILENT -eq 0 ] && echo "✅ 服务已全部停止。"
