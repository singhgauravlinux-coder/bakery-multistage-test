'use strict';
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');

const SERVICE_NAME = process.env.SERVICE_NAME || 'delivery-service';
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

// --- Bike delivery and pickup slots ---
const deliveries = new Map();

app.post('/deliveries', (req, res) => {
  const { orderId, address } = req.body || {};
  if (!orderId) return res.status(400).json({ error: 'orderId is required' });
  const delivery = { orderId, address: address || 'pickup at counter', mode: address ? 'bike' : 'pickup', status: 'scheduled', eta: new Date(Date.now() + 45 * 60000).toISOString() };
  deliveries.set(orderId, delivery);
  req.log.info({ event: 'delivery_scheduled', orderId, mode: delivery.mode }, 'delivery scheduled');
  res.status(201).json(delivery);
});

app.get('/deliveries/:orderId', (req, res) => {
  const delivery = deliveries.get(req.params.orderId);
  if (!delivery) return res.status(404).json({ error: 'No delivery for that order' });
  res.json(delivery);
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
