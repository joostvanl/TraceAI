# TraceAI on Raspberry Pi (Docker)

Deploy the TraceAI API + read-only web UI on a Pi (aarch64) using the same Aurora
website/project as local development.

## Prerequisites

- Docker + Compose on the Pi
- Clone of this repo (or `rsync` of sources)
- Aurora user token + public site key (same as local)

## Setup

Install the trigger script once as `~/deploy-traceai.sh`. It clones/updates this
repository over public HTTPS, builds both containers and runs health checks.

```bash
chmod +x ~/deploy-traceai.sh
~/deploy-traceai.sh
```

On its first run it creates `~/.config/traceai/traceai.env` and stops. Fill
`AURORA_USER_TOKEN` and `CMS_SITE_KEY`, then run the same command
again. Secrets remain outside the git checkout.

Upgrading from before TRA-81: rename `NEXT_PUBLIC_CMS_SITE_KEY` to
`CMS_SITE_KEY` in that env file. The key is server-only and is now read at
runtime instead of being baked into the image, so the old name leaves the web
container without a key. The deploy script refuses to continue if it finds only
the old name.

## URLs

| Service | URL |
|---|---|
| Public UI | https://traceai.joostvanleeuwaarden.com |
| LAN Web UI | http://192.168.1.91:3011 |
| LAN API health | http://192.168.1.91:3847/health |
| Public SSE | https://traceai.joostvanleeuwaarden.com/events?project=traceai |
| Public MCP | https://traceai.joostvanleeuwaarden.com/mcp |

## Cloudflare tunnel

Hostname `traceai.joostvanleeuwaarden.com` is served by systemd unit
`cloudflared-traceai` (config: `~/.config/traceai/cloudflared.yml`).

`path` values are **Go regular expressions**, not shell globs. Use anchored
prefixes only:

- `^/events(/|$)`, `^/v1(/|$)`, `^/mcp(/|$)`, `^/health$` → TraceAI API on `127.0.0.1:3847`
- everything else → TraceAI web on `127.0.0.1:3011`

Do **not** write `/v1*` or `/events*`: in regex `1*` means “zero or more ones”,
so `/v1*` matches any path containing `/v` (for example `/projects/vantage`)
and incorrectly routes it to the API.

Write/refresh the config, then install the unit:

```bash
~/TraceAI/deploy/write-cloudflared-config.sh
~/TraceAI/deploy/install-cloudflared-traceai.sh
sudo systemctl restart cloudflared-traceai
```

Keep `NEXT_PUBLIC_TRACEAI_EVENTS_URL=https://traceai.joostvanleeuwaarden.com/events`
and CORS for that origin in `~/.config/traceai/traceai.env`, then redeploy so the
web image is rebuilt with the public events URL.

Auth SQLite lives in the Docker volume `traceai-data`. Bootstrap a token once:

```bash
docker compose -p traceai exec api node apps/api/dist/cli/bootstrap.js --email you@example.com --name "You"
```

(If the CLI entry is not in the image, run bootstrap from a laptop against the Pi API
after exposing it, or copy a bootstrap script into the container.)

## Update

```bash
~/deploy-traceai.sh
```
