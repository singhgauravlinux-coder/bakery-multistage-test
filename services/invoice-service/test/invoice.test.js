'use strict';
process.env.LOG_LEVEL = 'silent';

const http = require('node:http');
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

// Stub order service so invoice amount resolution and paid-state gating
// can be exercised without the real service.
const orders = new Map();
const stub = http.createServer((req, res) => {
  const id = req.url.replace('/orders/', '');
  const order = orders.get(id);
  res.setHeader('content-type', 'application/json');
  if (!order) { res.statusCode = 404; return res.end('{"error":"not found"}'); }
  res.end(JSON.stringify(order));
});

let base;
before(async () => {
  await new Promise((resolve) => stub.listen(0, resolve));
  stub.unref();
  process.env.ORDER_SERVICE_URL = `http://127.0.0.1:${stub.address().port}`;
  const { app } = require('../server');
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  server.unref();
});

const post = (body) => fetch(base + '/invoices', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body || {})
});

test('POST /invoices without orderId is a 400 with details', async () => {
  const res = await post({});
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.details.orderId, 'missing');
});

test('invoice for a paid order with explicit amount succeeds', async () => {
  orders.set('ord-paid', { id: 'ord-paid', userId: 'u1', paymentStatus: 'paid', amount: 21.5, currency: 'EUR' });
  const res = await post({ orderId: 'ord-paid', amount: 21.5, currency: 'EUR', customer: 'u1' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.amount, 21.5);
  assert.ok(body.id.startsWith('inv-'));
});

test('invoice creation is idempotent per order', async () => {
  const res = await post({ orderId: 'ord-paid', amount: 21.5 });
  assert.equal(res.status, 200); // returns the existing invoice
});

test('amount is resolved from the order when omitted (the original 400 bug)', async () => {
  orders.set('ord-resolve', { id: 'ord-resolve', userId: 'u2', paymentStatus: 'paid', amount: 9.75, currency: 'EUR' });
  const res = await post({ orderId: 'ord-resolve' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.amount, 9.75);
  assert.equal(body.currency, 'EUR');
  assert.equal(body.customer, 'u2');
});

test('unpaid orders are refused with 409', async () => {
  orders.set('ord-unpaid', { id: 'ord-unpaid', paymentStatus: 'awaiting_payment', amount: 5 });
  const res = await post({ orderId: 'ord-unpaid', amount: 5 });
  assert.equal(res.status, 409);
});

test('COD orders can be invoiced (amount due on delivery)', async () => {
  orders.set('ord-cod', { id: 'ord-cod', userId: 'u3', paymentStatus: 'cod_pending', amount: 6.25, currency: 'EUR' });
  const res = await post({ orderId: 'ord-cod' });
  assert.equal(res.status, 201);
});

test('unresolvable amount yields 422 with details', async () => {
  const res = await post({ orderId: 'ord-unknown' }); // stub returns 404, no amount anywhere
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.details.amount, 'missing_or_invalid');
});

test('GET /invoices/:id returns the invoice', async () => {
  orders.set('ord-get', { id: 'ord-get', paymentStatus: 'paid', amount: 3, currency: 'EUR' });
  const created = await (await post({ orderId: 'ord-get' })).json();
  const res = await fetch(`${base}/invoices/${created.id}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).orderId, 'ord-get');
});
