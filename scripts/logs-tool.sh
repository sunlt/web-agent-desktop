#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

DEFAULT_SERVICES=(gateway control-plane executor-manager executor portal)

print_usage() {
  cat <<'EOF'
用法:
  bash scripts/logs-tool.sh up
  bash scripts/logs-tool.sh urls
  bash scripts/logs-tool.sh tail [service...]
  bash scripts/logs-tool.sh since <duration> [service...]
  bash scripts/logs-tool.sh run <runId> [service...]

说明:
  - up: 启动日志相关服务（loki/promtail/grafana/dozzle）
  - urls: 打印日志工具访问地址
  - tail: 实时查看多服务日志（默认 gateway/control-plane/executor-manager/executor/portal）
  - since: 查看最近一段时间日志，例如 30m / 2h
  - run: 按 runId 过滤日志（默认查看最近 30m，可通过 LOG_SINCE 覆盖）
EOF
}

select_services() {
  if (($# == 0)); then
    printf '%s\n' "${DEFAULT_SERVICES[@]}"
  else
    printf '%s\n' "$@"
  fi
}

print_urls() {
  cat <<'EOF'
日志工具入口:
  - Dozzle:  http://127.0.0.1:3003
  - Grafana: http://127.0.0.1:3002  (默认 anonymous viewer，可直接看 Loki 面板)
  - Loki API: http://127.0.0.1:3100
EOF
}

command_name="${1:-help}"

case "$command_name" in
  up)
    docker compose up -d loki promtail grafana dozzle
    print_urls
    ;;
  urls)
    print_urls
    ;;
  tail)
    shift || true
    mapfile -t services < <(select_services "$@")
    docker compose logs -f --tail="${LOG_TAIL:-200}" "${services[@]}"
    ;;
  since)
    if (($# < 2)); then
      print_usage
      exit 1
    fi
    duration="$2"
    shift 2
    mapfile -t services < <(select_services "$@")
    docker compose logs --since="$duration" "${services[@]}"
    ;;
  run)
    if (($# < 2)); then
      print_usage
      exit 1
    fi
    run_id="$2"
    shift 2
    mapfile -t services < <(select_services "$@")
    since_window="${LOG_SINCE:-30m}"
    if command -v rg >/dev/null 2>&1; then
      docker compose logs --since="$since_window" "${services[@]}" | rg --line-buffered -n --fixed-strings "$run_id"
    else
      docker compose logs --since="$since_window" "${services[@]}" | grep --line-buffered -n -- "$run_id"
    fi
    ;;
  help | --help | -h)
    print_usage
    ;;
  *)
    print_usage
    exit 1
    ;;
esac
