#!/usr/bin/env bash
# Stop only processes whose recorded creation time and command match this checkout.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SILENT=0
[ "${1:-}" = "--silent" ] && SILENT=1
[ "$SILENT" -eq 0 ] && echo "正在停止 Multi-Agent Hub 服务..."
for service in console hub; do
  pid_file="$ROOT_DIR/.run/$service.pid"
  started_file="$ROOT_DIR/.run/$service.started"
  [ -f "$pid_file" ] || continue
  service_pid=$(cat "$pid_file")
  case "$service_pid" in ''|*[!0-9]*) continue ;; esac
  if [ "$service" = hub ]; then entry="$ROOT_DIR/hub/agent_hub.py"; else entry="$ROOT_DIR/console/server.mjs"; fi
  current_started=$(ps -p "$service_pid" -o lstart= 2>/dev/null || true)
  recorded_started=$(cat "$started_file" 2>/dev/null || true)
  current_args=$(ps -p "$service_pid" -o args= 2>/dev/null || true)
  if [ -n "$recorded_started" ] && [ "$current_started" = "$recorded_started" ]; then
    case "$current_args" in *"$entry"*) kill "$service_pid" 2>/dev/null || true ;; esac
  fi
  rm -f -- "$pid_file" "$started_file"
done
[ "$SILENT" -eq 0 ] && echo "已停止本仓库记录且匹配的服务。"
exit 0
