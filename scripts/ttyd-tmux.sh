#!/bin/bash
set -euo pipefail

SESSION="${1:-}"
if [ -n "${SESSION}" ]; then
  if printf '%s' "${SESSION}" | grep -Eq '^[A-Za-z0-9_.-]+$'; then
    exec tmux new -A -s "${SESSION}"
  else
    echo "Invalid session name. Use letters, numbers, dot, underscore, hyphen."
    SESSION=""
  fi
fi

if tmux ls >/dev/null 2>&1; then
  exec tmux attach \; choose-tree -s
fi

tmux new-session -d -s _bootstrap
exec tmux attach -t _bootstrap \; choose-tree -s \; run-shell 'test "#{session_name}" != "_bootstrap" && tmux kill-session -t _bootstrap || true'
