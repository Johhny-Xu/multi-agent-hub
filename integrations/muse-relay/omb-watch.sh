#!/usr/bin/env bash
# OpenMausBot Muse Relay hook: one poll round per run.
# The runtime supplies log/silent/wake; this script only locks, calls the
# client and wakes the worker after the turn is durable on disk.
set -uo pipefail
umask 077

if [ -z "${HATCH_HOOK_RUNTIME:-}" ]; then
  echo "HATCH_HOOK_RUNTIME is not set; run this inside the Muse hook runtime" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$HATCH_HOOK_RUNTIME" || {
  echo "cannot source HATCH_HOOK_RUNTIME" >&2
  exit 1
}

for fn in log silent wake; do
  if ! command -v "$fn" >/dev/null 2>&1; then
    echo "hook runtime is missing $fn" >&2
    exit 1
  fi
done
if ! command -v flock >/dev/null 2>&1; then
  echo "flock is required for the single-instance hook lock" >&2
  exit 1
fi

HERE=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PY=${OMB_RELAY_PYTHON:-python3}
CLI="$HERE/omb_relay.py"

STATE_DIR=$("$PY" "$CLI" state-dir 2>/dev/null) || STATE_DIR=""
case "$STATE_DIR" in
  /*) ;;
  *)
    silent "state dir unavailable"
    exit 0
    ;;
esac
mkdir -p "$STATE_DIR" 2>/dev/null || {
  silent "state dir unavailable"
  exit 0
}

exec 9>"$STATE_DIR/watch.lock" || {
  silent "state lock unavailable"
  exit 0
}
if ! flock -n 9; then
  exit 0
fi

recovery=$("$PY" "$CLI" recover 2>/dev/null) || recovery=""
recovered=0
quarantined=0
for kv in $recovery; do
  case "$kv" in
    recovered=*) recovered=${kv#recovered=} ;;
    quarantined=*) quarantined=${kv#quarantined=} ;;
  esac
done
case "$recovered" in ''|*[!0-9]*) recovered=0 ;; esac
case "$quarantined" in ''|*[!0-9]*) quarantined=0 ;; esac
if [ "$recovered" -ne 0 ] || [ "$quarantined" -ne 0 ]; then
  log "muse-relay recovery recovered=$recovered quarantined=$quarantined"
fi

pending=$("$PY" "$CLI" pending-count 2>/dev/null) || pending=""
case "$pending" in ''|*[!0-9]*) pending=0 ;; esac
if [ "$pending" -gt 0 ]; then
  log "muse-relay pending $pending"
  wake "muse_relay_turn" "{\"count\":$pending}"
  exit 0
fi

result=$("$PY" "$CLI" poll --wait-ms 0 2>/dev/null) || true
status=""
count=0
notify=0
retry_ms=0
reason=""
for kv in $result; do
  case "$kv" in
    status=*) status=${kv#status=} ;;
    count=*) count=${kv#count=} ;;
    notify=*) notify=${kv#notify=} ;;
    retry_ms=*) retry_ms=${kv#retry_ms=} ;;
    reason=*) reason=${kv#reason=} ;;
  esac
done
case "$count" in ''|*[!0-9]*) count=0 ;; esac
case "$notify" in 1) notify=1 ;; *) notify=0 ;; esac
case "$retry_ms" in ''|*[!0-9]*) retry_ms=0 ;; esac
case "$reason" in ''|*[!a-z0-9_]*) reason="unknown" ;; esac
[ -z "$status" ] && notify=1

case "$status" in
  deliveries)
    if [ "$notify" -eq 1 ]; then
      log "muse-relay poll recovered"
    fi
    log "muse-relay deliveries $count"
    wake "muse_relay_turn" "{\"count\":$count}"
    ;;
  empty)
    if [ "$notify" -eq 1 ]; then
      log "muse-relay poll recovered"
    fi
    silent "no deliveries"
    ;;
  backoff)
    if [ "$notify" -eq 1 ]; then
      log "muse-relay poll backoff reason=$reason retry_ms=$retry_ms"
    fi
    silent "backoff"
    ;;
  *)
    if [ "$notify" -eq 1 ]; then
      log "muse-relay poll error reason=$reason"
    fi
    silent "poll error"
    ;;
esac
