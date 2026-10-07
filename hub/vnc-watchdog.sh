#!/bin/bash
# VNC 会话健康看门狗（用户日常桌面自愈）
# 职责: 1) :1 的 openbox 挂掉自动拉起  2) OPENBOX_FOCUS_CYCLE_POPUP 卡死 >120s 自动重建  3) fcitx5 挂掉自动拉起
# 注意: 只动 DISPLAY=:1 的实例, :99 自动化屏不受影响
export DISPLAY=:1
export XAUTHORITY="$HOME/.Xauthority"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
STATE="/tmp/vnc-watchdog.cycle.since"
LOG="$HOME/agent-hub/vnc-watchdog.log"

log() { echo "[$(date '+%m-%d %H:%M:%S')] $*" >> "$LOG"; }

# 找 :1 上的 openbox 进程 (按进程环境 DISPLAY 区分, 不伤 :99)
ob1_pids() {
  for p in $(pgrep -x openbox 2>/dev/null); do
    if tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -qx "DISPLAY=:1"; then
      echo "$p"
    fi
  done
}

while true; do
  # --- fcitx5 存活 ---
  if ! pgrep -x fcitx5 >/dev/null; then
    log "fcitx5 不在, 自动拉起"
    setsid fcitx5 -d --replace >/dev/null 2>&1 &
  fi

  # --- openbox 存活 ---
  PIDS=$(ob1_pids)
  if [ -z "$PIDS" ]; then
    log ":1 无 openbox, 自动拉起"
    rm -f "$STATE"
    setsid openbox >/dev/null 2>&1 &
    sleep 2
  fi

  # --- 焦点循环弹层卡死检测 (弹层名字为空, 必须查 WM_CLASS, xdotool search 会假阴性) ---
  # 忽略 1x1/2x2 的孤儿残留 (不可见无害), 只对真实可见弹层响应
  CYCLE=$(xwininfo -root -tree 2>/dev/null | grep -i "OPENBOX_FOCUS_CYCLE_POPUP" | grep -vcE " [1-2]x[1-2]\+")
  if [ "${CYCLE:-0}" -gt 0 ]; then
    NOW=$(date +%s)
    SINCE=$(cat "$STATE" 2>/dev/null)
    if [ -z "$SINCE" ]; then
      echo "$NOW" > "$STATE"
      log "检测到 FOCUS_CYCLE_POPUP, 开始计时 (120s 后重建)"
    else
      AGE=$(( NOW - SINCE ))
      if [ "$AGE" -ge 120 ]; then
        log "弹层卡死 ${AGE}s, 强制重建 openbox"
        for p in $(ob1_pids); do kill -9 "$p" 2>/dev/null; done
        rm -f "$STATE"
        sleep 1
        setsid openbox >/dev/null 2>&1 &
        sleep 2
        log "openbox 已重建"
      fi
    fi
  else
    rm -f "$STATE" 2>/dev/null
  fi

  sleep 60
done
