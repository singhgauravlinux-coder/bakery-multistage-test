'use strict';
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const { Pool } = require('pg');

const SERVICE_NAME = process.env.SERVICE_NAME || 'user-service';
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || '';

// All logs are structured JSON on stdout (12-factor), ready for
// Fluent Bit / Loki / ELK collection from the container runtime.
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: SERVICE_NAME, version: process.env.SERVICE_VERSION || '1.0.0' },
  formatters: { level: (label) => ({ level: label }) }
});

// --- Storage: PostgreSQL when DATABASE_URL is set, in-memory otherwise ---
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, max: 10 }) : null;
if (pool) pool.on('error', (err) => logger.error({ event: 'pg_pool_error', message: err.message }, 'postgres pool error'));

const memory = {
  'u-1': { id: 'u-1', name: 'Amelie Fournier', email: 'amelie@crumbandember.dev', address: '12 Rue du Levain', dietary: ['nut-free'] },
  'u-2': { id: 'u-2', name: 'Tomas Iversen', email: 'tomas@example.com', address: '8 Rye Lane', dietary: [] }
};

const store = pool ? {
  mode: 'postgres',
  async list() {
    const { rows } = await pool.query('SELECT id, name, email, address, dietary FROM profiles ORDER BY id');
    return rows;
  },
  async get(id) {
    const { rows } = await pool.query('SELECT id, name, email, address, dietary FROM profiles WHERE id = $1', [id]);
    return rows[0] || null;
  },
  async update(id, patch) {
    const { rows } = await pool.query(
      `UPDATE profiles SET
         name    = COALESCE($2, name),
         email   = COALESCE($3, email),
         address = COALESCE($4, address),
         dietary = COALESCE($5::jsonb, dietary)
       WHERE id = $1
       RETURNING id, name, email, address, dietary`,
      [id, patch.name ?? null, patch.email ?? null, patch.address ?? null,
       patch.dietary !== undefined ? JSON.stringify(patch.dietary) : null]);
    return rows[0] || null;
  },
  async ping() { await pool.query('SELECT 1'); }
} : {
  mode: 'memory',
  async list() { return Object.values(memory); },
  async get(id) { return memory[id] || null; },
  async update(id, patch) {
    if (!memory[id]) return null;
    memory[id] = { ...memory[id], ...patch, id };
    return memory[id];
  },
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
    req.log.warn({ event: 'readiness_failed', message: err.message }, 'database unreachable');
    res.status(503).json({ ready: false, service: SERVICE_NAME, storage: store.mode });
  }
});

// --- Customer profiles and addresses ---
app.get('/users', async (req, res, next) => {
  try { res.json(await store.list()); } catch (err) { next(err); }
});

app.get('/users/:id', async (req, res, next) => {
  try {
    const user = await store.get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) { next(err); }
});

app.put('/users/:id', async (req, res, next) => {
  try {
    const user = await store.update(req.params.id, req.body || {});
    if (!user) return res.status(404).json({ error: 'User not found' });
    req.log.info({ event: 'user_updated', userId: req.params.id }, 'profile updated');
    res.json(user);
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
    server.close(async () => { if (pool) await pool.end().catch(() => {}); process.exit(0); });
  });
}
