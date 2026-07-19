'use strict';
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const { Pool } = require('pg');

const SERVICE_NAME = process.env.SERVICE_NAME || 'product-catalog-service';
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || '';

// All logs are structured JSON on stdout (12-factor), ready for
// Fluent Bit / Loki / ELK collection from the container runtime.
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: SERVICE_NAME, version: process.env.SERVICE_VERSION || '1.0.0' },
  formatters: { level: (label) => ({ level: label }) }
});

// --- Storage: PostgreSQL when DATABASE_URL is set, in-memory otherwise ---
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, max: 10 }) : null;
if (pool) pool.on('error', (err) => logger.error({ event: 'pg_pool_error', message: err.message }, 'postgres pool error'));

const memoryProducts = [
  { id: 'p-1',  name: 'Levain Country Loaf',      category: 'bread',        price: 8.50, description: '48-hour fermented sourdough, dark bake.' },
  { id: 'p-2',  name: 'Seeded Rye',               category: 'bread',        price: 7.00, description: 'Dense Danish-style rye with sunflower and flax.' },
  { id: 'p-3',  name: 'Butter Croissant',         category: 'viennoiserie', price: 4.25, description: '27 layers of cultured butter.' },
  { id: 'p-4',  name: 'Cardamom Knot',            category: 'viennoiserie', price: 4.75, description: 'Swedish-style bun, freshly ground cardamom.' },
  { id: 'p-5',  name: 'Pain au Chocolat',         category: 'viennoiserie', price: 4.50, description: 'Two batons of 70% chocolate.' },
  { id: 'p-6',  name: 'Morning Bun',              category: 'viennoiserie', price: 4.50, description: 'Croissant dough, orange zest, muscovado.' },
  { id: 'p-7',  name: 'Pistachio Financier',      category: 'patisserie',   price: 3.75, description: 'Brown-butter almond cake, Sicilian pistachio.' },
  { id: 'p-8',  name: 'Sour Cherry Galette',      category: 'patisserie',   price: 6.25, description: 'Rye crust, whole sour cherries.' },
  { id: 'p-9',  name: 'Canele',                   category: 'patisserie',   price: 3.50, description: 'Rum and vanilla, caramelised copper-mould crust.' },
  { id: 'p-10', name: 'Baguette Tradition',       category: 'bread',        price: 3.90, description: 'Slow-fermented, thin crackling crust.' },
  { id: 'p-11', name: 'Focaccia al Rosmarino',    category: 'bread',        price: 5.50, description: 'Olive oil crumb, flaky salt, rosemary.' },
  { id: 'p-12', name: 'Espresso Walnut Babka',    category: 'patisserie',   price: 9.00, description: 'Twisted brioche, espresso frangipane.' }
];

const rowToProduct = (r) => ({ ...r, price: Number(r.price) });

const store = pool ? {
  mode: 'postgres',
  async list(category) {
    const { rows } = category
      ? await pool.query('SELECT id, name, category, price, description FROM products WHERE category = $1 ORDER BY id', [category])
      : await pool.query('SELECT id, name, category, price, description FROM products ORDER BY id');
    return rows.map(rowToProduct);
  },
  async get(id) {
    const { rows } = await pool.query('SELECT id, name, category, price, description FROM products WHERE id = $1', [id]);
    return rows[0] ? rowToProduct(rows[0]) : null;
  },
  async upsert(p) {
    const { rows } = await pool.query(
      `INSERT INTO products (id, name, category, price, description)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, category = EXCLUDED.category,
         price = EXCLUDED.price, description = EXCLUDED.description
       RETURNING id, name, category, price, description`,
      [p.id, p.name, p.category, p.price, p.description || '']);
    return rowToProduct(rows[0]);
  },
  async ping() { await pool.query('SELECT 1'); }
} : {
  mode: 'memory',
  async list(category) { return category ? memoryProducts.filter(p => p.category === category) : memoryProducts; },
  async get(id) { return memoryProducts.find(p => p.id === id) || null; },
  async upsert(p) {
    const idx = memoryProducts.findIndex(x => x.id === p.id);
    const product = { id: p.id, name: p.name, category: p.category, price: p.price, description: p.description || '' };
    if (idx >= 0) memoryProducts[idx] = product; else memoryProducts.push(product);
    return product;
  },
  async ping() {}
};

const app = express();
app.use(express.json());
app.use(pinoHttp({
  logger,
  customProps: (req) => ({ requestId: req.headers['x-request-id'] || undefined })
}));

// --- Kubernetes probes -------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok', service: SERVICE_NAME }));
app.get('/ready', async (req, res) => {
  try {
    await store.ping();
    res.json({ ready: true, service: SERVICE_NAME, storage: store.mode });
  } catch (err) {
    req.log.warn({ event: 'readiness_failed', message: err.message }, 'database unreachable');
    res.status(503).json({ ready: false, service: SERVICE_NAME, storage: store.mode });
  }
});

// --- The bakery's product range ---
app.get('/products', async (req, res, next) => {
  try {
    const { category } = req.query;
    const out = await store.list(category);
    req.log.info({ event: 'catalog_listed', count: out.length, category: category || 'all' }, 'catalog served');
    res.json(out);
  } catch (err) { next(err); }
});

app.get('/products/:id', async (req, res, next) => {
  try {
    const product = await store.get(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(product);
  } catch (err) { next(err); }
});

app.put('/products/:id', async (req, res, next) => {
  try {
    const { name, category, price, description } = req.body || {};
    if (!name || !category || typeof price !== 'number')
      return res.status(400).json({ error: 'name, category and numeric price are required' });
    const product = await store.upsert({ id: req.params.id, name, category, price, description });
    req.log.info({ event: 'product_upserted', productId: product.id }, 'product saved');
    res.json(product);
  } catch (err) { next(err); }
});

// --- 404 + error handling ----------------------------------------------
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  req.log.error({ event: 'unhandled_error', message: err.message }, 'request failed');
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () =>
  logger.info({ event: 'service_started', port: PORT, storage: store.mode }, `${SERVICE_NAME} listening`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    logger.info({ event: 'shutdown', signal }, 'shutting down gracefully');
    server.close(async () => { if (pool) await pool.end().catch(() => {}); process.exit(0); });
  });
}
