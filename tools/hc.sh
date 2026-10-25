#!/bin/sh
# hc.sh <path> [curl args...]: call your deployment through Cloudflare Access with a service
# token, e.g. `tools/hc.sh /w/agent-test/status`. Set HERDR_CLOUD_HOST (herdr.your-domain.com),
# CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET. Browsers and WebSockets need the same two headers.
: "${HERDR_CLOUD_HOST:?set HERDR_CLOUD_HOST}" "${CF_ACCESS_CLIENT_ID:?set CF_ACCESS_CLIENT_ID}" "${CF_ACCESS_CLIENT_SECRET:?set CF_ACCESS_CLIENT_SECRET}"
p="$1"; shift
exec curl -sS -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  "$@" "https://$HERDR_CLOUD_HOST$p"
