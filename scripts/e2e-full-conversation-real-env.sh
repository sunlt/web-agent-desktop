#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

log() {
  printf '[phase19-e2e] %s\n' "$*"
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

assert_sse() {
  local description="$1"
  local script="$2"
  local payload="$3"

  printf '%s' "$payload" | node -e '
    const fs = require("node:fs");
    const input = fs.readFileSync(0, "utf8");
    const blocks = input
      .split(/\n\n+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const events = [];
    for (const block of blocks) {
      const lines = block.split(/\n/);
      let event = "message";
      let dataText = "";
      for (const line of lines) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          dataText += line.slice(5).trim();
        }
      }
      if (!dataText) {
        continue;
      }
      let data;
      try {
        data = JSON.parse(dataText);
      } catch {
        continue;
      }
      events.push({ event, data });
    }
    globalThis.events = events;
  '"$script" || {
    log "assertion failed: $description"
    log "sse payload: $payload"
    return 1
  }
  log "assertion passed: $description"
}

db_count() {
  local sql="$1"
  docker exec pgsql psql -U app -d app -t -A -c "$sql" | tr -d '[:space:]'
}

post_json_with_retry() {
  local url="$1"
  local body="$2"
  local retries="${3:-4}"
  local sleep_sec="${4:-3}"
  local response
  local status
  local payload

  for ((i = 1; i <= retries; i += 1)); do
    response=$(curl -sS \
      -X POST \
      -H 'content-type: application/json' \
      -d "$body" \
      -w $'\n%{http_code}' \
      "$url")
    status="${response##*$'\n'}"
    payload="${response%$'\n'*}"

    if [[ "$status" =~ ^2 ]]; then
      printf '%s' "$payload"
      return 0
    fi

    if [[ "$i" -lt "$retries" ]]; then
      log "retry request: status=${status} url=${url} attempt=${i}/${retries}"
      sleep "$sleep_sec"
      continue
    fi

    log "request failed after retries: status=${status} url=${url}"
    log "payload: $payload"
    return 1
  done
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
)

log "starting compose services in scripted provider mode: ${COMPOSE_SERVICES[*]}"
CONTROL_PLANE_PROVIDER_MODE=scripted docker compose up -d --build "${COMPOSE_SERVICES[@]}"

wait_for_postgres
apply_db_migrations

wait_for_health "executor" "http://127.0.0.1:8090/health"
wait_for_health "executor-manager" "http://127.0.0.1:3010/health"
wait_for_health "gateway" "http://127.0.0.1:3001/health"
wait_for_health "control-plane-via-gateway" "http://127.0.0.1:3001/api/reconcile/metrics"

timestamp="$(date +%s)"
session_id="sess-phase19-${timestamp}"
run_id="run-phase19-${timestamp}"
question_id="question-phase19-${timestamp}"

log "activate session via gateway: $session_id"
activate_resp=$(curl -fsS \
  -X POST \
  -H 'content-type: application/json' \
  -d '{"appId":"app-phase19","projectName":"default","userLoginName":"alice"}' \
  "http://127.0.0.1:3001/api/session-workers/${session_id}/activate")
assert_json "session activated" \
  "if(!['created_and_started','started','already_running'].includes(data.action)){process.exit(1)}" \
  "$activate_resp"

log "create chat history session"
chat_create_resp=$(curl -fsS \
  -X POST \
  -H 'content-type: application/json' \
  -d '{"title":"phase19 real env chat","provider":"codex-cli","model":"gpt-5.1-codex"}' \
  "http://127.0.0.1:3001/api/chat-opencode-history")
assert_json "chat created" "if(!data.chat?.chatId){process.exit(1)}" "$chat_create_resp"
chat_id=$(printf '%s' "$chat_create_resp" | node -e "const fs=require('node:fs');const data=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(data.chat.chatId)")

log "start run with SSE (scripted provider)"
run_stream=$(curl -fsS -N \
  -X POST \
  -H 'accept: text/event-stream' \
  -H 'content-type: application/json' \
  -d "$(cat <<JSON
{"runId":"${run_id}","provider":"codex-cli","model":"gpt-5.1-codex","messages":[{"role":"user","content":"请输出一段简短问候"}],"requireHumanLoop":false}
JSON
)" \
  "http://127.0.0.1:3001/api/runs/start")

assert_sse "run stream contains started/message/todo/finished/closed" '
  if (!events.some((item) => item.event === "run.status" && item.data?.status === "started")) {
    process.exit(1);
  }
  if (!events.some((item) => item.event === "message.delta" && typeof item.data?.text === "string" && item.data.text.length > 0)) {
    process.exit(1);
  }
  if (!events.some((item) => item.event === "todo.update" && item.data?.todo?.todoId)) {
    process.exit(1);
  }
  if (!events.some((item) => item.event === "run.status" && item.data?.status === "finished" && item.data?.detail === "succeeded")) {
    process.exit(1);
  }
  if (!events.some((item) => item.event === "run.closed")) {
    process.exit(1);
  }
' "$run_stream"

log "bind run to session for callback sync"
bind_resp=$(curl -fsS \
  -X POST \
  -H 'content-type: application/json' \
  -d "{\"sessionId\":\"${session_id}\"}" \
  "http://127.0.0.1:3001/api/runs/${run_id}/bind")
assert_json "run bind success" "if(data.ok !== true){process.exit(1)}" "$bind_resp"

log "write chat snapshot"
chat_update_resp=$(curl -fsS \
  -X PUT \
  -H 'content-type: application/json' \
  -d "$(cat <<JSON
{"title":"phase19 real env chat","provider":"codex-cli","model":"gpt-5.1-codex","messages":[{"role":"user","content":"请输出一段简短问候"},{"role":"assistant","content":"[scripted:codex-cli] 请输出一段简短问候"}]}
JSON
)" \
  "http://127.0.0.1:3001/api/chat-opencode-history/${chat_id}")
assert_json "chat updated" "if(data.ok !== true){process.exit(1)}" "$chat_update_resp"

todo_event_ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

log "post todo.update callback"
todo_callback_resp=$(curl -fsS \
  -X POST \
  -H 'content-type: application/json' \
  -d "$(cat <<JSON
{"eventId":"evt-phase19-todo-${timestamp}","type":"todo.update","todo":{"todoId":"todo-callback-1","content":"回调补录 todo","status":"done","order":1,"updatedAt":"${todo_event_ts}"}}
JSON
)" \
  "http://127.0.0.1:3001/api/runs/${run_id}/callbacks")
assert_json "todo callback accepted" "if(data.action !== 'todo_upserted'){process.exit(1)}" "$todo_callback_resp"

log "post human-loop requested + resolved callbacks"
human_requested_resp=$(curl -fsS \
  -X POST \
  -H 'content-type: application/json' \
  -d "$(cat <<JSON
{"eventId":"evt-phase19-human-requested-${timestamp}","type":"human_loop.requested","questionId":"${question_id}","prompt":"请确认是否继续"}
JSON
)" \
  "http://127.0.0.1:3001/api/runs/${run_id}/callbacks")
assert_json "human-loop requested accepted" "if(data.action !== 'human_loop_requested'){process.exit(1)}" "$human_requested_resp"

human_resolved_resp=$(curl -fsS \
  -X POST \
  -H 'content-type: application/json' \
  -d "$(cat <<JSON
{"eventId":"evt-phase19-human-resolved-${timestamp}","type":"human_loop.resolved","questionId":"${question_id}"}
JSON
)" \
  "http://127.0.0.1:3001/api/runs/${run_id}/callbacks")
assert_json "human-loop resolved accepted" "if(data.action !== 'human_loop_resolved'){process.exit(1)}" "$human_resolved_resp"

log "post message.stop callback to trigger workspace sync"
message_stop_resp=$(curl -fsS \
  -X POST \
  -H 'content-type: application/json' \
  -d "{\"eventId\":\"evt-phase19-stop-${timestamp}\",\"type\":\"message.stop\"}" \
  "http://127.0.0.1:3001/api/runs/${run_id}/callbacks")
assert_json "message.stop callback synced" "if(data.action !== 'message_stop_synced'){process.exit(1)}" "$message_stop_resp"

run_finish_ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
log "post run.finished callback for usage finalization"
run_finished_resp=$(curl -fsS \
  -X POST \
  -H 'content-type: application/json' \
  -d "$(cat <<JSON
{"eventId":"evt-phase19-finished-${timestamp}","type":"run.finished","status":"succeeded","occurredAt":"${run_finish_ts}","usage":{"inputTokens":12,"outputTokens":34}}
JSON
)" \
  "http://127.0.0.1:3001/api/runs/${run_id}/callbacks")
assert_json "run.finished callback accepted" "if(data.action !== 'run_finished'){process.exit(1)}" "$run_finished_resp"

log "query todo + human-loop view apis"
todo_list_resp=$(curl -fsS "http://127.0.0.1:3001/api/runs/${run_id}/todos?limit=50")
assert_json "todo list contains callback item" "if(!(data.total>=1 && data.items.some((item)=>item.todoId==='todo-callback-1'))){process.exit(1)}" "$todo_list_resp"

todo_events_resp=$(curl -fsS "http://127.0.0.1:3001/api/runs/${run_id}/todos/events?limit=50")
assert_json "todo events list contains callback event" "if(!(data.total>=1 && data.events.some((item)=>item.todoId==='todo-callback-1'))){process.exit(1)}" "$todo_events_resp"

human_resolved_list_resp=$(curl -fsS "http://127.0.0.1:3001/api/human-loop/requests?runId=${run_id}&status=resolved&limit=50")
assert_json "resolved human-loop list contains question" "if(!(data.total>=1 && data.requests.some((item)=>item.questionId==='${question_id}'))){process.exit(1)}" "$human_resolved_list_resp"

log "assert database records from real infra"
agent_runs_count="$(db_count "SELECT COUNT(*) FROM agent_runs WHERE run_id = '${run_id}'")"
run_events_count="$(db_count "SELECT COUNT(*) FROM run_events WHERE run_id = '${run_id}'")"
human_loop_count="$(db_count "SELECT COUNT(*) FROM human_loop_requests WHERE run_id = '${run_id}'")"
usage_count="$(db_count "SELECT COUNT(*) FROM usage_logs WHERE run_id = '${run_id}'")"

if [[ "${agent_runs_count}" -lt 1 ]]; then
  log "assertion failed: agent_runs row missing for run ${run_id}"
  exit 1
fi
if [[ "${run_events_count}" -lt 4 ]]; then
  log "assertion failed: run_events count too small for run ${run_id}"
  exit 1
fi
if [[ "${human_loop_count}" -lt 1 ]]; then
  log "assertion failed: human_loop_requests row missing for run ${run_id}"
  exit 1
fi
if [[ "${usage_count}" -lt 1 ]]; then
  log "assertion failed: usage_logs row missing for run ${run_id}"
  exit 1
fi
log "assertion passed: database records exist for run ${run_id}"

log "cleanup session worker through gateway"
cleanup_idle_resp=$(post_json_with_retry \
  "http://127.0.0.1:3001/api/session-workers/cleanup/idle" \
  '{"idleTimeoutMs":1,"limit":20}')
assert_json "idle cleanup succeeded" "if(!(data.total>=1 && data.succeeded>=1)){process.exit(1)}" "$cleanup_idle_resp"

cleanup_stopped_resp=$(post_json_with_retry \
  "http://127.0.0.1:3001/api/session-workers/cleanup/stopped" \
  '{"removeAfterMs":1,"limit":20}')
assert_json "stopped cleanup succeeded" "if(!(data.total>=1 && data.succeeded>=1)){process.exit(1)}" "$cleanup_stopped_resp"

worker_resp=$(curl -fsS "http://127.0.0.1:3001/api/session-workers/${session_id}")
assert_json "worker marked deleted" "if(data.state !== 'deleted'){process.exit(1)}" "$worker_resp"

log "phase19 full conversation real-env e2e passed"
