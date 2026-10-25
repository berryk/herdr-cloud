#!/bin/sh
# After a home archive is unpacked onto a newer image, as dev in the background: reinstall the
# packages save-packages.sh recorded. Log: ~/.herdr-cloud/apt-restore.log.
set -u
OUT="$HOME/.herdr-cloud"; LIST="$OUT/apt-packages"
[ -s "$LIST" ] || exit 0
touch /tmp/apt-restore.running
trap 'rm -f /tmp/apt-restore.running' EXIT
exec >>"$OUT/apt-restore.log" 2>&1
echo "--- $(date -u +%FT%TZ) reinstalling $(wc -l < "$LIST") packages"
[ -s "$OUT/apt-sources.tar" ] && sudo tar -C / -xf "$OUT/apt-sources.tar"
sudo apt-get update -q || true
APT="sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends"
# shellcheck disable=SC2046 # one package name per line
if ! $APT $(cat "$LIST"); then
  # One name that no longer exists fails the lot: retry one at a time and keep the rest.
  for p in $(cat "$LIST"); do $APT "$p" || echo "could not reinstall $p"; done
fi
echo done
