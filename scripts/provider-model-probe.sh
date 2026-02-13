#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PROVIDER="${PROVIDER_MODEL_PROBE_PROVIDER:-}"
MODELS_CSV="${PROVIDER_MODEL_PROBE_MODELS:-}"
RUN_TIMEOUT_SEC="${PROVIDER_MODEL_PROBE_TIMEOUT_SEC:-120}"
SKIP_COMPOSE_UP="${PROVIDER_MODEL_PROBE_SKIP_COMPOSE_UP:-1}"
REPORT_DIR="${PROVIDER_MODEL_PROBE_REPORT_DIR:-observability/reports}"

if [[ -z "$PROVIDER" ]]; then
  echo "[provider-model-probe] PROVIDER_MODEL_PROBE_PROVIDER is required" >&2
  exit 1
fi

if [[ -z "$MODELS_CSV" ]]; then
  case "$PROVIDER" in
    claude-code)
      MODELS_CSV="sonnet,haiku,opus,claude-sonnet-4-20250514,claude-haiku-4-5-20251001"
      ;;
    opencode)
      MODELS_CSV="r2ai/deepseek-v3.2,openai/gpt-5.1-codex,anthropic/claude-sonnet-4-5-20250929"
      ;;
    codex-app-server|codex-cli)
      MODELS_CSV="gpt-5.1-codex,gpt-5.1-codex-mini,gpt-5.1-codex-max"
      ;;
    *)
      echo "[provider-model-probe] PROVIDER_MODEL_PROBE_MODELS is required for provider=${PROVIDER}" >&2
      exit 1
      ;;
  esac
fi

mkdir -p "$REPORT_DIR"
report_path="${REPORT_DIR}/provider-model-probe-${PROVIDER}-$(date +%Y%m%d-%H%M%S).json"
result_tmp="$(mktemp)"
cleanup() {
  rm -f "$result_tmp"
}
trap cleanup EXIT

IFS=',' read -r -a models <<<"$MODELS_CSV"

for model in "${models[@]}"; do
  model="$(echo "$model" | xargs)"
  if [[ -z "$model" ]]; then
    continue
  fi

  echo "[provider-model-probe] test provider=${PROVIDER} model=${model}"
  log_output="$(
    STRESS_SKIP_COMPOSE_UP="$SKIP_COMPOSE_UP" \
    STRESS_PRECHECK_ENABLED=0 \
    STRESS_ITERATIONS=1 \
    STRESS_PROVIDER="$PROVIDER" \
    STRESS_MODEL="$model" \
    STRESS_RUN_TIMEOUT_SEC="$RUN_TIMEOUT_SEC" \
    STRESS_STRICT=0 \
    bash scripts/e2e-portal-real-provider-stress.sh 2>&1
  )"

  report_line="$(printf '%s\n' "$log_output" | rg "stress report written:" | tail -n 1 || true)"
  if [[ -z "$report_line" ]]; then
    printf '%s\n' "$log_output" >&2
    echo "[provider-model-probe] failed to locate stress report path for model=${model}" >&2
    exit 1
  fi

  stress_report="${report_line##*: }"
  parsed="$(STRESS_REPORT_PATH="$stress_report" PROVIDER="$PROVIDER" MODEL="$model" node -e '
    const fs = require("node:fs");
    const reportPath = process.env.STRESS_REPORT_PATH;
    const provider = process.env.PROVIDER;
    const model = process.env.MODEL;
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const run = Array.isArray(report.runs) && report.runs.length > 0 ? report.runs[0] : null;
    const summary = report.summary || {};
    process.stdout.write(JSON.stringify({
      provider,
      model,
      outcome: run?.outcome ?? "unknown",
      detail: run?.detail ?? "",
      failureClass: run?.failureClass ?? "unknown_failure",
      suggestion: run?.suggestion ?? "",
      messagePreview: run?.messagePreview ?? "",
      successRate: summary.successRate ?? 0,
      reportPath,
    }));
  ')"
  printf '%s\n' "$parsed" >>"$result_tmp"
done

summary_json="$(
  RESULTS_FILE="$result_tmp" PROVIDER="$PROVIDER" node -e '
    const fs = require("node:fs");
    const rows = fs.readFileSync(process.env.RESULTS_FILE, "utf8")
      .split(/\n+/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const succeeded = rows.filter(item => item.outcome === "succeeded");
    const payload = {
      generatedAt: new Date().toISOString(),
      provider: process.env.PROVIDER,
      total: rows.length,
      succeeded: succeeded.length,
      bestModel: succeeded.length > 0 ? succeeded[0].model : null,
      rows,
    };
    process.stdout.write(JSON.stringify(payload, null, 2));
  '
)"

printf '%s\n' "$summary_json" >"$report_path"
echo "[provider-model-probe] report written: ${report_path}"
printf '%s\n' "$summary_json"
