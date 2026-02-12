-- Phase 5: persistence baseline for control-plane

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'session_worker_state') THEN
    CREATE TYPE session_worker_state AS ENUM ('running', 'stopped', 'deleted');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sync_status') THEN
    CREATE TYPE sync_status AS ENUM ('idle', 'running', 'success', 'failed');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'run_status') THEN
    CREATE TYPE run_status AS ENUM (
      'queued',
      'claimed',
      'restoring',
      'linking',
      'preparing',
      'running',
      'waiting_human',
      'syncing',
      'exported',
      'succeeded',
      'failed',
      'canceled'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'human_loop_status') THEN
    CREATE TYPE human_loop_status AS ENUM ('pending', 'resolved', 'canceled', 'expired');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'todo_status') THEN
    CREATE TYPE todo_status AS ENUM ('todo', 'doing', 'done', 'canceled');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS session_workers (
  session_id TEXT PRIMARY KEY,
  container_id TEXT NOT NULL,
  workspace_s3_prefix TEXT NOT NULL,
  state session_worker_state NOT NULL,
  last_active_at TIMESTAMPTZ NOT NULL,
  stopped_at TIMESTAMPTZ NULL,
  last_sync_at TIMESTAMPTZ NULL,
  last_sync_status sync_status NOT NULL DEFAULT 'idle',
  last_sync_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_workers_state_active
  ON session_workers (state, last_active_at);

CREATE INDEX IF NOT EXISTS idx_session_workers_state_stopped
  ON session_workers (state, stopped_at);

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status run_status NOT NULL DEFAULT 'queued',
  usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  finalized_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS run_queue (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  status run_status NOT NULL DEFAULT 'queued',
  lock_owner TEXT NULL,
  lock_expires_at TIMESTAMPTZ NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_run_queue_claim
  ON run_queue (status, lock_expires_at, created_at);

CREATE TABLE IF NOT EXISTS run_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  event_ts TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_run_events_run_ts
  ON run_events (run_id, event_ts);

CREATE TABLE IF NOT EXISTS usage_logs (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  usage JSONB NOT NULL,
  finalized_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS human_loop_requests (
  question_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status human_loop_status NOT NULL DEFAULT 'pending',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_human_loop_requests_run_status
  ON human_loop_requests (run_id, status);

CREATE TABLE IF NOT EXISTS human_loop_responses (
  id BIGSERIAL PRIMARY KEY,
  question_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  answer TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (question_id, run_id)
);

CREATE TABLE IF NOT EXISTS todo_items (
  run_id TEXT NOT NULL,
  todo_id TEXT NOT NULL,
  content TEXT NOT NULL,
  status todo_status NOT NULL,
  order_no INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, todo_id)
);

CREATE INDEX IF NOT EXISTS idx_todo_items_run_order
  ON todo_items (run_id, order_no, updated_at);

CREATE TABLE IF NOT EXISTS todo_item_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  todo_id TEXT NOT NULL,
  status todo_status NOT NULL,
  content TEXT NOT NULL,
  order_no INTEGER NOT NULL,
  event_ts TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_todo_item_events_run_ts
  ON todo_item_events (run_id, event_ts);
