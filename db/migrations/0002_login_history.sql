-- Per-attempt login history (success and failure) with client forensics.
CREATE TABLE IF NOT EXISTS login_history (
  id             BIGSERIAL PRIMARY KEY,
  user_id        TEXT,
  email          TEXT,
  success        BOOLEAN NOT NULL,
  failure_reason TEXT,
  ip             TEXT,
  user_agent     TEXT,
  browser        TEXT,
  os             TEXT,
  device         TEXT,
  request_id     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_history_user  ON login_history (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_history_email ON login_history (email, created_at DESC);
