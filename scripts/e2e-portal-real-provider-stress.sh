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
RUN_TIMEOUT_SEC="${STRESS_RUN_TIMEOUT_SEC:-180}"
PRECHECK_TIMEOUT_SEC="${STRESS_PRECHECK_TIMEOUT_SEC:-90}"
PROVIDER="${STRESS_PROVIDER:-codex-app-server}"
MODEL="${STRESS_MODEL:-gpt-5.1-codex}"
REQUIRE_HUMAN_LOOP="${STRESS_REQUIRE_HUMAN_LOOP:-0}"
SUCCESS_RATE_THRESHOLD="${STRESS_SUCCESS_RATE_THRESHOLD:-0.8}"
STRICT_MODE="${STRESS_STRICT:-0}"
PRECHECK_ENABLED="${STRESS_PRECHECK_ENABLED:-1}"
AUTO_FALLBACK_SCRIPTED="${STRESS_AUTO_FALLBACK_SCRIPTED:-0}"
FALLBACK_RUN_TIMEOUT_SEC="${STRESS_FALLBACK_TIMEOUT_SEC:-45}"
PROVIDER_RUNTIME_CONTAINER="${STRESS_PROVIDER_RUNTIME_CONTAINER:-executor}"
ARCHIVE_ENABLED="${STRESS_ARCHIVE_ENABLED:-1}"
ARCHIVE_MAX_FAILURES="${STRESS_ARCHIVE_MAX_FAILURES:-3}"
ARCHIVE_LOG_SERVICES="${STRESS_ARCHIVE_LOG_SERVICES:-gateway control-plane executor-manager executor}"
ARCHIVE_LOG_TAIL="${STRESS_ARCHIVE_LOG_TAIL:-250}"
REPORT_DIR="${STRESS_REPORT_DIR:-observability/reports}"
SUMMARY_OUT="${STRESS_SUMMARY_OUT:-}"
SKIP_COMPOSE_UP="${STRESS_SKIP_COMPOSE_UP:-0}"

mkdir -p "$REPORT_DIR"
report_path="${REPORT_DIR}/phase21-provider-stress-$(date +%Y%m%d-%H%M%S).json"
report_md_path="${report_path%.json}.md"
artifact_dir="${report_path%.json}-artifacts"
mkdir -p "$artifact_dir"
results_tmp="$(mktemp)"
runtime_checks_tmp="$(mktemp)"
preflight_tmp="$(mktemp)"
fallback_tmp="$(mktemp)"
artifacts_tmp="$(mktemp)"
last_sse_payload_file="$(mktemp)"
last_curl_error_file="$(mktemp)"
archived_failure_count=0

cleanup() {
  rm -f "$results_tmp" "$runtime_checks_tmp" "$preflight_tmp" "$fallback_tmp" "$artifacts_tmp" \
    "$last_sse_payload_file" "$last_curl_error_file"
}
trap cleanup EXIT

record_runtime_check() {
  local name="$1"
  local status="$2"
  local detail="$3"
  node -e '
    const [name, status, detail] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({ name, status, detail }));
  ' "$name" "$status" "$detail" >>"$runtime_checks_tmp"
  printf '\n' >>"$runtime_checks_tmp"
}

json_field() {
  local json="$1"
  local key="$2"
  printf '%s' "$json" | KEY="$key" node -e '
    const fs = require("node:fs");
    const key = process.env.KEY || "";
    const value = JSON.parse(fs.readFileSync(0, "utf8"))?.[key];
    process.stdout.write(value === undefined || value === null ? "" : String(value));
  '
}

capture_failure_artifact() {
  local stage="$1"
  local run_id="$2"
  local run_result="$3"
  local run_start_epoch="$4"

  if [[ "$ARCHIVE_ENABLED" != "1" ]]; then
    return 0
  fi
  if (( archived_failure_count >= ARCHIVE_MAX_FAILURES )); then
    return 0
  fi

  local safe_run_id
  safe_run_id="$(printf '%s' "$run_id" | tr '/: ' '___')"
  local sample_dir="${artifact_dir}/${stage}-${safe_run_id}"
  mkdir -p "$sample_dir"

  printf '%s\n' "$run_result" >"${sample_dir}/result.json"
  cp "$last_sse_payload_file" "${sample_dir}/sse.raw.txt"
  if [[ -s "$last_curl_error_file" ]]; then
    cp "$last_curl_error_file" "${sample_dir}/curl.stderr.txt"
  fi
  if [[ -s "$runtime_checks_tmp" ]]; then
    cp "$runtime_checks_tmp" "${sample_dir}/runtime-checks.ndjson"
  fi

  local since_iso
  since_iso="$(node -e '
    const s = Number(process.argv[1] || "0");
    const ts = Math.max(0, (s - 2) * 1000);
    process.stdout.write(new Date(ts).toISOString());
  ' "$run_start_epoch")"

  for service in $ARCHIVE_LOG_SERVICES; do
    if docker inspect "$service" >/dev/null 2>&1; then
      docker logs --since "$since_iso" --tail "$ARCHIVE_LOG_TAIL" "$service" >"${sample_dir}/${service}.log" 2>&1 || true
    else
      printf 'service_not_found\n' >"${sample_dir}/${service}.log"
    fi
  done

  local outcome
  local failure_class
  local detail
  outcome="$(json_field "$run_result" "outcome")"
  failure_class="$(json_field "$run_result" "failureClass")"
  detail="$(json_field "$run_result" "detail")"

  node -e '
    const [stage, runId, outcome, failureClass, detail, sampleDir] = process.argv.slice(1);
    process.stdout.write(
      JSON.stringify({
        stage,
        runId,
        outcome,
        failureClass,
        detail,
        artifactPath: sampleDir,
      }),
    );
  ' "$stage" "$run_id" "$outcome" "$failure_class" "$detail" "$sample_dir" >>"$artifacts_tmp"
  printf '\n' >>"$artifacts_tmp"

  archived_failure_count=$((archived_failure_count + 1))
}

check_provider_runtime() {
  log "provider runtime precheck: provider=${PROVIDER}, container=${PROVIDER_RUNTIME_CONTAINER}"

  if docker inspect "$PROVIDER_RUNTIME_CONTAINER" >/dev/null 2>&1; then
    record_runtime_check "provider_runtime_container" "pass" "runtime container exists: ${PROVIDER_RUNTIME_CONTAINER}"
  else
    record_runtime_check "provider_runtime_container" "fail" "runtime container not found: ${PROVIDER_RUNTIME_CONTAINER}"
    return 0
  fi

  if docker inspect executor >/dev/null 2>&1; then
    record_runtime_check "executor_container" "pass" "executor container exists"
  else
    record_runtime_check "executor_container" "warn" "executor container not found"
  fi

  local cli_name=""
  local auth_check_cmd=""
  local auth_hint=""
  local auth_env_name=""

  case "$PROVIDER" in
    codex-cli|codex-app-server)
      cli_name="codex"
      auth_check_cmd='[ -f /root/.codex/auth.json ] || [ -f /root/.codex/config.json ]'
      auth_hint="check /root/.codex/auth.json or /root/.codex/config.json"
      auth_env_name="OPENAI_API_KEY"
      ;;
    claude-code)
      cli_name="claude"
      auth_check_cmd='[ -f /root/.claude.json ] || [ -d /root/.config/claude ]'
      auth_hint="check /root/.claude.json or /root/.config/claude"
      auth_env_name="ANTHROPIC_API_KEY"
      ;;
    opencode)
      cli_name="opencode"
      auth_check_cmd=''
      auth_hint="no explicit auth file check configured"
      auth_env_name="OPENAI_API_KEY"
      ;;
    *)
      cli_name="$PROVIDER"
      auth_check_cmd=''
      auth_hint="unknown provider; skip auth file check"
      auth_env_name=""
      ;;
  esac

  local binary_path
  binary_path="$(docker exec "$PROVIDER_RUNTIME_CONTAINER" sh -lc "command -v ${cli_name} || true" 2>/dev/null | tr -d '\r' | head -n 1)"
  if [[ -n "$binary_path" ]]; then
    record_runtime_check "provider_binary" "pass" "${cli_name} found at ${binary_path} (${PROVIDER_RUNTIME_CONTAINER})"
    local version_line
    version_line="$(docker exec "$PROVIDER_RUNTIME_CONTAINER" sh -lc "${cli_name} --version 2>/dev/null | head -n 1 || true" | tr -d '\r')"
    if [[ -n "$version_line" ]]; then
      record_runtime_check "provider_version" "pass" "$version_line"
    else
      record_runtime_check "provider_version" "warn" "${cli_name} version output is empty"
    fi
  else
    record_runtime_check "provider_binary" "fail" "${cli_name} not found in ${PROVIDER_RUNTIME_CONTAINER}"
    record_runtime_check "provider_version" "warn" "skip version check because binary missing"
  fi

  if [[ -n "$auth_check_cmd" ]]; then
    auth_file_ok="0"
    if docker exec "$PROVIDER_RUNTIME_CONTAINER" sh -lc "$auth_check_cmd" >/dev/null 2>&1; then
      auth_file_ok="1"
      record_runtime_check "provider_auth_hint" "pass" "auth footprint exists (${auth_hint})"
    else
      record_runtime_check "provider_auth_hint" "warn" "auth footprint missing (${auth_hint})"
    fi
  else
    auth_file_ok="0"
    record_runtime_check "provider_auth_hint" "warn" "$auth_hint"
  fi

  auth_env_ok="0"
  if [[ -n "$auth_env_name" ]]; then
    if docker exec "$PROVIDER_RUNTIME_CONTAINER" sh -lc "[ -n \"\${${auth_env_name}:-}\" ]" >/dev/null 2>&1; then
      auth_env_ok="1"
      record_runtime_check "provider_auth_env" "pass" "${auth_env_name} present in ${PROVIDER_RUNTIME_CONTAINER}"
    else
      record_runtime_check "provider_auth_env" "warn" "${auth_env_name} missing in ${PROVIDER_RUNTIME_CONTAINER}"
    fi
  else
    record_runtime_check "provider_auth_env" "warn" "no auth env check configured for provider ${PROVIDER}"
  fi

  if [[ "$auth_file_ok" == "0" && "$auth_env_ok" == "0" ]]; then
    record_runtime_check "provider_auth_ready" "fail" "neither auth file nor auth env is ready for provider ${PROVIDER}"
  else
    record_runtime_check "provider_auth_ready" "pass" "provider auth source is available"
  fi
}

parse_sse_result() {
  local sse_payload="$1"
  local curl_exit="$2"
  local run_id="$3"
  local stage="$4"
  printf '%s' "$sse_payload" | CURL_EXIT="$curl_exit" RUN_ID="$run_id" STAGE="$stage" PROVIDER="$PROVIDER" MODEL="$MODEL" node -e '
    const fs = require("node:fs");
    const input = fs.readFileSync(0, "utf8");
    const curlExit = Number(process.env.CURL_EXIT || "0");
    const expectedRunId = process.env.RUN_ID || "";
    const stage = process.env.STAGE || "stress";
    const provider = process.env.PROVIDER || "unknown";
    const model = process.env.MODEL || "unknown";

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

    function classifyFailure(outcome, detail, messagePreview, messageCount, curlExitCode) {
      if (outcome === "succeeded") {
        return {
          failureClass: "none",
          suggestion: "provider path healthy",
        };
      }

      const lowered = `${String(detail || "")} ${String(messagePreview || "")}`.toLowerCase();
      if (outcome === "transport_error") {
        return {
          failureClass: "transport_error",
          suggestion: "check gateway/control-plane connectivity and curl timeout settings",
        };
      }
      if (outcome === "blocked") {
        if (lowered.includes("human-loop")) {
          return {
            failureClass: "provider_capability_blocked",
            suggestion: "switch provider or disable requireHumanLoop for this run",
          };
        }
        return {
          failureClass: "run_blocked",
          suggestion: "inspect run.status detail and provider capability matrix",
        };
      }
      if (curlExitCode === 28 || lowered.includes("timeout")) {
        return {
          failureClass: "timeout",
          suggestion: "increase STRESS_RUN_TIMEOUT_SEC and inspect upstream long-tail latency",
        };
      }
      if (
        lowered.includes("unauthorized") ||
        lowered.includes("authentication") ||
        lowered.includes("api key") ||
        lowered.includes("not logged in") ||
        lowered.includes("forbidden") ||
        lowered.includes("401")
      ) {
        return {
          failureClass: "auth_missing",
          suggestion: "verify provider credentials/login inside executor container",
        };
      }
      if (
        lowered.includes("model") &&
        (lowered.includes("not found") ||
          lowered.includes("unknown") ||
          lowered.includes("unsupported") ||
          lowered.includes("invalid"))
      ) {
        return {
          failureClass: "model_invalid",
          suggestion: "check STRESS_MODEL and provider model availability",
        };
      }
      if (
        lowered.includes("enoent") ||
        lowered.includes("spawn") ||
        lowered.includes("failed to start") ||
        lowered.includes("app-server")
      ) {
        return {
          failureClass: "provider_runtime_bootstrap",
          suggestion: "check provider binary/runtime startup in executor image",
        };
      }
      if (
        lowered.includes("econn") ||
        lowered.includes("network") ||
        lowered.includes("connection refused")
      ) {
        return {
          failureClass: "network_error",
          suggestion: "check network/proxy availability for provider upstream",
        };
      }
      if (lowered.includes("no output generated")) {
        return {
          failureClass: "provider_no_output",
          suggestion: "inspect provider internal logs; verify login state and model response permissions",
        };
      }
      if (outcome === "incomplete" || outcome === "empty_stream") {
        return {
          failureClass: "stream_incomplete",
          suggestion: "check SSE lifecycle, reconnect path, and upstream stream termination",
        };
      }
      if (outcome === "failed" && messageCount === 0) {
        return {
          failureClass: "provider_no_output",
          suggestion: "check provider stderr/auth and ensure terminal failure reason is propagated",
        };
      }
      return {
        failureClass: "unknown_failure",
        suggestion: "collect control-plane/executor logs and inspect run.status detail",
      };
    }

    const events = parseEvents(input);
    let runId = expectedRunId;
    let outcome = "unknown";
    let detail = "";
    let sawStarted = false;
    let sawClosed = false;
    const messageDeltas = [];

    for (const item of events) {
      const data = item.data && typeof item.data === "object" ? item.data : {};
      const dataRunId = typeof data.runId === "string" ? data.runId : "";
      if (dataRunId) {
        runId = dataRunId;
      }
      if (item.event === "message.delta") {
        const text = typeof data.text === "string" ? data.text : "";
        if (text) {
          messageDeltas.push(text);
        }
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
    const messagePreview = messageDeltas.length > 0 ? messageDeltas[messageDeltas.length - 1].slice(0, 240) : "";
    const todoCount = events.filter((item) => item.event === "todo.update").length;
    const runStatusCount = events.filter((item) => item.event === "run.status").length;
    const { failureClass, suggestion } = classifyFailure(
      outcome,
      detail,
      messagePreview,
      messageDeltaCount,
      curlExit,
    );

    process.stdout.write(
      JSON.stringify({
        stage,
        provider,
        model,
        runId,
        outcome,
        detail,
        messagePreview,
        failureClass,
        suggestion,
        curlExit,
        eventCount: events.length,
        runStatusCount,
        messageDeltaCount,
        todoCount,
        sawStarted,
        sawClosed,
      }),
    );
  '
}

run_single_case() {
  local run_id="$1"
  local prompt="$2"
  local timeout_sec="$3"
  local stage="$4"
  local err_file
  local curl_exit=0
  local sse_payload=""
  err_file="$(mktemp)"

  set +e
  sse_payload=$(curl -sS -N \
    --max-time "$timeout_sec" \
    -X POST \
    -H 'accept: text/event-stream' \
    -H 'content-type: application/json' \
    -d "$(cat <<JSON
{"runId":"${run_id}","provider":"${PROVIDER}","model":"${MODEL}","messages":[{"role":"user","content":"${prompt}"}],"requireHumanLoop":$( [[ "$REQUIRE_HUMAN_LOOP" == "1" ]] && echo "true" || echo "false" )}
JSON
)" \
    "http://127.0.0.1:3001/api/runs/start" 2>"$err_file")
  curl_exit=$?
  set -e

  local parse_result
  parse_result="$(parse_sse_result "$sse_payload" "$curl_exit" "$run_id" "$stage")"

  local curl_err_text
  curl_err_text="$(cat "$err_file" || true)"
  rm -f "$err_file"

  printf '%s' "$sse_payload" >"$last_sse_payload_file"
  printf '%s' "$curl_err_text" >"$last_curl_error_file"

  if [[ -n "$curl_err_text" ]]; then
    parse_result=$(printf '%s' "$parse_result" | CURL_ERR="$curl_err_text" node -e '
      const fs = require("node:fs");
      const base = JSON.parse(fs.readFileSync(0, "utf8"));
      const err = String(process.env.CURL_ERR || "").trim();
      base.curlError = err ? err.slice(0, 400) : "";
      process.stdout.write(JSON.stringify(base));
    ')
  fi

  printf '%s' "$parse_result"
}

run_scripted_fallback_probe() {
  log "fallback probe: switch control-plane to scripted mode"
  CONTROL_PLANE_PROVIDER_MODE=scripted docker compose up -d --build control-plane gateway >/dev/null
  wait_for_health "gateway(scripted)" "http://127.0.0.1:3001/health" 60 2

  local fallback_run_id
  local fallback_prompt
  local fallback_start_epoch
  fallback_run_id="run-phase21-fallback-$(date +%s)"
  fallback_prompt="phase21-fallback-$(date +%s)"
  fallback_start_epoch="$(date +%s)"

  local fallback_result
  fallback_result="$(run_single_case "$fallback_run_id" "$fallback_prompt" "$FALLBACK_RUN_TIMEOUT_SEC" "fallback-scripted")"
  echo "$fallback_result" >"$fallback_tmp"
  log "fallback result: $fallback_result"

  local fallback_outcome
  fallback_outcome="$(json_field "$fallback_result" "outcome")"
  if [[ "$fallback_outcome" != "succeeded" ]]; then
    capture_failure_artifact "fallback-scripted" "$fallback_run_id" "$fallback_result" "$fallback_start_epoch"
  fi

  log "restore control-plane to real mode"
  CONTROL_PLANE_PROVIDER_MODE=real docker compose up -d --build control-plane gateway >/dev/null
  wait_for_health "gateway(real-restored)" "http://127.0.0.1:3001/health" 60 2
}

if [[ "$SKIP_COMPOSE_UP" != "1" ]]; then
  log "starting compose services in real provider mode: ${COMPOSE_SERVICES[*]}"
  CONTROL_PLANE_PROVIDER_MODE=real docker compose up -d --build "${COMPOSE_SERVICES[@]}"
else
  log "skip compose startup because STRESS_SKIP_COMPOSE_UP=1"
fi

wait_for_postgres
apply_db_migrations

wait_for_health "gateway" "http://127.0.0.1:3001/health"
wait_for_health "control-plane-via-gateway" "http://127.0.0.1:3001/api/reconcile/metrics"
wait_for_health "portal" "http://127.0.0.1/"

check_provider_runtime

if [[ "$PRECHECK_ENABLED" == "1" ]]; then
  preflight_start_epoch="$(date +%s)"
  preflight_run_id="run-phase21-precheck-$(date +%s)"
  preflight_prompt="phase21-precheck-$(date +%s)"
  log "preflight run: runId=${preflight_run_id}, timeout=${PRECHECK_TIMEOUT_SEC}s"
  preflight_result="$(run_single_case "$preflight_run_id" "$preflight_prompt" "$PRECHECK_TIMEOUT_SEC" "preflight")"
  echo "$preflight_result" >"$preflight_tmp"
  log "preflight result: $preflight_result"

  preflight_outcome="$(printf '%s' "$preflight_result" | node -e 'const fs=require("node:fs");const data=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(data.outcome || "unknown");')"
  if [[ "$preflight_outcome" != "succeeded" ]]; then
    capture_failure_artifact "preflight" "$preflight_run_id" "$preflight_result" "$preflight_start_epoch"
  fi
  if [[ "$preflight_outcome" != "succeeded" && "$AUTO_FALLBACK_SCRIPTED" == "1" ]]; then
    run_scripted_fallback_probe
  fi
fi

log "stress config: iterations=${ITERATIONS}, provider=${PROVIDER}, model=${MODEL}, timeout=${RUN_TIMEOUT_SEC}s, strict=${STRICT_MODE}"

for ((i = 1; i <= ITERATIONS; i += 1)); do
  run_start_epoch="$(date +%s)"
  run_id="run-phase21-$(date +%s)-${i}"
  prompt="phase21-provider-stress-${i}-$(date +%s)"
  log "run ${i}/${ITERATIONS}: runId=${run_id}"
  parse_result="$(run_single_case "$run_id" "$prompt" "$RUN_TIMEOUT_SEC" "stress")"

  echo "$parse_result" >> "$results_tmp"
  log "run result: $parse_result"

  run_outcome="$(json_field "$parse_result" "outcome")"
  if [[ "$run_outcome" != "succeeded" ]]; then
    capture_failure_artifact "stress" "$run_id" "$parse_result" "$run_start_epoch"
  fi
done

summary_json=$(RESULTS_FILE="$results_tmp" RUNTIME_CHECKS_FILE="$runtime_checks_tmp" PRECHECK_FILE="$preflight_tmp" FALLBACK_FILE="$fallback_tmp" ARTIFACTS_FILE="$artifacts_tmp" REPORT_PATH="$report_path" REPORT_MD_PATH="$report_md_path" ARTIFACT_DIR="$artifact_dir" ARCHIVE_ENABLED="$ARCHIVE_ENABLED" ARCHIVE_MAX_FAILURES="$ARCHIVE_MAX_FAILURES" ARCHIVE_LOG_SERVICES="$ARCHIVE_LOG_SERVICES" ARCHIVE_LOG_TAIL="$ARCHIVE_LOG_TAIL" ITERATIONS="$ITERATIONS" PROVIDER="$PROVIDER" MODEL="$MODEL" REQUIRE_HUMAN_LOOP="$REQUIRE_HUMAN_LOOP" RUN_TIMEOUT_SEC="$RUN_TIMEOUT_SEC" STRICT_MODE="$STRICT_MODE" THRESHOLD="$SUCCESS_RATE_THRESHOLD" node -e '
  const fs = require("node:fs");
  const resultsFile = process.env.RESULTS_FILE;
  const runtimeChecksFile = process.env.RUNTIME_CHECKS_FILE;
  const precheckFile = process.env.PRECHECK_FILE;
  const fallbackFile = process.env.FALLBACK_FILE;
  const artifactsFile = process.env.ARTIFACTS_FILE;
  const reportPath = process.env.REPORT_PATH;
  const reportMdPath = process.env.REPORT_MD_PATH;
  const rows = fs
    .readFileSync(resultsFile, "utf8")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const runtimeChecks = fs
    .readFileSync(runtimeChecksFile, "utf8")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const precheckText = fs.readFileSync(precheckFile, "utf8").trim();
  const fallbackText = fs.readFileSync(fallbackFile, "utf8").trim();
  const preflight = precheckText ? JSON.parse(precheckText) : null;
  const fallbackProbe = fallbackText ? JSON.parse(fallbackText) : null;
  const failureArtifacts = fs
    .readFileSync(artifactsFile, "utf8")
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
  const strictMode = process.env.STRICT_MODE === "1";
  const threshold = Number(process.env.THRESHOLD || "0.8");

  const failureClassCounts = rows.reduce((acc, item) => {
    const key = item.failureClass || "unknown_failure";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const topFailures = Object.entries(failureClassCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([failureClass, count]) => ({ failureClass, count }));

  const suggestions = Array.from(
    new Set(
      rows
        .map((item) => item.suggestion)
        .filter((item) => typeof item === "string" && item.length > 0),
    ),
  ).slice(0, 8);

  const report = {
    generatedAt: new Date().toISOString(),
    config: {
      iterations: Number(process.env.ITERATIONS || "0"),
      provider: process.env.PROVIDER,
      model: process.env.MODEL,
      requireHumanLoop: process.env.REQUIRE_HUMAN_LOOP === "1",
      runTimeoutSec: Number(process.env.RUN_TIMEOUT_SEC || "0"),
      mode: "real-provider",
      strictMode,
      successRateThreshold: threshold,
      archive: {
        enabled: process.env.ARCHIVE_ENABLED === "1",
        maxFailures: Number(process.env.ARCHIVE_MAX_FAILURES || "0"),
        logServices: String(process.env.ARCHIVE_LOG_SERVICES || "")
          .split(/\s+/)
          .filter(Boolean),
        logTail: Number(process.env.ARCHIVE_LOG_TAIL || "0"),
        artifactDir: process.env.ARTIFACT_DIR,
      },
    },
    preflight,
    fallbackProbe,
    runtimeChecks,
    failureArtifacts,
    summary: {
      total,
      succeeded,
      failed,
      blocked,
      canceled,
      transportError,
      incomplete,
      successRate,
      failureClassCounts,
      topFailures,
      suggestions,
      failureArtifactCount: failureArtifacts.length,
    },
    runs: rows,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const md = [
    "# Phase 21 Real Provider Stress Report",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- provider: ${report.config.provider}`,
    `- model: ${report.config.model}`,
    `- iterations: ${report.config.iterations}`,
    `- strictMode: ${report.config.strictMode}`,
    `- successRateThreshold: ${report.config.successRateThreshold}`,
    `- archiveEnabled: ${report.config.archive.enabled}`,
    `- archiveMaxFailures: ${report.config.archive.maxFailures}`,
    `- artifactDir: ${report.config.archive.artifactDir}`,
    "",
    "## Summary",
    "",
    `- total: ${report.summary.total}`,
    `- succeeded: ${report.summary.succeeded}`,
    `- failed: ${report.summary.failed}`,
    `- blocked: ${report.summary.blocked}`,
    `- canceled: ${report.summary.canceled}`,
    `- transportError: ${report.summary.transportError}`,
    `- incomplete: ${report.summary.incomplete}`,
    `- successRate: ${report.summary.successRate}`,
    `- failureArtifactCount: ${report.summary.failureArtifactCount}`,
    "",
    "## Top Failures",
    "",
    ...report.summary.topFailures.map((item) => `- ${item.failureClass}: ${item.count}`),
    "",
    "## Suggestions",
    "",
    ...report.summary.suggestions.map((item) => `- ${item}`),
    "",
    "## Runtime Checks",
    "",
    ...report.runtimeChecks.map((item) => `- [${item.status}] ${item.name}: ${item.detail}`),
    "",
    "## Preflight",
    "",
    report.preflight
      ? `- outcome=${report.preflight.outcome}, class=${report.preflight.failureClass}, detail=${report.preflight.detail}`
      : "- preflight disabled",
    "",
    "## Fallback Probe",
    "",
    report.fallbackProbe
      ? `- outcome=${report.fallbackProbe.outcome}, class=${report.fallbackProbe.failureClass}, detail=${report.fallbackProbe.detail}`
      : "- fallback not executed",
    "",
    "## Failure Artifacts",
    "",
    ...(report.failureArtifacts.length > 0
      ? report.failureArtifacts.map(
          (item) =>
            `- [${item.stage}] runId=${item.runId}, class=${item.failureClass}, path=${item.artifactPath}`,
        )
      : ["- none"]),
    "",
  ].join("\n");
  fs.writeFileSync(reportMdPath, md);

  process.stdout.write(JSON.stringify(report.summary));
')

log "stress summary: ${summary_json}"
log "stress report written: ${report_path}"
log "stress markdown summary written: ${report_md_path}"
log "stress failure artifacts dir: ${artifact_dir}"

if [[ -n "$SUMMARY_OUT" ]]; then
  mkdir -p "$(dirname "$SUMMARY_OUT")"
  summary_payload="$(printf '%s' "$summary_json" | REPORT_PATH="$report_path" REPORT_MD_PATH="$report_md_path" ARTIFACT_DIR="$artifact_dir" node -e '
    const fs = require("node:fs");
    const summary = JSON.parse(fs.readFileSync(0, "utf8"));
    const payload = {
      reportPath: process.env.REPORT_PATH,
      reportMarkdownPath: process.env.REPORT_MD_PATH,
      artifactDir: process.env.ARTIFACT_DIR,
      summary,
    };
    process.stdout.write(JSON.stringify(payload, null, 2));
  ')"
  printf '%s\n' "$summary_payload" >"$SUMMARY_OUT"
  log "stress summary payload written: ${SUMMARY_OUT}"
fi

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

log "phase21 real-provider stress with precheck completed"
