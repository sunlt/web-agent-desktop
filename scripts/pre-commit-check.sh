#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run_checks() {
  local project_dir="$1"
  echo "[pre-commit] ${project_dir}: lint"
  npm --prefix "${ROOT_DIR}/${project_dir}" run lint

  echo "[pre-commit] ${project_dir}: typecheck"
  npm --prefix "${ROOT_DIR}/${project_dir}" run typecheck
}

run_checks "control-plane"
run_checks "portal"
run_checks "executor"
run_checks "gateway"
run_checks "executor-manager"
