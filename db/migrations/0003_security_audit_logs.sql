-- Cross-service security/audit trail: registration, login, logout,
-- forgot/reset/change password, email verification, payments, orders,
-- invoices and profile updates.
CREATE TABLE IF NOT EXISTS security_audit_logs (
  id             BIGSERIAL PRIMARY KEY,
  service        TEXT NOT NULL,
  action         TEXT NOT NULL,
  user_id        TEXT,
  email          TEXT,
  ip             TEXT,
  user_agent     TEXT,
  browser        TEXT,
  os             TEXT,
  device         TEXT,
  endpoint       TEXT,
  method         TEXT,
  request_id     TEXT,
  status_code    INTEGER,
  success        BOOLEAN NOT NULL DEFAULT true,
  failure_reason TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_user    ON security_audit_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action  ON security_audit_logs (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_request ON security_audit_logs (request_id);
