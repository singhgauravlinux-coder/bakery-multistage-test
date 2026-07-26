'use strict';
// Secure request payloads + manual data encryption.
//
// 1) TRANSPORT ENVELOPE (browser -> auth-service)
//    The frontend fetches GET /auth/crypto/public-key, then encrypts
//    sensitive JSON bodies (login / register / password flows) with a
//    fresh AES-256-GCM key and wraps that key with RSA-OAEP(SHA-256).
//    The request body becomes { enc: { v, alg, kid, key, iv, data } } so
//    plaintext emails/passwords never appear in the browser DevTools
//    Network tab, HAR exports, or proxy logs.
//
//    NOTE: this is defence-in-depth on top of TLS, not a replacement.
//    Anyone with DevTools open can still breakpoint the page's own JS
//    before encryption — the goal is to keep credentials out of
//    network captures, logs and shoulder-surfed Network panels.
//
// 2) MANUAL DATA API (POST /auth/crypto/encrypt|decrypt)
//    Server-side AES-256-GCM with a key derived (HKDF-SHA256) from
//    AUTH_DATA_ENCRYPTION_KEY (falls back to AUTH_TOKEN_SECRET).
//    Output format: enc1.<iv>.<ciphertext>.<tag>  (base64url parts)

const crypto = require('crypto');

const ENVELOPE_ALG = 'RSA-OAEP-256+A256GCM';
const DATA_PREFIX = 'enc1';

// --- RSA keypair for the transport envelope ------------------------------
// Provide a stable key via env (PEM, base64-encoded to survive .env files)
// so all replicas share it; otherwise generate one per process (fine for
// dev / single-replica; sessions are unaffected either way).
function loadOrCreateKeyPair(env) {
  const pem = env.AUTH_RSA_PRIVATE_KEY_B64
    ? Buffer.from(env.AUTH_RSA_PRIVATE_KEY_B64, 'base64').toString('utf8')
    : null;
  if (pem) {
    const privateKey = crypto.createPrivateKey(pem);
    const publicKey = crypto.createPublicKey(privateKey);
    return { privateKey, publicKey, source: 'env' };
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, publicKey, source: 'generated' };
}

function createSecurePayload({ env = process.env } = {}) {
  const { privateKey, publicKey, source } = loadOrCreateKeyPair(env);
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const keyId = crypto.createHash('sha256').update(publicKeyPem).digest('base64url').slice(0, 16);

  // Key for the manual encrypt/decrypt API, derived via HKDF so the raw
  // secret is never used directly as an AES key.
  const masterSecret = env.AUTH_DATA_ENCRYPTION_KEY || env.AUTH_TOKEN_SECRET || 'dev-only-secret-change-me';
  const dataKey = Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(masterSecret), Buffer.alloc(0), Buffer.from('crumb-data-encryption-v1'), 32)
  );

  function publicKeyInfo() {
    return {
      keyId,
      algorithm: ENVELOPE_ALG,
      publicKeyPem,
      usage: 'Encrypt request bodies as { enc: { v:1, alg, kid, key, iv, data } }'
    };
  }

  // enc = { v, alg, kid, key, iv, data } — all binary parts base64url.
  // `data` is AES-GCM ciphertext with the 16-byte auth tag appended
  // (WebCrypto's native output format).
  function decryptEnvelope(enc) {
    if (!enc || typeof enc !== 'object') throw new Error('missing envelope');
    if (enc.alg && enc.alg !== ENVELOPE_ALG) throw new Error('unsupported envelope algorithm');
    const wrappedKey = Buffer.from(String(enc.key || ''), 'base64url');
    const iv = Buffer.from(String(enc.iv || ''), 'base64url');
    const payload = Buffer.from(String(enc.data || ''), 'base64url');
    if (!wrappedKey.length || iv.length !== 12 || payload.length <= 16) throw new Error('malformed envelope');

    const aesKey = crypto.privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      wrappedKey
    );
    if (aesKey.length !== 32) throw new Error('bad key length');

    const tag = payload.subarray(payload.length - 16);
    const ciphertext = payload.subarray(0, payload.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  // --- Manual data encryption API -----------------------------------------
  function encryptData(plaintext, aad) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
    if (aad) cipher.setAAD(Buffer.from(String(aad)));
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [DATA_PREFIX, iv.toString('base64url'), ct.toString('base64url'), tag.toString('base64url')].join('.');
  }

  function decryptData(token, aad) {
    const parts = String(token || '').split('.');
    if (parts.length !== 4 || parts[0] !== DATA_PREFIX) throw new Error('unrecognised ciphertext format');
    const [, ivB64, ctB64, tagB64] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, Buffer.from(ivB64, 'base64url'));
    if (aad) decipher.setAAD(Buffer.from(String(aad)));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  }

  return { keyId, keySource: source, publicKeyInfo, decryptEnvelope, encryptData, decryptData };
}

module.exports = { createSecurePayload, ENVELOPE_ALG };
