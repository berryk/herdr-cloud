#!/bin/sh
# Record what was apt-installed on top of the image, so a wake on a newer image can put it back
# (restore-packages.sh). Runs as dev before each home archive, so the list travels with ~/.
#   ~/.herdr-cloud/apt-packages     packages marked manual that the image did not have
#   ~/.herdr-cloud/apt-sources.tar  apt sources and keyrings added for third-party repos
set -u
OUT="$HOME/.herdr-cloud"; BASE=/opt/herdr-cloud; mkdir -p "$OUT"
# Mid-reinstall the list is incomplete: keep the previous one.
[ -e /tmp/apt-restore.running ] && exit 0
[ -r "$BASE/apt-base.txt" ] || exit 0
apt-mark showmanual | sort | comm -13 "$BASE/apt-base.txt" - > "$OUT/apt-packages.tmp" \
  && mv "$OUT/apt-packages.tmp" "$OUT/apt-packages"
find /etc/apt/sources.list.d /etc/apt/keyrings /etc/apt/trusted.gpg.d /usr/share/keyrings -type f 2>/dev/null \
  | sort | comm -13 "$BASE/apt-files-base.txt" - > "$OUT/apt-files.tmp"
if [ -s "$OUT/apt-files.tmp" ]; then
  tar -cf "$OUT/apt-sources.tar" -T "$OUT/apt-files.tmp" 2>/dev/null
else
  rm -f "$OUT/apt-sources.tar"
fi
rm -f "$OUT/apt-files.tmp" "$OUT/apt-packages.tmp"
echo "$(wc -l < "$OUT/apt-packages") extra packages"
