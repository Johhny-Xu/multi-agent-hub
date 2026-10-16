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
  bundle=$package_root
  if [ ! -f "$package_root/manifest.json" ] && [ -f "$package_root/packaging/build.py" ]; then
    # Source checkout (no release manifest): build a "both" bundle into a temp dir
    # first, because install.py only accepts a bundle carrying manifest.json.
    build_dir=$(mktemp -d "${TMPDIR:-/tmp}/agenthub-src-bundle.XXXXXX")
    trap 'rm -rf "$build_dir"' EXIT HUP INT TERM
    echo "Source tree detected; building an installable bundle in $build_dir" >&2
    "$installer_python" "$package_root/packaging/build.py" --output "$build_dir" --component both >/dev/null
    "$installer_python" -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$(ls "$build_dir"/agenthub-*-both.zip)" "$build_dir"
    bundle=$(ls -d "$build_dir"/agenthub-*-both)
    # Deliberately not exec'd: exec would replace this shell and skip the EXIT trap,
    # leaving the temp bundle behind on every source-tree install.
    "$installer_python" "$package_root/packaging/install.py" --bundle "$bundle" "$@"
    exit $?
  fi
  exec "$installer_python" "$package_root/packaging/install.py" --bundle "$bundle" "$@"
fi
if [ "$action" = connect ]; then
  exec "$installer_python" "$package_root/packaging/connect.py" --prefix "$package_root" "$@"
fi
exec "$installer_python" "$package_root/packaging/service.py" "$action" --prefix "$package_root" "$@"
