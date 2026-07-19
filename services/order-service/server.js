'use strict';
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const { Pool } = require('pg');
const { clientInfo } = require('./lib/client-info');
const { createAuditLogger } = require('./lib/audit');

const SERVICE_NAME = process.env.SERVICE_NAME || 'order-service';
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || '';
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://payment-service:3008';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: SERVICE_NAME, version: process.env.SERVICE_VERSION || '1.0.0' },
  formatters: { level: (label) => ({ level: label }) }
});

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, max: 10 }) : null;
if (pool) pool.on('error', (err) => logger.error({ event: 'pg_pool_error', message: err.message }, 'postgres pool error'));

// Self-migrating (idempotent) — mirrored in db/migrations/0004_orders_payment_gating.sql.
const MIGRATION = `
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'card';
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'paid';
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_id     TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS amount         NUMERIC(10,2);
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS currency       TEXT NOT NULL DEFAULT 'EUR';
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at        TIMESTAMPTZ;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_payment_id ON orders (payment_id) WHERE payment_id IS NOT NULL;
`;

const ORDER_ROW = `id, user_id AS "userId", items, pickup_time AS "pickupTime", status,
  payment_method AS "paymentMethod", payment_status AS "paymentStatus", payment_id AS "paymentId",
  amount, currency, paid_at AS "paidAt", created_at AS "createdAt"`;

const memory = { orders: new Map(), seq: 1000 };

const store = pool ? {
  mode: 'postgres',
  async init() { await pool.query(MIGRATION); },
  async create(o) {
    const { rows } = await pool.query(
      `INSERT INTO orders (id, user_id, items, pickup_time, status, payment_method, payment_status, amount, currency)
       VALUES ('ord-' || nextval('order_seq'), $1, $2::jsonb, $3, $4, $5, $6, $7, $8)
       RETURNING ${ORDER_ROW}`,
      [o.userId, JSON.stringify(o.items), o.pickupTime || null, o.status, o.paymentMethod, o.paymentStatus, o.amount, o.currency]);
    return rows[0];
  },
  async list() {
    const { rows } = await pool.query(`SELECT ${ORDER_ROW} FROM orders ORDER BY created_at DESC LIMIT 500`);
    return rows;
  },
  async get(id) {
    const { rows } = await pool.query(`SELECT ${ORDER_ROW} FROM orders WHERE id = $1`, [id]);
    return rows[0] || null;
  },
  async confirmPaid(id, paymentId) {
    const { rows } = await pool.query(
      `UPDATE orders SET status = 'received', payment_status = 'paid', payment_id = $2, paid_at = now()
       WHERE id = $1 AND status = 'pending_payment'
       RETURNING ${ORDER_ROW}`, [id, paymentId]);
    return rows[0] || null;
  },
  async setStatus(id, status) {
    const { rows } = await pool.query(
      `UPDATE orders SET status = COALESCE($2, status) WHERE id = $1 RETURNING ${ORDER_ROW}`,
      [id, status || null]);
    return rows[0] || null;
  },
  async ping() { await pool.query('SELECT 1'); }
} : {
  mode: 'memory',
  async init() {},
  async create(o) {
    const id = 'ord-' + (++memory.seq);
    const order = {
      id, userId: o.userId, items: o.items, pickupTime: o.pickupTime || null,
      status: o.status, paymentMethod: o.paymentMethod, paymentStatus: o.paymentStatus,
      paymentId: null, amount: o.amount, currency: o.currency, paidAt: null,
      createdAt: new Date().toISOString()
    };
    memory.orders.set(id, order);
    return order;
  },
  async list() { return [...memory.orders.values()]; },
  async get(id) { return memory.orders.get(id) || null; },
  async confirmPaid(id, paymentId) {
    const order = memory.orders.get(id);
    if (!order || order.status !== 'pending_payment') return null;
    order.status = 'received';
    order.paymentStatus = 'paid';
    order.paymentId = paymentId;
    order.paidAt = new Date().toISOString();
    return order;
  },
  async setStatus(id, status) {
    const order = memory.orders.get(id);
    if (!order) return null;
    if (status) order.status = status;
    return order;
  },
  async ping() {}
};

const audit = createAuditLogger({ pool, logger, service: SERVICE_NAME });

// Server-to-server payment verification: an order is only confirmed when
// the payment service says the referenced payment succeeded, belongs to
// this order, and matches the order amount/currency.
async function fetchPayment(paymentId) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`${PAYMENT_SERVICE_URL}/payments/${encodeURIComponent(paymentId)}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } finally { clearTimeout(timer); }
}

function validatePaymentForOrder(payment, order) {
  if (!payment) return 'payment_not_found';
  if (String(payment.orderId) !== String(order.id)) return 'payment_belongs_to_other_order';
  if (!['succeeded', 'paid'].includes(payment.status)) return `payment_status_${payment.status}`;
  if (order.amount !== null && Math.abs(Number(payment.amount) - Number(order.amount)) > 0.01) return 'amount_mismatch';
  return null;
}

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(pinoHttp({
  logger,
  customProps: (req) => {
    const info = clientInfo(req);
    return { requestId: info.requestId, clientIp: info.ip, browser: info.browser, os: info.os, device: info.device };
  }
}));

// --- Kubernetes probes -------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok', service: SERVICE_NAME }));
app.get('/ready', async (req, res) => {
  try {
    await store.ping();
    res.json({ ready: true, service: SERVICE_NAME, storage: store.mode });
  } catch (err) {
    req.log.warn({ event: 'readiness_failed', message: err.message }, 'database unreachable');
    res.status(503).json({ ready: false, service: SERVICE_NAME, storage: store.mode });
  }
});

// --- Order lifecycle ---
// Orders are created in `pending_payment` and only become `received` once
// the payment service confirms a successful charge (POST /orders/:id/confirm).
// The single exception is Cash-on-Delivery, which is `received` immediately
// with payment_status `cod_pending`.
app.post('/orders', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const { userId, items, pickupTime, paymentMethod, amount, currency } = req.body || {};
    if (!userId || !Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: 'userId and a non-empty items array are required' });
    const method = String(paymentMethod || 'card').toLowerCase();
    if (!['card', 'upi', 'cod', 'razorpay'].includes(method))
      return res.status(400).json({ error: 'paymentMethod must be one of card, upi, cod, razorpay' });
    const numericAmount = amount === undefined || amount === null ? null : Number(amount);
    if (method !== 'cod' && (numericAmount === null || !Number.isFinite(numericAmount) || numericAmount <= 0))
      return res.status(400).json({ error: 'a positive amount is required for prepaid orders' });

    const isCod = method === 'cod';
    const order = await store.create({
      userId, items, pickupTime,
      status: isCod ? 'received' : 'pending_payment',
      paymentMethod: method,
      paymentStatus: isCod ? 'cod_pending' : 'awaiting_payment',
      amount: numericAmount,
      currency: currency || 'EUR'
    });
    req.log.info({
      event: 'order_created', orderId: order.id, userId, itemCount: items.length,
      paymentMethod: method, status: order.status, amount: numericAmount,
      ip: info.ip, requestId: info.requestId, browser: info.browser, device: info.device
    }, isCod ? 'COD order received' : 'order awaiting payment');
    audit.record({
      ...info, action: 'order_created', userId, success: true, statusCode: 201,
      metadata: { orderId: order.id, paymentMethod: method, status: order.status, amount: numericAmount }
    });
    res.status(201).json(order);
  } catch (err) { next(err); }
});

// Confirm a pending order after a successful payment. Verified against the
// payment service — the client cannot mark an order paid on its own say-so.
app.post('/orders/:id/confirm', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const { paymentId } = req.body || {};
    if (!paymentId) return res.status(400).json({ error: 'paymentId is required' });
    const order = await store.get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending_payment') {
      return res.status(409).json({ error: `Order is not awaiting payment (status: ${order.status})` });
    }

    let payment = null;
    try {
      payment = await fetchPayment(paymentId);
    } catch (err) {
      req.log.error({ event: 'payment_lookup_failed', orderId: order.id, paymentId, message: err.message }, 'payment service unreachable');
      return res.status(502).json({ error: 'Could not verify payment — please retry' });
    }
    const failureReason = validatePaymentForOrder(payment, order);
    if (failureReason) {
      req.log.warn({
        event: 'order_confirm_rejected', orderId: order.id, paymentId, failureReason,
        ip: info.ip, requestId: info.requestId
      }, 'payment verification failed');
      audit.record({
        ...info, action: 'order_confirmed', userId: order.userId, success: false,
        statusCode: 402, failureReason, metadata: { orderId: order.id, paymentId }
      });
      return res.status(402).json({ error: 'Payment could not be verified for this order', reason: failureReason });
    }

    const confirmed = await store.confirmPaid(order.id, paymentId);
    if (!confirmed) return res.status(409).json({ error: 'Order was already confirmed' });
    req.log.info({
      event: 'order_confirmed', orderId: confirmed.id, paymentId, userId: confirmed.userId,
      ip: info.ip, requestId: info.requestId
    }, 'order confirmed after verified payment');
    audit.record({
      ...info, action: 'order_confirmed', userId: confirmed.userId, success: true,
      statusCode: 200, metadata: { orderId: confirmed.id, paymentId }
    });
    res.json(confirmed);
  } catch (err) { next(err); }
});

app.get('/orders', async (req, res, next) => {
  try { res.json(await store.list()); } catch (err) { next(err); }
});

app.get('/orders/:id', async (req, res, next) => {
  try {
    const order = await store.get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) { next(err); }
});

app.put('/orders/:id/status', async (req, res, next) => {
  try {
    const order = await store.setStatus(req.params.id, req.body && req.body.status);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    req.log.info({ event: 'order_status_changed', orderId: order.id, status: order.status }, 'order status updated');
    res.json(order);
  } catch (err) { next(err); }
});

// --- 404 + error handling ----------------------------------------------
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars -- Express error signature
  req.log.error({ event: 'unhandled_error', message: err.message }, 'request failed');
  res.status(500).json({ error: 'Internal server error' });
});

function start() {
  const server = app.listen(PORT, () => {
    logger.info({ event: 'service_started', port: PORT, storage: store.mode }, `${SERVICE_NAME} listening`);
    store.init().catch((err) =>
      logger.warn({ event: 'migration_deferred', message: err.message }, 'orders migration will run when the database is up'));
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      logger.info({ event: 'shutdown', signal }, 'shutting down gracefully');
      server.close(async () => { if (pool) await pool.end().catch(() => {}); process.exit(0); });
    });
  }
  return server;
}

if (require.main === module) start();

module.exports = { app, store, validatePaymentForOrder };
