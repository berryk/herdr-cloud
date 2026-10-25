#!/bin/sh
# Run before a container snapshot, as dev. Herdr persists its own workspaces/tabs/panes on disk,
# so here we only record which panes were running Claude (and which were busy) so restore can
# restart them, resuming the same conversation. Shell panes keep their own state (shell-state.zsh);
# here we also save their screens.
set -u
OUT="$HOME/.herdr-cloud"; mkdir -p "$OUT"
herdr api snapshot 2>/dev/null | jq -c '
  .result.snapshot as $s
  | [ ($s.agents // [])[]
      | select(((.kind // .agent // .name // "") | ascii_downcase | test("claude")))
      | { pane_id, cwd: (.foreground_cwd // .cwd), session: (.agent_session.value // null),
          busy: (((.agent_status // .status // "unknown") | ascii_downcase)
                 | test("^(unknown|idle|done|blocked|waiting|stopped|exited)$") | not) } ]' \
  > "$OUT/agents.json.tmp" 2>/dev/null && mv "$OUT/agents.json.tmp" "$OUT/agents.json"
rm -f "$OUT/agents.json.tmp"
[ -x /opt/herdr-cloud/save-shells.sh ] && /opt/herdr-cloud/save-shells.sh
sync
echo "saved $(jq length "$OUT/agents.json" 2>/dev/null || echo 0) claude panes"
