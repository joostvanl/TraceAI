#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${TRACEAI_REPO_URL:-https://github.com/joostvanl/TraceAI.git}"
APP_DIR="${TRACEAI_APP_DIR:-$HOME/TraceAI}"
ENV_FILE="${TRACEAI_ENV_FILE:-$HOME/.config/traceai/traceai.env}"
BRANCH="${TRACEAI_BRANCH:-main}"
LAN_HOST="${TRACEAI_LAN_HOST:-192.168.1.91}"
# Empty TRACEAI_PUBLIC_ORIGIN = LAN-only (test laptop). Unset = prod public hostname.
if [[ "${TRACEAI_PUBLIC_ORIGIN+x}" == "x" && -z "${TRACEAI_PUBLIC_ORIGIN}" ]]; then
  PUBLIC_ORIGIN=""
else
  PUBLIC_ORIGIN="${TRACEAI_PUBLIC_ORIGIN:-https://traceai.joostvanleeuwaarden.com}"
fi
LAN_UI="http://${LAN_HOST}:3011"
LAN_API="http://${LAN_HOST}:3847"
if [[ -n "$PUBLIC_ORIGIN" ]]; then
  CORS_DEFAULT="${PUBLIC_ORIGIN},${LAN_UI}"
  EVENTS_DEFAULT="${PUBLIC_ORIGIN}/events"
else
  CORS_DEFAULT="${LAN_UI}"
  EVENTS_DEFAULT="${LAN_API}/events"
fi

log() {
  printf '[TraceAI deploy] %s\n' "$*"
}

fail() {
  printf '[TraceAI deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

command -v git >/dev/null || fail "git is not installed"
command -v docker >/dev/null || fail "Docker is not installed"
docker compose version >/dev/null || fail "Docker Compose is not available"

if [[ ! -f "$ENV_FILE" ]]; then
  mkdir -p "$(dirname "$ENV_FILE")"
  cat >"$ENV_FILE" <<EOF
AURORA_API_URL=https://aurora-api.joostvanleeuwaarden.com
AURORA_USER_TOKEN=
AURORA_WEBSITE_ID=cmsiyy8oy00quoc01zzam3t6p
AURORA_LOCALE=en-US
TRACEAI_LAN_HOST=${LAN_HOST}
TRACEAI_CORS_ORIGINS=${CORS_DEFAULT}
NEXT_PUBLIC_CMS_API_URL=https://aurora-api.joostvanleeuwaarden.com
CMS_SITE_KEY=
NEXT_PUBLIC_TRACEAI_EVENTS_URL=${EVENTS_DEFAULT}
TRACEAI_API_URL=http://api:3847
TRACEAI_TOKEN=
TRACEAI_SESSION_SECRET=
TRACEAI_HUMAN_PROXY_SECRET=
EOF
  chmod 600 "$ENV_FILE"
  fail "Created $ENV_FILE. Fill AURORA_USER_TOKEN, CMS_SITE_KEY, TRACEAI_TOKEN, and TRACEAI_SESSION_SECRET, then run this script again."
fi

grep -Eq '^AURORA_USER_TOKEN=.+$' "$ENV_FILE" ||
  fail "AURORA_USER_TOKEN is missing in $ENV_FILE"
# TRA-81 renamed the site key. Catch the old name explicitly: keeping it would
# leave the web container without a key and take the public read path down.
if grep -Eq '^NEXT_PUBLIC_CMS_SITE_KEY=.+$' "$ENV_FILE" &&
  ! grep -Eq '^CMS_SITE_KEY=.+$' "$ENV_FILE"; then
  fail "Rename NEXT_PUBLIC_CMS_SITE_KEY to CMS_SITE_KEY in $ENV_FILE (TRA-81: the key is server-only and is now read at runtime)"
fi
grep -Eq '^CMS_SITE_KEY=.+$' "$ENV_FILE" ||
  fail "CMS_SITE_KEY is missing in $ENV_FILE"
grep -Eq '^TRACEAI_TOKEN=trc_.+$' "$ENV_FILE" ||
  fail "TRACEAI_TOKEN (trc_…) is missing in $ENV_FILE — needed for the New ticket form"
grep -Eq '^TRACEAI_SESSION_SECRET=.+$' "$ENV_FILE" ||
  fail "TRACEAI_SESSION_SECRET is missing in $ENV_FILE — needed for the UI session cookie"

# Ensure older env files still get the write-proxy defaults when absent.
grep -q '^TRACEAI_API_URL=' "$ENV_FILE" ||
  printf '\nTRACEAI_API_URL=http://api:3847\n' >>"$ENV_FILE"

if [[ -d "$APP_DIR/.git" ]]; then
  log "Updating $APP_DIR from $BRANCH"
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
elif [[ -e "$APP_DIR" ]] && [[ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]]; then
  fail "$APP_DIR exists but is not a git checkout. Move/remove it once, then retry."
else
  log "Cloning $REPO_URL"
  rm -rf "$APP_DIR"
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$APP_DIR"
fi

install -m 600 "$ENV_FILE" "$APP_DIR/deploy/.env"

log "Building and starting containers"
docker compose --project-name traceai \
  --project-directory "$APP_DIR/deploy" \
  --env-file "$ENV_FILE" \
  up -d --build

log "Waiting for API health"
for attempt in {1..30}; do
  if curl --fail --silent http://127.0.0.1:3847/health >/dev/null; then
    break
  fi
  if [[ "$attempt" == 30 ]]; then
    docker compose --project-name traceai --project-directory "$APP_DIR/deploy" ps
    fail "API did not become healthy"
  fi
  sleep 2
done

log "Waiting for web UI"
for attempt in {1..30}; do
  if curl --fail --silent http://127.0.0.1:3011/ >/dev/null; then
    break
  fi
  if [[ "$attempt" == 30 ]]; then
    docker compose --project-name traceai --project-directory "$APP_DIR/deploy" ps
    fail "Web UI did not become healthy"
  fi
  sleep 2
done

docker compose --project-name traceai --project-directory "$APP_DIR/deploy" ps
log "Deployment complete"
log "UI:  ${LAN_UI}"
log "API: ${LAN_API}/health"
