#!/bin/sh
# The workspace journal: git history of what happens here, pushed to the workspace's Cloudflare
# Artifacts repo. Commits are local and cheap; the Durable Object pushes them every minute.
#
#   journal.sh home              commit home state (Claude, shell state, history, dotfiles) to
#                                ~/.herdr-cloud/journal.git, branch "home"
#   journal.sh snap DIR [MSG]    snapshot the working tree of the git repo holding DIR, untracked
#                                files included and .gitignore honoured, without touching its
#                                index or branches: a commit on refs/journal/work. Untracked files
#                                over JOURNAL_MAX_FILE_MB (25) are left out.
#   journal.sh tick              save pane screens, home, then snap every repo directly under ~/work
#   journal.sh push              push what changed; needs JOURNAL_REMOTE and JOURNAL_TOKEN.
#                                Prints each pushed branch.
#   journal.sh size              estimated size of the journal history in KB (what its Artifacts
#                                repo holds; Artifacts does not report repo sizes)
#   journal.sh rollover          start every branch again from one commit of its current state,
#                                for a fresh Artifacts repo, and drop the old history locally
#   journal.sh restore           after waking from an older copy (an unannounced stop): lay the
#                                newer pushed state over the home folder and the projects; needs
#                                JOURNAL_REMOTE and JOURNAL_TOKEN.
set -u
HOME=${HOME:-/home/dev}
J=$HOME/.herdr-cloud/journal.git
REPOS=$HOME/.herdr-cloud/journal-repos
export GIT_AUTHOR_NAME=herdr-cloud GIT_AUTHOR_EMAIL=journal@herdr-cloud GIT_COMMITTER_NAME=herdr-cloud GIT_COMMITTER_EMAIL=journal@herdr-cloud
now() { date -u +%FT%TZ; }

home() {
  if [ ! -d "$J" ]; then
    GIT_DIR=$J git init -q -b home || return 1
    # Never journal credentials, caches or anything that is rebuilt anyway.
    printf '%s\n' /.claude/.credentials.json /.claude/plugins/ /.claude/local/ /.claude/debug/ /.claude/statsig/ \
      /.claude/shell-snapshots/ /.claude/ide/ /.claude/cache/ /.claude/backups/ > "$J/info/exclude"
  fi
  set --
  for p in .claude.json .claude .zsh_history .zshrc .gitconfig .config/herdr/config.toml .config/mise \
    .herdr-cloud/shells .herdr-cloud/commands.log .herdr-cloud/agent-events.log; do
    [ -e "$HOME/$p" ] && set -- "$@" "$p"
  done
  [ $# -gt 0 ] || return 0
  cd "$HOME" || return 1  # the paths above are relative to it
  g() { git --git-dir="$J" --work-tree="$HOME" "$@"; }
  g add -A -- "$@" 2>/dev/null
  g diff --cached --quiet 2>/dev/null && g rev-parse -q --verify HEAD >/dev/null && return 0
  g commit -q -m "home $(now)" --no-verify
}

snap() {
  top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || return 0
  case $top in "$HOME"|"$HOME/.herdr-cloud"*) return 0 ;; esac
  gd=$(git -C "$top" rev-parse --absolute-git-dir) || return 0
  # Untracked files too big to journal (datasets, media, build output nobody ignored).
  max=$((${JOURNAL_MAX_FILE_MB:-25} * 1024 * 1024))
  big=$(cd "$top" && git ls-files -z --others --exclude-standard | xargs -0r stat -c '%s %n' -- 2>/dev/null \
    | awk -v m="$max" '$1 > m { sub(/^[0-9]+ /, ""); print }')
  idx=$(mktemp); cp "$gd/index" "$idx" 2>/dev/null || rm -f "$idx"
  tree=$(
    cd "$top" && export GIT_INDEX_FILE="$idx" && git add -A 2>/dev/null || exit 1
    [ -n "$big" ] && printf '%s\n' "$big" | xargs -d '\n' git rm -q --cached --ignore-unmatch -- >/dev/null
    git write-tree
  )
  rm -f "$idx"
  nbig=$(printf '%s' "$big" | grep -c .)
  [ -n "$tree" ] || return 0
  grep -qxF "$top" "$REPOS" 2>/dev/null || echo "$top" >> "$REPOS"
  prev=$(git -C "$top" rev-parse -q --verify refs/journal/work)
  [ -n "$prev" ] && [ "$(git -C "$top" rev-parse "$prev^{tree}")" = "$tree" ] && return 0
  head=$(git -C "$top" rev-parse -q --verify HEAD | cut -c1-12)
  branch=$(git -C "$top" symbolic-ref -q --short HEAD)
  note=""; [ "$nbig" -gt 0 ] && note="
left out $nbig untracked file(s) over ${JOURNAL_MAX_FILE_MB:-25} MB"
  c=$(printf '%s\n\nrepo HEAD %s on %s%s\n' "${2:-edits $(now)}" "${head:-none}" "${branch:-detached}" "$note" \
    | git -C "$top" commit-tree "$tree" ${prev:+-p "$prev"}) || return 0
  # Agent turns and shell commands can snapshot at once: only move the ref from what we read.
  git -C "$top" update-ref refs/journal/work "$c" "${prev:-0000000000000000000000000000000000000000}" 2>/dev/null
}

# Branch in the Artifacts repo for a project: its path under ~/work, as a valid ref name.
branch_for() { echo "work/$(echo "${1#"$HOME"/work/}" | tr -c 'A-Za-z0-9._/\n-' '-' | sed 's|^/||; s|\.\.|-|g')"; }

pushref() { # pushref GIT_DIR_ARGS... -- LOCAL_REF BRANCH
  local_ref=$1; branch=$2; shift 2
  cur=$("$@" rev-parse -q --verify "$local_ref") || return 0
  [ "$("$@" rev-parse -q --verify refs/journal/pushed)" = "$cur" ] && return 0
  if out=$("$@" -c http.extraHeader="Authorization: Bearer $JOURNAL_TOKEN" push -q "$JOURNAL_REMOTE" "+$local_ref:refs/heads/$branch" 2>&1); then
    "$@" update-ref refs/journal/pushed "$cur" && echo "$branch"
  else
    echo "push $branch: $out" >&2; failed=1
  fi
}

# KB on disk of everything reachable from a journal ref: kb REF GIT...
kb() {
  ref=$1; shift
  "$@" rev-parse -q --verify "$ref" >/dev/null || { echo 0; return; }
  "$@" rev-list --objects "$ref" | cut -d' ' -f1 | "$@" cat-file --batch-check='%(objectsize:disk)' \
    | awk '{ s += $1 } END { print int(s / 1024) }'
}

size() {
  total=0
  [ -d "$J" ] && total=$(kb refs/heads/home git --git-dir="$J")
  [ -s "$REPOS" ] && while read -r top; do
    [ -d "$top" ] && total=$((total + $(kb refs/journal/work git -C "$top")))
  done < "$REPOS"
  echo "size $total"
}

# Rebase each journal branch onto a single commit of its current tree.
restart() { # restart REF GIT...
  ref=$1; shift
  prev=$("$@" rev-parse -q --verify "$ref") || return 0
  c=$(echo "baseline $(now)" | "$@" commit-tree "$prev^{tree}") || return 1
  "$@" update-ref "$ref" "$c" "$prev" && "$@" update-ref -d refs/journal/pushed
}

rollover() {
  if [ -d "$J" ]; then
    restart refs/heads/home git --git-dir="$J"
    # Our own repo: drop the old history now. Projects' repos keep their usual gc schedule.
    git --git-dir="$J" reflog expire --expire=now --all && git --git-dir="$J" gc -q --prune=now
  fi
  [ -s "$REPOS" ] && while read -r top; do
    [ -d "$top" ] && restart refs/journal/work git -C "$top"
  done < "$REPOS"
  echo rolled
}

auth() { echo "http.extraHeader=Authorization: Bearer $JOURNAL_TOKEN"; }

# lay_over LABEL ROOT LOCAL_REF INDEX GIT...: fetched refs/journal/remote is newer than LOCAL_REF;
# bring the files that changed between them (in ROOT) up to it and move LOCAL_REF on. INDEX=1 also
# resets the index to it (the journal's own repo; never a project's). Prints "restored LABEL".
lay_over() {
  label=$1 root=$2 ref=$3 index=$4; shift 4
  new=$("$@" rev-parse -q --verify refs/journal/remote) || return 0
  old=$("$@" rev-parse -q --verify "$ref")
  [ "$old" = "$new" ] && return 0
  # Ours is newer (the remote fell behind): keep it.
  [ -n "$old" ] && "$@" merge-base --is-ancestor "$new" "$old" 2>/dev/null && return 0
  (
    cd "$root" || exit 1
    if [ -n "$old" ]; then
      "$@" diff --name-only -z --no-renames --diff-filter=D "$old" "$new" | xargs -0r rm -f --
      "$@" diff --name-only -z --no-renames --diff-filter=d "$old" "$new" | xargs -0r "$@" restore --source="$new" --worktree --
    else
      "$@" restore --source="$new" --worktree -- .
    fi
  ) || return 1
  [ "$index" = 1 ] && "$@" read-tree "$new"
  "$@" update-ref "$ref" "$new" && "$@" update-ref refs/journal/pushed "$new" && echo "restored $label"
}

restore() {
  [ -n "${JOURNAL_REMOTE:-}" ] && [ -n "${JOURNAL_TOKEN:-}" ] || { echo "no remote" >&2; exit 2; }
  heads=$(git -c "$(auth)" ls-remote --heads "$JOURNAL_REMOTE" 2>/dev/null | sed 's|.*refs/heads/||') || exit 1
  if echo "$heads" | grep -qx home; then
    [ -d "$J" ] || GIT_DIR=$J git init -q -b home
    g="git --git-dir=$J --work-tree=$HOME"
    $g -c "$(auth)" fetch -q --no-tags "$JOURNAL_REMOTE" "+refs/heads/home:refs/journal/remote" \
      && lay_over home "$HOME" refs/heads/home 1 $g
  fi
  [ -s "$REPOS" ] && while read -r top; do
    b=$(branch_for "$top")
    [ -d "$top" ] && echo "$heads" | grep -qxF "$b" || continue
    git -C "$top" -c "$(auth)" fetch -q --no-tags "$JOURNAL_REMOTE" "+refs/heads/$b:refs/journal/remote" \
      && lay_over "$b" "$top" refs/journal/work 0 git -C "$top"
  done < "$REPOS"
  exit 0
}

case ${1:-} in
  home) home ;;
  snap) snap "${2:-$PWD}" "${3:-}" ;;
  tick)
    [ -x /opt/herdr-cloud/save-shells.sh ] && /opt/herdr-cloud/save-shells.sh
    home
    for d in "$HOME"/work/*/; do [ -e "$d/.git" ] && snap "$d"; done
    ;;
  restore) restore ;;
  size) size ;;
  rollover) rollover ;;
  push)
    [ -n "${JOURNAL_REMOTE:-}" ] && [ -n "${JOURNAL_TOKEN:-}" ] || { echo "no remote" >&2; exit 2; }
    [ -d "$J" ] && pushref refs/heads/home home git --git-dir="$J"
    [ -s "$REPOS" ] && while read -r top; do
      [ -d "$top" ] && pushref refs/journal/work "$(branch_for "$top")" git -C "$top"
    done < "$REPOS"
    exit "${failed:-0}"
    ;;
  *) echo "usage: journal.sh home|snap DIR [MSG]|tick|push|restore|size|rollover" >&2; exit 2 ;;
esac
