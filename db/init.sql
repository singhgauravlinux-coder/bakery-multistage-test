-- Crumb & Ember — schema + seed data
-- Applied automatically on first boot of the postgres container
-- (docker-entrypoint-initdb.d) and via the bakery-db-init ConfigMap in k8s.

CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  price       NUMERIC(8,2) NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS profiles (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  email   TEXT UNIQUE NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  dietary JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS accounts (
  email         TEXT PRIMARY KEY,
  user_id       TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS order_seq START 1001;

CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  items       JSONB NOT NULL,
  pickup_time TEXT,
  status      TEXT NOT NULL DEFAULT 'received',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_user   ON orders (user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
CREATE INDEX IF NOT EXISTS idx_products_cat  ON products (category);

CREATE TABLE IF NOT EXISTS payments (
  id                  TEXT PRIMARY KEY,          -- razorpay order_id or mock pay_ id
  provider            TEXT NOT NULL DEFAULT 'mock',
  order_id            TEXT NOT NULL,
  razorpay_payment_id TEXT,
  amount              NUMERIC(10,2) NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'INR',
  method              TEXT,
  status              TEXT NOT NULL DEFAULT 'created',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_order  ON payments (order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);

-- ---------------------------------------------------------------- seed data
INSERT INTO products (id, name, category, price, description) VALUES
  ('p-1',  'Levain Country Loaf',   'bread',        8.50, '48-hour fermented sourdough, dark bake.'),
  ('p-2',  'Seeded Rye',            'bread',        7.00, 'Dense Danish-style rye with sunflower and flax.'),
  ('p-3',  'Butter Croissant',      'viennoiserie', 4.25, '27 layers of cultured butter.'),
  ('p-4',  'Cardamom Knot',         'viennoiserie', 4.75, 'Swedish-style bun, freshly ground cardamom.'),
  ('p-5',  'Pain au Chocolat',      'viennoiserie', 4.50, 'Two batons of 70% chocolate.'),
  ('p-6',  'Morning Bun',           'viennoiserie', 4.50, 'Croissant dough, orange zest, muscovado.'),
  ('p-7',  'Pistachio Financier',   'patisserie',   3.75, 'Brown-butter almond cake, Sicilian pistachio.'),
  ('p-8',  'Sour Cherry Galette',   'patisserie',   6.25, 'Rye crust, whole sour cherries.'),
  ('p-9',  'Canele',                'patisserie',   3.50, 'Rum and vanilla, caramelised copper-mould crust.'),
  ('p-10', 'Baguette Tradition',    'bread',        3.90, 'Slow-fermented, thin crackling crust.'),
  ('p-11', 'Focaccia al Rosmarino', 'bread',        5.50, 'Olive oil crumb, flaky salt, rosemary.'),
  ('p-12', 'Espresso Walnut Babka', 'patisserie',   9.00, 'Twisted brioche, espresso frangipane.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO profiles (id, name, email, address, dietary) VALUES
  ('u-1', 'Amelie Fournier', 'amelie@crumbandember.dev', '12 Rue du Levain', '["nut-free"]'),
  ('u-2', 'Tomas Iversen',   'tomas@example.com',        '8 Rye Lane',        '[]')
ON CONFLICT (id) DO NOTHING;

-- The demo account (amelie / baguette) is seeded by auth-service on startup
-- so the scrypt hash is produced by the same code path that verifies it.
-- Failed-login tracking + account locking/unlocking + email verification.
-- Idempotent; also applied automatically by auth-service on startup.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS failed_login_attempts   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_failed_login_at    TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS locked_at               TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS unlock_token_hash       TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS unlock_token_expires_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email_verified          BOOLEAN NOT NULL DEFAULT false;
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
-- Orders now carry payment state; prepaid orders start as pending_payment
-- and are confirmed only after the payment service verifies the charge.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'card';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'paid';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_id     TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS amount         NUMERIC(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS currency       TEXT NOT NULL DEFAULT 'EUR';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at        TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_payment_id ON orders (payment_id) WHERE payment_id IS NOT NULL;
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
