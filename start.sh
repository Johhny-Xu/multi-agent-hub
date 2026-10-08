#!/usr/bin/env bash
# ==============================================================
# All-in-One Agent Hub 一键启动脚本 / Launcher
# ==============================================================
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

# 1. 检查运行环境 / Check prerequisites
command -v python3 >/dev/null 2>&1 || { echo "[Error] 需要 Python 3.8+，但未找到 python3 命令！"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "[Error] 需要 Node.js 20+，但未找到 node 命令！"; exit 1; }

# 2. 加载环境配置 / Load environment
if [ -f "$ROOT_DIR/.env" ]; then
  # 兼容注释和空行导出环境变量
  set -a
  source "$ROOT_DIR/.env"
  set +a
elif [ -f "$ROOT_DIR/hub/.env" ]; then
  set -a
  source "$ROOT_DIR/hub/.env"
  set +a
fi

# 默认变量填充
export AGENTHUB_HOST="${AGENTHUB_HOST:-127.0.0.1}"
export AGENTHUB_PORT="${AGENTHUB_PORT:-8765}"
export HUB_TOKEN="${HUB_TOKEN:-}"
export HUBCONSOLE_HOST="${HUBCONSOLE_HOST:-0.0.0.0}"
export HUBCONSOLE_PORT="${HUBCONSOLE_PORT:-8890}"
export HUBCONSOLE_SERVER_URL="${HUBCONSOLE_SERVER_URL:-http://127.0.0.1:${AGENTHUB_PORT}/mcp}"
export HUBCONSOLE_SERVER_TOKEN="${HUBCONSOLE_SERVER_TOKEN:-$HUB_TOKEN}"

# 3. 准备配置文件 / Prepare configs
mkdir -p "$ROOT_DIR/logs" "$ROOT_DIR/.run"

if [ ! -f "$ROOT_DIR/hub/agents.json" ]; then
  if [ -f "$ROOT_DIR/hub/agents.example.json" ]; then
    echo "[Info] hub/agents.json 不存在，已从 agents.example.json 自动生成示例配置..."
    cp "$ROOT_DIR/hub/agents.example.json" "$ROOT_DIR/hub/agents.json"
  fi
fi

# 4. 检查并清理旧实例 / Stop existing instances if running
if [ -f "$ROOT_DIR/stop.sh" ]; then
  bash "$ROOT_DIR/stop.sh" --silent || true
fi

echo "=========================================================="
echo "          🚀 Starting All-in-One Agent Hub...             "
echo "=========================================================="

# 5. 启动 Task Bus (Python MCP Server)
echo "[1/2] 正在拉起任务总线 (Task Bus :${AGENTHUB_PORT})..."
cd "$ROOT_DIR/hub"
nohup python3 agent_hub.py --http "${AGENTHUB_PORT}" --host "${AGENTHUB_HOST}" > "$ROOT_DIR/logs/hub.log" 2>&1 &
HUB_PID=$!
echo "$HUB_PID" > "$ROOT_DIR/.run/hub.pid"

# 6. 启动 Web 控制台 (Node.js Console)
echo "[2/2] 正在拉起 Web 控制台 (Web Console :${HUBCONSOLE_PORT})..."
cd "$ROOT_DIR/console"
nohup node server.mjs > "$ROOT_DIR/logs/console.log" 2>&1 &
CONSOLE_PID=$!
echo "$CONSOLE_PID" > "$ROOT_DIR/.run/console.pid"

cd "$ROOT_DIR"

# 7. 稍作等待并验证存活 / Health Check
sleep 2

if ! kill -0 "$HUB_PID" 2>/dev/null; then
  echo "[Error] Task Bus 启动失败！请检查 logs/hub.log 查看报错日志。"
  exit 1
fi

if ! kill -0 "$CONSOLE_PID" 2>/dev/null; then
  echo "[Error] Web Console 启动失败！请检查 logs/console.log 查看报错日志。"
  exit 1
fi

echo ""
echo "=========================================================="
echo "  ✅ All-in-One Agent Hub 已成功启动！"
echo "=========================================================="
echo "  🌐 Web 控制台地址 : http://localhost:${HUBCONSOLE_PORT}/dashboard"
if [ "$HUBCONSOLE_HOST" = "0.0.0.0" ]; then
  echo "     (局域网请使用本机局域网 IP 访问)"
fi
echo "  📡 MCP 任务总线地址 : http://${AGENTHUB_HOST}:${AGENTHUB_PORT}/mcp"
if [ -n "$HUB_TOKEN" ]; then
  echo "  🔑 认证 Token     : [已启用]"
else
  echo "  🔑 认证 Token     : [无，仅限回环本地使用]"
fi
echo "  📁 日志查看       : tail -f logs/console.log 或 logs/hub.log"
echo "  ⏹  停止服务       : ./stop.sh"
echo "=========================================================="
