-- Payment event trail (created / captured / rejected / webhook updates)
-- plus a masked instrument summary on the payment row (never full PAN).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS instrument_summary TEXT;
CREATE TABLE IF NOT EXISTS payment_events (
  id         BIGSERIAL PRIMARY KEY,
  payment_id TEXT,
  order_id   TEXT,
  event      TEXT NOT NULL,
  status     TEXT,
  amount     NUMERIC(10,2),
  currency   TEXT,
  ip         TEXT,
  request_id TEXT,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_events_payment ON payment_events (payment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_events_order   ON payment_events (order_id, created_at DESC);
