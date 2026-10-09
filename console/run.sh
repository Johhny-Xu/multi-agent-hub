#!/usr/bin/env bash
# Run the console from this checkout, preserving caller/.env settings.
set -e
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi
export HUBCONSOLE_HOST="${HUBCONSOLE_HOST:-127.0.0.1}"
export HUBCONSOLE_PORT="${HUBCONSOLE_PORT:-8890}"
export HUBCONSOLE_SUB_HOST="${HUBCONSOLE_SUB_HOST:-127.0.0.1}"
export HUBCONSOLE_SERVER_URL="${HUBCONSOLE_SERVER_URL:-http://127.0.0.1:${AGENTHUB_PORT:-8765}/mcp}"
export HUBCONSOLE_SERVER_TOKEN="${HUBCONSOLE_SERVER_TOKEN:-${HUB_TOKEN:-}}"
command -v node >/dev/null 2>&1 || { echo "Node.js is required" >&2; exit 1; }
exec node "$ROOT_DIR/console/server.mjs"
