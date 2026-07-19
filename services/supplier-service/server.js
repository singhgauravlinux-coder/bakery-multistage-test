'use strict';
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');

const SERVICE_NAME = process.env.SERVICE_NAME || 'supplier-service';
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

// --- Flour mills and dairy suppliers ---
const suppliers = [
  { id: 's-1', name: 'Moulin de la Colline', supplies: ['T65 flour', 'T80 flour', 'rye flour'] },
  { id: 's-2', name: 'Alpine Dairy Collective', supplies: ['cultured butter', 'milk', 'cream'] },
  { id: 's-3', name: 'Orchard & Stone', supplies: ['sour cherries', 'walnuts', 'pistachios'] }
];
const purchaseOrders = { 's-1': [{ id: 'po-101', item: 'T65 flour', kg: 500, status: 'in_transit' }], 's-2': [{ id: 'po-102', item: 'cultured butter', kg: 80, status: 'delivered' }] };

app.get('/suppliers', (req, res) => res.json(suppliers));

app.get('/suppliers/:id/orders', (req, res) => {
  if (!suppliers.find(s => s.id === req.params.id)) return res.status(404).json({ error: 'Supplier not found' });
  res.json(purchaseOrders[req.params.id] || []);
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
