#!/bin/sh
# Chrome's site sign-ins (its cookie database) follow their owner between workspaces, like Claude
# and gh logins: the Durable Object keeps an encrypted copy per user (see #syncBrowser). Cookies are
# encrypted with Chrome's fixed "basic" key (agent-chrome passes --password-store=basic), so a copy
# reads the same in any workspace. Copies are merged, never replaced: a row wins when it is newer.
#
#   browser-logins.sh stat           "<hash> <mtime>" of the cookie database, or "- 0"
#   browser-logins.sh pack < SAVED   the live database merged with SAVED (gzip, may be empty), as gzip
#                                    on stdout; Chrome keeps running
#   browser-logins.sh merge < SAVED  merge SAVED (gzip) into the live database; Chrome stops for a
#                                    moment (agent-chrome waits for us) and restores its tabs
set -eu
PROFILE=${AGENT_CHROME_PROFILE:-$HOME/.local/share/agent-browser}
DB=$PROFILE/Default/Cookies
HOLD=/tmp/hc-browser-hold

cols() { sqlite3 "$1" "select group_concat(name) from pragma_table_info('cookies')"; }

# merge INTO FROM: rows of FROM that INTO lacks, or has older, go into INTO.
merge_db() {
  # A newer Chrome may have changed the table; then keep what we have.
  if [ "$(cols "$1")" != "$(cols "$2")" ]; then echo "cookie tables differ; not merged" >&2; return 0; fi
  sqlite3 "$1" "attach '$2' as s; insert or replace into main.cookies select * from s.cookies c
    where c.last_update_utc > coalesce((select max(m.last_update_utc) from main.cookies m where m.host_key = c.host_key
      and m.name = c.name and m.path = c.path and m.top_frame_site_key = c.top_frame_site_key), -1);"
}

t=$(mktemp -d)
trap 'rm -rf "$t"; rm -f "$HOLD"' EXIT
case ${1:-} in
  stat)
    if [ -f "$DB" ]; then echo "$(sha256sum < "$DB" | cut -c1-64) $(stat -c %Y "$DB")"; else echo "- 0"; fi
    ;;
  pack)
    [ -f "$DB" ] || exit 3
    sqlite3 "$DB" ".backup '$t/live'"
    cat > "$t/saved.gz"
    if [ -s "$t/saved.gz" ]; then gunzip -c "$t/saved.gz" > "$t/saved" && merge_db "$t/live" "$t/saved"; fi
    gzip -c "$t/live"
    ;;
  merge)
    cat > "$t/saved.gz"
    gunzip -c "$t/saved.gz" > "$t/saved"
    touch "$HOLD"
    # TERM lets Chrome write out its cookies first.
    pkill -x chrome 2>/dev/null || true
    i=0
    while pgrep -x chrome >/dev/null && [ "$i" -lt 40 ]; do i=$((i + 1)); sleep 0.25; done
    pkill -9 -x chrome 2>/dev/null || true
    if [ -f "$DB" ]; then
      merge_db "$DB" "$t/saved"
    else
      mkdir -p "$(dirname "$DB")" && install -m 600 "$t/saved" "$DB"
    fi
    ;;
  *) echo "usage: browser-logins.sh stat|pack|merge" >&2; exit 2 ;;
esac
