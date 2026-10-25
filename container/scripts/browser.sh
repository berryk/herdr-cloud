#!/bin/sh
# Run the agent browser in the foreground: a KasmVNC X server on :1 (web client on port
# 6901) running i3 and Chrome with CDP on 127.0.0.1:9222. init.sh runs this as dev and
# restarts it if it exits.
#
# Xvnc is started directly, not through the kasmvncserver wrapper: on Cloudflare the
# hostname is a 64-character ID that does not resolve, and the wrapper derives its
# defaults and xauth entry from it and gives up. No -auth: only local X clients exist.
# Arguments are the wrapper's, minus TLS-only and GPU ones (see git history for the YAML).
set -eu
# Left behind when the disk was snapshotted with the display running.
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
Xvnc :1 \
  -interface 0.0.0.0 -websocketPort 6901 -rfbport 5901 -UseIPv4 1 -UseIPv6 0 \
  -httpd /usr/share/kasmvnc/www -sslOnly 0 \
  -cert /etc/ssl/certs/ssl-cert-snakeoil.pem -key /etc/ssl/private/ssl-cert-snakeoil.key \
  -DisableBasicAuth -SecurityTypes None -KasmPasswordFile /etc/kasmpasswd \
  -desktop browser -geometry 1440x900 -depth 24 -AcceptSetDesktopSize 1 \
  -FrameRate 30 -DynamicQualityMin 3 -DynamicQualityMax 8 -TreatLossless 10 -CompareFB 2 \
  -RawKeyboard 1 -AcceptKeyEvents 1 -AcceptPointerEvents 1 \
  -SendCutText 1 -AcceptCutText 1 -SendPrimary 0 \
  -DLP_ClipDelay 0 -DLP_KeyRateLimit 0 -DLP_ClipSendMax 0 -DLP_ClipAcceptMax 0 \
  -IdleTimeout 0 -MaxIdleTime 0 -MaxConnectionTime 0 -MaxDisconnectionTime 0 \
  -QueryConnect 0 -DisconnectClients 0 -PublicIP 127.0.0.1 \
  -AllowOverride AcceptPointerEvents,SendCutText,AcceptCutText,SendPrimary \
  -http-header Cross-Origin-Embedder-Policy=require-corp \
  -http-header Cross-Origin-Opener-Policy=same-origin \
  -Log '*:stdout:30' &
xvnc=$!
i=0
while [ ! -S /tmp/.X11-unix/X1 ] && [ "$i" -lt 100 ]; do i=$((i + 1)); sleep 0.1; done
DISPLAY=:1 /opt/herdr-cloud/browser/xstartup &
wait "$xvnc"
