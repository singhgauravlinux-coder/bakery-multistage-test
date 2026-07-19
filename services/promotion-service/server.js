'use strict';
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');

const SERVICE_NAME = process.env.SERVICE_NAME || 'promotion-service';
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

// --- Discount codes ---
const promos = { CRUMB10: { percentOff: 10, active: true }, DAYOLD50: { percentOff: 50, active: true }, WINTER: { percentOff: 15, active: false } };

app.get('/promotions', (req, res) => {
  res.json(Object.entries(promos).filter(([, p]) => p.active).map(([code, p]) => ({ code, ...p })));
});

app.post('/promotions/validate', (req, res) => {
  const code = String((req.body && req.body.code) || '').toUpperCase();
  const promo = promos[code];
  const valid = Boolean(promo && promo.active);
  req.log.info({ event: 'promo_validated', code, valid }, 'promotion checked');
  if (!valid) return res.status(404).json({ code, valid: false });
  res.json({ code, valid: true, percentOff: promo.percentOff });
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
