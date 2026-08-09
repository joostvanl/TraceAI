#!/usr/bin/env bash
# Install/start the pi-ssh Cloudflare Tunnel (SSH from outside).
set -Eeuo pipefail

TUNNEL_ID=205eeb43-c43e-4cd7-bfef-5de8ef2cf87c
HOSTNAME=ssh.joostvanleeuwaarden.com
CONFIG_DIR="${HOME}/.config/pi-ssh"
CONFIG="${CONFIG_DIR}/cloudflared.yml"
CREDENTIALS="${HOME}/.cloudflared/${TUNNEL_ID}.json"
UNIT=/etc/systemd/system/cloudflared-pi-ssh.service

[[ -f "$CREDENTIALS" ]] || {
  echo "Missing credentials $CREDENTIALS â€” create the tunnel first:"
  echo "  cloudflared tunnel create pi-ssh"
  exit 1
}

mkdir -p "$CONFIG_DIR"
cat >"$CONFIG" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $CREDENTIALS
ingress:
  - hostname: $HOSTNAME
    service: ssh://localhost:22
  - service: http_status:404
EOF
chmod 600 "$CONFIG"

cloudflared tunnel --config "$CONFIG" ingress validate
cloudflared tunnel route dns --overwrite-dns "$TUNNEL_ID" "$HOSTNAME"

sudo tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=cloudflared tunnel=pi-ssh ($TUNNEL_ID)
After=network-online.target
Wants=network-online.target

[Service]
TimeoutStartSec=15
Type=notify
ExecStart=/usr/bin/cloudflared --no-autoupdate --config $CONFIG tunnel run $TUNNEL_ID
Restart=on-failure
RestartSec=5s
User=$(id -un)
Group=$(id -gn)

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-pi-ssh.service
sleep 2
systemctl is-active cloudflared-pi-ssh
sudo systemctl --no-pager --full status cloudflared-pi-ssh.service | sed -n '1,25p'
cloudflared tunnel info "$TUNNEL_ID" | sed -n '1,20p'

cat <<EOF

Client setup (Windows / macOS / Linux):
  1. Install cloudflared on your laptop.
  2. Add to ~/.ssh/config:

Host ssh.joostvanleeuwaarden.com
  User joostvl
  ProxyCommand cloudflared access ssh --hostname %h

  3. Connect:  ssh ssh.joostvanleeuwaarden.com

Recommended next step: protect $HOSTNAME with a Cloudflare Access
self-hosted app (email allowlist) in Zero Trust â†’ Access â†’ Applications.
EOF
