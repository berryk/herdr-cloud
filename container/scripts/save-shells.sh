#!/bin/sh
# Copy each shell pane's screen to ~/.herdr-cloud/shells/<pane>/screen, which shell-state.zsh
# redraws when the pane comes back after a restart. Run by save-layout.sh and the per-minute sync.
# Agent panes are skipped: Claude redraws its own conversation when it resumes.
set -u
HOME=${HOME:-/home/dev}
D=$HOME/.herdr-cloud/shells
J=$(herdr pane list 2>/dev/null) || exit 0
ALL=$(printf '%s' "$J" | jq -r '.result.panes[]?.pane_id') || exit 0
[ -n "$ALL" ] || exit 0
mkdir -p "$D"
for id in $(printf '%s' "$J" | jq -r '.result.panes[]? | select(.agent == null) | .pane_id'); do
  d="$D/$(printf '%s' "$id" | tr -c 'A-Za-z0-9_.-' '_')"; f="$d/screen"
  mkdir -p "$d"
  herdr pane read "$id" --source recent --lines 1000 --ansi > "$f.tmp" 2>/dev/null || { rm -f "$f.tmp"; continue; }
  # Only replace it when it changed, so an idle pane uploads nothing.
  if cmp -s "$f.tmp" "$f"; then rm -f "$f.tmp"; else mv -f "$f.tmp" "$f"; fi
done
# Forget panes that are gone.
keep=$(printf '%s\n' "$ALL" | tr -c 'A-Za-z0-9_.\n-' '_')
for d in "$D"/*/; do
  [ -d "$d" ] || continue
  n=$(basename "$d")
  printf '%s\n' "$keep" | grep -qxF "$n" || rm -rf "$d"
done
exit 0
