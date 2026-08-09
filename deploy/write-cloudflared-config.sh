#!/usr/bin/env bash
# Write / refresh the TraceAI cloudflared ingress config.
#
# IMPORTANT: path values are Go regular expressions (not shell globs).
# Never use `/v1*` or `/events*` — in regex `1*` / `s*` means "zero or more
# of that character", so `/v1*` matches ANY path containing `/v`
# (e.g. /projects/vantage) and sends it to the API.
set -Eeuo pipefail

CONFIG="${TRACEAI_CLOUDFLARED_CONFIG:-$HOME/.config/traceai/cloudflared.yml}"
TUNNEL_ID="${TRACEAI_TUNNEL_ID:-94bb4a5e-2fda-44b1-8899-1a208eb3227f}"
CREDENTIALS_FILE="${TRACEAI_TUNNEL_CREDENTIALS:-$HOME/.cloudflared/$TUNNEL_ID.json}"

mkdir -p "$(dirname "$CONFIG")"
cat >"$CONFIG" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $CREDENTIALS_FILE
ingress:
  # Anchored regexes: only the API prefixes, never stray /v… project slugs.
  - hostname: traceai.joostvanleeuwaarden.com
    path: ^/events(/|$)
    service: http://127.0.0.1:3847
  - hostname: traceai.joostvanleeuwaarden.com
    path: ^/v1(/|$)
    service: http://127.0.0.1:3847
  - hostname: traceai.joostvanleeuwaarden.com
    path: ^/health$
    service: http://127.0.0.1:3847
  - hostname: traceai.joostvanleeuwaarden.com
    service: http://127.0.0.1:3011
  - service: http_status:404
EOF
chmod 600 "$CONFIG"
echo "Wrote $CONFIG"
cloudflared tunnel --config "$CONFIG" ingress validate
echo "Validate OK. Restart with: sudo systemctl restart cloudflared-traceai"
