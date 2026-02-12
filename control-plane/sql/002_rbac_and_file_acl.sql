DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'visibility_scope') THEN
    CREATE TYPE visibility_scope AS ENUM ('all', 'department', 'user');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'file_principal_type') THEN
    CREATE TYPE file_principal_type AS ENUM ('all', 'user', 'role');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  login_name TEXT NOT NULL,
  department_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS roles (
  role_key TEXT PRIMARY KEY,
  description TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_role_bindings (
  user_id TEXT NOT NULL,
  role_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, role_key)
);

CREATE TABLE IF NOT EXISTS apps (
  app_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_visibility_rules (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL,
  scope_type visibility_scope NOT NULL,
  scope_value TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_visibility_rules_app
  ON app_visibility_rules (app_id, scope_type, scope_value);

CREATE TABLE IF NOT EXISTS app_members (
  app_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  can_use BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, user_id)
);

CREATE TABLE IF NOT EXISTS file_acl_policies (
  id BIGSERIAL PRIMARY KEY,
  path_prefix TEXT NOT NULL,
  principal_type file_principal_type NOT NULL,
  principal_id TEXT NULL,
  can_read BOOLEAN NOT NULL DEFAULT FALSE,
  can_write BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_file_acl_policies_path
  ON file_acl_policies (path_prefix);

CREATE TABLE IF NOT EXISTS file_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  path TEXT NOT NULL,
  allowed BOOLEAN NOT NULL,
  reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_file_audit_logs_user_ts
  ON file_audit_logs (user_id, created_at DESC);
