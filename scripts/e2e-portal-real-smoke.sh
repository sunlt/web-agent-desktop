#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

log() {
  printf '[phase20-e2e] %s\n' "$*"
}

wait_for_health() {
  local name="$1"
  local url="$2"
  local retries="${3:-90}"
  local sleep_sec="${4:-2}"

  for ((i = 1; i <= retries; i += 1)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log "$name is healthy: $url"
      return 0
    fi
    sleep "$sleep_sec"
  done

  log "$name health check failed: $url"
  return 1
}

wait_for_postgres() {
  local retries="${1:-60}"
  local sleep_sec="${2:-2}"

  for ((i = 1; i <= retries; i += 1)); do
    if docker exec pgsql pg_isready -U app -d app >/dev/null 2>&1; then
      log "postgres is ready"
      return 0
    fi
    sleep "$sleep_sec"
  done

  log "postgres readiness check failed"
  return 1
}

apply_db_migrations() {
  log "apply database migrations (001/002/003)"
  docker exec pgsql psql -U app -d app -v ON_ERROR_STOP=1 \
    -f /docker-entrypoint-initdb.d/001_init.sql >/dev/null
  docker exec pgsql psql -U app -d app -v ON_ERROR_STOP=1 \
    -f /docker-entrypoint-initdb.d/002_rbac_and_file_acl.sql >/dev/null
  docker exec pgsql psql -U app -d app -v ON_ERROR_STOP=1 \
    -f /docker-entrypoint-initdb.d/003_chat_history.sql >/dev/null
}

COMPOSE_SERVICES=(
  pgsql
  rustfs
  executor
  control-plane
  executor-manager
  gateway
  portal
)

log "starting compose services in scripted provider mode: ${COMPOSE_SERVICES[*]}"
CONTROL_PLANE_PROVIDER_MODE=scripted docker compose up -d --build "${COMPOSE_SERVICES[@]}"

wait_for_postgres
apply_db_migrations

wait_for_health "gateway" "http://127.0.0.1:3001/health"
wait_for_health "control-plane-via-gateway" "http://127.0.0.1:3001/api/reconcile/metrics"
wait_for_health "portal" "http://127.0.0.1/"

log "run portal real-backend playwright smoke"
(
  cd portal
  PORTAL_E2E_REAL=1 \
  REAL_PORTAL_E2E=1 \
  PORTAL_E2E_BASE_URL=http://127.0.0.1 \
  npm run test:e2e -- e2e/tests/chat-workbench.real-smoke.spec.ts --project=chromium
)

log "phase20 portal real-backend smoke passed"
