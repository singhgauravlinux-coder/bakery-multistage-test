'use strict';
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');

const SERVICE_NAME = process.env.SERVICE_NAME || 'search-service';
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

// --- Full-text search across the catalog ---
const index = [
  { id: 'p-1', name: 'Levain Country Loaf', terms: 'sourdough bread levain country loaf' },
  { id: 'p-2', name: 'Seeded Rye', terms: 'rye bread seeded danish' },
  { id: 'p-3', name: 'Butter Croissant', terms: 'croissant butter pastry viennoiserie' },
  { id: 'p-4', name: 'Cardamom Knot', terms: 'cardamom bun knot swedish' },
  { id: 'p-5', name: 'Pain au Chocolat', terms: 'chocolate pain au chocolat pastry' },
  { id: 'p-8', name: 'Sour Cherry Galette', terms: 'cherry galette pie tart' },
  { id: 'p-10', name: 'Baguette Tradition', terms: 'baguette french bread tradition' },
  { id: 'p-12', name: 'Espresso Walnut Babka', terms: 'babka espresso walnut brioche' }
];

app.get('/search', (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  if (!q) return res.status(400).json({ error: 'query parameter q is required' });
  const hits = index.filter(d => d.terms.includes(q) || d.name.toLowerCase().includes(q));
  req.log.info({ event: 'search_executed', query: q, hits: hits.length }, 'search served');
  res.json({ query: q, hits });
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
