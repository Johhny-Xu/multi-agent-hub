#!/usr/bin/env bash
# Sync multi-agent-hub to a new upstream OpenMausBot tag.
#
#   scripts/upstream-sync.sh <old-tag> <new-tag>
#
# Backs up both repositories, applies the upstream delta to the hub repo (three-way,
# file by file when the tree is dirty), creates an om worktree at <new-tag>, ports this
# project's changes into it, and runs the targeted tests.
#
# It stops at "conflicts need a person" or "ready for review": no commit, no push, no
# tag, no restart, no port is bound.
#
# Exit: 0 done, 2 conflicts, 3 tests failed, 1 precondition failed.
set -euo pipefail

OLD=${1:-}
NEW=${2:-}
if [[ -z "$OLD" || -z "$NEW" || "$OLD" == "-h" || "$OLD" == "--help" ]]; then
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

HUB_REPO=${HUB_REPO:-/home/johhny/multi-agent-hub}
OM_REPO=${OM_REPO:-/home/johhny/openmausbot}
OM_WORKTREE=${OM_WORKTREE:-$HOME/openmausbot-${NEW#v}}
WORK=$(mktemp -d "/tmp/upstream-sync-XXXXXX")
PATCH="$WORK/upstream.patch"
trap 'rm -rf "$WORK"' EXIT

say() { printf '\n== %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

for tool in git python3 tar; do command -v "$tool" >/dev/null || die "$tool is required"; done
git -C "$HUB_REPO" rev-parse --git-dir >/dev/null 2>&1 || die "not a git repo: $HUB_REPO"
git -C "$OM_REPO" rev-parse --git-dir >/dev/null 2>&1 || die "not a git repo: $OM_REPO"
git -C "$OM_REPO" rev-parse -q --verify "refs/tags/$OLD" >/dev/null || die "missing tag $OLD in $OM_REPO"
git -C "$OM_REPO" rev-parse -q --verify "refs/tags/$NEW" >/dev/null || die "missing tag $NEW in $OM_REPO"

# 1. Backups: tracked diff, status, untracked list and contents.
backup_repo() {
  local repo=$1 name=$2 dir
  dir="/tmp/$name-pre-${NEW#v}"
  rm -rf "$dir" && mkdir -p "$dir"
  ( cd "$repo"
    git diff HEAD > "$dir/tracked.patch"
    git status --porcelain > "$dir/status.txt"
    git ls-files -o --exclude-standard > "$dir/untracked-list.txt"
    tar czf "$dir/untracked.tgz" -T "$dir/untracked-list.txt" 2>/dev/null || true
    tar czf "/tmp/$name-pre-${NEW#v}.tgz" -C /tmp "$(basename "$dir")" )
  echo "  /tmp/$name-pre-${NEW#v}.tgz"
}
say "Backing up both repositories"
backup_repo "$HUB_REPO" hub
backup_repo "$OM_REPO" om

# 2. Upstream delta, filtered to paths the hub snapshot actually carries. Without these
# excludes git apply stops on docs/, .github/, deploy/, Dockerfile and the docs app. build/ is NOT excluded: the
# hub carries upstream's packaging resources since 1.3.2 (release run failed without them, E67).
say "Generating $OLD -> $NEW delta"
EXCLUDES=(
  ':(exclude)docs/**' ':(exclude).github/**' ':(exclude)deploy/**'
  ':(exclude).tmpexp/**' ':(exclude).oss-scanner/**' ':(exclude).claude/**'
  ':(exclude).well-known/**' ':(exclude)apps/**' ':(exclude)Dockerfile'
  ':(exclude).dockerignore' ':(exclude)compose.yaml'
)
git -C "$OM_REPO" diff "$OLD" "$NEW" -- . "${EXCLUDES[@]}" > "$PATCH"
git -C "$OM_REPO" diff --stat "$OLD" "$NEW" -- . "${EXCLUDES[@]}" | tail -1
echo "  patch: $PATCH"

# 3. Apply to the hub repo. A clean tree can use git apply --3way; a dirty one cannot
# (the index no longer matches the worktree), so each file is merged with git merge-file
# against the pre-apply tree.
say "Applying to $HUB_REPO"
conflicts=0
if [[ -z "$(git -C "$HUB_REPO" status --porcelain)" ]]; then
  GIT_ALTERNATE_OBJECT_DIRECTORIES="$OM_REPO/.git/objects" \
    git -C "$HUB_REPO" apply --3way --whitespace=nowarn "$PATCH" || die "git apply --3way failed on a clean tree; see its output"
else
  echo "  worktree has uncommitted changes; merging file by file"
  HUB="$HUB_REPO" OM="$OM_REPO" PATCH="$PATCH" WORK="$WORK" python3 - "$OLD" "$NEW" <<'PY'
import os, re, subprocess, sys
old, new = sys.argv[1], sys.argv[2]
HUB, OM, PATCH, WORK = os.environ["HUB"], os.environ["OM"], os.environ["PATCH"], os.environ["WORK"]
pre, out = os.path.join(WORK, "pre"), os.path.join(WORK, "merged")
os.makedirs(pre); os.makedirs(out)

def run(args, **kw):
    return subprocess.run(args, capture_output=True, **kw)

def show(tree, path):
    r = run(["git", "-C", OM, "show", f"{tree}:{path}"])
    return r.stdout if r.returncode == 0 else None

# Pre-apply tree: HEAD plus this repo's uncommitted tracked changes. src/state is
# ignored by .gitignore, so it is copied from the worktree instead of from HEAD.
subprocess.run(f"git -C {HUB!r} archive HEAD | tar -x -C {pre!r}", shell=True, check=True)
diff = run(["git", "-C", HUB, "diff", "HEAD"]).stdout
if diff:
    subprocess.run(["git", "-C", pre, "apply", "-"], input=diff, check=True)
state = os.path.join(HUB, "src", "state")
if os.path.isdir(state):
    subprocess.run(["cp", "-a", state + "/.", os.path.join(pre, "src", "state")], check=True)

files = re.findall(r"^diff --git a/(.*?) b/", open(PATCH, encoding="utf-8", errors="replace").read(), re.M)
results = []
for f in files:
    base, theirs = show(old, f), show(new, f)
    ours = None
    for root in (pre, HUB):
        p = os.path.join(root, f)
        if os.path.lexists(p):
            ours = open(p, "rb").read(); break
    rec = {"file": f}
    if ours is None and theirs is None:
        rec["action"] = "none"
    elif ours is None:
        rec["action"] = "add"
    elif theirs is None:
        rec["action"] = "delete" if (base is not None and ours == base) else "keep-modified-deleted-upstream"
    elif base is None and ours == theirs:
        rec["action"] = "already"
    elif base is not None and ours == base:
        rec["action"] = "take-upstream"
    else:
        d = os.path.join(WORK, "one"); os.makedirs(d, exist_ok=True)
        po, pb, pn = (os.path.join(d, n) for n in ("ours", "base", "theirs"))
        open(po, "wb").write(ours); open(pb, "wb").write(base or b""); open(pn, "wb").write(theirs)
        r = subprocess.run(["git", "merge-file", "-p", "-L", "hub", "-L", old, "-L", new, po, pb, pn], capture_output=True)
        rec["action"] = "merged" if r.returncode == 0 else "conflict"
        rec["data"] = r.stdout
    if rec["action"] in ("add", "take-upstream"):
        rec["data"] = theirs
    results.append(rec)

for rec in results:
    f, dest = rec["file"], os.path.join(HUB, rec["file"])
    if "data" in rec:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        open(dest, "wb").write(rec["data"])
    elif rec["action"] == "delete" and os.path.lexists(dest):
        os.remove(dest)

bad = [r["file"] for r in results if r["action"] == "conflict"]
kept = [r["file"] for r in results if r["action"] == "keep-modified-deleted-upstream"]
counts = {k: sum(1 for r in results if r["action"] == k) for k in
          ("merged", "add", "take-upstream", "delete", "already", "conflict")}
print("  " + ", ".join(f"{k} {v}" for k, v in counts.items()))
for f in kept: print(f"  kept (changed here, deleted upstream): {f}")
open(os.path.join(WORK, "conflicts.txt"), "w").write("\n".join(bad) + ("\n" if bad else ""))
PY
  [[ -s "$WORK/conflicts.txt" ]] && conflicts=1
fi

if [[ "$conflicts" != 0 ]]; then
  say "Conflicts need a person"
  sed 's/^/  /' "$WORK/conflicts.txt"
  echo "  Resolve them in $HUB_REPO, then run the om port step again (or rerun after committing)."
  exit 2
fi

# 4. om worktree at the new tag, with this project's delta copied in.
say "Preparing worktree $OM_WORKTREE"
if git -C "$OM_REPO" worktree list --porcelain | grep -qx "worktree $OM_WORKTREE"; then
  echo "  reusing existing worktree"
else
  git -C "$OM_REPO" worktree add -b "port/${NEW#v}" "$OM_WORKTREE" "$NEW"
fi
if [[ ! -e "$OM_WORKTREE/node_modules" && -d "$OM_REPO/node_modules" ]]; then
  ln -s "$OM_REPO/node_modules" "$OM_WORKTREE/node_modules"
fi

HUB="$HUB_REPO" OM_WT="$OM_WORKTREE" python3 - <<'PY'
import fnmatch, hashlib, os, shutil
HUB, OM = os.environ["HUB"], os.environ["OM_WT"]
skip_dirs = {".git", "node_modules", "dist", "dist-companion", "dist-server", ".run", "logs",
             "__pycache__", ".codeartsdoer", ".vite", "results", ".openmausbot"}
# E97: server/hub-compat/ is NOT skipped: server/hub-bridge.ts imports it, so the om tree must carry it verbatim.
skip_prefix = ("docs/", "checkin/", "apps/", "state/", "hub/state/")
skip_globs = ("tests/console_*", "*.log", "*.pyc", ".env", "hub/agents.json")
skip_files = {"README.md", "README.en.md", "LICENSE", "CODE_OF_CONDUCT.md", "CONTRIBUTING.md",
              "SECURITY.md", "CHANGELOG.md", "RUN_ON_LINUX.md", "package.json", ".gitignore"}

def skipped(rel):
    return (rel in skip_files or rel.startswith(skip_prefix)
            or any(p in skip_dirs for p in rel.split("/"))
            or any(fnmatch.fnmatch(rel, g) for g in skip_globs))

def digest(path):
    try: return hashlib.sha256(open(path, "rb").read()).hexdigest()
    except OSError: return None

copied = 0
for root, dirs, names in os.walk(HUB):
    dirs[:] = [d for d in dirs if d not in skip_dirs]
    for name in names:
        src = os.path.join(root, name)
        rel = os.path.relpath(src, HUB)
        if rel.startswith(".git/") or skipped(rel): continue
        dst = os.path.join(OM, rel)
        if digest(src) == digest(dst): continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        copied += 1
print(f"  copied {copied} project files into the worktree")
PY

# 5. Targeted tests (paths shared by both repos; each side runs the ones it has).
if [[ "${SKIP_TESTS:-}" == "1" ]]; then
  say "Skipping tests (SKIP_TESTS=1)"
  exit 0
fi

say "Running targeted tests"
TESTS=(
  server/drivers/acp/acp.test.ts server/drivers/acp/deepseek.test.ts
  server/drivers/acp/central-keys.test.ts server/drivers/zcode-acp.test.ts
  server/drivers/zcode-acp-bridge.test.ts server/drivers/antigravity-runtime.test.ts
  server/drivers/antigravity-lifecycle.test.ts server/drivers/antigravity.test.ts
  server/startup-model-catalog.test.ts server/config.test.ts
  server/default-model-selection.test.ts server/engine-updates.test.ts
  server/service-accounts.test.ts server/routes/service-accounts.test.ts
  src/lib/debug-zone.test.ts src/components/inbox/inbox-view.test.ts
  src/components/PhoneDevicesSection.reveal.test.ts src/components/ServiceAccounts.test.ts
  src/components/ProviderIcons.engines.test.ts src/components/EnginesSettings.models.test.ts
  server/bot-box/relay.test.ts server/email/sending.test.ts server/lent-mcp.test.ts
  server/retired-apps.test.ts server/sign-in-mail.test.ts server/headless/token.test.ts
  server/headless/host-doctor.test.ts server/voice-notes-chat.e2e.test.ts
)
failed=0
for repo in "$HUB_REPO" "$OM_WORKTREE"; do
  if [[ ! -x "$repo/node_modules/.bin/vitest" ]]; then
    echo "  $repo: node_modules missing, skipped"
    continue
  fi
  present=()
  for t in "${TESTS[@]}"; do [[ -f "$repo/$t" ]] && present+=("$t"); done
  echo "  $repo: ${#present[@]} files"
  ( cd "$repo" && nice node_modules/.bin/vitest run "${present[@]}" ) || failed=1
done

say "Done"
echo "  hub:       $HUB_REPO (working tree contains the merge; nothing committed)"
echo "  om:        $OM_WORKTREE (branch port/${NEW#v})"
echo "  backups:   /tmp/hub-pre-${NEW#v}.tgz, /tmp/om-pre-${NEW#v}.tgz"
echo "  next:      review the diff, fix failures, then build and switch 8801 by hand"
echo "             (docs/porting/upstream-sync.md §8)"
[[ "$failed" == 0 ]] || exit 3
