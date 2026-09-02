#!/usr/bin/env bash
# Pull the requested branch and rebuild the stack. Run this on the host
# (or over LAN SSH) after the first bootstrap (deploy-traceai.sh).
# GitHub-hosted Actions cannot reach LAN-only hosts such as the test laptop.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${TRACEAI_ENV_FILE:-$HOME/.config/traceai/traceai.env}"

read_env_val() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r' || true
}

if [[ -z "${TRACEAI_LAN_HOST:-}" && -f "$ENV_FILE" ]]; then
  TRACEAI_LAN_HOST="$(read_env_val TRACEAI_LAN_HOST)"
fi
LAN_HOST="${TRACEAI_LAN_HOST:-192.168.1.91}"

if [[ -z "${TRACEAI_BRANCH:-}" && -f "$ENV_FILE" ]]; then
  TRACEAI_BRANCH="$(read_env_val TRACEAI_BRANCH)"
fi
if [[ -z "${TRACEAI_BRANCH:-}" && "$LAN_HOST" == "192.168.1.185" ]]; then
  TRACEAI_BRANCH=test
fi
BRANCH="${TRACEAI_BRANCH:-main}"

cd "$ROOT"

if [[ ! -d "$ROOT/.git" ]]; then
  echo "Missing git checkout at $ROOT" >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — run deploy/deploy-traceai.sh once and fill secrets." >&2
  exit 1
fi

echo "==> git fetch/checkout $BRANCH"
# Drop local noise on deploy scripts (e.g. chmod) so checkout can proceed.
git restore --worktree --staged -- deploy/remote-update.sh deploy/deploy-traceai.sh deploy/git-use-branch.sh 2>/dev/null \
  || true
# Fetch by explicit refspec so a --single-branch main clone can switch to test.
if [[ -f deploy/git-use-branch.sh ]]; then
  chmod +x deploy/git-use-branch.sh
  ./deploy/git-use-branch.sh "$ROOT" "$BRANCH"
else
  git -c protocol.version=1 -c http.version=HTTP/1.1 config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"
  git -c protocol.version=1 -c http.version=HTTP/1.1 fetch --prune origin "refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}"
  git -c protocol.version=1 -c http.version=HTTP/1.1 checkout -B "$BRANCH" "origin/${BRANCH}"
  git -c protocol.version=1 -c http.version=HTTP/1.1 pull --ff-only origin "$BRANCH"
fi
chmod +x deploy/remote-update.sh deploy/deploy-traceai.sh
[[ -f deploy/git-use-branch.sh ]] && chmod +x deploy/git-use-branch.sh

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
