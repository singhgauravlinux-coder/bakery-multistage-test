'use strict';
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');

const SERVICE_NAME = process.env.SERVICE_NAME || 'pricing-service';
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

// --- Prices, VAT and order quotes ---
const VAT = 0.07;
const basePrices = { 'p-1': 8.50, 'p-2': 7.00, 'p-3': 4.25, 'p-4': 4.75, 'p-5': 4.50, 'p-6': 4.50, 'p-7': 3.75, 'p-8': 6.25, 'p-9': 3.50, 'p-10': 3.90, 'p-11': 5.50, 'p-12': 9.00 };

app.get('/prices/:productId', (req, res) => {
  const base = basePrices[req.params.productId];
  if (base === undefined) return res.status(404).json({ error: 'Unknown product' });
  res.json({ productId: req.params.productId, net: base, vat: +(base * VAT).toFixed(2), gross: +(base * (1 + VAT)).toFixed(2), currency: 'EUR' });
});

app.post('/quote', (req, res) => {
  const items = (req.body && req.body.items) || [];
  let net = 0;
  for (const item of items) net += (basePrices[item.productId] || 0) * (item.quantity || 1);
  const quote = { net: +net.toFixed(2), vat: +(net * VAT).toFixed(2), gross: +(net * (1 + VAT)).toFixed(2), currency: 'EUR' };
  req.log.info({ event: 'quote_created', itemCount: items.length, gross: quote.gross }, 'quote calculated');
  res.json(quote);
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
