'use strict';
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');

const SERVICE_NAME = process.env.SERVICE_NAME || 'inventory-service';
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

// --- Stock levels per product per day ---
const stock = { 'p-1': 24, 'p-2': 18, 'p-3': 60, 'p-4': 40, 'p-5': 48, 'p-6': 30, 'p-7': 26, 'p-8': 12, 'p-9': 36, 'p-10': 80, 'p-11': 20, 'p-12': 10 };

app.get('/stock', (req, res) => res.json(stock));

app.get('/stock/:productId', (req, res) => {
  const qty = stock[req.params.productId];
  if (qty === undefined) return res.status(404).json({ error: 'Unknown product' });
  res.json({ productId: req.params.productId, quantity: qty, status: qty === 0 ? 'sold_out' : qty < 10 ? 'low' : 'in_stock' });
});

app.post('/stock/adjust', (req, res) => {
  const { productId, delta } = req.body || {};
  if (stock[productId] === undefined) return res.status(404).json({ error: 'Unknown product' });
  stock[productId] = Math.max(0, stock[productId] + Number(delta || 0));
  req.log.info({ event: 'stock_adjusted', productId, delta, newQuantity: stock[productId] }, 'stock level changed');
  res.json({ productId, quantity: stock[productId] });
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
