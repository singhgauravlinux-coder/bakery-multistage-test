'use strict';
process.env.LOG_LEVEL = 'silent';

const http = require('node:http');
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

// Stub payment service: started first so PAYMENT_SERVICE_URL is set
// before the order service module is loaded.
const payments = new Map();
const stub = http.createServer((req, res) => {
  const id = req.url.replace('/payments/', '');
  const payment = payments.get(id);
  res.setHeader('content-type', 'application/json');
  if (!payment) { res.statusCode = 404; return res.end('{"error":"not found"}'); }
  res.end(JSON.stringify(payment));
});

let base;
before(async () => {
  await new Promise((resolve) => stub.listen(0, resolve));
  stub.unref();
  process.env.PAYMENT_SERVICE_URL = `http://127.0.0.1:${stub.address().port}`;
  const { app } = require('../server');
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  server.unref();
});

const send = (method, path, body) => fetch(base + path, {
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body)
});

const createOrder = async (overrides) => {
  const res = await send('POST', '/orders', {
    userId: 'u1', items: [{ productId: 'p1', quantity: 2 }],
    paymentMethod: 'card', amount: 10, currency: 'EUR', ...(overrides || {})
  });
  return { res, body: await res.json() };
};

test('prepaid orders start in pending_payment / awaiting_payment', async () => {
  const { res, body } = await createOrder();
  assert.equal(res.status, 201);
  assert.equal(body.status, 'pending_payment');
  assert.equal(body.paymentStatus, 'awaiting_payment');
});

test('prepaid orders require a positive amount', async () => {
  const { res } = await createOrder({ amount: undefined });
  assert.equal(res.status, 400);
  const bad = await createOrder({ amount: -3 });
  assert.equal(bad.res.status, 400);
});

test('COD orders are received immediately with cod_pending', async () => {
  const { res, body } = await createOrder({ paymentMethod: 'cod', amount: undefined });
  assert.equal(res.status, 201);
  assert.equal(body.status, 'received');
  assert.equal(body.paymentStatus, 'cod_pending');
});

test('confirm succeeds only with a verified, matching payment', async () => {
  const { body: order } = await createOrder();
  payments.set('pay_ok', { id: 'pay_ok', orderId: order.id, status: 'succeeded', amount: 10 });
  const res = await send('POST', `/orders/${order.id}/confirm`, { paymentId: 'pay_ok' });
  assert.equal(res.status, 200);
  const confirmed = await res.json();
  assert.equal(confirmed.status, 'received');
  assert.equal(confirmed.paymentStatus, 'paid');
  assert.equal(confirmed.paymentId, 'pay_ok');

  // second confirm is rejected — order is no longer pending
  const again = await send('POST', `/orders/${order.id}/confirm`, { paymentId: 'pay_ok' });
  assert.equal(again.status, 409);
});

test('confirm rejects a payment that belongs to another order', async () => {
  const { body: order } = await createOrder();
  payments.set('pay_other', { id: 'pay_other', orderId: 'ord-elsewhere', status: 'succeeded', amount: 10 });
  const res = await send('POST', `/orders/${order.id}/confirm`, { paymentId: 'pay_other' });
  assert.equal(res.status, 402);
  assert.equal((await res.json()).reason, 'payment_belongs_to_other_order');
});

test('confirm rejects amount mismatches and unsuccessful payments', async () => {
  const { body: order } = await createOrder();
  payments.set('pay_short', { id: 'pay_short', orderId: order.id, status: 'succeeded', amount: 4 });
  const short = await send('POST', `/orders/${order.id}/confirm`, { paymentId: 'pay_short' });
  assert.equal(short.status, 402);
  assert.equal((await short.json()).reason, 'amount_mismatch');

  payments.set('pay_fail', { id: 'pay_fail', orderId: order.id, status: 'failed', amount: 10 });
  const failed = await send('POST', `/orders/${order.id}/confirm`, { paymentId: 'pay_fail' });
  assert.equal(failed.status, 402);
  assert.match((await failed.json()).reason, /payment_status_failed/);
});

test('confirm rejects unknown payment ids', async () => {
  const { body: order } = await createOrder();
  const res = await send('POST', `/orders/${order.id}/confirm`, { paymentId: 'pay_missing' });
  assert.equal(res.status, 402);
  assert.equal((await res.json()).reason, 'payment_not_found');
});

test('validatePaymentForOrder unit checks', () => {
  const { validatePaymentForOrder } = require('../server');
  const order = { id: 'o1', amount: 10 };
  assert.equal(validatePaymentForOrder(null, order), 'payment_not_found');
  assert.equal(validatePaymentForOrder({ orderId: 'o1', status: 'succeeded', amount: 10 }, order), null);
  assert.equal(validatePaymentForOrder({ orderId: 'o1', status: 'succeeded', amount: 10.005 }, order), null); // within tolerance
});
