'use strict';
process.env.LOG_LEVEL = 'silent';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { app, validateCard, validateUpi, luhnValid } = require('../server');

let base;
before(async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  server.unref();
});

const post = (path, body) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body || {})
});

const FUTURE_EXPIRY = (() => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 2);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(-2)}`;
})();

test('luhnValid accepts valid PANs and rejects tampered ones', () => {
  assert.equal(luhnValid('4111111111111111'), true);
  assert.equal(luhnValid('4111111111111112'), false);
});

test('validateCard enforces PAN, expiry and CVV rules', () => {
  assert.ok(validateCard({ cardNumber: '4111 1111 1111 1111', expiry: FUTURE_EXPIRY, cvv: '123' }).summary);
  assert.ok(validateCard({ cardNumber: '1234', expiry: FUTURE_EXPIRY, cvv: '123' }).error);
  assert.ok(validateCard({ cardNumber: '4111111111111111', expiry: '01/20', cvv: '123' }).error); // expired
  assert.ok(validateCard({ cardNumber: '4111111111111111', expiry: FUTURE_EXPIRY, cvv: '12' }).error);
  assert.ok(validateCard({ cardNumber: '4111111111111111', expiry: '13/30', cvv: '123' }).error);
});

test('validateCard keeps only brand + last4 in the summary', () => {
  const { summary } = validateCard({ cardNumber: '4111111111111111', expiry: FUTURE_EXPIRY, cvv: '123' });
  assert.match(summary, /visa/);
  assert.match(summary, /1111$/);
  assert.ok(!summary.includes('4111111111111111'));
});

test('validateUpi accepts name@bank and masks the VPA', () => {
  const ok = validateUpi({ vpa: 'amelie@okhdfc' });
  assert.ok(ok.summary && ok.summary.includes('***'));
  assert.ok(validateUpi({ vpa: 'not-a-vpa' }).error);
  assert.ok(validateUpi({ vpa: '@bank' }).error);
});

test('POST /payments rejects a card payment without valid instrument details', async () => {
  const res = await post('/payments', { orderId: 'ord-1', amount: 12.5, method: 'card' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error);
});

test('POST /payments succeeds with a valid card and returns a masked summary', async () => {
  const res = await post('/payments', {
    orderId: 'ord-2', amount: 12.5, currency: 'EUR', method: 'card',
    cardNumber: '4111 1111 1111 1111', expiry: FUTURE_EXPIRY, cvv: '123'
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.status, 'succeeded');
  assert.match(body.instrumentSummary, /••••/);
  assert.ok(!JSON.stringify(body).includes('4111 1111'));

  const lookup = await fetch(`${base}/payments/${body.id}`);
  assert.equal(lookup.status, 200);
  assert.equal((await lookup.json()).orderId, 'ord-2');
});

test('POST /payments with upi validates the VPA', async () => {
  const bad = await post('/payments', { orderId: 'ord-3', amount: 8, method: 'upi', vpa: 'nope' });
  assert.equal(bad.status, 400);
  const good = await post('/payments', { orderId: 'ord-3', amount: 8, method: 'upi', vpa: 'amelie@okhdfc' });
  assert.equal(good.status, 201);
  assert.equal((await good.json()).status, 'succeeded');
});

test('POST /payments with cod stays pending (collected on delivery)', async () => {
  const res = await post('/payments', { orderId: 'ord-4', amount: 5, method: 'cod' });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).status, 'pending');
});

test('POST /payments requires orderId and a positive amount', async () => {
  assert.equal((await post('/payments', { amount: 5, method: 'cod' })).status, 400);
  assert.equal((await post('/payments', { orderId: 'x', amount: -1, method: 'cod' })).status, 400);
});
