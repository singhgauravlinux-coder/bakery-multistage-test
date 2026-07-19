'use strict';
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');

const SERVICE_NAME = process.env.SERVICE_NAME || 'baking-schedule-service';
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

// --- What comes out of the oven, and when ---
const schedule = [
  { time: '06:30', product: 'Baguette Tradition', batch: 40 },
  { time: '07:00', product: 'Butter Croissant', batch: 60 },
  { time: '07:15', product: 'Pain au Chocolat', batch: 48 },
  { time: '08:00', product: 'Levain Country Loaf', batch: 24 },
  { time: '09:30', product: 'Cardamom Knot', batch: 40 },
  { time: '11:00', product: 'Focaccia al Rosmarino', batch: 20 },
  { time: '13:00', product: 'Sour Cherry Galette', batch: 12 },
  { time: '15:30', product: 'Second bake: Baguette Tradition', batch: 40 }
];

app.get('/schedule/today', (req, res) => {
  req.log.info({ event: 'schedule_served', bakes: schedule.length }, "today's schedule served");
  res.json({ date: new Date().toISOString().slice(0, 10), bakes: schedule });
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
