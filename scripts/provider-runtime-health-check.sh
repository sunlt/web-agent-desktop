#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PROVIDER="${PROVIDER_HEALTH_PROVIDER:-codex-app-server}"
RUNTIME_CONTAINER="${PROVIDER_HEALTH_RUNTIME_CONTAINER:-executor}"
CONTROL_PLANE_CONTAINER="${PROVIDER_HEALTH_CONTROL_PLANE_CONTAINER:-control-plane}"
EXECUTOR_MANAGER_CONTAINER="${PROVIDER_HEALTH_EXECUTOR_MANAGER_CONTAINER:-executor-manager}"
EXECUTOR_MANAGER_HEALTH_URL="${PROVIDER_HEALTH_EXECUTOR_MANAGER_URL:-http://127.0.0.1:3010/health}"
OUT_PATH="${PROVIDER_HEALTH_OUT:-}"
STRICT_MODE="${PROVIDER_HEALTH_STRICT:-0}"

checks_tmp="$(mktemp)"
cleanup() {
  rm -f "$checks_tmp"
}
trap cleanup EXIT

record_check() {
  local name="$1"
  local status="$2"
  local detail="$3"
  node -e '
    const [name, status, detail] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({ name, status, detail }));
  ' "$name" "$status" "$detail" >>"$checks_tmp"
  printf '\n' >>"$checks_tmp"
}

if docker inspect "$CONTROL_PLANE_CONTAINER" >/dev/null 2>&1; then
  record_check "control_plane_container" "pass" "container exists: ${CONTROL_PLANE_CONTAINER}"
else
  record_check "control_plane_container" "fail" "container not found: ${CONTROL_PLANE_CONTAINER}"
fi

if docker inspect "$RUNTIME_CONTAINER" >/dev/null 2>&1; then
  record_check "runtime_container" "pass" "container exists: ${RUNTIME_CONTAINER}"
else
  record_check "runtime_container" "fail" "container not found: ${RUNTIME_CONTAINER}"
fi

if docker inspect "$EXECUTOR_MANAGER_CONTAINER" >/dev/null 2>&1; then
  record_check "executor_manager_container" "pass" "container exists: ${EXECUTOR_MANAGER_CONTAINER}"
else
  record_check "executor_manager_container" "fail" "container not found: ${EXECUTOR_MANAGER_CONTAINER}"
fi

if [[ -n "$EXECUTOR_MANAGER_HEALTH_URL" ]]; then
  if curl -fsS "$EXECUTOR_MANAGER_HEALTH_URL" >/dev/null 2>&1; then
    record_check "executor_manager_health" "pass" "health endpoint reachable: ${EXECUTOR_MANAGER_HEALTH_URL}"
  else
    record_check "executor_manager_health" "fail" "health endpoint unreachable: ${EXECUTOR_MANAGER_HEALTH_URL}"
  fi
fi

cli_name=""
auth_file_cmd=""
auth_hint=""
auth_env_names=""
case "$PROVIDER" in
  codex-cli|codex-app-server)
    cli_name="codex"
    auth_file_cmd='[ -f /root/.codex/auth.json ] || [ -f /root/.codex/config.json ]'
    auth_hint="/root/.codex/auth.json or /root/.codex/config.json"
    auth_env_names="OPENAI_API_KEY"
    ;;
  claude-code)
    cli_name="claude"
    auth_file_cmd='[ -f /root/.claude/settings.json ] || [ -f /root/.claude.json ] || [ -d /root/.config/claude ]'
    auth_hint="/root/.claude/settings.json or /root/.claude.json or /root/.config/claude"
    auth_env_names="ANTHROPIC_AUTH_TOKEN,ANTHROPIC_API_KEY"
    ;;
  opencode)
    cli_name="opencode"
    auth_file_cmd='[ -f /root/.config/opencode/opencode.json ] || [ -f /root/.config/opencode/config.json ]'
    auth_hint="/root/.config/opencode/opencode.json or /root/.config/opencode/config.json"
    auth_env_names="OPENCODE_R2AI_API_KEY,OPENAI_API_KEY"
    ;;
  *)
    cli_name="$PROVIDER"
    auth_file_cmd=''
    auth_hint="unknown provider auth footprint"
    auth_env_names=""
    ;;
esac

if docker inspect "$RUNTIME_CONTAINER" >/dev/null 2>&1; then
  runtime_path="$(docker exec "$RUNTIME_CONTAINER" sh -lc "command -v ${cli_name} || true" 2>/dev/null | tr -d '\r' | head -n 1)"
  if [[ -n "$runtime_path" ]]; then
    record_check "provider_runtime_binary" "pass" "${cli_name} found in ${RUNTIME_CONTAINER} at ${runtime_path}"
    runtime_version="$(docker exec "$RUNTIME_CONTAINER" sh -lc "${cli_name} --version 2>/dev/null | head -n 1 || true" | tr -d '\r')"
    if [[ -n "$runtime_version" ]]; then
      record_check "provider_runtime_version" "pass" "$runtime_version"
    else
      record_check "provider_runtime_version" "warn" "version output is empty"
    fi
  else
    record_check "provider_runtime_binary" "fail" "${cli_name} not found in ${RUNTIME_CONTAINER}"
    record_check "provider_runtime_version" "warn" "skip version check because binary missing"
  fi

  auth_file_ok="0"
  if [[ -n "$auth_file_cmd" ]] && docker exec "$RUNTIME_CONTAINER" sh -lc "$auth_file_cmd" >/dev/null 2>&1; then
    auth_file_ok="1"
    record_check "provider_auth_file" "pass" "auth footprint exists (${auth_hint})"
  else
    if [[ -n "$auth_file_cmd" ]]; then
      record_check "provider_auth_file" "warn" "auth footprint missing (${auth_hint})"
    else
      record_check "provider_auth_file" "warn" "$auth_hint"
    fi
  fi

  auth_env_ok="0"
  if [[ -n "$auth_env_names" ]]; then
    IFS=',' read -r -a auth_env_name_list <<<"$auth_env_names"
    for env_name in "${auth_env_name_list[@]}"; do
      if docker exec "$RUNTIME_CONTAINER" sh -lc "[ -n \"\${${env_name}:-}\" ]" >/dev/null 2>&1; then
        auth_env_ok="1"
        record_check "provider_auth_env" "pass" "${env_name} present in ${RUNTIME_CONTAINER}"
        break
      fi
    done

    if [[ "$auth_env_ok" != "1" ]]; then
      record_check "provider_auth_env" "warn" "none of [${auth_env_names}] is present in ${RUNTIME_CONTAINER}"
    fi
  else
    record_check "provider_auth_env" "warn" "no auth env check configured for provider ${PROVIDER}"
  fi

  if [[ "$auth_file_ok" == "0" && "$auth_env_ok" == "0" ]]; then
    record_check "provider_auth_ready" "fail" "neither auth file nor auth env is ready for provider ${PROVIDER}"
  else
    record_check "provider_auth_ready" "pass" "provider auth source is available"
  fi
else
  record_check "provider_runtime_binary" "warn" "skip binary/auth checks because runtime missing"
  record_check "provider_runtime_version" "warn" "skip version check because runtime missing"
  record_check "provider_auth_file" "warn" "skip auth file check because runtime missing"
  record_check "provider_auth_env" "warn" "skip auth env check because runtime missing"
  record_check "provider_auth_ready" "fail" "runtime missing"
fi

report="$(CHECKS_FILE="$checks_tmp" PROVIDER="$PROVIDER" RUNTIME_CONTAINER="$RUNTIME_CONTAINER" CONTROL_PLANE_CONTAINER="$CONTROL_PLANE_CONTAINER" EXECUTOR_MANAGER_CONTAINER="$EXECUTOR_MANAGER_CONTAINER" EXECUTOR_MANAGER_HEALTH_URL="$EXECUTOR_MANAGER_HEALTH_URL" node -e '
  const fs = require("node:fs");
  const checks = fs
    .readFileSync(process.env.CHECKS_FILE, "utf8")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const failed = checks.filter((item) => item.status === "fail");
  const warned = checks.filter((item) => item.status === "warn");
  const failedNames = failed.map((item) => item.name);
  const authRelated = new Set([
    "provider_auth_ready",
    "provider_auth_env",
    "provider_auth_file",
  ]);
  const ready = failed.length === 0;
  const readinessCategory = ready
    ? "ready"
    : failedNames.every((name) => authRelated.has(name))
      ? "environment_not_ready"
      : "runtime_unhealthy";
  const blockingReason = ready
    ? null
    : readinessCategory === "environment_not_ready"
      ? "provider auth not ready"
      : `failed checks: ${failedNames.join(", ")}`;
  const report = {
    generatedAt: new Date().toISOString(),
    provider: process.env.PROVIDER,
    runtimeContainer: process.env.RUNTIME_CONTAINER,
    controlPlaneContainer: process.env.CONTROL_PLANE_CONTAINER,
    executorManagerContainer: process.env.EXECUTOR_MANAGER_CONTAINER,
    executorManagerHealthUrl: process.env.EXECUTOR_MANAGER_HEALTH_URL,
    ready,
    readinessCategory,
    blockingReason,
    failedChecks: failedNames,
    warnedChecks: warned.map((item) => item.name),
    checks,
  };
  process.stdout.write(JSON.stringify(report, null, 2));
')"

printf '%s\n' "$report"

if [[ -n "$OUT_PATH" ]]; then
  mkdir -p "$(dirname "$OUT_PATH")"
  printf '%s\n' "$report" >"$OUT_PATH"
fi

if [[ "$STRICT_MODE" == "1" ]]; then
  ready="$(printf '%s' "$report" | node -e 'const fs=require("node:fs");const data=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(data.ready ? "1" : "0");')"
  if [[ "$ready" != "1" ]]; then
    exit 1
  fi
fi
