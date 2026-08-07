#!/usr/bin/env bash
set -Eeuo pipefail
ENV_FILE="${HOME}/.config/traceai/traceai.env"
tmp="$(mktemp)"
awk '
  BEGIN {
    cors="TRACEAI_CORS_ORIGINS=https://traceai.joostvanleeuwaarden.com,http://192.168.1.91:3011"
    events="NEXT_PUBLIC_TRACEAI_EVENTS_URL=https://traceai.joostvanleeuwaarden.com/events"
  }
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
