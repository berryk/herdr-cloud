#!/bin/sh
# Container entrypoint (also re-run after a snapshot restore). Processes started by the
# Durable Object's exec() do not outlive that exec, so anything long-lived starts here.
as_dev() { runuser -u dev -- env HOME=/home/dev USER=dev PATH=/home/dev/.local/bin:/usr/local/bin:/usr/bin:/bin "$@"; }

# Claude's browser MCP is user-scoped so it sits beside servers you add; re-add it in case
# a home archive from an older image replaced ~/.claude.json.
as_dev sh -c 'claude mcp get chrome-devtools >/dev/null 2>&1 || claude mcp add -s user chrome-devtools -- chrome-devtools-mcp --browserUrl http://127.0.0.1:9222' >/dev/null 2>&1 &

# Herdr's Claude integration reports each Claude session to Herdr, which then resumes it after a
# restart; our plugin journals each agent turn. Both live in the home folder, so redo them in case
# a home archive from an older image replaced it.
as_dev sh -c 'mkdir -p ~/.claude && herdr integration install claude
  herdr plugin list 2>/dev/null | grep -q herdr-cloud || herdr plugin link /opt/herdr-cloud/herdr-plugin' >/tmp/herdr-setup.log 2>&1

# Skip Herdr's first-run welcome. The key must be top-level, so it goes at the top of the file.
as_dev sh -c 'f=$HOME/.config/herdr/config.toml; mkdir -p "${f%/*}"; touch "$f"
  grep -q "^onboarding *=" "$f" || { printf "onboarding = false\n" | cat - "$f" > "$f.new" && mv "$f.new" "$f"; }'

# SSH (see the Dockerfile): this workspace's own host key, then sshd. After a home archive is
# unpacked the Durable Object sends sshd a HUP so it picks up the archived key.
as_dev sh -c 'k=$HOME/.herdr-cloud/ssh/ssh_host_ed25519_key; [ -f "$k" ] || { mkdir -p "${k%/*}" && ssh-keygen -q -t ed25519 -N "" -C herdr-cloud -f "$k"; }'
mkdir -p /run/sshd && /usr/sbin/sshd

# Agent browser: restart the display if it ever exits. Xvnc runs as dev and cannot create this.
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
( while :; do as_dev /opt/herdr-cloud/browser.sh; sleep 2; done ) >>/tmp/browser.log 2>&1 &

exec sleep infinity
