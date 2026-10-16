#!/usr/bin/env bash
# Linux service entrypoint; environment and ownership checks live in the helper.
set -eu
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "${HUB_PYTHON:-python3}" "$ROOT_DIR/scripts/remote_linux_services.py" console --root "$ROOT_DIR" "$@"
