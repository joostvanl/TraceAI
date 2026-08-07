#!/usr/bin/env bash
# Run on the Pi to install/start the TraceAI cloudflared systemd unit.
set -Eeuo pipefail

UNIT=/etc/systemd/system/cloudflared-traceai.service
CONFIG=/home/joostvl/.config/traceai/cloudflared.yml
TUNNEL_ID=94bb4a5e-2fda-44b1-8899-1a208eb3227f

[[ -f "$CONFIG" ]] || { echo "Missing $CONFIG"; exit 1; }

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
