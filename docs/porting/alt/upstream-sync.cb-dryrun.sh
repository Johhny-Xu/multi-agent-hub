#!/usr/bin/env bash
# upstream-sync.sh — 把上游 OpenMausBot 的一个增量版本移植进本项目。
#
# 用法:
#   scripts/upstream-sync.sh <old-tag> <new-tag> [--continue] [--dry-run]
#
#   --continue   冲突已人工解决，跳过“应用增量/移植改动”两步，直接跑定向测试
#   --dry-run    只打印将要执行的命令（只做只读查询，不写任何文件）
#
# 环境变量:
#   HUB_DIR        本项目仓目录（默认：本脚本所在仓库根）
#   OM_DIR         上游仓目录（默认：$HOME/openmausbot）
#   HUB_BASE       本项目基线（默认：v1.3.0；无此 ref 时回退到标题以 “v1.3.0:” 开头的提交）
#   OM_WORKTREE    新版本工作树目录（默认：OM_DIR 同级的 openmausbot-<new-tag>，通常即 ~/openmausbot-<new-tag>）
#   SKIP_TESTS=1   跳过第 6 步定向测试
#
# 产物（/tmp）:
#   hub-pre-<new>.tgz                本项目未提交改动备份（patch + 未跟踪文件）
#   om-pre-<new>.tgz                 上游仓未提交改动备份
#   upstream-<old>-<new>.patch       上游增量补丁
#   upstream-<old>-<new>.stat        上游增量 --stat
#   upstream-<new>-files.txt         补丁涉及的文件
#   upstream-<new>-overlap.txt       与本项目改动重叠的文件
#   upstream-<new>-worktree-conflicts.txt  第 5 步移植时的冲突文件
#   upstream-<new>-tests/            第 6 步每个测试的完整日志
#
# 退出码: 0 成功；2 有冲突待人工处理；1 用法/环境错误。
#
# 纪律: 本脚本绝不 commit / push / tag / stash / reset / checkout / 重启服务。
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HUB_DIR="${HUB_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
OM_DIR="${OM_DIR:-$HOME/openmausbot}"
HUB_BASE="${HUB_BASE:-v1.3.0}"

DRY_RUN=0
CONTINUE=0
SKIP_TESTS="${SKIP_TESTS:-0}"

# 第 6 步定向测试清单（相对仓库根）。缺失的文件会跳过并告警。
TESTS=(
  server/service-accounts.test.ts
  server/checkin.test.ts
  server/account-signin.test.ts
  server/default-model-selection.test.ts
  server/engine-memory.test.ts
  server/drivers/acp/acp.test.ts
  server/drivers/antigravity.test.ts
  server/harness/registry.test.ts
  server/hub-compat/dispatch.test.ts
  server/hub-compat/main.test.ts
  server/hub-compat/store.test.ts
)

# 已知既有失败，汇总时单独标注，不算本次回归。
KNOWN_FAILING_HINT="已知既有失败: happy-dom 前端测试、registry.test.ts 的 npm PATH"

note()  { printf '%s\n' "$*"; }
warn()  { printf '警告: %s\n' "$*" >&2; }
die()   { printf '错误: %s\n' "$*" >&2; exit 1; }
section() { printf '\n== %s ==\n' "$*"; }

usage() {
  sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)  DRY_RUN=1; shift ;;
    --continue) CONTINUE=1; shift ;;
    -h|--help)  usage ;;
    --*)        die "未知参数: $1" ;;
    *)
      if [ -z "${OLD_TAG:-}" ]; then OLD_TAG="$1"
      elif [ -z "${NEW_TAG:-}" ]; then NEW_TAG="$1"
      else die "多余参数: $1"
      fi
      shift ;;
  esac
done

[ -n "${OLD_TAG:-}" ] && [ -n "${NEW_TAG:-}" ] || usage

PATCH="/tmp/upstream-${OLD_TAG}-${NEW_TAG}.patch"
STAT="/tmp/upstream-${OLD_TAG}-${NEW_TAG}.stat"
PATCH_FILES="/tmp/upstream-${NEW_TAG}-files.txt"
OVERLAP="/tmp/upstream-${NEW_TAG}-overlap.txt"
WT_CONFLICTS="/tmp/upstream-${NEW_TAG}-worktree-conflicts.txt"
STEP4_CONFLICTS="/tmp/upstream-${NEW_TAG}-hub-conflicts.txt"
HUB_BACKUP="/tmp/hub-pre-${NEW_TAG}.tgz"
OM_BACKUP="/tmp/om-pre-${NEW_TAG}.tgz"
WORK_DIR="${OM_WORKTREE:-$(dirname -- "$OM_DIR")/openmausbot-${NEW_TAG}}"
TEST_LOG_DIR="/tmp/upstream-${NEW_TAG}-tests"
PORT_BRANCH="port/${NEW_TAG}"

# ---------------------------------------------------------------- 前置检查

section "前置检查"
[ -d "$HUB_DIR/.git" ] || die "HUB_DIR 不是 git 仓库: $HUB_DIR"
[ -d "$OM_DIR/.git" ]  || die "OM_DIR 不是 git 仓库: $OM_DIR"
note "HUB_DIR = $HUB_DIR"
note "OM_DIR  = $OM_DIR"
note "WORK_DIR= $WORK_DIR"

resolve_hub_base() {
  if git -C "$HUB_DIR" rev-parse --verify --quiet "${HUB_BASE}^{commit}" >/dev/null; then
    printf '%s' "$HUB_BASE"
    return 0
  fi
  local found
  found="$(git -C "$HUB_DIR" log --format='%H %s' -n 200 \
    | awk '/^[0-9a-f]+ v1\.3\.0:/{print $1; exit}')"
  [ -n "$found" ] || return 1
  printf '%s' "$found"
}

HUB_BASE_REF="$(resolve_hub_base)" || die "找不到基线 $HUB_BASE（也没有标题以 'v1.3.0:' 开头的提交）"
note "基线    = $HUB_BASE_REF ($(git -C "$HUB_DIR" log -1 --format='%h %s' "$HUB_BASE_REF"))"

if [ "$DRY_RUN" = "1" ]; then
  note "模式    = dry-run（只打印命令）"
fi

# ---------------------------------------------------------------- 1. 备份

backup_repo() {
  local repo="$1" out="$2" label="$3"
  if [ "$DRY_RUN" = "1" ]; then
    note "  + git -C $repo diff HEAD > ... ; 未跟踪文件打包"
    note "  + tar -czf $out ..."
    return 0
  fi
  local tmp
  tmp="$(mktemp -d)"
  git -C "$repo" rev-parse HEAD > "$tmp/HEAD.txt"
  git -C "$repo" status --porcelain > "$tmp/status.txt"
  git -C "$repo" diff HEAD > "$tmp/worktree.patch"
  git -C "$repo" diff HEAD --stat > "$tmp/worktree.stat"
  git -C "$repo" ls-files --others --exclude-standard -z > "$tmp/untracked.z"
  git -C "$repo" ls-files --others --exclude-standard > "$tmp/untracked-files.txt"
  if [ -s "$tmp/untracked.z" ]; then
    tar -C "$repo" --null -T "$tmp/untracked.z" -czf "$tmp/untracked.tgz"
  else
    tar -czf "$tmp/untracked.tgz" -T /dev/null
  fi
  tar -C "$tmp" -czf "$out" .
  rm -rf "$tmp"
  note "  备份 $label -> $out ($(du -h "$out" | cut -f1))"
}

section "1. 备份未提交改动"
backup_repo "$HUB_DIR" "$HUB_BACKUP" "本项目"
backup_repo "$OM_DIR"  "$OM_BACKUP"  "上游仓"

# ---------------------------------------------------------------- 2. 取增量

section "2. 上游 $OLD_TAG -> $NEW_TAG 增量"
if [ "$DRY_RUN" = "1" ]; then
  note "  + git -C $OM_DIR fetch origin --tags"
  note "  + git -C $OM_DIR diff --binary $OLD_TAG $NEW_TAG > $PATCH"
  note "  + git -C $OM_DIR diff --stat $OLD_TAG $NEW_TAG > $STAT"
else
  git -C "$OM_DIR" fetch origin --tags
  git -C "$OM_DIR" rev-parse --verify --quiet "refs/tags/${OLD_TAG}^{commit}" >/dev/null \
    || die "上游仓没有 tag $OLD_TAG"
  git -C "$OM_DIR" rev-parse --verify --quiet "refs/tags/${NEW_TAG}^{commit}" >/dev/null \
    || die "上游仓没有 tag $NEW_TAG"
  git -C "$OM_DIR" diff --binary "$OLD_TAG" "$NEW_TAG" > "$PATCH"
  git -C "$OM_DIR" diff --stat "$OLD_TAG" "$NEW_TAG" > "$STAT"
  note "  补丁 -> $PATCH ($(du -h "$PATCH" | cut -f1))"
  note "  统计 -> $STAT"
fi

if [ "$DRY_RUN" = "1" ]; then
  if [ -f "$PATCH" ]; then
    note "  复用已有补丁计算文件清单"
  else
    note "  + git -C $OM_DIR apply --numstat <生成后的补丁>"
  fi
fi

# 补丁涉及的文件（只读查询；dry-run 下不落盘，全部写临时文件）
if [ "$DRY_RUN" = "1" ]; then
  PATCH_FILES="$(mktemp)"
else
  : > "$PATCH_FILES"
fi
if [ -f "$PATCH" ]; then
  git -C "$OM_DIR" apply --numstat "$PATCH" \
    | sed -E 's/^[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+//' \
    | sed -E 's/^"//; s/"$//' \
    | sort -u > "$PATCH_FILES"
  note "  补丁涉及 $(wc -l < "$PATCH_FILES") 个文件"
elif [ "$DRY_RUN" = "1" ] \
  && git -C "$OM_DIR" rev-parse --verify --quiet "refs/tags/${OLD_TAG}^{commit}" >/dev/null \
  && git -C "$OM_DIR" rev-parse --verify --quiet "refs/tags/${NEW_TAG}^{commit}" >/dev/null; then
  git -C "$OM_DIR" diff --name-only "$OLD_TAG" "$NEW_TAG" | sort -u > "$PATCH_FILES"
  note "  dry-run: 用 git diff --name-only 取清单（不落盘补丁）"
  note "  补丁涉及 $(wc -l < "$PATCH_FILES") 个文件"
else
  warn "补丁尚未生成，跳过重叠分析的文件交集（首次 dry-run 属正常）"
fi

# ---------------------------------------------------------------- 3. 重叠文件

section "3. 与本项目改动重叠的文件"
hub_changed="$(mktemp)"
{
  git -C "$HUB_DIR" diff HEAD --name-only
  git -C "$HUB_DIR" ls-files --others --exclude-standard
} | sort -u > "$hub_changed"

overlap_tmp="$(mktemp)"
if [ -s "$PATCH_FILES" ]; then
  comm -12 "$hub_changed" <(sort -u "$PATCH_FILES") > "$overlap_tmp"
fi

if [ "$DRY_RUN" = "1" ]; then
  note "  + 写入 $OVERLAP"
else
  {
    printf '# 本项目改动 ∩ 上游 %s->%s 增量\n' "$OLD_TAG" "$NEW_TAG"
    printf '# 生成时间: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
    if [ -s "$overlap_tmp" ]; then cat "$overlap_tmp"; fi
    printf '\n# 共 %s 个重叠文件\n' "$(wc -l < "$overlap_tmp")"
  } > "$OVERLAP"
  note "  重叠清单 -> $OVERLAP"
fi
note "  重叠 $(wc -l < "$overlap_tmp") 个文件:"
head -n 40 "$overlap_tmp" | sed 's/^/    /'
if [ "$(wc -l < "$overlap_tmp")" -gt 40 ]; then
  note "    ... 其余 $(( $(wc -l < "$overlap_tmp") - 40 )) 个见清单文件"
fi
if [ -s "$overlap_tmp" ]; then
  note "  提示: 其中未提交的改动会让第 4 步 --3way 停下（要求工作区与暂存区一致）。"
fi
rm -f "$overlap_tmp" "$hub_changed"

# ---------------------------------------------------------------- 4. 应用增量

section "4. 在本项目仓应用增量（git apply --3way）"
if [ "$CONTINUE" = "1" ]; then
  if [ "$DRY_RUN" = "0" ]; then
    mapfile -t still_unmerged < <(git -C "$HUB_DIR" diff --name-only --diff-filter=U)
    if [ "${#still_unmerged[@]}" -gt 0 ]; then
      printf '仍有未解决冲突（%s 个）:\n' "${#still_unmerged[@]}" >&2
      printf '  %s\n' "${still_unmerged[@]}" >&2
      die "先解完再 --continue"
    fi
  fi
  note "  --continue: 跳过应用，视为冲突已解"
elif [ "$DRY_RUN" = "1" ]; then
  note "  + git -C $HUB_DIR apply --3way $PATCH"
  note "  + git -C $HUB_DIR diff --name-only --diff-filter=U   # 有冲突则退出码 2"
else
  [ -f "$PATCH" ] || die "补丁不存在: $PATCH"
  if git -C "$HUB_DIR" apply --reverse --check "$PATCH" >/dev/null 2>&1; then
    note "  增量已应用过，跳过（可重复跑）"
  elif apply_out="$(git -C "$HUB_DIR" apply --3way "$PATCH" 2>&1)"; then
    printf '%s\n' "$apply_out"
    note "  应用完成"
  else
    printf '%s\n' "$apply_out"
    mapfile -t unmerged < <(git -C "$HUB_DIR" diff --name-only --diff-filter=U)
    if [ "${#unmerged[@]}" -eq 0 ]; then
      if printf '%s' "$apply_out" | grep -q 'does not match index'; then
        die "这些文件在工作区有未提交改动，--3way 要求它们与暂存区一致：先 commit 或 git add 后重跑（脚本不动暂存区，见 $OVERLAP）"
      fi
      die "git apply 失败且没有产生冲突文件（可能是缺 blob 或补丁损坏），见上方 git 输出"
    fi
    printf '\n待人工解冲突（%s 个）:\n' "${#unmerged[@]}"
    printf '  %s\n' "${unmerged[@]}"
    printf '%s\n' "${unmerged[@]}" > "$STEP4_CONFLICTS"
    cat >&2 <<EOF

停在这里：请在本项目仓手工解决冲突（git status 查看），解决后运行
  scripts/upstream-sync.sh $OLD_TAG $NEW_TAG --continue
本脚本不会 commit，也不会自动解冲突。
EOF
    exit 2
  fi
fi

# ---------------------------------------------------------------- 5. 新版本工作树

section "5. 新版本工作树 $WORK_DIR"

# 若已有工作树就检出在目标 tag 的提交上，直接复用，避免重复 add。
# 主工作树（OM_DIR 本身）不算，避免把项目改动写进上游克隆。
existing_wt=""
new_commit="$(git -C "$OM_DIR" rev-parse --verify --quiet "${NEW_TAG}^{commit}" || true)"
primary_wt="$(git -C "$OM_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -n "$new_commit" ]; then
  existing_wt="$(git -C "$OM_DIR" worktree list --porcelain \
    | awk -v c="$new_commit" -v skip="$primary_wt" '
        /^worktree /{wt=$2}
        /^HEAD /{ if ($2==c && wt!=skip) {print wt; exit} }' || true)"
fi

if [ -n "$existing_wt" ]; then
  WORK_DIR="$existing_wt"
  note "  已存在检出 $NEW_TAG 的工作树，复用: $WORK_DIR"
elif [ -d "$WORK_DIR" ]; then
  note "  目录已存在，跳过 worktree add: $WORK_DIR"
elif [ "$DRY_RUN" = "1" ]; then
  note "  + git -C $OM_DIR worktree add $WORK_DIR $NEW_TAG -b $PORT_BRANCH"
else
  if git -C "$OM_DIR" show-ref --verify --quiet "refs/heads/${PORT_BRANCH}"; then
    git -C "$OM_DIR" worktree add "$WORK_DIR" "$PORT_BRANCH"
  else
    git -C "$OM_DIR" worktree add "$WORK_DIR" "$NEW_TAG" -b "$PORT_BRANCH"
  fi
  note "  工作树就绪: $WORK_DIR"
fi

if [ "$DRY_RUN" = "0" ]; then
  [ -e "$WORK_DIR/.git" ] || die "工作树不可用（不是 git 工作树）: $WORK_DIR"
  wt_head="$(git -C "$WORK_DIR" rev-parse HEAD)"
  [ "$wt_head" = "$new_commit" ] \
    || die "工作树 $WORK_DIR 的 HEAD ($wt_head) 不是 $NEW_TAG ($new_commit)"
fi

is_excluded() {
  case "$1" in
    docs/*|server/hub-compat/*|checkin/*|tests/console_*) return 0 ;;
  esac
  return 1
}

section "5b. 移植本项目改动（排除 docs/、server/hub-compat/、checkin/、tests/console_*）"

project_files_tmp="$(mktemp)"
{
  git -C "$HUB_DIR" diff --name-only "$HUB_BASE_REF" --
  git -C "$HUB_DIR" ls-files --others --exclude-standard
} | sort -u > "$project_files_tmp"

# 上游增量刚应用过的文件不算“本项目改动”，去掉它们。
if [ -s "$PATCH_FILES" ]; then
  grep -Fvxf "$PATCH_FILES" "$project_files_tmp" > "${project_files_tmp}.filtered" || true
  mv "${project_files_tmp}.filtered" "$project_files_tmp"
fi

# 第 4 步冲突后人工解过的文件带着项目改动，必须回到移植清单（否则项目代码会丢）。
if [ "$CONTINUE" = "1" ] && [ -s "$STEP4_CONFLICTS" ]; then
  sort -u "$project_files_tmp" "$STEP4_CONFLICTS" > "${project_files_tmp}.merged"
  mv "${project_files_tmp}.merged" "$project_files_tmp"
  note "  第 4 步解过冲突的 $(wc -l < "$STEP4_CONFLICTS") 个文件一并移植"
fi

declare -A prev_conflicts=()
if [ "$CONTINUE" = "1" ] && [ -f "$WT_CONFLICTS" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] && prev_conflicts["$f"]=1
  done < "$WT_CONFLICTS"
  if [ "${#prev_conflicts[@]}" -gt 0 ]; then
    note "  上次的 ${#prev_conflicts[@]} 个冲突文件视为已人工解决，跳过"
  fi
fi

: > "$WT_CONFLICTS"
copied_new=0; copied_plain=0; merged=0; identical=0; deleted=0; conflict=0; skipped=0

if [ "$DRY_RUN" = "1" ]; then
  plan_count=0
  while IFS= read -r f; do
    is_excluded "$f" && continue
    plan_count=$((plan_count + 1))
    if [ "$plan_count" -le 40 ]; then
      note "  + 移植 $f"
    fi
  done < "$project_files_tmp"
  note "  共 $plan_count 个文件待移植（dry-run 不实际写文件）"
else
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if is_excluded "$f"; then skipped=$((skipped + 1)); continue; fi
    if [ -n "${prev_conflicts[$f]:-}" ]; then skipped=$((skipped + 1)); continue; fi
    if [ ! -e "$HUB_DIR/$f" ] && [ ! -L "$HUB_DIR/$f" ]; then
      deleted=$((deleted + 1)); continue          # 本项目删掉的文件不往新树搬
    fi
    dest="$WORK_DIR/$f"
    if ! git -C "$HUB_DIR" cat-file -e "${HUB_BASE_REF}:${f}" 2>/dev/null; then
      mkdir -p "$(dirname -- "$dest")"
      cp -p -- "$HUB_DIR/$f" "$dest"
      copied_new=$((copied_new + 1)); continue    # 基线里没有 = 本项目新增文件
    fi
    if [ ! -e "$dest" ]; then
      mkdir -p "$(dirname -- "$dest")"
      cp -p -- "$HUB_DIR/$f" "$dest"
      copied_plain=$((copied_plain + 1)); continue
    fi
    if cmp -s -- "$HUB_DIR/$f" "$dest"; then
      identical=$((identical + 1)); continue
    fi
    if git -C "$HUB_DIR" diff --numstat "$HUB_BASE_REF" -- "$f" | awk -F'\t' '$1=="-"{found=1} END{exit !found}'; then
      cp -p -- "$HUB_DIR/$f" "$dest"              # 二进制文件整体覆盖
      copied_plain=$((copied_plain + 1)); continue
    fi
    base_tmp="$(mktemp)"; out_tmp="$(mktemp)"
    git -C "$HUB_DIR" show "${HUB_BASE_REF}:${f}" > "$base_tmp"
    set +e
    git merge-file -p \
      -L "upstream/${NEW_TAG}" \
      -L "base/${HUB_BASE_REF}" \
      -L "project/hub" \
      "$dest" "$base_tmp" "$HUB_DIR/$f" > "$out_tmp"
    rc=$?
    set -e
    cat "$out_tmp" > "$dest"                       # 保留冲突标记，交人工处理
    rm -f "$base_tmp" "$out_tmp"
    if [ "$rc" -gt 0 ]; then
      conflict=$((conflict + 1))
      printf '%s\n' "$f" >> "$WT_CONFLICTS"
      note "  冲突: $f"
    else
      merged=$((merged + 1))
    fi
  done < "$project_files_tmp"

  printf '\n  新增复制 %d / 整体复制 %d / 3way 合并 %d / 已一致 %d / 跳过(排除) %d / 本项目已删 %d / 冲突 %d\n' \
    "$copied_new" "$copied_plain" "$merged" "$identical" "$skipped" "$deleted" "$conflict"
  if [ "$conflict" -gt 0 ]; then
    note "  冲突清单 -> $WT_CONFLICTS"
    cat >&2 <<EOF

停在这里：请在工作树 $WORK_DIR 手工解决冲突（文件内已留冲突标记），解决后运行
  scripts/upstream-sync.sh $OLD_TAG $NEW_TAG --continue
EOF
    rm -f "$project_files_tmp"
    exit 2
  fi
fi
rm -f "$project_files_tmp"

# ---------------------------------------------------------------- 6. 定向测试

section "6. 定向测试"
if [ "$SKIP_TESTS" = "1" ]; then
  note "  SKIP_TESTS=1，跳过"
elif [ "$DRY_RUN" = "1" ]; then
  for t in "${TESTS[@]}"; do
    note "  + (cd $WORK_DIR && nice node_modules/.bin/vitest run $t)"
  done
else
  mkdir -p "$TEST_LOG_DIR"
  pass=0; fail=0; missing=0
  failed_list=()
  for t in "${TESTS[@]}"; do
    if [ ! -f "$WORK_DIR/$t" ]; then
      warn "测试文件不存在，跳过: $t"
      missing=$((missing + 1)); continue
    fi
    log="$TEST_LOG_DIR/$(printf '%s' "$t" | tr '/' '_').log"
    if ( cd "$WORK_DIR" && nice node_modules/.bin/vitest run "$t" ) > "$log" 2>&1; then
      pass=$((pass + 1)); printf '  通过  %s\n' "$t"
    else
      fail=$((fail + 1)); failed_list+=("$t"); printf '  失败  %s  (日志: %s)\n' "$t" "$log"
      tail -n 20 "$log" | sed 's/^/      /'
    fi
  done
  printf '\n  测试汇总: 通过 %d / 失败 %d / 缺失 %d\n' "$pass" "$fail" "$missing"
  if [ "$fail" -gt 0 ]; then
    printf '  失败清单:\n'; printf '    %s\n' "${failed_list[@]}"
  fi
  note "  $KNOWN_FAILING_HINT"
fi

# ---------------------------------------------------------------- 7. 8801 切换步骤

section "7. 8801 切换步骤（仅打印，不执行）"
cat <<EOF
  前提: 上面的测试已通过，且工作树 $WORK_DIR 里没有未解决的冲突。

  1) 构建前端（在 $WORK_DIR）:
       NODE_OPTIONS=--max-old-space-size=3072 nice node_modules/.bin/vite build
  2) 清模型缓存（旧列表会让 UI 显示过期模型）:
       rm -f ~/.openmausbot/providers/engine-models/*.json
  3) 重启 8801:
       systemctl --user restart openmausbot-lan.service
  4) 验证:
       systemctl --user status openmausbot-lan.service --no-pager
       curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8801/
  5) 回滚（任选其一）:
       a. 把 8801 指向旧工作树/旧构建，再 systemctl --user restart openmausbot-lan.service
       b. 用备份恢复未提交改动:
            tar -xzf $HUB_BACKUP -C /tmp/hub-restore && cd $HUB_DIR && git apply /tmp/hub-restore/worktree.patch
       c. 用备份里的 untracked.tgz 找回未跟踪文件。

  本脚本没有 commit / push / tag / stash / reset / checkout，也没有重启任何服务。
EOF

section "完成"
note "  补丁:   $PATCH"
note "  重叠:   $OVERLAP"
note "  备份:   $HUB_BACKUP  $OM_BACKUP"
note "  工作树: $WORK_DIR"
