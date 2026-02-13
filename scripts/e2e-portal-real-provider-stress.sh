#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

log() {
  printf '[phase21-stress] %s\n' "$*"
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

ITERATIONS="${STRESS_ITERATIONS:-5}"
RUN_TIMEOUT_SEC="${STRESS_RUN_TIMEOUT_SEC:-90}"
PROVIDER="${STRESS_PROVIDER:-codex-cli}"
MODEL="${STRESS_MODEL:-gpt-5.1-codex}"
REQUIRE_HUMAN_LOOP="${STRESS_REQUIRE_HUMAN_LOOP:-0}"
SUCCESS_RATE_THRESHOLD="${STRESS_SUCCESS_RATE_THRESHOLD:-0.8}"
STRICT_MODE="${STRESS_STRICT:-0}"
REPORT_DIR="${STRESS_REPORT_DIR:-observability/reports}"

mkdir -p "$REPORT_DIR"
report_path="${REPORT_DIR}/phase21-provider-stress-$(date +%Y%m%d-%H%M%S).json"
results_tmp="$(mktemp)"

cleanup() {
  rm -f "$results_tmp"
}
trap cleanup EXIT

log "starting compose services in real provider mode: ${COMPOSE_SERVICES[*]}"
CONTROL_PLANE_PROVIDER_MODE=real docker compose up -d --build "${COMPOSE_SERVICES[@]}"

wait_for_postgres
apply_db_migrations

wait_for_health "gateway" "http://127.0.0.1:3001/health"
wait_for_health "control-plane-via-gateway" "http://127.0.0.1:3001/api/reconcile/metrics"
wait_for_health "portal" "http://127.0.0.1/"

log "stress config: iterations=${ITERATIONS}, provider=${PROVIDER}, model=${MODEL}, timeout=${RUN_TIMEOUT_SEC}s, strict=${STRICT_MODE}"

for ((i = 1; i <= ITERATIONS; i += 1)); do
  run_id="run-phase21-$(date +%s)-${i}"
  prompt="phase21-provider-stress-${i}-$(date +%s)"
  err_file="$(mktemp)"
  curl_exit=0
  sse_payload=""

  log "run ${i}/${ITERATIONS}: runId=${run_id}"
  if ! sse_payload=$(curl -sS -N \
    --max-time "$RUN_TIMEOUT_SEC" \
    -X POST \
    -H 'accept: text/event-stream' \
    -H 'content-type: application/json' \
    -d "$(cat <<JSON
{"runId":"${run_id}","provider":"${PROVIDER}","model":"${MODEL}","messages":[{"role":"user","content":"${prompt}"}],"requireHumanLoop":$( [[ "$REQUIRE_HUMAN_LOOP" == "1" ]] && echo "true" || echo "false" )}
JSON
)" \
    "http://127.0.0.1:3001/api/runs/start" 2>"$err_file"); then
    curl_exit=$?
  fi

  parse_result=$(printf '%s' "$sse_payload" | CURL_EXIT="$curl_exit" RUN_ID="$run_id" node -e '
    const fs = require("node:fs");
    const input = fs.readFileSync(0, "utf8");
    const curlExit = Number(process.env.CURL_EXIT || "0");
    const expectedRunId = process.env.RUN_ID || "";

    function parseEvents(raw) {
      return raw
        .replace(/\r\n/g, "\n")
        .split(/\n\n+/)
        .map((block) => block.trim())
        .filter(Boolean)
        .map((block) => {
          const lines = block.split("\n");
          let event = "message";
          const dataLines = [];
          for (const line of lines) {
            if (line.startsWith("event:")) {
              event = line.slice(6).trim();
              continue;
            }
            if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trimStart());
            }
          }
          const dataText = dataLines.join("\n");
          let data = dataText;
          try {
            data = JSON.parse(dataText);
          } catch {
            data = dataText;
          }
          return { event, data };
        });
    }

    const events = parseEvents(input);
    let runId = expectedRunId;
    let outcome = "unknown";
    let detail = "";
    let sawStarted = false;
    let sawClosed = false;

    for (const item of events) {
      const data = item.data && typeof item.data === "object" ? item.data : {};
      const dataRunId = typeof data.runId === "string" ? data.runId : "";
      if (dataRunId) {
        runId = dataRunId;
      }
      if (item.event === "run.closed") {
        sawClosed = true;
      }
      if (item.event === "run.status") {
        const status = typeof data.status === "string" ? data.status : "";
        const statusDetail = typeof data.detail === "string" ? data.detail : "";
        if (status === "started") {
          sawStarted = true;
        }
        if (status === "blocked") {
          outcome = "blocked";
          detail = statusDetail || "blocked";
        } else if (status === "failed") {
          outcome = "failed";
          detail = statusDetail || "failed";
        } else if (status === "finished") {
          const lowered = statusDetail.toLowerCase();
          if (lowered === "succeeded") {
            outcome = "succeeded";
            detail = "succeeded";
          } else if (lowered === "canceled") {
            outcome = "canceled";
            detail = "canceled";
          } else {
            outcome = "failed";
            detail = statusDetail || "finished-without-succeeded";
          }
        }
      }
    }

    if (curlExit !== 0 && events.length === 0) {
      outcome = "transport_error";
      detail = `curl_exit_${curlExit}`;
    } else if (outcome === "unknown") {
      if (sawStarted && sawClosed) {
        outcome = "incomplete";
        detail = "run.closed without terminal run.status";
      } else if (events.length === 0) {
        outcome = "empty_stream";
        detail = "empty_sse";
      } else {
        outcome = "incomplete";
        detail = "missing_terminal_status";
      }
    }

    const messageDeltaCount = events.filter((item) => item.event === "message.delta").length;
    const todoCount = events.filter((item) => item.event === "todo.update").length;
    const runStatusCount = events.filter((item) => item.event === "run.status").length;

    process.stdout.write(
      JSON.stringify({
        runId,
        outcome,
        detail,
        curlExit,
        eventCount: events.length,
        runStatusCount,
        messageDeltaCount,
        todoCount,
        sawStarted,
        sawClosed,
      }),
    );
  ')

  curl_err_text="$(cat "$err_file" || true)"
  rm -f "$err_file"

  if [[ -n "$curl_err_text" ]]; then
    parse_result=$(printf '%s' "$parse_result" | CURL_ERR="$curl_err_text" node -e '
      const fs = require("node:fs");
      const base = JSON.parse(fs.readFileSync(0, "utf8"));
      const err = String(process.env.CURL_ERR || "").trim();
      base.curlError = err ? err.slice(0, 300) : "";
      process.stdout.write(JSON.stringify(base));
    ')
  fi

  echo "$parse_result" >> "$results_tmp"
  log "run result: $parse_result"
done

summary_json=$(RESULTS_FILE="$results_tmp" REPORT_PATH="$report_path" ITERATIONS="$ITERATIONS" PROVIDER="$PROVIDER" MODEL="$MODEL" REQUIRE_HUMAN_LOOP="$REQUIRE_HUMAN_LOOP" RUN_TIMEOUT_SEC="$RUN_TIMEOUT_SEC" node -e '
  const fs = require("node:fs");
  const resultsFile = process.env.RESULTS_FILE;
  const reportPath = process.env.REPORT_PATH;
  const rows = fs
    .readFileSync(resultsFile, "utf8")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const total = rows.length;
  const count = (name) => rows.filter((item) => item.outcome === name).length;
  const succeeded = count("succeeded");
  const failed = count("failed");
  const blocked = count("blocked");
  const canceled = count("canceled");
  const transportError = count("transport_error");
  const incomplete = count("incomplete") + count("empty_stream") + count("unknown");
  const successRate = total > 0 ? succeeded / total : 0;

  const report = {
    generatedAt: new Date().toISOString(),
    config: {
      iterations: Number(process.env.ITERATIONS || "0"),
      provider: process.env.PROVIDER,
      model: process.env.MODEL,
      requireHumanLoop: process.env.REQUIRE_HUMAN_LOOP === "1",
      runTimeoutSec: Number(process.env.RUN_TIMEOUT_SEC || "0"),
      mode: "real-provider",
    },
    summary: {
      total,
      succeeded,
      failed,
      blocked,
      canceled,
      transportError,
      incomplete,
      successRate,
    },
    runs: rows,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report.summary));
')

log "stress summary: ${summary_json}"
log "stress report written: ${report_path}"

pass_check=$(printf '%s' "$summary_json" | THRESHOLD="$SUCCESS_RATE_THRESHOLD" node -e '
  const fs = require("node:fs");
  const summary = JSON.parse(fs.readFileSync(0, "utf8"));
  const threshold = Number(process.env.THRESHOLD || "0");
  if (!Number.isFinite(threshold) || threshold <= 0) {
    process.stdout.write("true");
    process.exit(0);
  }
  process.stdout.write(summary.successRate >= threshold ? "true" : "false");
')

if [[ "$STRICT_MODE" == "1" && "$pass_check" != "true" ]]; then
  log "strict mode failed: successRate below threshold (${SUCCESS_RATE_THRESHOLD})"
  exit 1
fi

log "phase21 real-provider stress baseline completed"
