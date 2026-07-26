'use strict';
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const swaggerUi = require('swagger-ui-express');
const openapiSpec = require('./openapi');

const SERVICE_NAME = process.env.SERVICE_NAME || 'api-gateway';
const PORT = Number(process.env.PORT || 3000);
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 5000);

// All logs are structured JSON on stdout (12-factor), ready for
// Fluent Bit / Loki / ELK collection from the container runtime.
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: SERVICE_NAME, version: process.env.SERVICE_VERSION || '1.0.0' },
  formatters: { level: (label) => ({ level: label }) }
});

// --- Upstream domain services --------------------------------------------
// Each entry maps the first path segment after the /api prefix to the
// owning service. Hostnames resolve via the in-cluster Kubernetes Service
// name; env var overrides exist for local/dev use (see docker-compose.yml).
const UPSTREAMS = {
  auth: process.env.AUTH_SERVICE_URL || 'http://auth-service:3001',
  users: process.env.USER_SERVICE_URL || 'http://user-service:3002',
  products: process.env.PRODUCT_CATALOG_SERVICE_URL || 'http://product-catalog-service:3003',
  stock: process.env.INVENTORY_SERVICE_URL || 'http://inventory-service:3004',
  prices: process.env.PRICING_SERVICE_URL || 'http://pricing-service:3005',
  quote: process.env.PRICING_SERVICE_URL || 'http://pricing-service:3005',
  carts: process.env.CART_SERVICE_URL || 'http://cart-service:3006',
  orders: process.env.ORDER_SERVICE_URL || 'http://order-service:3007',
  payments: process.env.PAYMENT_SERVICE_URL || 'http://payment-service:3008',
  deliveries: process.env.DELIVERY_SERVICE_URL || 'http://delivery-service:3009',
  notify: process.env.NOTIFICATION_SERVICE_URL || 'http://notification-service:3010',
  reviews: process.env.REVIEW_SERVICE_URL || 'http://review-service:3011',
  search: process.env.SEARCH_SERVICE_URL || 'http://search-service:3012',
  recommendations: process.env.RECOMMENDATION_SERVICE_URL || 'http://recommendation-service:3013',
  promotions: process.env.PROMOTION_SERVICE_URL || 'http://promotion-service:3014',
  loyalty: process.env.LOYALTY_SERVICE_URL || 'http://loyalty-service:3015',
  recipes: process.env.RECIPE_SERVICE_URL || 'http://recipe-service:3016',
  schedule: process.env.BAKING_SCHEDULE_SERVICE_URL || 'http://baking-schedule-service:3017',
  suppliers: process.env.SUPPLIER_SERVICE_URL || 'http://supplier-service:3018',
  events: process.env.ANALYTICS_SERVICE_URL || 'http://analytics-service:3019',
  metrics: process.env.ANALYTICS_SERVICE_URL || 'http://analytics-service:3019',
  media: process.env.MEDIA_SERVICE_URL || 'http://media-service:3020',
  invoices: process.env.INVOICE_SERVICE_URL || 'http://invoice-service:3021',
  currency: process.env.CURRENCY_SERVICE_URL || 'http://currency-service:3022',
  language: process.env.LANGUAGE_SERVICE_URL || 'http://language-service:3023'
};

// Distinct upstreams, for aggregated health checks on GET /api/status.
const UNIQUE_UPSTREAMS = [...new Set(Object.values(UPSTREAMS))];

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(pinoHttp({
  logger,
  customProps: (req) => ({ requestId: req.headers['x-request-id'] || undefined })
}));

// --- Kubernetes probes ----------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok', service: SERVICE_NAME }));
app.get('/ready', (req, res) => res.json({ ready: true, service: SERVICE_NAME }));

// --- API docs --------------------------------------------------------------
app.get('/api/openapi.json', (req, res) => res.json(openapiSpec));
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));

// --- Aggregated upstream health -------------------------------------------
async function checkUpstream(baseUrl) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: ctrl.signal });
    return { up: res.ok, latencyMs: Date.now() - started };
  } catch {
    return { up: false, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

app.get('/api/status', async (req, res) => {
  const entries = await Promise.all(
    Object.entries(UPSTREAMS)
      .filter(([, url], i, arr) => arr.findIndex(([, u]) => u === url) === i)
      .map(async ([segment, url]) => [segment, await checkUpstream(url)])
  );
  const services = Object.fromEntries(entries);
  const status = Object.values(services).every((s) => s.up) ? 'ok' : 'degraded';
  res.json({ status, services });
});

// --- Proxy: /api/<segment>/... -> owning service: /<segment>/... ---------
// The gateway strips the /api prefix and forwards the remaining path
// unchanged, matching each domain service's own route definitions.
app.use('/api', async (req, res) => {
  const segment = req.path.split('/').filter(Boolean)[0];
  const upstreamBase = UPSTREAMS[segment];

  if (!upstreamBase) {
    return res.status(404).json({ error: 'Unknown API route' });
  }

  const targetUrl = `${upstreamBase}${req.originalUrl.replace(/^\/api/, '')}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);

  // Only set headers that actually have a value — fetch() coerces an
  // `undefined` header value to the literal string "undefined" instead of
  // omitting it, which was corrupting downstream audit logs (request_id,
  // browser/OS parsing) for every proxied request.
  const proxyHeaders = {
    'content-type': req.headers['content-type'] || 'application/json'
  };
  if (req.headers['authorization']) proxyHeaders.authorization = req.headers['authorization'];
  if (req.headers['x-request-id']) proxyHeaders['x-request-id'] = req.headers['x-request-id'];

  // Preserve the real client's User-Agent so downstream services' audit
  // logs (lib/client-info.js) can parse browser/OS/device correctly instead
  // of seeing the gateway's own fetch() default User-Agent.
  if (req.headers['user-agent']) proxyHeaders['user-agent'] = req.headers['user-agent'];

  // Preserve/extend the client-IP chain the same way any reverse proxy
  // should: append this hop's peer address to any existing X-Forwarded-For
  // rather than dropping it, so lib/client-info.js sees the real visitor
  // IP instead of the gateway pod's own address.
  proxyHeaders['x-forwarded-for'] = [req.headers['x-forwarded-for'], req.socket.remoteAddress]
    .filter(Boolean)
    .join(', ');
  if (req.headers['x-real-ip']) proxyHeaders['x-real-ip'] = req.headers['x-real-ip'];
  if (req.headers['cf-connecting-ip']) proxyHeaders['cf-connecting-ip'] = req.headers['cf-connecting-ip'];

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: req.method,
      headers: proxyHeaders,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body ?? {}),
      signal: ctrl.signal
    });

    const contentType = upstreamRes.headers.get('content-type') || '';
    res.status(upstreamRes.status);
    if (contentType.includes('application/json')) {
      res.json(await upstreamRes.json().catch(() => ({})));
    } else {
      res.send(await upstreamRes.text());
    }
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    req.log.error(
      { event: 'upstream_error', segment, timedOut, message: err.message },
      'upstream request failed'
    );
    res.status(timedOut ? 504 : 502).json({ error: timedOut ? 'Upstream timeout' : 'Upstream unavailable' });
  } finally {
    clearTimeout(timer);
  }
});

// --- 404 + error handling --------------------------------------------------
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  req.log.error({ event: 'unhandled_error', message: err.message }, 'request failed');
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () =>
  logger.info({ event: 'service_started', port: PORT, upstreams: UNIQUE_UPSTREAMS.length }, `${SERVICE_NAME} listening`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    logger.info({ event: 'shutdown', signal }, 'shutting down gracefully');
    server.close(() => process.exit(0));
  });
}
