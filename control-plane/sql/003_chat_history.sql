CREATE TABLE IF NOT EXISTS chat_sessions (
  chat_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT 'u-anon',
  title TEXT NOT NULL,
  provider TEXT NULL,
  model TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ NULL
);

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS user_id TEXT;

UPDATE chat_sessions
SET user_id = 'u-anon'
WHERE user_id IS NULL OR btrim(user_id) = '';

ALTER TABLE chat_sessions
  ALTER COLUMN user_id SET DEFAULT 'u-anon';

ALTER TABLE chat_sessions
  ALTER COLUMN user_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chat_sessions_order
  ON chat_sessions (user_id, last_message_at DESC, updated_at DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_session_messages (
  id BIGSERIAL PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chat_sessions(chat_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_session_messages_chat_seq
  ON chat_session_messages (chat_id, seq);

CREATE INDEX IF NOT EXISTS idx_chat_session_messages_chat_created
  ON chat_session_messages (chat_id, created_at, id);
