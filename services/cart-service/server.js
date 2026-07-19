'use strict';
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const { createClient } = require('redis');

const SERVICE_NAME = process.env.SERVICE_NAME || 'cart-service';
const PORT = Number(process.env.PORT || 3000);
const REDIS_URL = process.env.REDIS_URL || '';
const CART_TTL_SECONDS = Number(process.env.CART_TTL_SECONDS || 7 * 24 * 3600);

// All logs are structured JSON on stdout (12-factor), ready for
// Fluent Bit / Loki / ELK collection from the container runtime.
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: SERVICE_NAME, version: process.env.SERVICE_VERSION || '1.0.0' },
  formatters: { level: (label) => ({ level: label }) }
});

// --- Storage: Redis when REDIS_URL is set, in-memory otherwise ----------
let redis = null;
if (REDIS_URL) {
  redis = createClient({ url: REDIS_URL });
  redis.on('error', (err) => logger.error({ event: 'redis_error', message: err.message }, 'redis client error'));
  redis.connect().catch((err) =>
    logger.error({ event: 'redis_connect_failed', message: err.message }, 'initial redis connection failed, will retry'));
}

const memoryCarts = new Map();
const key = (userId) => `cart:${userId}`;

const store = redis ? {
  mode: 'redis',
  async get(userId) {
    const raw = await redis.get(key(userId));
    return raw ? JSON.parse(raw) : [];
  },
  async set(userId, items) {
    await redis.set(key(userId), JSON.stringify(items), { EX: CART_TTL_SECONDS });
  },
  async ping() { await redis.ping(); }
} : {
  mode: 'memory',
  async get(userId) { return memoryCarts.get(userId) || []; },
  async set(userId, items) { memoryCarts.set(userId, items); },
  async ping() {}
};

const app = express();
app.use(express.json());
app.use(pinoHttp({
  logger,
  customProps: (req) => ({ requestId: req.headers['x-request-id'] || undefined })
}));

// --- Kubernetes probes -------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok', service: SERVICE_NAME }));
app.get('/ready', async (req, res) => {
  try {
    await store.ping();
    res.json({ ready: true, service: SERVICE_NAME, storage: store.mode });
  } catch (err) {
    req.log.warn({ event: 'readiness_failed', message: err.message }, 'redis unreachable');
    res.status(503).json({ ready: false, service: SERVICE_NAME, storage: store.mode });
  }
});

// --- Shopping carts (Redis-backed with TTL) ---
app.get('/carts/:userId', async (req, res, next) => {
  try {
    res.json({ userId: req.params.userId, items: await store.get(req.params.userId) });
  } catch (err) { next(err); }
});

app.post('/carts/:userId/items', async (req, res, next) => {
  try {
    const { productId, quantity } = req.body || {};
    if (!productId) return res.status(400).json({ error: 'productId is required' });
    const items = await store.get(req.params.userId);
    const existing = items.find(i => i.productId === productId);
    if (existing) existing.quantity += quantity || 1;
    else items.push({ productId, quantity: quantity || 1 });
    await store.set(req.params.userId, items);
    req.log.info({ event: 'cart_item_added', userId: req.params.userId, productId }, 'item added to cart');
    res.status(201).json({ userId: req.params.userId, items });
  } catch (err) { next(err); }
});

app.delete('/carts/:userId/items/:productId', async (req, res, next) => {
  try {
    const items = (await store.get(req.params.userId)).filter(i => i.productId !== req.params.productId);
    await store.set(req.params.userId, items);
    req.log.info({ event: 'cart_item_removed', userId: req.params.userId, productId: req.params.productId }, 'item removed');
    res.json({ userId: req.params.userId, items });
  } catch (err) { next(err); }
});

app.delete('/carts/:userId', async (req, res, next) => {
  try {
    await store.set(req.params.userId, []);
    req.log.info({ event: 'cart_cleared', userId: req.params.userId }, 'cart cleared');
    res.json({ userId: req.params.userId, items: [] });
  } catch (err) { next(err); }
});

// --- 404 + error handling ----------------------------------------------
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  req.log.error({ event: 'unhandled_error', message: err.message }, 'request failed');
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () =>
  logger.info({ event: 'service_started', port: PORT, storage: store.mode }, `${SERVICE_NAME} listening`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    logger.info({ event: 'shutdown', signal }, 'shutting down gracefully');
    server.close(async () => { if (redis) await redis.quit().catch(() => {}); process.exit(0); });
  });
}
