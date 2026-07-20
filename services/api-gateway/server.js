'use strict';
const crypto = require('crypto');
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const swaggerUi = require('swagger-ui-express');
const openapiSpec = require('./openapi');

const SERVICE_NAME = process.env.SERVICE_NAME || 'api-gateway';
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
app.set('trust proxy', true);
app.use(express.json());
app.use(pinoHttp({
  logger,
  customProps: (req) => ({ requestId: req.headers['x-request-id'] || undefined })
}));

// --- Kubernetes probes -------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok', service: SERVICE_NAME }));
app.get('/ready', (req, res) => res.json({ ready: true, service: SERVICE_NAME }));

// --- Routes /api/* traffic to domain services ---
// Path prefix -> upstream Kubernetes service (cluster DNS). Under
// docker-compose the same names resolve via the compose network.
const routes = {
  '/api/auth':            'http://auth-service:3001',
  '/api/users':           'http://user-service:3002',
  '/api/products':        'http://product-catalog-service:3003',
  '/api/stock':           'http://inventory-service:3004',
  '/api/prices':          'http://pricing-service:3005',
  '/api/quote':           'http://pricing-service:3005',
  '/api/carts':           'http://cart-service:3006',
  '/api/orders':          'http://order-service:3007',
  '/api/payments':        'http://payment-service:3008',
  '/api/deliveries':      'http://delivery-service:3009',
  '/api/notify':          'http://notification-service:3010',
  '/api/reviews':         'http://review-service:3011',
  '/api/search':          'http://search-service:3012',
  '/api/recommendations': 'http://recommendation-service:3013',
  '/api/promotions':      'http://promotion-service:3014',
  '/api/loyalty':         'http://loyalty-service:3015',
  '/api/recipes':         'http://recipe-service:3016',
  '/api/schedule':        'http://baking-schedule-service:3017',
  '/api/suppliers':       'http://supplier-service:3018',
  '/api/events':          'http://analytics-service:3019',
  '/api/metrics':         'http://analytics-service:3019',
  '/api/media':           'http://media-service:3020',
  '/api/invoices':        'http://invoice-service:3021',
  '/api/currency':        'http://currency-service:3022',
  '/api/language':        'http://language-service:3023'
};

// Unique upstream service list, used by the /api/status aggregator.
const upstreams = [...new Set(Object.values(routes))].map((base) => ({
  name: new URL(base).hostname,
  url: base + '/health'
}));

// --- API root: human/machine-friendly index (fixes 404 on GET /api) ----
app.get(['/api', '/api/'], (req, res) => {
  res.json({
    service: SERVICE_NAME,
    message: 'Crumb & Ember API gateway',
    docs: '/api/docs',
    openapi: '/api/openapi.json',
    status: '/api/status',
    routes: Object.keys(routes)
  });
});

// --- Aggregated upstream health: one call to see the whole platform ----
app.get('/api/status', async (req, res) => {
  const checks = await Promise.all(upstreams.map(async (u) => {
    const started = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const r = await fetch(u.url, { signal: ctrl.signal });
      clearTimeout(timer);
      return [u.name, { up: r.ok, latencyMs: Date.now() - started }];
    } catch {
      return [u.name, { up: false, latencyMs: Date.now() - started }];
    }
  }));
  const services = Object.fromEntries(checks);
  const allUp = checks.every(([, v]) => v.up);
  res.status(200).json({ status: allUp ? 'ok' : 'degraded', gateway: 'ok', services });
});

// --- OpenAPI spec + Swagger UI ------------------------------------------
app.get('/api/openapi.json', (req, res) => res.json(openapiSpec));
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, {
  customSiteTitle: 'Crumb & Ember API',
  swaggerOptions: { displayRequestDuration: true, tryItOutEnabled: true }
}));

// --- Proxy: everything else under /api/* goes to the owning service ----
app.all('/api/*', async (req, res) => {
  const prefix = Object.keys(routes).find(p => req.path === p || req.path.startsWith(p + '/'));
  if (!prefix) {
    return res.status(404).json({
      error: 'No upstream for that path',
      hint: 'GET /api lists available route prefixes; interactive docs at /api/docs'
    });
  }
  const upstreamBase = process.env.UPSTREAM_OVERRIDE || routes[prefix];
  const upstreamPath = req.originalUrl.startsWith('/api')
    ? req.originalUrl.slice('/api'.length)
    : req.originalUrl;
  const requestId = req.headers['x-request-id'] || 'req_' + crypto.randomUUID();
  // Preserve the caller's identity for the upstream audit logs: append this
  // hop to X-Forwarded-For (never replacing what Traefik/Nginx already set)
  // and pass through X-Real-IP, User-Agent and Authorization untouched.
  const socketIp = (req.socket && req.socket.remoteAddress) || '';
  const forwardedFor = [req.headers['x-forwarded-for'], socketIp].filter(Boolean).join(', ');
  const headers = { 'content-type': 'application/json', 'x-request-id': requestId };
  if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;
  if (req.headers['x-real-ip']) headers['x-real-ip'] = req.headers['x-real-ip'];
  if (req.headers['cf-connecting-ip']) headers['cf-connecting-ip'] = req.headers['cf-connecting-ip'];
  if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent'];
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  if (req.headers['x-razorpay-signature']) headers['x-razorpay-signature'] = req.headers['x-razorpay-signature'];
  const started = Date.now();
  try {
    const upstreamRes = await fetch(upstreamBase + upstreamPath, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {})
    });
    const body = await upstreamRes.text();
    req.log.info({ event: 'proxy_request', upstream: upstreamBase, path: upstreamPath, status: upstreamRes.status, durationMs: Date.now() - started, requestId }, 'proxied');
    res.status(upstreamRes.status).type('application/json').send(body);
  } catch (err) {
    req.log.error({ event: 'proxy_error', upstream: upstreamBase, path: upstreamPath, message: err.message, requestId }, 'upstream unavailable');
    res.status(502).json({ error: 'Upstream service unavailable', upstream: new URL(upstreamBase).hostname });
  }
});

// --- 404 + error handling ----------------------------------------------
app.use((req, res) => res.status(404).json({ error: 'Route not found', hint: 'API lives under /api — see /api/docs' }));
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
