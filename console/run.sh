#!/usr/bin/env bash
# agent-hub-console 独立后端 (Linux 版) — 由 standalone 模式引导
export HUBCONSOLE_HOST=0.0.0.0
export HUBCONSOLE_PORT=8890
export HUBCONSOLE_SUB_HOST=0.0.0.0
export HUBCONSOLE_DATA_DIR="$HOME/.agent-hub-console"
cd "$HOME/agent-hub-console"
exec /usr/bin/node miniapp/node/server.mjs >> "$HOME/agent-hub-console/console.log" 2>&1
