-- Orders now carry payment state; prepaid orders start as pending_payment
-- and are confirmed only after the payment service verifies the charge.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'card';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'paid';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_id     TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS amount         NUMERIC(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS currency       TEXT NOT NULL DEFAULT 'EUR';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at        TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_payment_id ON orders (payment_id) WHERE payment_id IS NOT NULL;
