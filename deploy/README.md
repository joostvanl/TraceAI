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
`AURORA_USER_TOKEN` and `NEXT_PUBLIC_CMS_SITE_KEY`, then run the same command
again. Secrets remain outside the git checkout.

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
~/deploy-traceai.sh
```
