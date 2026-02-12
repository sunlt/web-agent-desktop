#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

log() {
  printf '[phase18-e2e] %s\n' "$*"
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

assert_json() {
  local description="$1"
  local script="$2"
  local payload="$3"

  printf '%s' "$payload" | node -e "const fs=require('node:fs');const input=fs.readFileSync(0,'utf8');const data=JSON.parse(input);${script}" || {
    log "assertion failed: $description"
    log "payload: $payload"
    return 1
  }
  log "assertion passed: $description"
}

COMPOSE_SERVICES=(
  pgsql
  rustfs
  executor
  control-plane
  executor-manager
  gateway
)

log "starting compose services: ${COMPOSE_SERVICES[*]}"
docker compose up -d --build "${COMPOSE_SERVICES[@]}"

wait_for_health "executor" "http://127.0.0.1:8090/health"
wait_for_health "executor-manager" "http://127.0.0.1:3010/health"
wait_for_health "gateway" "http://127.0.0.1:3001/health"
wait_for_health "control-plane-via-gateway" "http://127.0.0.1:3001/api/reconcile/metrics"

log "probe gateway alertmanager webhook"
webhook_probe_resp=$(curl -fsS \
  -X POST \
  -H 'content-type: application/json' \
  -d '{"receiver":"phase18-smoke","status":"firing","alerts":[]}' \
  "http://127.0.0.1:3001/alertmanager/webhook")
assert_json "gateway alertmanager webhook accepted" "if(data.ok !== true){process.exit(1)}" "$webhook_probe_resp"

session_id="sess-phase18-$(date +%s)"
run_id="run-phase18-$(date +%s)"

activate_payload=$(cat <<JSON
{"appId":"app-phase18","projectName":"default","userLoginName":"alice"}
JSON
)

log "activating session via gateway: $session_id"
activate_resp=$(curl -fsS \
  -X POST \
  -H 'content-type: application/json' \
  -d "$activate_payload" \
  "http://127.0.0.1:3001/api/session-workers/${session_id}/activate")

assert_json "session activated" \
  "if(!['created_and_started','started','already_running'].includes(data.action)){process.exit(1)}" \
  "$activate_resp"

sleep 0.1

log "cleanup idle via gateway"
cleanup_idle_resp=$(curl -fsS \
  -X POST \
  -H 'content-type: application/json' \
  -d '{"idleTimeoutMs":1,"limit":20}' \
  "http://127.0.0.1:3001/api/session-workers/cleanup/idle")

assert_json "idle cleanup touched one worker" \
  "if(!(data.total>=1 && data.succeeded>=1)){process.exit(1)}" \
  "$cleanup_idle_resp"

log "bind run via gateway"
bind_resp=$(curl -fsS \
  -X POST \
  -H 'content-type: application/json' \
  -d "{\"sessionId\":\"${session_id}\"}" \
  "http://127.0.0.1:3001/api/runs/${run_id}/bind")

assert_json "run bind success" "if(data.ok !== true){process.exit(1)}" "$bind_resp"

event_id="evt-phase18-$(date +%s)"
log "callback message.stop via gateway"
callback_resp=$(curl -fsS \
  -X POST \
  -H 'content-type: application/json' \
  -d "{\"eventId\":\"${event_id}\",\"type\":\"message.stop\"}" \
  "http://127.0.0.1:3001/api/runs/${run_id}/callbacks")

assert_json "message.stop callback synced" "if(data.action !== 'message_stop_synced'){process.exit(1)}" "$callback_resp"

log "cleanup stopped via gateway"
cleanup_stopped_resp=$(curl -fsS \
  -X POST \
  -H 'content-type: application/json' \
  -d '{"removeAfterMs":1,"limit":20}' \
  "http://127.0.0.1:3001/api/session-workers/cleanup/stopped")

assert_json "stopped cleanup succeeded" \
  "if(!(data.total>=1 && data.succeeded>=1)){process.exit(1)}" \
  "$cleanup_stopped_resp"

log "query worker via gateway"
worker_resp=$(curl -fsS "http://127.0.0.1:3001/api/session-workers/${session_id}")
assert_json "worker marked deleted" "if(data.state !== 'deleted'){process.exit(1)}" "$worker_resp"

log "phase18 gateway + executor-manager real-env e2e passed"
