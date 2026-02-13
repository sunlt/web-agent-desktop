#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PROVIDER_ENV_OUT="${PROVIDER_ENV_OUT:-$ROOT_DIR/.tmp/provider-local.env}"
CLAUDE_SETTINGS_PATH="${CLAUDE_SETTINGS_PATH:-$HOME/.claude/settings.json}"
OPENCODE_CONFIG_PATH="${OPENCODE_CONFIG_PATH:-$HOME/.config/opencode/opencode.json}"
CODEX_AUTH_PATH="${CODEX_AUTH_PATH:-$HOME/.codex/auth.json}"
INJECT_EXECUTOR="${PROVIDER_ENV_INJECT_EXECUTOR:-0}"
EXECUTOR_SERVICE="${PROVIDER_ENV_EXECUTOR_SERVICE:-executor}"
SYNC_AUTH_FILES="${PROVIDER_ENV_SYNC_AUTH_FILES:-1}"

mkdir -p "$(dirname "$PROVIDER_ENV_OUT")"

env_payload="$(
  CLAUDE_SETTINGS_PATH="$CLAUDE_SETTINGS_PATH" OPENCODE_CONFIG_PATH="$OPENCODE_CONFIG_PATH" CODEX_AUTH_PATH="$CODEX_AUTH_PATH" node -e '
    const fs = require("node:fs");

    const claudePath = process.env.CLAUDE_SETTINGS_PATH;
    const opencodePath = process.env.OPENCODE_CONFIG_PATH;
    const codexAuthPath = process.env.CODEX_AUTH_PATH;
    const env = {};
    const sources = [];

    function isRecord(value) {
      return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    }

    function sanitizeProviderName(name) {
      return String(name).trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
    }

    function setEnv(key, value) {
      if (typeof value !== "string") {
        return;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return;
      }
      env[key] = trimmed.replace(/[\r\n]/g, "");
    }

    if (claudePath && fs.existsSync(claudePath)) {
      try {
        const claude = JSON.parse(fs.readFileSync(claudePath, "utf8"));
        if (isRecord(claude.env)) {
          for (const [key, value] of Object.entries(claude.env)) {
            setEnv(key, value);
          }
          if (!env.ANTHROPIC_API_KEY && typeof claude.env.ANTHROPIC_AUTH_TOKEN === "string") {
            setEnv("ANTHROPIC_API_KEY", claude.env.ANTHROPIC_AUTH_TOKEN);
          }
          sources.push("claude_settings");
        }
      } catch {
        sources.push("claude_settings_invalid_json");
      }
    } else {
      sources.push("claude_settings_missing");
    }

    if (opencodePath && fs.existsSync(opencodePath)) {
      try {
        const opencode = JSON.parse(fs.readFileSync(opencodePath, "utf8"));
        if (isRecord(opencode.provider)) {
          for (const [providerName, providerValue] of Object.entries(opencode.provider)) {
            if (!isRecord(providerValue) || !isRecord(providerValue.options)) {
              continue;
            }
            const normalized = sanitizeProviderName(providerName);
            const apiKey = providerValue.options.apiKey;
            const baseUrl = providerValue.options.baseURL ?? providerValue.options.baseUrl;
            if (typeof apiKey === "string") {
              setEnv(`OPENCODE_${normalized}_API_KEY`, apiKey);
              if (providerName === "r2ai") {
                setEnv("OPENCODE_R2AI_API_KEY", apiKey);
              }
            }
            if (typeof baseUrl === "string") {
              setEnv(`OPENCODE_${normalized}_BASE_URL`, baseUrl);
              if (providerName === "r2ai") {
                setEnv("OPENCODE_R2AI_BASE_URL", baseUrl);
              }
            }
          }
          sources.push("opencode_config");
        }
      } catch {
        sources.push("opencode_config_invalid_json");
      }
    } else {
      sources.push("opencode_config_missing");
    }

    if (codexAuthPath && fs.existsSync(codexAuthPath)) {
      try {
        const codexAuth = JSON.parse(fs.readFileSync(codexAuthPath, "utf8"));
        if (isRecord(codexAuth)) {
          if (typeof codexAuth.OPENAI_API_KEY === "string") {
            setEnv("OPENAI_API_KEY", codexAuth.OPENAI_API_KEY);
          }
          if (typeof codexAuth.OPENAI_BASE_URL === "string") {
            setEnv("OPENAI_BASE_URL", codexAuth.OPENAI_BASE_URL);
          }
          sources.push("codex_auth");
        }
      } catch {
        sources.push("codex_auth_invalid_json");
      }
    } else {
      sources.push("codex_auth_missing");
    }

    const orderedKeys = Object.keys(env).sort((a, b) => a.localeCompare(b));
    const lines = orderedKeys.map((key) => `${key}=${env[key]}`);
    process.stdout.write(JSON.stringify({ lines, orderedKeys, sources }));
  '
)"

printf '%s' "$env_payload" | node -e '
  const fs = require("node:fs");
  const payload = JSON.parse(fs.readFileSync(0, "utf8"));
  process.stdout.write(payload.lines.join("\n"));
' >"$PROVIDER_ENV_OUT"

key_summary="$(
  printf '%s' "$env_payload" | node -e '
    const fs = require("node:fs");
    const payload = JSON.parse(fs.readFileSync(0, "utf8"));
    const keys = payload.orderedKeys || [];
    const sourceText = Array.isArray(payload.sources) && payload.sources.length > 0
      ? payload.sources.join(",")
      : "none";
    process.stdout.write(`keys=${keys.length};sources=${sourceText}`);
  '
)"

echo "[provider-env] wrote ${PROVIDER_ENV_OUT} (${key_summary})"

if [[ "$INJECT_EXECUTOR" == "1" ]]; then
  if [[ ! -s "$PROVIDER_ENV_OUT" ]]; then
    echo "[provider-env] env file is empty, skip executor recreation"
    exit 0
  fi
  echo "[provider-env] recreating ${EXECUTOR_SERVICE} with ${PROVIDER_ENV_OUT}"
  docker compose --env-file "$PROVIDER_ENV_OUT" up -d --force-recreate "$EXECUTOR_SERVICE"

  if [[ "$SYNC_AUTH_FILES" == "1" ]]; then
    if [[ -f "$CODEX_AUTH_PATH" ]]; then
      echo "[provider-env] syncing codex auth file into ${EXECUTOR_SERVICE}:/root/.codex/auth.json"
      docker exec "$EXECUTOR_SERVICE" sh -lc 'mkdir -p /root/.codex'
      docker cp "$CODEX_AUTH_PATH" "${EXECUTOR_SERVICE}:/root/.codex/auth.json"
    else
      echo "[provider-env] codex auth file missing, skip sync: ${CODEX_AUTH_PATH}"
    fi
  fi
fi
