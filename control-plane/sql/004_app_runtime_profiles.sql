CREATE TABLE IF NOT EXISTS app_runtime_profiles (
  app_id TEXT PRIMARY KEY REFERENCES apps(app_id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (
    provider IN ('claude-code', 'opencode', 'codex-cli', 'codex-app-server')
  ),
  model TEXT NOT NULL,
  timeout_ms INTEGER NULL CHECK (timeout_ms IS NULL OR timeout_ms > 0),
  credential_env JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_options JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_runtime_profiles_provider_model
  ON app_runtime_profiles (provider, model);
