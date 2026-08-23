# TraceAI Docker deploy (Pi + LAN test host)

Two hosts, two Aurora tenants, same production Aurora API:

| Host | LAN | Git branch | Aurora website | How to deploy |
|---|---|---|---|---|
| Raspberry Pi (prod) | 192.168.1.91 | `main` | live (`cmsiyy8oy00quoc01zzam3t6p`) | `~/deploy-traceai.sh` or `deploy/remote-update.sh` on the Pi |
| Ubuntu laptop (test) | 192.168.1.185 | `test` (or any) | **TraceAI Test** (own website id + site key) | **manual** over LAN SSH — see below |

GitHub-hosted Actions cannot reach `192.168.1.185`. There is no auto-deploy to the test laptop.

The test checkout is often a `--single-branch` clone of `main`. `git checkout test` then fails with `pathspec 'test' did not match`. First switch once (creates `origin/test` and a local `test` branch), then use `remote-update.sh`. Set `TRACEAI_BRANCH=test` in `~/.config/traceai/traceai.env` so later runs do not fall back to `main`.

```bash
# first time only — from a --single-branch main clone
ssh joostvl@192.168.1.185 'cd ~/TraceAI && git config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*" && git fetch --prune origin refs/heads/test:refs/remotes/origin/test && git checkout -B test origin/test'

# every update (script defaults to test when LAN host is 192.168.1.185)
ssh joostvl@192.168.1.185 'TRACEAI_LAN_HOST=192.168.1.185 ~/TraceAI/deploy/remote-update.sh'
```

Both stacks talk to `https://aurora-api.joostvanleeuwaarden.com`. The test host must use the TraceAI Test tenant so tickets never land on the live board.

Set `TRACEAI_LAN_HOST` (and matching `TRACEAI_CORS_ORIGINS` / `NEXT_PUBLIC_TRACEAI_EVENTS_URL`) in `~/.config/traceai/traceai.env` on each host.

## Prerequisites

- Docker + Compose on the host
- Clone of this repo (or `rsync` of sources)
- Aurora user token + the **site key of that host’s tenant**

## Setup

Install the trigger script once as `~/deploy-traceai.sh`. It clones/updates this
repository over public HTTPS, builds both containers and runs health checks.

```bash
# Pi (defaults: branch main, LAN 192.168.1.91)
chmod +x ~/deploy-traceai.sh
~/deploy-traceai.sh

# Test laptop
TRACEAI_BRANCH=test TRACEAI_LAN_HOST=192.168.1.185 TRACEAI_PUBLIC_ORIGIN= \
  ~/deploy-traceai.sh
```

On its first run it creates `~/.config/traceai/traceai.env` and stops. Fill
`AURORA_USER_TOKEN` and `CMS_SITE_KEY` (plus `AURORA_WEBSITE_ID` for the test
tenant), then run the same command again. Secrets remain outside the git checkout.

Upgrading from before TRA-81: rename `NEXT_PUBLIC_CMS_SITE_KEY` to
`CMS_SITE_KEY` in that env file. The key is server-only and is now read at
runtime instead of being baked into the image, so the old name leaves the web
container without a key. The deploy script refuses to continue if it finds only
the old name.

## URLs

| Service | Prod | Test (LAN only) |
|---|---|---|
| Web UI | https://traceai.joostvanleeuwaarden.com | http://192.168.1.185:3011 |
| LAN Web UI | http://192.168.1.91:3011 | http://192.168.1.185:3011 |
| API health | https://traceai.joostvanleeuwaarden.com/health | http://192.168.1.185:3847/health |
| API SSE | https://traceai.joostvanleeuwaarden.com/events?project=traceai | http://192.168.1.185:3847/events |
| MCP | https://traceai.joostvanleeuwaarden.com/mcp | http://192.168.1.185:3847/mcp (optional; Cursor stays on prod) |

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

The board no longer opens that URL from the browser. It uses same-origin
`/api/events`, which proxies to `TRACEAI_API_URL/events` with the session.
Keep CORS for the UI origin in `~/.config/traceai/traceai.env` if anything
still calls the API stream directly.

Auth SQLite lives in the Docker volume `traceai-data`. Bootstrap a token once:

```bash
docker compose -p traceai exec api node apps/api/dist/cli/bootstrap.js --email you@example.com --name "You"
```

(If the CLI entry is not in the image, run bootstrap from a laptop against the Pi API
after exposing it, or copy a bootstrap script into the container.)

## Update

On the host (Pi or test laptop):

```bash
~/deploy-traceai.sh
# or, once the checkout exists:
TRACEAI_LAN_HOST=<this-host-ip> ~/TraceAI/deploy/remote-update.sh
```

From Windows on the LAN, test laptop only:

```powershell
ssh joostvl@192.168.1.185 "cd ~/TraceAI && git config remote.origin.fetch `"+refs/heads/*:refs/remotes/origin/*`" && git fetch --prune origin refs/heads/test:refs/remotes/origin/test && git checkout -B test origin/test"
ssh joostvl@192.168.1.185 "TRACEAI_LAN_HOST=192.168.1.185 ~/TraceAI/deploy/remote-update.sh"
```
