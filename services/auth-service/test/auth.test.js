'use strict';
process.env.LOG_LEVEL = 'silent';
process.env.AUTH_RETURN_DEBUG_TOKENS = 'true';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { app, audit, MAX_FAILED_ATTEMPTS } = require('../server');
const { getClientIp, parseUserAgent, isPrivateIp } = require('../lib/client-info');

let base;
before(async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  server.unref();
});

const post = (path, body, headers) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(headers || {}) },
  body: JSON.stringify(body || {})
});

async function register(email, password) {
  const res = await post('/auth/register', { email, password, name: 'Test' });
  assert.equal(res.status, 201);
  return res.json();
}

test('register + login succeeds and is audited with client context', async () => {
  await register('login-ok@test.dev', 'password123');
  const res = await post('/auth/login', { email: 'login-ok@test.dev', password: 'password123' }, {
    'x-forwarded-for': '203.0.113.9, 172.18.0.4',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64) Chrome/120.0.0.0 Safari/537.36'
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.token && body.userId);
  const rows = audit.memoryRows().filter((r) => r.action === 'login' && r.email === 'login-ok@test.dev');
  assert.ok(rows.length >= 1);
  const row = rows.at(-1);
  assert.equal(row.success, true);
  assert.equal(row.ip, '203.0.113.9'); // public XFF hop, not the Docker one
  assert.match(row.browser, /Chrome/);
  assert.match(row.os, /Windows/);
  assert.equal(row.device, 'desktop');
  assert.ok(row.request_id);
});

test('failed logins report remaining attempts, lock at the limit, and unlock resets', async () => {
  await register('locky@test.dev', 'password123');
  let unlockToken = null;
  for (let i = 1; i <= MAX_FAILED_ATTEMPTS; i++) {
    const res = await post('/auth/login', { email: 'locky@test.dev', password: 'wrong-pass' });
    const body = await res.json();
    if (i < MAX_FAILED_ATTEMPTS) {
      assert.equal(res.status, 401);
      assert.equal(body.remainingAttempts, MAX_FAILED_ATTEMPTS - i);
    } else {
      assert.equal(res.status, 423);
      assert.equal(body.locked, true);
      unlockToken = body.unlockToken;
      assert.ok(unlockToken);
    }
  }
  // Even the correct password is rejected while locked.
  const blocked = await post('/auth/login', { email: 'locky@test.dev', password: 'password123' });
  assert.equal(blocked.status, 423);

  // Bad unlock token rejected; good token unlocks and resets attempts.
  assert.equal((await post('/auth/unlock', { token: 'nonsense' })).status, 401);
  assert.equal((await post('/auth/unlock', { token: unlockToken })).status, 200);
  const after = await post('/auth/login', { email: 'locky@test.dev', password: 'password123' });
  assert.equal(after.status, 200);

  const lockRows = audit.memoryRows().filter((r) => r.action === 'account_locked' && r.email === 'locky@test.dev');
  assert.equal(lockRows.length, 1);
  assert.equal(lockRows[0].failure_reason, 'too_many_failed_attempts');
});

test('change password requires a valid OTP and mirrors the forgot flow', async () => {
  await register('otp@test.dev', 'password123');
  const login = await (await post('/auth/login', { email: 'otp@test.dev', password: 'password123' })).json();
  const auth = { authorization: `Bearer ${login.token}` };

  // Legacy body (currentPassword only) is now rejected with guidance.
  const legacy = await post('/auth/password', { currentPassword: 'password123', newPassword: 'password456' }, auth);
  assert.equal(legacy.status, 400);

  const reqRes = await post('/auth/password/request', {}, auth);
  assert.equal(reqRes.status, 200);
  const { changeToken, devOtp } = await reqRes.json();
  assert.ok(changeToken && /^\d{6}$/.test(devOtp));

  const badOtp = await post('/auth/password', { changeToken, otp: devOtp === '000000' ? '000001' : '000000', newPassword: 'password456' }, auth);
  assert.equal(badOtp.status, 401);

  const good = await post('/auth/password', { changeToken, otp: devOtp, newPassword: 'password456' }, auth);
  assert.equal(good.status, 200);
  assert.equal((await post('/auth/login', { email: 'otp@test.dev', password: 'password456' })).status, 200);
});

test('forgot/reset flow still works and clears any lockout', async () => {
  await register('resetme@test.dev', 'password123');
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await post('/auth/login', { email: 'resetme@test.dev', password: 'nope-nope' });
  const forgot = await (await post('/auth/forgot-password', { email: 'resetme@test.dev' })).json();
  assert.ok(forgot.resetToken);
  const reset = await post('/auth/reset-password', { token: forgot.resetToken, newPassword: 'brandnew1' });
  assert.equal(reset.status, 200);
  assert.equal((await post('/auth/login', { email: 'resetme@test.dev', password: 'brandnew1' })).status, 200);
});

test('logout is audited; email verification round-trips', async () => {
  await register('bye@test.dev', 'password123');
  const login = await (await post('/auth/login', { email: 'bye@test.dev', password: 'password123' })).json();
  const auth = { authorization: `Bearer ${login.token}` };
  assert.equal((await post('/auth/logout', {}, auth)).status, 200);
  assert.ok(audit.memoryRows().some((r) => r.action === 'logout' && r.user_id === login.userId && r.success));

  const reqRes = await (await post('/auth/verify-email/request', {}, auth)).json();
  assert.ok(reqRes.verifyToken);
  assert.equal((await post('/auth/verify-email/confirm', { token: reqRes.verifyToken })).status, 200);
});

test('client-info: real public IP wins over internal Docker hops; UA parsing', () => {
  const req = (headers) => ({ headers, socket: { remoteAddress: '172.18.0.2' }, method: 'POST', url: '/x' });
  assert.equal(getClientIp(req({ 'x-forwarded-for': '172.18.0.5, 198.51.100.7' })), '198.51.100.7');
  assert.equal(getClientIp(req({ 'x-real-ip': '203.0.113.44' })), '203.0.113.44');
  assert.equal(getClientIp(req({})), '172.18.0.2'); // best available in dev
  assert.equal(isPrivateIp('10.1.2.3'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);

  const ua = parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1');
  assert.match(ua.os, /iOS/);
  assert.equal(ua.device, 'mobile');
});
