-- Failed-login tracking + account locking/unlocking + email verification.
-- Idempotent; also applied automatically by auth-service on startup.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS failed_login_attempts   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_failed_login_at    TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS locked_at               TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS unlock_token_hash       TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS unlock_token_expires_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email_verified          BOOLEAN NOT NULL DEFAULT false;
