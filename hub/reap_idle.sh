#!/usr/bin/env bash
# reap_idle.sh — 空闲进程安全回收 (精确白名单 + 多层自我保护)
# 用法:
#   reap_idle.sh            # 默认 --dry-run, 只打印不杀
#   reap_idle.sh --kill     # 正式回收: TERM -> 3s -> KILL 幸存者
#
# 白名单 (只匹配 cmdline 里的精确脚本/命令路径):
#   http8899        '-m http.server 8899'                     # ZCode 瞬态 scope 拉起的静态服务
#   captcha_worker  'server_captcha_worker.js'                # flow-captcha-worker 任务
#   grab_full_token 'grab_full_token.js'                      # cron 取 token 任务
#   ↑ 三类的全部【后代进程】(chrome-headless-shell 子树) 一并纳入, 不按宽泛进程名收
#
# 自我保护 (一票否决, 即使命中白名单):
#   - 自身 PID / PPID / 全部祖先
#   - cmdline 含 reap_idle.sh
#   - zcode_dom.js / zcode_read.js / dom_read.js / agent_hub.py / async_worker.py
#   - systemd 用户服务 (agent-hub/traeclaw-gateway/traecode-desktop/zcode-desktop/
#     xvfb/openbox/mihomo/x11vnc/codebuddy-serve/clipboard-bridge/fcitx5 等) 的
#     cgroup 内全部进程
set -uo pipefail

MODE="${1:---dry-run}"
DRY=1
[ "$MODE" = "--kill" ] && DRY=0

declare -A RULES=(
  ["http8899"]='\-m http\.server 8899'
  ["captcha_worker"]='server_captcha_worker\.js'
  ["grab_full_token"]='grab_full_token\.js'
)

# cmdline 一票否决正则 (会话执行器/枢纽/基础设施/脚本自身)
PROTECT='reap_idle\.sh|zcode_dom\.js|zcode_read\.js|dom_read\.js|agent_hub\.py|async_worker\.py|TraeClaw/|src/server\.js|trae-cn|zcode-app|ZCode|codebuddy|x11vnc|mihomo|openbox|Xvfb|clipboard-bridge|fcitx|crashpad|/app/|systemd|sshd|ensure-|/QQ'

# ---- 保护集 1: 所有运行中的 systemd 用户服务 cgroup 全量进程 ----
declare -A PROTECT_PID
UID_N=$(id -u)
CG_BASE="/sys/fs/cgroup/user.slice/user-${UID_N}.slice/user@${UID_N}.service/app.slice"
for u in $(systemctl --user list-units --type=service --state=running --no-legend 2>/dev/null | awk '{print $1}'); do
  if [ -r "$CG_BASE/$u/cgroup.procs" ]; then
    while read -r p; do [ -n "$p" ] && PROTECT_PID[$p]=1; done < "$CG_BASE/$u/cgroup.procs"
  fi
  mp=$(systemctl --user show -p MainPID --value "$u" 2>/dev/null)
  [ -n "$mp" ] && [ "$mp" != "0" ] && PROTECT_PID[$mp]=1
done

# ---- 保护集 2: 自身与全部祖先 ----
SELF=$$
declare -A ANC
p=$SELF
while [ -n "$p" ] && [ "$p" != "1" ] && [ "$p" != "0" ]; do
  ANC[$p]=1
  p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
done

# ---- 全系统 PPID 映射 (用于后代扩展) ----
declare -A PPID_OF
for d in /proc/[0-9]*; do
  pid=${d#/proc/}
  pp=$(awk '/^PPid:/{print $2}' "$d/status" 2>/dev/null)
  [ -n "$pp" ] && PPID_OF[$pid]=$pp
done

is_protected() {  # $1=pid  返回 0=保护
  [ -n "${PROTECT_PID[$1]:-}" ] && return 0
  [ -n "${ANC[$1]:-}" ] && return 0
  [ "$1" = "$SELF" ] && return 0
  local a
  a=$(ps -o args= -p "$1" 2>/dev/null)
  [ -z "$a" ] && return 0          # 进程已消失
  echo "$a" | grep -qE "$PROTECT" && return 0
  return 1
}

# ---- 收集白名单命中 ----
declare -A HIT ROOTS
for name in "${!RULES[@]}"; do
  while read -r pid; do
    [ -z "$pid" ] && continue
    is_protected "$pid" && continue
    HIT[$pid]="$name"
    ROOTS[$pid]=1
  done < <(pgrep -f "${RULES[$name]}" 2>/dev/null)
done

# ---- 后代树扩展 (chrome 子进程等) ----
if [ ${#ROOTS[@]} -gt 0 ]; then
  changed=1
  while [ "$changed" = "1" ]; do
    changed=0
    for pid in "${!PPID_OF[@]}"; do
      [ -n "${HIT[$pid]:-}" ] && continue
      pp=${PPID_OF[$pid]:-}
      [ -z "$pp" ] && continue
      if [ -n "${HIT[$pp]:-}" ]; then
        is_protected "$pid" && continue
        HIT[$pid]="${HIT[$pp]}/child"
        changed=1
      fi
    done
  done
fi

if [ ${#HIT[@]} -eq 0 ]; then
  echo "没有命中白名单的可回收进程, 无事可做。"
  exit 0
fi

echo "命中白名单 (含后代扩展, 按 %CPU 降序):"
rows=""
for pid in "${!HIT[@]}"; do
  info=$(ps -o pcpu=,etime=,rss= -p "$pid" 2>/dev/null)
  [ -z "$info" ] && continue
  pc=$(echo "$info" | awk '{print $1}')
  et=$(echo "$info" | awk '{print $2}')
  rss=$(echo "$info" | awk '{print $3}')
  rows="$rows$(printf '%s\t%s\t%s\t%s\t%s\n' "$pc" "$pid" "$et" "$rss" "${HIT[$pid]}")"$'\n'
done
printf '%s' "$rows" | sort -t$'\t' -k1,1 -rn | while IFS=$'\t' read -r pc pid et rss rule; do
  [ -z "${pid:-}" ] && continue
  printf '  PID %-8s cpu=%-7s up=%-12s rss=%-8s [rule:%s]\n' \
    "$pid" "$pc" "$et" "$((rss / 1024))MB" "$rule"
  printf '      %s\n' "$(ps -o args= -p "$pid" 2>/dev/null | cut -c1-100)"
done
echo "共 ${#HIT[@]} 个进程。"

if [ "$DRY" = "1" ]; then
  echo "[DRY-RUN] 未执行任何 kill。正式回收: $0 --kill"
  exit 0
fi

# ---- 正式回收: TERM -> 3s -> KILL ----
allpids=$(printf '%s\n' "${!HIT[@]}" | sort -n)
echo "== TERM 阶段 =="
kill $allpids 2>/dev/null && echo "TERM 已发送至全部 ${#HIT[@]} 个 PID" || echo "TERM 发送部分失败(进程可能已自行退出)"
sleep 3
survivors=""
for pid in $allpids; do
  if kill -0 "$pid" 2>/dev/null; then survivors="$survivors $pid"; fi
done
if [ -n "$survivors" ]; then
  echo "== KILL 阶段 (TERM 3 秒后仍存活) =="
  echo " 幸存者:$survivors"
  kill -9 $survivors 2>/dev/null && echo "KILL -9 已发送"
  sleep 1
  still=""
  for pid in $survivors; do kill -0 "$pid" 2>/dev/null && still="$still $pid"; done
  [ -n "$still" ] && echo "警告: 仍未退出:$still (可能处于不可中断态)" || echo "KILL 后全部退出。"
else
  echo "== 3 秒后检查: 全部已退出, 无需 KILL =="
fi
echo "回收完成。注: captcha_worker / grab_full_token 由 crontab ensure 脚本托管, 可能按计划重生; 若反复僵挂请给 ensure-flow-token.sh 加 timeout 兜底。"
