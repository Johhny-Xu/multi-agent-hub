#!/usr/bin/env bash
# OpenMausBot Muse Relay hook: one poll round per run, or a short polling loop (OMB_RELAY_LOOP_SECONDS).
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
  # Drop pending copies no worker claimed within OMB's pickup window: OMB has redelivered those turns by now, and a
  # stale copy here would stop this hook from ever polling for the fresh attempt. Sends nothing to OMB.
  "$PY" "$CLI" keepalive >/dev/null 2>&1 || true
  pending=$("$PY" "$CLI" pending-count 2>/dev/null) || pending=""
  case "$pending" in ''|*[!0-9]*) pending=0 ;; esac
fi
if [ "$pending" -gt 0 ]; then
  log "muse-relay pending $pending"
  wake "muse_relay_turn" "{\"count\":$pending}"
  exit 0
fi

# One run may poll several times: OMB_RELAY_LOOP_SECONDS (default 0 = one poll, as before; at most 45 so a run fits
# Muse's 60 s hook timeout) keeps a poll starting every OMB_RELAY_POLL_INTERVAL_MS (default 2500, min 1000) until a
# delivery arrives or the budget ends. An error or backoff answer inside the budget only pauses the loop (the client
# already retried transient errors at once). OMB_RELAY_WAIT_MS is the server-side wait per poll (0 = return at once;
# Muse's egress proxy kills long polls). Overlapping runs are dropped by the flock above, so a long loop costs nothing.
loop_s=${OMB_RELAY_LOOP_SECONDS:-0}
interval_ms=${OMB_RELAY_POLL_INTERVAL_MS:-2500}
wait_ms=${OMB_RELAY_WAIT_MS:-0}
case "$loop_s" in ''|*[!0-9]*) loop_s=0 ;; esac
case "$interval_ms" in ''|*[!0-9]*) interval_ms=2500 ;; esac
case "$wait_ms" in ''|*[!0-9]*) wait_ms=0 ;; esac
[ "$interval_ms" -lt 1000 ] && interval_ms=1000
[ "$loop_s" -gt 45 ] && loop_s=45

now_ms() {
  local t
  t=$(date +%s%3N 2>/dev/null)
  case "$t" in
    ''|*[!0-9]*) echo $(( $(date +%s) * 1000 )) ;;
    *) echo "$t" ;;
  esac
}

parse_result() {
  status=""
  count=0
  notify=0
  retry_ms=0
  reason=""
  for kv in $1; do
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
  return 0
}

loop_end_ms=$(( $(now_ms) + loop_s * 1000 ))
if [ "$loop_s" -gt 0 ]; then
  # The client caps its request timeout and quick retries so the last poll still ends inside the run.
  export OMB_RELAY_RUN_DEADLINE=$(( loop_end_ms / 1000 + 8 ))
fi
while :; do
  started_ms=$(now_ms)
  result=$("$PY" "$CLI" poll --wait-ms "$wait_ms" 2>/dev/null) || true
  parse_result "$result"
  case "$status" in
    empty|error|backoff)
      pause_ms=$(( interval_ms - ( $(now_ms) - started_ms ) ))
      if [ "$status" != "empty" ] && [ "$retry_ms" -gt "$pause_ms" ]; then
        pause_ms=$retry_ms
      fi
      [ "$pause_ms" -lt 200 ] && pause_ms=200
      if [ $(( $(now_ms) + pause_ms )) -lt "$loop_end_ms" ]; then
        # A notice from a poll inside the loop still reaches the log; the single silent/wake comes at the end.
        if [ "$notify" -eq 1 ]; then
          case "$status" in
            empty) log "muse-relay poll recovered" ;;
            error) log "muse-relay poll error reason=$reason" ;;
            backoff) log "muse-relay poll backoff reason=$reason retry_ms=$retry_ms" ;;
          esac
        fi
        sleep "$(awk -v ms="$pause_ms" 'BEGIN{printf "%.3f", ms/1000}')"
        continue
      fi
      ;;
  esac
  break
done

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
