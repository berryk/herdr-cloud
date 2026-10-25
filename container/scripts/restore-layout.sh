#!/bin/sh
# After starting from a snapshot, as dev, in the background. Herdr restores its own layout when the
# first browser attaches and starts the server; we then restart Claude in each pane that had it.
set -u
OUT="$HOME/.herdr-cloud"; SAVED="$OUT/agents.json"; LOG="$OUT/restore.log"
PROMPT="You were interrupted by a container restart. Check the repo and task state, then carry on where you left off."
exec >>"$LOG" 2>&1
echo "--- restore $(date -u +%FT%TZ)"
[ -s "$SAVED" ] || { echo "nothing to resume"; exit 0; }
i=0
until herdr workspace list 2>/dev/null | grep -q '"result"'; do
  i=$((i+1)); [ "$i" -gt 180 ] && { echo "herdr server never came up"; exit 1; }; sleep 1
done
sleep 2  # let herdr finish rebuilding panes
PANES=$(herdr pane list 2>/dev/null)
NATIVE=0; herdr integration status 2>/dev/null | grep -q '^claude: current' && NATIVE=1
claude_in() {
  herdr pane process-info --pane "$1" 2>/dev/null \
    | jq -e '[.result.process_info.foreground_processes[]?.name] | index("claude")' >/dev/null
}
jq -c '.[]' "$SAVED" | while read -r a; do
  pane=$(echo "$a" | jq -r .pane_id); cwd=$(echo "$a" | jq -r .cwd); busy=$(echo "$a" | jq -r .busy)
  # The pane's own conversation when Claude saved one, else the latest one in that folder, else a
  # fresh Claude. Claude saves a conversation only after its first message, so a session Herdr knew
  # can have nothing to resume.
  session=$(echo "$a" | jq -r '.session // empty' | tr -cd 'A-Za-z0-9-')
  proj="$HOME/.claude/projects/$(printf %s "$cwd" | sed 's/[^A-Za-z0-9]/-/g')"
  resume=""
  if [ -n "$session" ] && [ -f "$proj/$session.jsonl" ]; then resume="--resume $session"
  elif ls "$proj"/*.jsonl >/dev/null 2>&1; then resume="--continue"; fi
  if ! echo "$PANES" | grep -q "\"$pane\""; then
    # Pane not restored: give it a fresh workspace in the same folder.
    pane=$(herdr workspace create --cwd "$cwd" --label "$(basename "$cwd")" --no-focus 2>/dev/null | jq -r '.result.root_pane.pane_id // empty')
    [ -n "$pane" ] || { echo "could not recreate $cwd"; continue; }
  fi
  # With its Claude integration installed, Herdr resumes Claude itself once a client attaches.
  # Give it a moment; if it did, only pass on the carry-on prompt to panes that were busy.
  n=0; [ -n "$session" ] && [ "$NATIVE" = 1 ] && n=20
  while :; do
    if claude_in "$pane"; then
      if [ -n "$session" ] && [ "$resume" != "--resume $session" ]; then
        # Herdr is resuming a session Claude never saved: it will say so and exit. Wait, then
        # start Claude ourselves.
        w=0; while claude_in "$pane" && [ "$w" -lt 60 ]; do w=$((w + 1)); sleep 1; done
        echo "herdr's resume in $pane had no conversation"; break
      fi
      if [ "$busy" = "true" ]; then
        herdr agent wait "$pane" --timeout 60000 >/dev/null 2>&1
        herdr agent prompt "$pane" "$PROMPT" >/dev/null 2>&1 && echo "prompted $pane (herdr resumed it)" || echo "could not prompt $pane"
      else
        echo "herdr resumed $pane"
      fi
      continue 2
    fi
    [ "$n" -gt 0 ] || break
    n=$((n - 1)); sleep 1
  done
  if [ "$busy" = "true" ] && [ -n "$resume" ]; then
    herdr pane run "$pane" "cd '$cwd' && claude $resume '$PROMPT'"
  else
    herdr pane run "$pane" "cd '$cwd' && claude $resume"
  fi && echo "resumed $pane ($cwd, busy=$busy)" || echo "failed $pane"
done
rm -f "$SAVED"
echo done
