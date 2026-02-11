FROM docker.m.daocloud.io/library/node:22-trixie

ARG DEBIAN_FRONTEND=noninteractive
ARG APT_MIRROR=mirrors.aliyun.com
ARG TTYD_VERSION=1.7.7

ENV TZ=Asia/Shanghai \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  NONINTERACTIVE=1 \
  UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple \
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
  SASS_BINARY_SITE=https://npmmirror.com/mirrors/node-sass/ \
  PHANTOMJS_CDNURL=https://npmmirror.com/mirrors/phantomjs/ \
  SHARP_BINARY_HOST=https://npmmirror.com/mirrors/sharp \
  SHARP_LIBVIPS_BINARY_HOST=https://npmmirror.com/mirrors/sharp-libvips


# -----------------------
# 1) 大陆 apt 源 + 基础依赖 + 中文字体 + 时区
# -----------------------
RUN set -eux; \
  if [ -f /etc/apt/sources.list ]; then \
  sed -i "s|http://deb.debian.org|http://${APT_MIRROR}|g; s|http://security.debian.org|http://${APT_MIRROR}|g" /etc/apt/sources.list; \
  fi; \
  if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
  sed -i "s|http://deb.debian.org|http://${APT_MIRROR}|g; s|http://security.debian.org|http://${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
  fi; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
  ca-certificates curl wget gnupg dirmngr \
  tzdata locales \
  bash git file zip 7zip sqlite3 jq ripgrep \
  procps \
  pandoc nano vim chromium \
  fontconfig \
  graphicsmagick dos2unix ffmpeg htop gettext default-mysql-client postgresql-client tree \
  tmux \
  fonts-noto-cjk fonts-noto-color-emoji fonts-wqy-zenhei fonts-wqy-microhei fonts-arphic-ukai fonts-arphic-uming \
  python3 python3-pip python3-venv \
  build-essential pkg-config \
  texlive-xetex texlive-lang-chinese texlive-fonts-recommended; \
  ln -snf /usr/share/zoneinfo/${TZ} /etc/localtime; \
  echo ${TZ} > /etc/timezone; \
  rm -rf /var/lib/apt/lists/*

# -----------------------
# 1.5) 安装 ttyd (binary release)
# -----------------------
RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "${arch}" in \
  amd64) ttyd_arch="x86_64" ;; \
  arm64) ttyd_arch="aarch64" ;; \
  armhf) ttyd_arch="armhf" ;; \
  i386) ttyd_arch="i686" ;; \
  s390x) ttyd_arch="s390x" ;; \
  *) echo "Unsupported arch: ${arch}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o "/tmp/ttyd.${ttyd_arch}" "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}"; \
  curl -fsSL -o /tmp/SHA256SUMS "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/SHA256SUMS"; \
  (cd /tmp && grep "ttyd.${ttyd_arch}$" SHA256SUMS | sha256sum -c -); \
  install -m 0755 "/tmp/ttyd.${ttyd_arch}" /usr/local/bin/ttyd; \
  rm -f "/tmp/ttyd.${ttyd_arch}" /tmp/SHA256SUMS

# -----------------------
# 2) npm 镜像 + 常用工具
# -----------------------
RUN set -eux; \
  npm config -g set registry https://registry.npmmirror.com; \
  npm install -g npm@latest pnpm

# -----------------------
# 3) pip 镜像 + 安装 uv
# -----------------------
RUN set -eux; \
  python3 -m pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple; \
  python3 -m pip config set global.trusted-host pypi.tuna.tsinghua.edu.cn; \
  python3 -m pip install --no-cache-dir -U uv --break-system-packages


# -----------------------
# 4) 安装 opencode
# -----------------------
RUN set -eux; \
  npm i -g @anthropic-ai/claude-code@latest @google/gemini-cli@latest @qwen-code/qwen-code@latest @openai/codex@latest opencode-ai@latest

# -----------------------
# -----------------------
# 5) .bashrc Proxy & Color
# -----------------------
RUN { \
  echo 'export HTTP_PROXY="http://mihomo:7890"'; \
  echo 'export HTTPS_PROXY="http://mihomo:7890"'; \
  echo 'export ALL_PROXY="socks5://mihomo:7890"'; \
  echo 'export http_proxy="http://mihomo:7890"'; \
  echo 'export https_proxy="http://mihomo:7890"'; \
  echo 'export all_proxy="socks5://mihomo:7890"'; \
  echo 'export TERM=xterm-256color'; \
  echo "alias ls='ls --color=auto'"; \
  echo "alias grep='grep --color=auto'"; \
  echo "alias ll='ls -al'"; \
  echo "export PS1='\[\033[01;32m\]\u@\h\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ '"; \
  } >> /root/.bashrc

# -----------------------
# 5.5) 设置中文为系统默认字体
# -----------------------
RUN cat > /etc/fonts/local.conf <<'EOF'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <alias>
    <family>sans-serif</family>
    <prefer>
      <family>Noto Sans CJK SC</family>
      <family>WenQuanYi Zen Hei</family>
      <family>WenQuanYi Micro Hei</family>
      <family>AR PL UKai CN</family>
      <family>AR PL UMing CN</family>
      <family>DejaVu Sans</family>
      <family>Noto Color Emoji</family>
    </prefer>
  </alias>
  <alias>
    <family>serif</family>
    <prefer>
      <family>Noto Serif CJK SC</family>
      <family>AR PL UMing CN</family>
      <family>DejaVu Serif</family>
      <family>Noto Color Emoji</family>
    </prefer>
  </alias>
  <alias>
    <family>monospace</family>
    <prefer>
      <family>Noto Sans Mono CJK SC</family>
      <family>WenQuanYi Zen Hei Mono</family>
      <family>DejaVu Sans Mono</family>
      <family>Noto Color Emoji</family>
    </prefer>
  </alias>
</fontconfig>
EOF

# -----------------------
# 6) 入口脚本
# -----------------------
RUN cat > /usr/local/bin/start-agent-runtime <<'EOF'
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
EOF
RUN chmod +x /usr/local/bin/start-agent-runtime

RUN cat > /usr/local/bin/ttyd-tmux <<'EOF'
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
EOF
RUN chmod +x /usr/local/bin/ttyd-tmux

RUN cat > /usr/local/bin/tmux-api <<'EOF'
#!/usr/bin/env python3
import argparse
import json
import os
import re
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

SESSION_RE = re.compile(r"^[A-Za-z0-9_.-]+$")

def run(cmd):
  return subprocess.check_output(cmd, stderr=subprocess.DEVNULL).decode("utf-8", "ignore")

def list_sessions():
  try:
    out = run(["tmux", "ls", "-F", "#{session_name}\t#{session_windows}\t#{session_attached}"])
  except subprocess.CalledProcessError:
    return []
  sessions = []
  for line in out.strip().splitlines():
    parts = line.split("\t")
    if len(parts) < 3:
      continue
    name, windows, attached = parts[0], parts[1], parts[2]
    sessions.append({
      "name": name,
      "windows": int(windows) if windows.isdigit() else 0,
      "attached": attached == "1",
    })
  return sessions

def has_session(name):
  try:
    subprocess.check_call(["tmux", "has-session", "-t", name], stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
    return True
  except subprocess.CalledProcessError:
    return False

def create_session(name):
  if has_session(name):
    return False
  subprocess.check_call(["tmux", "new-session", "-d", "-s", name], stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
  return True

def kill_session(name):
  subprocess.check_call(["tmux", "kill-session", "-t", name], stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)

class Handler(BaseHTTPRequestHandler):
  def _json(self, code, data):
    body = json.dumps(data).encode("utf-8")
    self.send_response(code)
    self.send_header("Content-Type", "application/json; charset=utf-8")
    self.send_header("Content-Length", str(len(body)))
    self.end_headers()
    self.wfile.write(body)

  def _read_json(self):
    length = int(self.headers.get("Content-Length", "0"))
    if length <= 0:
      return {}
    raw = self.rfile.read(length)
    try:
      return json.loads(raw.decode("utf-8"))
    except Exception:
      return {}

  def do_GET(self):
    path = urlparse(self.path).path
    if path == "/sessions":
      return self._json(200, {"sessions": list_sessions()})
    return self._json(404, {"error": "not_found"})

  def do_POST(self):
    path = urlparse(self.path).path
    if path == "/sessions":
      data = self._read_json()
      name = str(data.get("name", "")).strip()
      if not name or not SESSION_RE.match(name):
        return self._json(400, {"error": "invalid_name"})
      try:
        created = create_session(name)
        return self._json(200, {"ok": True, "name": name, "created": created})
      except subprocess.CalledProcessError:
        return self._json(500, {"error": "create_failed"})
    return self._json(404, {"error": "not_found"})

  def do_DELETE(self):
    path = urlparse(self.path).path
    if path.startswith("/sessions/"):
      name = path.split("/sessions/", 1)[1]
      if not name or not SESSION_RE.match(name):
        return self._json(400, {"error": "invalid_name"})
      try:
        kill_session(name)
        return self._json(200, {"ok": True, "name": name})
      except subprocess.CalledProcessError:
        return self._json(404, {"error": "not_found"})
    return self._json(404, {"error": "not_found"})

  def log_message(self, fmt, *args):
    return

def main():
  parser = argparse.ArgumentParser()
  parser.add_argument("--host", default=os.environ.get("TMUX_API_HOST", "0.0.0.0"))
  parser.add_argument("--port", type=int, default=int(os.environ.get("TMUX_API_PORT", "7682")))
  args = parser.parse_args()
  httpd = HTTPServer((args.host, args.port), Handler)
  httpd.serve_forever()

if __name__ == "__main__":
  main()
EOF
RUN chmod +x /usr/local/bin/tmux-api

# -----------------------
# 9) /root 外部挂载目录
# -----------------------
VOLUME ["/root"]
WORKDIR /root

EXPOSE 4096 7681

CMD ["/usr/local/bin/start-agent-runtime"]
