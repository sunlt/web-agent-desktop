#!/bin/bash
set -e

if command -v ttyd >/dev/null 2>&1; then
  ttyd -p 7681 -i 0.0.0.0 -b /tty -a -W -t disableLeaveAlert=true /usr/local/bin/ttyd-tmux &
else
  echo "[warn] ttyd not found, skip starting web terminal" >&2
fi

if command -v tmux-api >/dev/null 2>&1; then
  tmux-api --host 0.0.0.0 --port 7682 &
else
  echo "[warn] tmux-api not found, skip starting tmux api" >&2
fi

exec opencode web --port 4096 --hostname 0.0.0.0
