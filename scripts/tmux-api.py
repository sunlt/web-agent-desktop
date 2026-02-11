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
