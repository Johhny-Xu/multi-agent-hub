#!/bin/sh
set -eu
action=${1:-install}
shift
package_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
installer_python=${AGENTHUB_PYTHON:-${HUB_PYTHON:-}}
if [ -z "$installer_python" ]; then
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3,8) else 1)' >/dev/null 2>&1; then
      installer_python=$(command -v "$candidate")
      break
    fi
  done
fi
if [ -z "$installer_python" ] || ! "$installer_python" -c 'import sys; sys.exit(0 if sys.version_info >= (3,8) else 1)' >/dev/null 2>&1; then
  echo 'Python 3.8+ is required (native plugin installation: 3.11+): https://www.python.org/downloads/ . Set AGENTHUB_PYTHON to a working executable.' >&2
  exit 1
fi
if [ "$action" = install ]; then
  exec "$installer_python" "$package_root/packaging/install.py" --bundle "$package_root" "$@"
fi
exec "$installer_python" "$package_root/packaging/service.py" "$action" --prefix "$package_root" "$@"
