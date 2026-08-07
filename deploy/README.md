# TraceAI on Raspberry Pi (Docker)

Deploy the TraceAI API + read-only web UI on a Pi (aarch64) using the same Aurora
website/project as local development.

## Prerequisites

- Docker + Compose on the Pi
- Clone of this repo (or `rsync` of sources)
- Aurora user token + public site key (same as local)

## Setup

```bash
cd ~/TraceAI/deploy
cp .env.example .env
# edit .env — set AURORA_USER_TOKEN and NEXT_PUBLIC_CMS_SITE_KEY

docker compose up -d --build
```

## URLs

| Service | URL |
|---|---|
| Web UI | http://192.168.1.91:3010 |
| API health | http://192.168.1.91:3847/health |
| SSE events | http://192.168.1.91:3847/events?project=traceai |

Auth SQLite lives in the Docker volume `traceai-data`. Bootstrap a token once:

```bash
docker compose exec api node apps/api/dist/cli/bootstrap.js --email you@example.com --name "You"
```

(If the CLI entry is not in the image, run bootstrap from a laptop against the Pi API
after exposing it, or copy a bootstrap script into the container.)

## Update

```bash
cd ~/TraceAI
git pull
cd deploy
docker compose up -d --build
```
