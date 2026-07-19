'use strict';
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');

const SERVICE_NAME = process.env.SERVICE_NAME || 'loyalty-service';
const PORT = Number(process.env.PORT || 3000);

// All logs are structured JSON on stdout (12-factor), ready for
// Fluent Bit / Loki / ELK collection from the container runtime.
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: SERVICE_NAME, version: process.env.SERVICE_VERSION || '1.0.0' },
  formatters: { level: (label) => ({ level: label }) }
});

const app = express();
app.use(express.json());
app.use(pinoHttp({
  logger,
  customProps: (req) => ({ requestId: req.headers['x-request-id'] || undefined })
}));

// --- Kubernetes probes -------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok', service: SERVICE_NAME }));
app.get('/ready', (req, res) => res.json({ ready: true, service: SERVICE_NAME }));

// --- Crumbs — the loyalty points program ---
const balances = { 'u-1': 240, 'u-2': 85 };

app.get('/loyalty/:userId', (req, res) => {
  res.json({ userId: req.params.userId, points: balances[req.params.userId] || 0, tier: (balances[req.params.userId] || 0) >= 200 ? 'golden-crust' : 'proofing' });
});

app.post('/loyalty/:userId/earn', (req, res) => {
  const points = Number((req.body && req.body.points) || 0);
  balances[req.params.userId] = (balances[req.params.userId] || 0) + points;
  req.log.info({ event: 'points_earned', userId: req.params.userId, points, balance: balances[req.params.userId] }, 'loyalty points added');
  res.json({ userId: req.params.userId, points: balances[req.params.userId] });
});

// --- 404 + error handling ----------------------------------------------
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  req.log.error({ event: 'unhandled_error', message: err.message }, 'request failed');
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => logger.info({ event: 'service_started', port: PORT }, `${SERVICE_NAME} listening`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    logger.info({ event: 'shutdown', signal }, 'shutting down gracefully');
    server.close(() => process.exit(0));
  });
}
