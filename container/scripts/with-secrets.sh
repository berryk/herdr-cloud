#!/bin/bash
# with-secrets.sh CMD...: replace op:// references in the environment with their values from
# 1Password, using the workspace owner's OP_SERVICE_ACCOUNT_TOKEN, then exec CMD. Values only
# live in process memory, never on disk. If 1Password cannot be reached the references are
# dropped (see /tmp/with-secrets.log) and CMD still runs.
set -u
LOG=/tmp/with-secrets.log
refs=$(env | sed -n 's|^\([A-Za-z_][A-Za-z0-9_]*\)=op://.*|\1|p')
if [ -n "$refs" ]; then
  if [ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]; then
    # One 1Password round trip resolves them all; its environment comes back NUL-separated.
    if all=$(op run --no-masking -- env -0 2>>"$LOG" | base64 -w0; exit "${PIPESTATUS[0]}"); then
      while IFS= read -r -d '' kv; do
        grep -qx "${kv%%=*}" <<<"$refs" && export "$kv"
      done < <(base64 -d <<<"$all")
    else
      # A single bad reference fails the lot: resolve one at a time and keep the good ones.
      for n in $refs; do v=$(op read -n "${!n}" 2>>"$LOG") && export "$n=$v"; done
    fi
  fi
  # An unresolved reference would look like a real (and wrong) value to the program.
  for n in $refs; do
    case ${!n} in op://*) echo "$(date -u +%FT%TZ) $n not resolved" >>"$LOG"; unset "$n" ;; esac
  done
fi
[ -n "${GITHUB_TOKEN:-}" ] && export GH_TOKEN="${GH_TOKEN:-$GITHUB_TOKEN}"
exec "$@"
