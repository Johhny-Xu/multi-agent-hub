#!/usr/bin/env bash
# ==============================================================
# Multi-Agent Hub - DSH (DeepSeek Harness) Plugin Installer
# ==============================================================
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo 'Usage: install.sh --profile EXISTING_PROFILE [--url URL] [--check]'
  echo 'This helper prepares configuration; the official dsh CLI links the package.'
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_PYTHON="${HUB_PYTHON:-python3}"
"$DSH_PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1 || { echo 'Python 3.8+ is required; set HUB_PYTHON to a working Python path.'; exit 1; }

exec "$DSH_PYTHON" "$ROOT_DIR/install-dsh.py" "$@"
