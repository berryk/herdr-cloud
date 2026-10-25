#!/bin/sh
# Herdr plugin event hook (herdr-plugin/herdr-plugin.toml) for pane.agent_status_changed:
# logs agent status changes, and when an agent settles after a turn, snapshots its project
# into the journal so each turn's changes are one commit.
set -u
HOME=${HOME:-/home/dev}
LOG=$HOME/.herdr-cloud/agent-events.log
E=${HERDR_PLUGIN_EVENT_JSON:-'{}'}
pane=$(printf '%s' "$E" | jq -r '.data.pane_id // .pane_id // empty' 2>/dev/null)
[ -n "$pane" ] || pane=${HERDR_PANE_ID:-}
status=$(printf '%s' "$E" | jq -r '(.data.agent_status // .agent_status // "") | ascii_downcase' 2>/dev/null)
P=$(herdr pane get "$pane" 2>/dev/null)
cwd=$(printf '%s' "$P" | jq -r '.result.pane.foreground_cwd // .result.pane.cwd // empty' 2>/dev/null)
agent=$(printf '%s' "$P" | jq -r '.result.pane.agent // "agent"' 2>/dev/null)
title=$(printf '%s' "$P" | jq -r '.result.pane.terminal_title_stripped // empty' 2>/dev/null)
echo "$(date -u +%FT%TZ) $pane $agent $status $cwd" >> "$LOG"
case $status in
  idle|done|blocked) [ -n "$cwd" ] && /opt/herdr-cloud/journal.sh snap "$cwd" "$agent $status in $pane${title:+: $title}" ;;
esac
exit 0
