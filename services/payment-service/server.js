'use strict';
const crypto = require('crypto');
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const { Pool } = require('pg');
const { clientInfo } = require('./lib/client-info');
const { createAuditLogger } = require('./lib/audit');

const SERVICE_NAME = process.env.SERVICE_NAME || 'payment-service';
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || '';
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://order-service:3007';

// --- Razorpay configuration --------------------------------------------
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const RAZORPAY_ENABLED = Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);

let razorpay = null;
if (RAZORPAY_ENABLED) {
  const Razorpay = require('razorpay');
  razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
}

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: SERVICE_NAME, version: process.env.SERVICE_VERSION || '1.0.0' },
  formatters: { level: (label) => ({ level: label }) }
});

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, max: 10 }) : null;
if (pool) pool.on('error', (err) => logger.error({ event: 'pg_pool_error', message: err.message }, 'postgres pool error'));

// Self-migrating (idempotent) — mirrored in db/migrations/0005_payment_logs.sql.
const MIGRATION = `
  CREATE TABLE IF NOT EXISTS payments (
    id                  TEXT PRIMARY KEY,
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
`;

const ROW = `id, provider, order_id AS "orderId", razorpay_payment_id AS "razorpayPaymentId",
             amount, currency, method, status, instrument_summary AS "instrumentSummary",
             created_at AS "createdAt", updated_at AS "updatedAt"`;

const memory = new Map();
const memoryEvents = [];

const store = pool ? {
  mode: 'postgres',
  async init() { await pool.query(MIGRATION); },
  async create(p) {
    const { rows } = await pool.query(
      `INSERT INTO payments (id, provider, order_id, amount, currency, method, status, instrument_summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${ROW}`,
      [p.id, p.provider, p.orderId, p.amount, p.currency || 'INR', p.method || null, p.status, p.instrumentSummary || null]);
    return rows[0];
  },
  async get(id) {
    const { rows } = await pool.query(`SELECT ${ROW} FROM payments WHERE id = $1`, [id]);
    return rows[0] || null;
  },
  async byOrder(orderId) {
    const { rows } = await pool.query(
      `SELECT ${ROW} FROM payments WHERE order_id = $1 ORDER BY created_at DESC`, [orderId]);
    return rows;
  },
  async update(id, { status, razorpayPaymentId }) {
    const { rows } = await pool.query(
      `UPDATE payments
       SET status = COALESCE($2, status),
           razorpay_payment_id = COALESCE($3, razorpay_payment_id),
           updated_at = now()
       WHERE id = $1
       RETURNING ${ROW}`,
      [id, status || null, razorpayPaymentId || null]);
    return rows[0] || null;
  },
  async logEvent(e) {
    await pool.query(
      `INSERT INTO payment_events (payment_id, order_id, event, status, amount, currency, ip, request_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [e.paymentId || null, e.orderId || null, e.event, e.status || null, e.amount ?? null,
       e.currency || null, e.ip || null, e.requestId || null, JSON.stringify(e.detail || {})]);
  },
  async ping() { await pool.query('SELECT 1'); }
} : {
  mode: 'memory',
  async init() {},
  async create(p) {
    const record = { ...p, currency: p.currency || 'INR', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    memory.set(p.id, record);
    return record;
  },
  async get(id) { return memory.get(id) || null; },
  async byOrder(orderId) { return [...memory.values()].filter(p => p.orderId === orderId); },
  async update(id, { status, razorpayPaymentId }) {
    const record = memory.get(id);
    if (!record) return null;
    if (status) record.status = status;
    if (razorpayPaymentId) record.razorpayPaymentId = razorpayPaymentId;
    record.updatedAt = new Date().toISOString();
    return record;
  },
  async logEvent(e) {
    memoryEvents.push({ ...e, createdAt: new Date().toISOString() });
    if (memoryEvents.length > 1000) memoryEvents.shift();
  },
  async ping() {}
};

const audit = createAuditLogger({ pool, logger, service: SERVICE_NAME });

function logPaymentEvent(req, event) {
  store.logEvent(event).catch((err) =>
    req.log.warn({ event: 'payment_event_log_failed', message: err.message }, 'payment event not persisted'));
}

// --- Payment instrument validation (mock provider) -----------------------
// The mock gateway now behaves like a real one: it refuses to "charge"
// unless valid instrument details are presented. Card data is validated
// (Luhn, expiry, CVV) and immediately discarded — only brand + last4 are
// kept, keeping the service out of PAN-storage scope.
function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function cardBrand(pan) {
  if (/^4/.test(pan)) return 'visa';
  if (/^5[1-5]/.test(pan) || /^2[2-7]/.test(pan)) return 'mastercard';
  if (/^3[47]/.test(pan)) return 'amex';
  if (/^6/.test(pan)) return 'rupay/discover';
  return 'card';
}

function validateCard({ cardNumber, expiry, cvv }) {
  const pan = String(cardNumber || '').replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(pan)) return { error: 'cardNumber must be 13-19 digits' };
  if (!luhnValid(pan)) return { error: 'cardNumber failed validation (Luhn check)' };
  const m = String(expiry || '').match(/^(\d{2})\s*\/\s*(\d{2}|\d{4})$/);
  if (!m) return { error: 'expiry must be in MM/YY format' };
  const month = Number(m[1]);
  const year = Number(m[2].length === 2 ? '20' + m[2] : m[2]);
  if (month < 1 || month > 12) return { error: 'expiry month is invalid' };
  const endOfMonth = new Date(Date.UTC(year, month, 1));
  if (endOfMonth <= new Date()) return { error: 'card has expired' };
  if (!/^\d{3,4}$/.test(String(cvv || ''))) return { error: 'cvv must be 3 or 4 digits' };
  return { summary: `${cardBrand(pan)} •••• ${pan.slice(-4)}` };
}

function validateUpi({ vpa }) {
  if (!/^[a-zA-Z0-9._-]{2,64}@[a-zA-Z]{2,32}$/.test(String(vpa || ''))) {
    return { error: 'vpa must look like name@bank' };
  }
  return { summary: `upi ${String(vpa).replace(/^(..).*(@.*)$/, '$1***$2')}` };
}

function validateInstrument(method, body) {
  if (method === 'card') return validateCard(body);
  if (method === 'upi') return validateUpi(body);
  if (method === 'cod') return { summary: 'cash on delivery' };
  return { error: 'method must be one of card, upi, cod' };
}

const app = express();
app.set('trust proxy', true);
// Keep the raw body around: Razorpay webhook signatures are computed over
// the exact bytes received, so re-serialising parsed JSON would break HMAC.
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(pinoHttp({
  logger,
  customProps: (req) => {
    const info = clientInfo(req);
    return { requestId: info.requestId, clientIp: info.ip, browser: info.browser, os: info.os, device: info.device };
  }
}));

// --- Kubernetes probes -------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok', service: SERVICE_NAME, provider: RAZORPAY_ENABLED ? 'razorpay' : 'mock', storage: store.mode }));
app.get('/ready', async (req, res) => {
  try {
    await store.ping();
    res.json({ ready: true, service: SERVICE_NAME, storage: store.mode });
  } catch (err) {
    req.log.error({ event: 'readiness_failed', message: err.message }, 'database unreachable');
    res.status(503).json({ ready: false, error: 'database unreachable' });
  }
});

const timingSafeEqualHex = (a, b) => {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};

// Tell the order service a payment succeeded (used by the Razorpay verify
// and webhook paths so orders confirm even if the browser dies mid-flow).
async function confirmOrder(orderId, paymentId, log) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${ORDER_SERVICE_URL}/orders/${encodeURIComponent(orderId)}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paymentId }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    log.info({ event: 'order_confirm_relayed', orderId, paymentId, status: res.status }, 'order confirmation relayed');
  } catch (err) {
    log.warn({ event: 'order_confirm_relay_failed', orderId, paymentId, message: err.message }, 'order service unreachable — client confirm will cover it');
  }
}

// --- Razorpay: create an order ------------------------------------------
app.post('/payments/razorpay/order', async (req, res) => {
  if (!RAZORPAY_ENABLED) {
    return res.status(503).json({ error: 'Razorpay is not configured (set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)' });
  }
  const info = clientInfo(req);
  const { orderId, amount, currency } = req.body || {};
  if (!orderId || !amount || Number(amount) <= 0) {
    return res.status(400).json({ error: 'orderId and a positive amount are required' });
  }
  try {
    const rzpOrder = await razorpay.orders.create({
      amount: Math.round(Number(amount) * 100), // rupees -> paise
      currency: currency || 'INR',
      receipt: String(orderId),
      notes: { bakeryOrderId: String(orderId) }
    });
    const record = await store.create({
      id: rzpOrder.id,
      provider: 'razorpay',
      orderId: String(orderId),
      amount: Number(amount),
      currency: rzpOrder.currency,
      status: 'created'
    });
    logPaymentEvent(req, { paymentId: rzpOrder.id, orderId: String(orderId), event: 'razorpay_order_created', status: 'created', amount: Number(amount), currency: rzpOrder.currency, ip: info.ip, requestId: info.requestId });
    req.log.info({ event: 'razorpay_order_created', razorpayOrderId: rzpOrder.id, orderId, amount, ip: info.ip, requestId: info.requestId }, 'razorpay order created');
    res.status(201).json({ ...record, razorpayOrderId: rzpOrder.id, keyId: RAZORPAY_KEY_ID });
  } catch (err) {
    req.log.error({ event: 'razorpay_order_failed', orderId, message: err.message }, 'razorpay order creation failed');
    res.status(502).json({ error: 'Failed to create Razorpay order' });
  }
});

// --- Razorpay: verify a checkout payment ---------------------------------
app.post('/payments/razorpay/verify', async (req, res) => {
  if (!RAZORPAY_ENABLED) {
    return res.status(503).json({ error: 'Razorpay is not configured' });
  }
  const info = clientInfo(req);
  const { razorpay_order_id: rzpOrderId, razorpay_payment_id: rzpPaymentId, razorpay_signature: signature } = req.body || {};
  if (!rzpOrderId || !rzpPaymentId || !signature) {
    return res.status(400).json({ error: 'razorpay_order_id, razorpay_payment_id and razorpay_signature are required' });
  }
  const expected = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${rzpOrderId}|${rzpPaymentId}`)
    .digest('hex');
  if (!timingSafeEqualHex(expected, signature)) {
    req.log.warn({ event: 'razorpay_signature_invalid', razorpayOrderId: rzpOrderId, ip: info.ip, requestId: info.requestId }, 'signature verification failed');
    logPaymentEvent(req, { paymentId: rzpOrderId, event: 'razorpay_verify_failed', status: 'signature_invalid', ip: info.ip, requestId: info.requestId });
    return res.status(400).json({ verified: false, error: 'Invalid payment signature' });
  }
  try {
    const record = await store.update(rzpOrderId, { status: 'paid', razorpayPaymentId: rzpPaymentId });
    logPaymentEvent(req, { paymentId: rzpOrderId, orderId: record && record.orderId, event: 'razorpay_verified', status: 'paid', ip: info.ip, requestId: info.requestId });
    audit.record({ ...info, action: 'payment', success: true, statusCode: 200, metadata: { provider: 'razorpay', paymentId: rzpOrderId, razorpayPaymentId: rzpPaymentId } });
    if (record && record.orderId) await confirmOrder(record.orderId, rzpOrderId, req.log);
    req.log.info({ event: 'razorpay_payment_verified', razorpayOrderId: rzpOrderId, razorpayPaymentId: rzpPaymentId, ip: info.ip, requestId: info.requestId }, 'payment verified');
    res.json({ verified: true, razorpayOrderId: rzpOrderId, razorpayPaymentId: rzpPaymentId, status: 'paid', payment: record });
  } catch (err) {
    req.log.error({ event: 'payment_update_failed', message: err.message }, 'failed to persist verification');
    res.status(500).json({ error: 'Payment verified but could not be persisted' });
  }
});

// --- Razorpay: webhook ----------------------------------------------------
app.post('/payments/razorpay/webhook', async (req, res) => {
  if (!RAZORPAY_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Webhook secret not configured (set RAZORPAY_WEBHOOK_SECRET)' });
  }
  const signature = req.headers['x-razorpay-signature'];
  if (!signature || !req.rawBody) {
    return res.status(400).json({ error: 'Missing signature or body' });
  }
  const expected = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(req.rawBody).digest('hex');
  if (!timingSafeEqualHex(expected, String(signature))) {
    req.log.warn({ event: 'razorpay_webhook_invalid' }, 'webhook signature verification failed');
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }
  const eventType = req.body && req.body.event;
  const paymentEntity = req.body && req.body.payload && req.body.payload.payment && req.body.payload.payment.entity;
  try {
    if (paymentEntity && paymentEntity.order_id) {
      let status = null;
      if (eventType === 'payment.captured') status = 'paid';
      else if (eventType === 'payment.failed') status = 'failed';
      if (status) {
        const record = await store.update(paymentEntity.order_id, { status, razorpayPaymentId: paymentEntity.id });
        logPaymentEvent(req, { paymentId: paymentEntity.order_id, orderId: record && record.orderId, event: `webhook_${eventType}`, status });
        if (status === 'paid' && record && record.orderId) await confirmOrder(record.orderId, paymentEntity.order_id, req.log);
      }
    }
    req.log.info({ event: 'razorpay_webhook', webhookEvent: eventType }, 'webhook processed');
    res.json({ received: true });
  } catch (err) {
    req.log.error({ event: 'webhook_persist_failed', message: err.message }, 'failed to persist webhook update');
    // 500 so Razorpay retries the delivery.
    res.status(500).json({ error: 'Failed to persist webhook event' });
  }
});

// --- Mock provider (local dev without Razorpay keys) ---------------------
// Now requires real-looking instrument details; the pre-fix behaviour of
// silently "succeeding" with no card/UPI data is gone.
app.post('/payments', async (req, res) => {
  const info = clientInfo(req);
  const { orderId, amount, method } = req.body || {};
  if (!orderId || !amount || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'orderId and a positive amount are required' });
  }
  const chosenMethod = String(method || '').toLowerCase();
  const instrument = validateInstrument(chosenMethod, req.body || {});
  if (instrument.error) {
    req.log.warn({
      event: 'payment_rejected', orderId, method: chosenMethod, failureReason: instrument.error,
      ip: info.ip, requestId: info.requestId, browser: info.browser, device: info.device
    }, 'payment instrument validation failed');
    logPaymentEvent(req, { orderId: String(orderId), event: 'payment_rejected', status: 'rejected', amount: Number(amount), ip: info.ip, requestId: info.requestId, detail: { reason: instrument.error, method: chosenMethod } });
    audit.record({ ...info, action: 'payment', success: false, statusCode: 400, failureReason: instrument.error, metadata: { orderId, method: chosenMethod } });
    return res.status(400).json({ error: instrument.error });
  }
  try {
    const payment = await store.create({
      id: 'pay_' + crypto.randomBytes(8).toString('hex'),
      provider: 'mock',
      orderId: String(orderId),
      amount: Number(amount),
      currency: (req.body && req.body.currency) || 'INR',
      method: chosenMethod,
      status: chosenMethod === 'cod' ? 'pending' : 'succeeded',
      instrumentSummary: instrument.summary
    });
    logPaymentEvent(req, { paymentId: payment.id, orderId: String(orderId), event: 'payment_captured', status: payment.status, amount: Number(amount), currency: payment.currency, ip: info.ip, requestId: info.requestId, detail: { method: chosenMethod, instrument: instrument.summary } });
    audit.record({ ...info, action: 'payment', success: true, statusCode: 201, metadata: { paymentId: payment.id, orderId, method: chosenMethod, amount: Number(amount), instrument: instrument.summary } });
    req.log.info({
      event: 'payment_captured', paymentId: payment.id, orderId, amount, method: chosenMethod,
      instrument: instrument.summary, ip: info.ip, requestId: info.requestId, browser: info.browser, device: info.device
    }, 'payment processed');
    res.status(201).json(payment);
  } catch (err) {
    req.log.error({ event: 'payment_create_failed', message: err.message }, 'failed to persist payment');
    res.status(500).json({ error: 'Failed to store payment' });
  }
});

// Transactions for a bakery order (must come before /payments/:id).
app.get('/payments/order/:orderId', async (req, res) => {
  const rows = await store.byOrder(req.params.orderId);
  res.json(rows);
});

app.get('/payments/:id', async (req, res) => {
  const payment = await store.get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  res.json(payment);
});

// --- 404 + error handling ----------------------------------------------
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars -- Express error signature
  req.log.error({ event: 'unhandled_error', message: err.message }, 'request failed');
  res.status(500).json({ error: 'Internal server error' });
});

function start() {
  let server;
  store.init()
    .then(() => {
      server = app.listen(PORT, () => logger.info({ event: 'service_started', port: PORT, razorpay: RAZORPAY_ENABLED, storage: store.mode }, `${SERVICE_NAME} listening`));
    })
    .catch((err) => {
      logger.error({ event: 'startup_failed', message: err.message }, 'could not initialise storage');
      process.exit(1);
    });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      logger.info({ event: 'shutdown', signal }, 'shutting down gracefully');
      if (server) server.close(() => process.exit(0)); else process.exit(0);
    });
  }
}

if (require.main === module) start();

module.exports = { app, store, validateCard, validateUpi, luhnValid };
