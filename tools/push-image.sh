#!/bin/sh
# push-image.sh [TAG]: build the workspace image, push it to your account's Cloudflare registry and
# pin wrangler.jsonc to the pushed digest (the containers "images" map only accepts digest-pinned
# registry images). Then `npm run deploy`. Set DOCKER_BUILD_FLAGS=--network=host if your Docker
# builds cannot resolve names.
set -eu
cd "$(dirname "$0")/.."
tag=${1:-$(date -u +%Y%m%d-%H%M)}
[ -f wrangler.jsonc ] || { echo "copy wrangler.example.jsonc to wrangler.jsonc first" >&2; exit 1; }
docker build ${DOCKER_BUILD_FLAGS:-} -t "herdr-cloud:$tag" container
out=$(npx wrangler containers push "herdr-cloud:$tag" 2>&1) || { echo "$out" >&2; exit 1; }
digest=$(printf '%s\n' "$out" | sed -n "s/^$tag: digest: \(sha256:[0-9a-f]*\).*/\1/p" | head -1)
repo=$(printf '%s\n' "$out" | sed -n 's/^Pushed image: \(registry\.cloudflare\.com\/[^:]*\):.*/\1/p' | head -1)
[ -n "$digest" ] && [ -n "$repo" ] || { echo "could not read the pushed digest:" >&2; echo "$out" >&2; exit 1; }
sed -i.bak -E "s#\"image\": \"[^\"]*\"#\"image\": \"$repo@$digest\"#" wrangler.jsonc && rm -f wrangler.jsonc.bak
echo "pinned $repo@$digest in wrangler.jsonc"
