#!/usr/bin/env bash
set -Eeuo pipefail
ENV_FILE="${HOME}/.config/traceai/traceai.env"
LAN_HOST="${TRACEAI_LAN_HOST:-192.168.1.91}"
PUBLIC_ORIGIN="${TRACEAI_PUBLIC_ORIGIN:-https://traceai.joostvanleeuwaarden.com}"
LAN_UI="http://${LAN_HOST}:3011"
# Public origin first (Cloudflare), then this host's LAN UI.
cors="TRACEAI_CORS_ORIGINS=${PUBLIC_ORIGIN},${LAN_UI}"
events="NEXT_PUBLIC_TRACEAI_EVENTS_URL=${PUBLIC_ORIGIN}/events"
tmp="$(mktemp)"
awk -v cors="$cors" -v events="$events" '
  /^TRACEAI_CORS_ORIGINS=/ { print cors; seen_cors=1; next }
  /^NEXT_PUBLIC_TRACEAI_EVENTS_URL=/ { print events; seen_events=1; next }
  { print }
  END {
    if (!seen_cors) print cors
    if (!seen_events) print events
  }
' "$ENV_FILE" >"$tmp"
install -m 600 "$tmp" "$ENV_FILE"
rm -f "$tmp"
grep -E '^(TRACEAI_CORS_ORIGINS|NEXT_PUBLIC_TRACEAI_EVENTS_URL)=' "$ENV_FILE"
