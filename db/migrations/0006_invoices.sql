-- Invoices move from in-memory to Postgres.
CREATE TABLE IF NOT EXISTS invoices (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL,
  amount      NUMERIC(10,2) NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'EUR',
  customer    TEXT NOT NULL DEFAULT 'walk-in',
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_in_days INTEGER NOT NULL DEFAULT 14
);
CREATE INDEX IF NOT EXISTS idx_invoices_order ON invoices (order_id);
