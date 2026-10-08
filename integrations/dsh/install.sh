#!/usr/bin/env bash
# ==============================================================
# All-in-One Agent Hub - DSH (DeepSeek Harness) Plugin Installer
# ==============================================================
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v python3 >/dev/null 2>&1 || { echo "[Error] 需要 python3 命令"; exit 1; }

python3 "$ROOT_DIR/install-dsh.py" "$@"
