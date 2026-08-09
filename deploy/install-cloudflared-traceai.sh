#!/usr/bin/env bash
# Run on the Pi to install/start the TraceAI cloudflared systemd unit.
set -Eeuo pipefail

UNIT=/etc/systemd/system/cloudflared-traceai.service
CONFIG=/home/joostvl/.config/traceai/cloudflared.yml
TUNNEL_ID=94bb4a5e-2fda-44b1-8899-1a208eb3227f

if [[ ! -f "$CONFIG" ]]; then
  echo "Missing $CONFIG — run deploy/write-cloudflared-config.sh first"
  exit 1
fi
if grep -E 'path:[[:space:]]*/(v1|events)\*' "$CONFIG" >/dev/null 2>&1; then
  echo "Refusing unsafe cloudflared paths (/v1* or /events*)."
  echo "Those are Go regexes and match stray /v… URLs (e.g. /projects/vantage)."
  echo "Run: deploy/write-cloudflared-config.sh"
  exit 1
fi

sudo tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=cloudflared tunnel=traceai ($TUNNEL_ID)
After=network-online.target docker.service
Wants=network-online.target

[Service]
TimeoutStartSec=15
Type=notify
ExecStart=/usr/bin/cloudflared --no-autoupdate --config $CONFIG tunnel run $TUNNEL_ID
Restart=on-failure
RestartSec=5s
User=joostvl
Group=joostvl

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-traceai.service
sudo systemctl --no-pager --full status cloudflared-traceai.service | sed -n '1,25p'
