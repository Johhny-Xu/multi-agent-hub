#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TREE_NAME="$(basename "$ROOT_DIR")"
# 远端目录：已有 node_modules 的固定目录（rtest 用 mah，0154 用 om0154）；可用 OMB_REMOTE_BUILD_DIR 覆盖。
case "${TREE_NAME}" in
  multi-agent-hub) DEFAULT_REMOTE_DIR=/data/workspace/mah ;;
  openmausbot-0154) DEFAULT_REMOTE_DIR=/data/workspace/om0154 ;;
  openmausbot-0146) DEFAULT_REMOTE_DIR=/data/workspace/om0146 ;;
  *) DEFAULT_REMOTE_DIR="/data/workspace/${TREE_NAME}" ;;
esac
REMOTE_DIR="${OMB_REMOTE_BUILD_DIR:-$DEFAULT_REMOTE_DIR}"
# 远端构建机的 SSH 别名：OMB_REMOTE_BUILD_HOST，或写在 ~/.config/omb-remote-build-host。
REMOTE_HOST="${OMB_REMOTE_BUILD_HOST:-$(cat "${HOME}/.config/omb-remote-build-host" 2>/dev/null || true)}"
if [ -z "$REMOTE_HOST" ]; then
  echo "[remote-build] Error: set OMB_REMOTE_BUILD_HOST or ~/.config/omb-remote-build-host" >&2
  exit 2
fi
BACKUP_DIR="${HOME}/.cache/zrev"
STAMP="$(date +%Y%m%d-%H%M%S)"
TMP_TGZ="$(mktemp "/tmp/omb-remote-dist-${STAMP}-XXXXXX.tgz")"

cleanup() {
  rm -f "$TMP_TGZ"
}
trap cleanup EXIT

cd "$ROOT_DIR"

echo "[remote-build] Syncing ${TREE_NAME} to ${REMOTE_HOST}:${REMOTE_DIR}..."
rsync -az --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude 'dist' \
  --exclude 'dist-server' \
  --exclude 'release' \
  --exclude 'state' \
  --exclude '*.log' \
  ./ "${REMOTE_HOST}:${REMOTE_DIR}/"

echo "[remote-build] Checking remote node_modules and running vite build on ${REMOTE_HOST}..."
ssh "$REMOTE_HOST" "bash -lc '
  set -euo pipefail
  cd \"${REMOTE_DIR}\"
  if [ ! -d node_modules ] || [ ! -x node_modules/.bin/vite ]; then
    echo \"[remote-build] Error: ${REMOTE_DIR}/node_modules or vite missing on ${REMOTE_HOST}. Refusing local fallback.\" >&2
    exit 1
  fi
  export PATH=/data/home/.local/opt/node24/bin:\$PATH
  export NODE_OPTIONS=--max-old-space-size=4096
  node_modules/.bin/vite build
  tar -czf \"/tmp/${TREE_NAME}-dist-${STAMP}.tgz\" dist
'"

echo "[remote-build] Pulling built dist archive from ${REMOTE_HOST}..."
scp -q "${REMOTE_HOST}:/tmp/${TREE_NAME}-dist-${STAMP}.tgz" "$TMP_TGZ"
ssh "$REMOTE_HOST" "rm -f \"/tmp/${TREE_NAME}-dist-${STAMP}.tgz\""

if [ -d "${ROOT_DIR}/dist" ]; then
  mkdir -p "$BACKUP_DIR"
  BACKUP_PATH="${BACKUP_DIR}/${TREE_NAME}-dist-${STAMP}.tgz"
  echo "[remote-build] Backing up local dist to ${BACKUP_PATH}..."
  tar -czf "$BACKUP_PATH" -C "$ROOT_DIR" dist
  rm -rf "${ROOT_DIR}/dist"
fi

echo "[remote-build] Extracting new dist into ${ROOT_DIR}/dist..."
tar -xzf "$TMP_TGZ" -C "$ROOT_DIR"
echo "[remote-build] Done."
