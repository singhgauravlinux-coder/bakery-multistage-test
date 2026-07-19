'use strict';
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const crypto = require('crypto');
const { Pool } = require('pg');
const { clientInfo } = require('./lib/client-info');
const { createAuditLogger } = require('./lib/audit');

const SERVICE_NAME = process.env.SERVICE_NAME || 'auth-service';
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || '';
const TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || 'dev-only-secret-change-me';
const TOKEN_TTL_MS = Number(process.env.AUTH_TOKEN_TTL_MS || 24 * 60 * 60 * 1000);
const RESET_TOKEN_TTL_MS = Number(process.env.AUTH_RESET_TOKEN_TTL_MS || 15 * 60 * 1000);
const CHANGE_TOKEN_TTL_MS = Number(process.env.AUTH_CHANGE_TOKEN_TTL_MS || 10 * 60 * 1000);
const UNLOCK_TOKEN_TTL_MS = Number(process.env.AUTH_UNLOCK_TOKEN_TTL_MS || 30 * 60 * 1000);
const MAX_FAILED_ATTEMPTS = Number(process.env.AUTH_MAX_FAILED_ATTEMPTS || 5);
const NOTIFY_URL = process.env.NOTIFY_SERVICE_URL || 'http://notification-service:3010';
// The demo stack has no real mail transport (notification-service is a mock
// dispatcher), so security tokens/OTPs are additionally returned in API
// responses to keep the UI flows usable. MUST be "false" in production.
const RETURN_DEBUG_TOKENS = (process.env.AUTH_RETURN_DEBUG_TOKENS || 'true') === 'true';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: SERVICE_NAME, version: process.env.SERVICE_VERSION || '1.0.0' },
  formatters: { level: (label) => ({ level: label }) },
  redact: ['req.headers.authorization']
});

if (TOKEN_SECRET === 'dev-only-secret-change-me')
  logger.warn({ event: 'insecure_config' }, 'AUTH_TOKEN_SECRET is not set — using an insecure default');

// --- Password hashing (scrypt, no native deps) --------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}
function verifyPassword(password, stored) {
  try {
    const [, saltB64, hashB64] = stored.split('$');
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64url'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

// --- Stateless signed tokens (HMAC-SHA256), scoped by purpose ------------
// One signer/verifier pair covers session, forgot-password reset,
// change-password (OTP-bound) and email-verification tokens; the `purpose`
// claim prevents a token issued for one flow being replayed in another.
function signScopedToken(userId, purpose, ttlMs, extra) {
  const claims = { sub: userId, purpose, exp: Date.now() + ttlMs, ...(extra || {}) };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyScopedToken(token, purpose) {
  try {
    const [payload, sig] = String(token).split('.');
    const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.sub || Date.now() > data.exp) return null;
    // Session tokens minted before purpose-scoping carry no `purpose` claim;
    // accept those only for the session scope so existing logins keep working.
    const tokenPurpose = data.purpose || 'session';
    if (tokenPurpose !== purpose) return null;
    return data;
  } catch { return null; }
}
const signToken = (userId) => signScopedToken(userId, 'session', TOKEN_TTL_MS);
const verifyToken = (token) => {
  const data = verifyScopedToken(token, 'session');
  return data ? data.sub : null;
};

// --- Storage: PostgreSQL when DATABASE_URL is set, in-memory otherwise ---
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, max: 10 }) : null;
if (pool) pool.on('error', (err) => logger.error({ event: 'pg_pool_error', message: err.message }, 'postgres pool error'));
// Set once store.init() has actually applied the migration successfully.
// /ready stays 503 until this is true, so k8s never routes login traffic
// to a pod whose accounts/audit tables are missing the security columns.
let migrationReady = !pool;

// Self-migrating (idempotent): init.sql only runs on the FIRST postgres
// boot, so existing clusters would miss the security columns/tables.
// Mirrored by db/migrations/000{1,2,3}_*.sql for migration-tool users.
const MIGRATION = `
  ALTER TABLE accounts ADD COLUMN IF NOT EXISTS failed_login_attempts   INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_failed_login_at    TIMESTAMPTZ;
  ALTER TABLE accounts ADD COLUMN IF NOT EXISTS locked_at               TIMESTAMPTZ;
  ALTER TABLE accounts ADD COLUMN IF NOT EXISTS unlock_token_hash       TEXT;
  ALTER TABLE accounts ADD COLUMN IF NOT EXISTS unlock_token_expires_at TIMESTAMPTZ;
  ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email_verified          BOOLEAN NOT NULL DEFAULT false;

  CREATE TABLE IF NOT EXISTS login_history (
    id         BIGSERIAL PRIMARY KEY,
    user_id    TEXT,
    email      TEXT,
    success    BOOLEAN NOT NULL,
    failure_reason TEXT,
    ip         TEXT,
    user_agent TEXT,
    browser    TEXT,
    os         TEXT,
    device     TEXT,
    request_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_login_history_user    ON login_history (user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_login_history_email   ON login_history (email, created_at DESC);

  CREATE TABLE IF NOT EXISTS security_audit_logs (
    id             BIGSERIAL PRIMARY KEY,
    service        TEXT NOT NULL,
    action         TEXT NOT NULL,
    user_id        TEXT,
    email          TEXT,
    ip             TEXT,
    user_agent     TEXT,
    browser        TEXT,
    os             TEXT,
    device         TEXT,
    endpoint       TEXT,
    method         TEXT,
    request_id     TEXT,
    status_code    INTEGER,
    success        BOOLEAN NOT NULL DEFAULT true,
    failure_reason TEXT,
    metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_audit_user    ON security_audit_logs (user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_action  ON security_audit_logs (action, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_request ON security_audit_logs (request_id);
`;

const ACCOUNT_ROW = `email, user_id AS "userId", name, password_hash AS "passwordHash",
  failed_login_attempts AS "failedLoginAttempts", last_failed_login_at AS "lastFailedLoginAt",
  locked_at AS "lockedAt", unlock_token_expires_at AS "unlockTokenExpiresAt",
  email_verified AS "emailVerified"`;

const memoryAccounts = new Map();
const memoryLoginHistory = [];

function newMemoryAccount(email, name, passwordHash) {
  return {
    email, name, passwordHash,
    userId: 'u-' + (memoryAccounts.size + 1),
    failedLoginAttempts: 0, lastFailedLoginAt: null,
    lockedAt: null, unlockTokenHash: null, unlockTokenExpiresAt: null,
    emailVerified: false
  };
}

const store = pool ? {
  mode: 'postgres',
  async init() { await pool.query(MIGRATION); },
  async find(email) {
    const { rows } = await pool.query(`SELECT ${ACCOUNT_ROW} FROM accounts WHERE email = $1`, [email]);
    return rows[0] || null;
  },
  async findById(userId) {
    const { rows } = await pool.query(`SELECT ${ACCOUNT_ROW} FROM accounts WHERE user_id = $1`, [userId]);
    return rows[0] || null;
  },
  async create(email, name, passwordHash) {
    const { rows } = await pool.query(
      `INSERT INTO accounts (email, user_id, name, password_hash)
       VALUES ($1, 'u-' || substr(md5(random()::text), 1, 8), $2, $3)
       ON CONFLICT (email) DO NOTHING
       RETURNING user_id AS "userId"`, [email, name, passwordHash]);
    return rows[0] || null;
  },
  async updatePassword(userId, passwordHash) {
    const { rowCount } = await pool.query(
      'UPDATE accounts SET password_hash = $1 WHERE user_id = $2', [passwordHash, userId]);
    return rowCount > 0;
  },
  async recordFailedLogin(email) {
    const { rows } = await pool.query(
      `UPDATE accounts
       SET failed_login_attempts = failed_login_attempts + 1, last_failed_login_at = now()
       WHERE email = $1
       RETURNING failed_login_attempts AS "failedLoginAttempts"`, [email]);
    return rows[0] ? rows[0].failedLoginAttempts : 0;
  },
  async lock(email, unlockTokenHash, expiresAt) {
    await pool.query(
      `UPDATE accounts SET locked_at = now(), unlock_token_hash = $2, unlock_token_expires_at = $3
       WHERE email = $1`, [email, unlockTokenHash, expiresAt]);
  },
  async resetLoginFailures(userId) {
    await pool.query(
      `UPDATE accounts SET failed_login_attempts = 0, last_failed_login_at = NULL,
         locked_at = NULL, unlock_token_hash = NULL, unlock_token_expires_at = NULL
       WHERE user_id = $1`, [userId]);
  },
  async unlockByTokenHash(tokenHash) {
    const { rows } = await pool.query(
      `UPDATE accounts SET failed_login_attempts = 0, last_failed_login_at = NULL,
         locked_at = NULL, unlock_token_hash = NULL, unlock_token_expires_at = NULL
       WHERE unlock_token_hash = $1 AND unlock_token_expires_at > now()
       RETURNING user_id AS "userId", email`, [tokenHash]);
    return rows[0] || null;
  },
  async setEmailVerified(userId) {
    const { rowCount } = await pool.query(
      'UPDATE accounts SET email_verified = true WHERE user_id = $1', [userId]);
    return rowCount > 0;
  },
  async addLoginHistory(h) {
    await pool.query(
      `INSERT INTO login_history (user_id, email, success, failure_reason, ip, user_agent, browser, os, device, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [h.userId || null, h.email || null, h.success, h.failureReason || null,
       h.ip, h.userAgent, h.browser, h.os, h.device, h.requestId]);
  },
  async ping() { await pool.query('SELECT 1'); }
} : {
  mode: 'memory',
  async init() {},
  async find(email) { return memoryAccounts.get(email) || null; },
  async findById(userId) {
    for (const account of memoryAccounts.values()) if (account.userId === userId) return account;
    return null;
  },
  async create(email, name, passwordHash) {
    if (memoryAccounts.has(email)) return null;
    const account = newMemoryAccount(email, name, passwordHash);
    memoryAccounts.set(email, account);
    return { userId: account.userId };
  },
  async updatePassword(userId, passwordHash) {
    const account = await this.findById(userId);
    if (!account) return false;
    account.passwordHash = passwordHash;
    return true;
  },
  async recordFailedLogin(email) {
    const account = memoryAccounts.get(email);
    if (!account) return 0;
    account.failedLoginAttempts += 1;
    account.lastFailedLoginAt = new Date().toISOString();
    return account.failedLoginAttempts;
  },
  async lock(email, unlockTokenHash, expiresAt) {
    const account = memoryAccounts.get(email);
    if (!account) return;
    account.lockedAt = new Date().toISOString();
    account.unlockTokenHash = unlockTokenHash;
    account.unlockTokenExpiresAt = expiresAt;
  },
  async resetLoginFailures(userId) {
    const account = await this.findById(userId);
    if (!account) return;
    Object.assign(account, {
      failedLoginAttempts: 0, lastFailedLoginAt: null,
      lockedAt: null, unlockTokenHash: null, unlockTokenExpiresAt: null
    });
  },
  async unlockByTokenHash(tokenHash) {
    for (const account of memoryAccounts.values()) {
      const valid = account.unlockTokenHash === tokenHash &&
        account.unlockTokenExpiresAt && new Date(account.unlockTokenExpiresAt) > new Date();
      if (valid) {
        await this.resetLoginFailures(account.userId);
        return { userId: account.userId, email: account.email };
      }
    }
    return null;
  },
  async setEmailVerified(userId) {
    const account = await this.findById(userId);
    if (!account) return false;
    account.emailVerified = true;
    return true;
  },
  async addLoginHistory(h) {
    memoryLoginHistory.push({ ...h, createdAt: new Date().toISOString() });
    if (memoryLoginHistory.length > 1000) memoryLoginHistory.shift();
  },
  async ping() {}
};

const audit = createAuditLogger({ pool, logger, service: SERVICE_NAME });

// --- Outbound e-mail via notification-service (mock dispatcher) ---------
async function sendEmail(to, subject, body, log) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${NOTIFY_URL}/notify/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, subject, body }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    log.info({ event: 'security_email_dispatched', to, subject, delivered: res.ok }, 'security email dispatched');
    return res.ok;
  } catch (err) {
    log.warn({ event: 'security_email_failed', to, subject, message: err.message },
      'notification-service unreachable — email content was logged only');
    return false;
  }
}

// Seed the demo account through the same hashing code path.
async function seedDemoAccount() {
  try {
    const email = 'amelie@crumbandember.dev';
    if (!(await store.find(email))) {
      await store.create(email, 'Amelie', hashPassword('baguette'));
      logger.info({ event: 'demo_account_seeded', email }, 'demo account ready');
    }
  } catch (err) {
    logger.warn({ event: 'seed_deferred', message: err.message }, 'demo seed will succeed once the database is up');
  }
}

const app = express();
// Traefik / Nginx / the API gateway sit in front of this service; trust
// their X-Forwarded-* headers so req.ip and rate-limit keys are correct.
app.set('trust proxy', true);
app.use(express.json());
app.use(pinoHttp({
  logger,
  customProps: (req) => {
    const info = clientInfo(req);
    return {
      requestId: info.requestId,
      clientIp: info.ip,
      browser: info.browser,
      os: info.os,
      device: info.device
    };
  }
}));

const bearerToken = (req) => (req.headers.authorization || '').replace('Bearer ', '');

// --- Kubernetes probes -------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok', service: SERVICE_NAME }));
app.get('/ready', async (req, res) => {
  try {
    await store.ping();
    if (!migrationReady) {
      return res.status(503).json({ ready: false, service: SERVICE_NAME, storage: store.mode, reason: 'migration_pending' });
    }
    res.json({ ready: true, service: SERVICE_NAME, storage: store.mode });
  } catch (err) {
    req.log.warn({ event: 'readiness_failed', message: err.message }, 'database unreachable');
    res.status(503).json({ ready: false, service: SERVICE_NAME, storage: store.mode });
  }
});

const isLocked = (account) => Boolean(account && account.lockedAt);

async function handleFailedLogin(req, res, info, email, account, reason) {
  let remainingAttempts = null;
  let failedAttempts = null;
  let locked = false;
  let lockedUnlockToken = null;
  if (account) {
    const attempts = await store.recordFailedLogin(email);
    failedAttempts = attempts;
    remainingAttempts = Math.max(MAX_FAILED_ATTEMPTS - attempts, 0);
    if (attempts >= MAX_FAILED_ATTEMPTS) {
      locked = true;
      const unlockToken = crypto.randomBytes(32).toString('base64url');
      lockedUnlockToken = unlockToken;
      const expiresAt = new Date(Date.now() + UNLOCK_TOKEN_TTL_MS).toISOString();
      await store.lock(email, sha256(unlockToken), expiresAt);
      const unlockLink = `/api/auth/unlock?token=${unlockToken}`;
      await sendEmail(email, 'Your Crumb & Ember account is locked',
        `Too many failed sign-in attempts. Unlock your account within 30 minutes: ${unlockLink}`, req.log);
      req.log.warn({
        event: 'account_locked', email, userId: account.userId, ip: info.ip,
        requestId: info.requestId, browser: info.browser, os: info.os, device: info.device,
        failedAttempts: attempts, unlockTokenExpiresAt: expiresAt
      }, 'account locked after repeated failures — unlock email sent');
      audit.record({
        ...info, action: 'account_locked', userId: account.userId, email,
        success: false, statusCode: 423, failureReason: 'too_many_failed_attempts',
        metadata: { failedAttempts: attempts, unlockTokenExpiresAt: expiresAt }
      });
    }
  }
  await store.addLoginHistory({ ...info, userId: account ? account.userId : null, email, success: false, failureReason: reason });
  req.log.warn({
    event: 'login_failed', email, ip: info.ip, requestId: info.requestId,
    browser: info.browser, os: info.os, device: info.device,
    failureReason: reason, failedAttempts, remainingAttempts, locked
  }, 'invalid credentials');
  audit.record({
    ...info, action: 'login', userId: account ? account.userId : null, email,
    success: false, statusCode: locked ? 423 : 401, failureReason: reason,
    metadata: { failedAttempts, remainingAttempts, locked }
  });
  if (locked) {
    const lockedPayload = {
      error: 'Account locked after too many failed attempts. Check your email for an unlock link.',
      locked: true
    };
    if (RETURN_DEBUG_TOKENS) lockedPayload.unlockToken = lockedUnlockToken;
    return res.status(423).json(lockedPayload);
  }
  const payload = { error: 'Invalid email or password' };
  if (remainingAttempts !== null) payload.remainingAttempts = remainingAttempts;
  return res.status(401).json(payload);
}

// --- Login, registration and token verification ---
app.post('/auth/login', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const { email, password } = req.body || {};
    const account = email ? await store.find(email) : null;

    if (isLocked(account)) {
      await store.addLoginHistory({ ...info, userId: account.userId, email, success: false, failureReason: 'account_locked' });
      req.log.warn({ event: 'login_blocked_locked', email, userId: account.userId, ip: info.ip, requestId: info.requestId }, 'login attempt on locked account');
      audit.record({ ...info, action: 'login', userId: account.userId, email, success: false, statusCode: 423, failureReason: 'account_locked' });
      return res.status(423).json({
        error: 'Account is locked. Use the unlock link emailed to you, or request a new one by waiting for the link to expire.',
        locked: true
      });
    }

    if (!account || !verifyPassword(password || '', account.passwordHash)) {
      return await handleFailedLogin(req, res, info, email, account, account ? 'invalid_password' : 'unknown_email');
    }

    await store.resetLoginFailures(account.userId);
    await store.addLoginHistory({ ...info, userId: account.userId, email, success: true });
    req.log.info({
      event: 'login_success', userId: account.userId, email, ip: info.ip,
      requestId: info.requestId, browser: info.browser, os: info.os, device: info.device
    }, 'user logged in');
    audit.record({ ...info, action: 'login', userId: account.userId, email, success: true, statusCode: 200 });
    res.json({ token: signToken(account.userId), userId: account.userId, name: account.name });
  } catch (err) { next(err); }
});

// Redeem an unlock token (from the "account locked" email).
app.post('/auth/unlock', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const token = (req.body && req.body.token) || req.query.token;
    if (!token) return res.status(400).json({ error: 'token is required' });
    const unlocked = await store.unlockByTokenHash(sha256(token));
    if (!unlocked) {
      audit.record({ ...info, action: 'account_unlock', success: false, statusCode: 401, failureReason: 'invalid_or_expired_token' });
      return res.status(401).json({ error: 'Unlock link is invalid or has expired' });
    }
    req.log.info({ event: 'account_unlocked', userId: unlocked.userId, ip: info.ip, requestId: info.requestId }, 'account unlocked');
    audit.record({ ...info, action: 'account_unlock', userId: unlocked.userId, email: unlocked.email, success: true, statusCode: 200 });
    res.json({ ok: true, message: 'Account unlocked — you can sign in again.' });
  } catch (err) { next(err); }
});

app.post('/auth/register', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const { email, password, name } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    const created = await store.create(email, name || email, hashPassword(password));
    if (!created) {
      audit.record({ ...info, action: 'registration', email, success: false, statusCode: 409, failureReason: 'email_already_registered' });
      return res.status(409).json({ error: 'An account with that email already exists' });
    }
    req.log.info({ event: 'user_registered', userId: created.userId, email, ip: info.ip, requestId: info.requestId }, 'new account created');
    audit.record({ ...info, action: 'registration', userId: created.userId, email, success: true, statusCode: 201 });
    res.status(201).json({ userId: created.userId });
  } catch (err) { next(err); }
});

// Stateless tokens can't be revoked server-side; logout exists so the
// sign-out event is captured in the audit trail with full client context.
app.post('/auth/logout', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const userId = verifyToken(bearerToken(req));
    if (!userId) {
      audit.record({ ...info, action: 'logout', success: false, statusCode: 401, failureReason: 'invalid_token' });
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.log.info({ event: 'logout', userId, ip: info.ip, requestId: info.requestId }, 'user logged out');
    audit.record({ ...info, action: 'logout', userId, success: true, statusCode: 200 });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.get('/auth/verify', (req, res) => {
  const userId = verifyToken(bearerToken(req));
  if (!userId) return res.status(401).json({ valid: false });
  res.json({ valid: true, userId });
});

// Step 1 of the forgot-password flow: issue a short-lived, purpose-scoped
// reset token for the account, if one exists. The response never reveals
// whether the email was registered, to avoid leaking account existence.
app.post('/auth/forgot-password', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email is required' });

    const account = await store.find(email);
    if (!account) {
      req.log.info({ event: 'password_reset_requested_unknown_email', ip: info.ip, requestId: info.requestId }, 'reset requested for unknown email');
      audit.record({ ...info, action: 'forgot_password', email, success: false, statusCode: 200, failureReason: 'unknown_email' });
      return res.json({ message: 'If that email exists, a reset link was sent.' });
    }

    const resetToken = signScopedToken(account.userId, 'reset', RESET_TOKEN_TTL_MS);
    await sendEmail(email, 'Reset your Crumb & Ember password',
      'Use this link within 15 minutes to reset your password.', req.log);
    req.log.info({ event: 'password_reset_requested', userId: account.userId, ip: info.ip, requestId: info.requestId }, 'reset link generated and emailed');
    audit.record({ ...info, action: 'forgot_password', userId: account.userId, email, success: true, statusCode: 200 });
    const payload = { message: 'If that email exists, a reset link was sent.' };
    if (RETURN_DEBUG_TOKENS) payload.resetToken = resetToken;
    res.json(payload);
  } catch (err) { next(err); }
});

// Step 2: redeem the reset token for a new password.
app.post('/auth/reset-password', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) return res.status(400).json({ error: 'token and newPassword are required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'newPassword must be at least 8 characters' });

    const claims = verifyScopedToken(token, 'reset');
    if (!claims) {
      audit.record({ ...info, action: 'reset_password', success: false, statusCode: 401, failureReason: 'invalid_or_expired_token' });
      return res.status(401).json({ error: 'Reset link is invalid or has expired' });
    }

    const updated = await store.updatePassword(claims.sub, hashPassword(newPassword));
    if (!updated) return res.status(404).json({ error: 'Account not found' });
    // A successful password reset also clears any lockout.
    await store.resetLoginFailures(claims.sub);

    req.log.info({ event: 'password_reset', userId: claims.sub, ip: info.ip, requestId: info.requestId }, 'password reset via forgot-password flow');
    audit.record({ ...info, action: 'reset_password', userId: claims.sub, success: true, statusCode: 200 });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// --- Change password (signed-in): OTP-verified, mirroring forgot-password.
// Step 1: request a change — a 6-digit OTP is emailed and a change token
// (binding the OTP hash) is issued. Reuses the same scoped-token machinery
// as the forgot-password flow.
app.post('/auth/password/request', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const userId = verifyToken(bearerToken(req));
    if (!userId) return res.status(401).json({ error: 'Invalid or expired token' });
    const account = await store.findById(userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const changeToken = signScopedToken(userId, 'change', CHANGE_TOKEN_TTL_MS, { otpHash: sha256(otp) });
    await sendEmail(account.email, 'Your Crumb & Ember verification code',
      `Your password-change code is ${otp}. It expires in 10 minutes.`, req.log);
    req.log.info({ event: 'password_change_requested', userId, ip: info.ip, requestId: info.requestId }, 'change-password OTP emailed');
    audit.record({ ...info, action: 'change_password_request', userId, email: account.email, success: true, statusCode: 200 });
    const payload = { message: 'A verification code was emailed to you.', changeToken };
    if (RETURN_DEBUG_TOKENS) payload.devOtp = otp;
    res.json(payload);
  } catch (err) { next(err); }
});

// Step 2: confirm with the OTP and set the new password.
app.post('/auth/password', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const userId = verifyToken(bearerToken(req));
    if (!userId) return res.status(401).json({ error: 'Invalid or expired token' });

    const { changeToken, otp, newPassword } = req.body || {};
    if (!changeToken || !otp || !newPassword) {
      return res.status(400).json({ error: 'changeToken, otp and newPassword are required — call POST /auth/password/request first' });
    }
    if (newPassword.length < 8) return res.status(400).json({ error: 'newPassword must be at least 8 characters' });

    const claims = verifyScopedToken(changeToken, 'change');
    const otpOk = claims && claims.sub === userId &&
      crypto.timingSafeEqual(Buffer.from(sha256(otp)), Buffer.from(String(claims.otpHash || '')));
    if (!otpOk) {
      req.log.warn({ event: 'password_update_failed', userId, ip: info.ip, requestId: info.requestId, failureReason: 'invalid_otp' }, 'OTP verification failed');
      audit.record({ ...info, action: 'change_password', userId, success: false, statusCode: 401, failureReason: 'invalid_or_expired_otp' });
      return res.status(401).json({ error: 'Verification code is invalid or has expired' });
    }

    const account = await store.findById(userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (verifyPassword(newPassword, account.passwordHash)) {
      return res.status(400).json({ error: 'New password must be different from the current password' });
    }

    await store.updatePassword(userId, hashPassword(newPassword));
    req.log.info({ event: 'password_updated', userId, ip: info.ip, requestId: info.requestId }, 'password updated after OTP verification');
    audit.record({ ...info, action: 'change_password', userId, email: account.email, success: true, statusCode: 200 });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// --- Email verification --------------------------------------------------
app.post('/auth/verify-email/request', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const userId = verifyToken(bearerToken(req));
    if (!userId) return res.status(401).json({ error: 'Invalid or expired token' });
    const account = await store.findById(userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.emailVerified) return res.json({ ok: true, message: 'Email already verified.' });

    const verifyEmailToken = signScopedToken(userId, 'verify-email', RESET_TOKEN_TTL_MS);
    await sendEmail(account.email, 'Verify your Crumb & Ember email',
      'Use this link within 15 minutes to verify your email address.', req.log);
    audit.record({ ...info, action: 'email_verification_request', userId, email: account.email, success: true, statusCode: 200 });
    const payload = { message: 'A verification link was emailed to you.' };
    if (RETURN_DEBUG_TOKENS) payload.verifyToken = verifyEmailToken;
    res.json(payload);
  } catch (err) { next(err); }
});

app.post('/auth/verify-email/confirm', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token is required' });
    const claims = verifyScopedToken(token, 'verify-email');
    if (!claims) {
      audit.record({ ...info, action: 'email_verification', success: false, statusCode: 401, failureReason: 'invalid_or_expired_token' });
      return res.status(401).json({ error: 'Verification link is invalid or has expired' });
    }
    const updated = await store.setEmailVerified(claims.sub);
    if (!updated) return res.status(404).json({ error: 'Account not found' });
    audit.record({ ...info, action: 'email_verification', userId: claims.sub, success: true, statusCode: 200 });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// --- 404 + error handling ----------------------------------------------
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars -- Express error signature
  req.log.error({ event: 'unhandled_error', message: err.message }, 'request failed');
  res.status(500).json({ error: 'Internal server error' });
});

async function runMigrationWithRetry(attempt = 1) {
  try {
    await store.init();
    await seedDemoAccount();
    migrationReady = true;
    logger.info({ event: 'migration_complete', attempt }, 'security migration applied');
  } catch (err) {
    const delayMs = Math.min(30000, 1000 * 2 ** (attempt - 1));
    logger.warn({ event: 'migration_deferred', attempt, delayMs, message: err.message },
      'security migration failed; retrying');
    setTimeout(() => runMigrationWithRetry(attempt + 1), delayMs);
  }
}

function start() {
  const server = app.listen(PORT, () => {
    logger.info({ event: 'service_started', port: PORT, storage: store.mode }, `${SERVICE_NAME} listening`);
    runMigrationWithRetry();
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      logger.info({ event: 'shutdown', signal }, 'shutting down gracefully');
      server.close(async () => { if (pool) await pool.end().catch(() => {}); process.exit(0); });
    });
  }
  return server;
}

if (require.main === module) start();

module.exports = { app, store, audit, signScopedToken, verifyScopedToken, hashPassword, verifyPassword, MAX_FAILED_ATTEMPTS };
