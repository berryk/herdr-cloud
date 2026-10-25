#!/bin/sh
# Exit 0 if a person or a command has done something in a shell pane since the last call, 1 if not.
# Something means the pane's visible screen changed (typing, output, an editor) or its foreground
# command used more than ACTIVITY_CPU_SECONDS (2) of CPU (a silent build). A command that sits there
# quietly, like an idle dev server, does not count, so a forgotten one does not keep the workspace
# awake. Agent panes are left to busy.sh. With --why, print what counted.
set -u
D=/tmp/hc-activity; mkdir -p "$D"
TICK=$(getconf CLK_TCK)
LIMIT=$(( ${ACTIVITY_CPU_SECONDS:-2} * TICK ))
J=$(herdr pane list 2>/dev/null) || exit 1
active=1
for id in $(printf '%s' "$J" | jq -r '.result.panes[]? | select(.agent == null) | .pane_id'); do
  f="$D/$(printf '%s' "$id" | tr -c 'A-Za-z0-9_.-' '_')"
  scr=$(herdr pane read "$id" --source visible 2>/dev/null | md5sum | cut -c1-32)
  # CPU ticks of the foreground processes, including children they have waited for.
  cpu=0
  for pid in $(herdr pane process-info --pane "$id" 2>/dev/null | jq -r '.result.process_info as $p
      | if ($p.foreground_process_group_id == $p.shell_pid) then empty else $p.foreground_processes[]?.pid end'); do
    t=$(awk '{ print $14 + $15 + $16 + $17 }' "/proc/$pid/stat" 2>/dev/null) && cpu=$((cpu + t))
  done
  if [ -f "$f" ]; then
    read -r oscr ocpu < "$f"
    if [ "$scr" != "$oscr" ]; then active=0; [ "${1:-}" = --why ] && echo "$id screen"
    elif [ $((cpu - ocpu)) -gt "$LIMIT" ]; then active=0; [ "${1:-}" = --why ] && echo "$id cpu"
    fi
  fi
  echo "$scr $cpu" > "$f"
done
# Typing anywhere, including plain SSH sessions outside Herdr: a terminal is read from only when
# input arrives. (sshd here records no logins, so look at the terminal devices themselves.)
for t in /dev/pts/[0-9]*; do
  [ -e "$t" ] || continue
  f="$D/tty_${t##*/}"
  at=$(stat -c %X "$t" 2>/dev/null) || continue
  if [ -f "$f" ] && [ "$at" != "$(cat "$f")" ]; then active=0; [ "${1:-}" = --why ] && echo "${t#/dev/} typing"; fi
  echo "$at" > "$f"
done
exit "$active"
