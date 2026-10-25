#!/bin/sh
# Exit 0 if any Herdr agent is busy, 1 otherwise. With --list, print "<pane_id> <cwd>" per busy agent.
# Busy = any agent whose status is not a resting state, so we err towards staying awake.
set -u
J=$(herdr agent list 2>/dev/null) || exit 1
LIST=$(printf '%s' "$J" | jq -r '
  (.result.agents // [])[]
  | select(((.agent_status // .status // "unknown") | ascii_downcase)
           | test("^(unknown|idle|done|blocked|waiting|stopped|exited)$") | not)
  | "\(.pane_id // "?") \(.foreground_cwd // .cwd // "?")"' 2>/dev/null) || exit 1
[ "${1:-}" = "--list" ] && [ -n "$LIST" ] && printf '%s\n' "$LIST"
[ -n "$LIST" ]
