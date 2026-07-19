'use strict';
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');

const SERVICE_NAME = process.env.SERVICE_NAME || 'review-service';
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

// --- Product reviews ---
const reviews = [
  { id: 'r-1', productId: 'p-1', userId: 'u-2', rating: 5, text: 'The crust shatters exactly the way it should.' },
  { id: 'r-2', productId: 'p-4', userId: 'u-1', rating: 5, text: 'Best cardamom knot outside of Stockholm.' },
  { id: 'r-3', productId: 'p-3', userId: 'u-2', rating: 4, text: 'Flaky, deeply buttery. Sells out fast.' }
];

app.get('/reviews/:productId', (req, res) => {
  res.json(reviews.filter(r => r.productId === req.params.productId));
});

app.post('/reviews', (req, res) => {
  const { productId, userId, rating, text } = req.body || {};
  if (!productId || !rating) return res.status(400).json({ error: 'productId and rating are required' });
  const review = { id: 'r-' + (reviews.length + 1), productId, userId: userId || 'anonymous', rating: Math.min(5, Math.max(1, rating)), text: text || '' };
  reviews.push(review);
  req.log.info({ event: 'review_posted', productId, rating: review.rating }, 'review added');
  res.status(201).json(review);
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
