#!/usr/bin/env bash
# Pull the requested branch and rebuild the stack. Run this on the host
# (or over LAN SSH) after the first bootstrap (deploy-traceai.sh).
# GitHub-hosted Actions cannot reach LAN-only hosts such as the test laptop.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH="${TRACEAI_BRANCH:-main}"
ENV_FILE="${TRACEAI_ENV_FILE:-$HOME/.config/traceai/traceai.env}"
LAN_HOST="${TRACEAI_LAN_HOST:-192.168.1.91}"

cd "$ROOT"

if [[ ! -d "$ROOT/.git" ]]; then
  echo "Missing git checkout at $ROOT" >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — run deploy/deploy-traceai.sh once and fill secrets." >&2
  exit 1
fi

echo "==> git fetch/pull $BRANCH"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
# Drop local noise on deploy scripts (e.g. chmod) so pull can fast-forward.
git restore --worktree --staged -- deploy/remote-update.sh deploy/deploy-traceai.sh 2>/dev/null \
  || git checkout -- deploy/remote-update.sh deploy/deploy-traceai.sh
git pull --ff-only origin "$BRANCH"
chmod +x deploy/remote-update.sh deploy/deploy-traceai.sh

install -m 600 "$ENV_FILE" "$ROOT/deploy/.env"

echo "==> docker compose up"
docker compose --project-name traceai \
  --project-directory "$ROOT/deploy" \
  --env-file "$ENV_FILE" \
  up -d --build --remove-orphans

echo "==> health"
for attempt in {1..30}; do
  if curl --fail --silent http://127.0.0.1:3847/health >/dev/null; then
    break
  fi
  if [[ "$attempt" == 30 ]]; then
    docker compose --project-name traceai --project-directory "$ROOT/deploy" ps
    echo "API did not become healthy" >&2
    exit 1
  fi
  sleep 2
done

docker compose --project-name traceai --project-directory "$ROOT/deploy" ps
echo "Deploy finished."
echo "UI:  http://${LAN_HOST}:3011"
echo "API: http://${LAN_HOST}:3847/health"
