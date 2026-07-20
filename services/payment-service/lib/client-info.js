'use strict';
/**
 * Client-request forensics: real public IP (behind Traefik / Nginx / the
 * API gateway), request id, and a dependency-free User-Agent breakdown
 * (browser / OS / device). Used by the audit-log and security-log writers.
 */
const crypto = require('crypto');

const PRIVATE_V4 = [
  /^10\./, // RFC1918
  /^192\.168\./, // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918 172.16/12 (Docker default bridge lives here)
  /^127\./, // loopback
  /^169\.254\./, // link-local
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./ // CGNAT 100.64/10
];

function isPrivateIp(ip) {
  if (!ip) return true;
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (v4 === '::1' || v4.toLowerCase() === 'localhost') return true;
  if (/^[0-9.]+$/.test(v4)) return PRIVATE_V4.some((re) => re.test(v4));
  // IPv6 private ranges: unique-local fc00::/7 and link-local fe80::/10
  return /^(fc|fd|fe8|fe9|fea|feb)/i.test(v4.replace(/^\[|\]$/g, ''));
}

/**
 * Left-most *public* address in X-Forwarded-For wins; falls back to
 * X-Real-IP, then to the socket address. Internal Docker/compose hop
 * addresses (172.16/12 etc.) are never reported as the client IP: if only
 * private addresses are present the left-most entry is returned so local
 * development still records something meaningful.
 */
function getClientIp(req) {
  const cfIp = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cfIp && !isPrivateIp(cfIp)) return cfIp;
  const xff = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const firstPublic = xff.find((ip) => !isPrivateIp(ip));
  if (firstPublic) return firstPublic;
  const realIp = String(req.headers['x-real-ip'] || '').trim();
  if (realIp && !isPrivateIp(realIp)) return realIp;
  if (xff.length) return xff[0]; // best available (dev / all-private chains)
  if (realIp) return realIp;
  const socketIp = (req.socket && req.socket.remoteAddress) || '';
  return socketIp.startsWith('::ffff:') ? socketIp.slice(7) : socketIp;
}

const BROWSERS = [
  { name: 'Edge', re: /Edg(?:e|A|iOS)?\/([\d.]+)/ },
  { name: 'Opera', re: /(?:OPR|Opera)\/([\d.]+)/ },
  { name: 'Samsung Internet', re: /SamsungBrowser\/([\d.]+)/ },
  { name: 'Chrome', re: /(?:Chrome|CriOS)\/([\d.]+)/ },
  { name: 'Firefox', re: /(?:Firefox|FxiOS)\/([\d.]+)/ },
  { name: 'Safari', re: /Version\/([\d.]+).*Safari/ },
  { name: 'curl', re: /curl\/([\d.]+)/ },
  { name: 'PostmanRuntime', re: /PostmanRuntime\/([\d.]+)/ }
];

const OSES = [
  { name: 'Windows', re: /Windows NT ([\d.]+)/ },
  { name: 'iOS', re: /(?:iPhone|iPad|iPod).*OS ([\d_]+)/ },
  { name: 'Android', re: /Android ([\d.]+)/ },
  { name: 'macOS', re: /Mac OS X ([\d_.]+)/ },
  { name: 'Chrome OS', re: /CrOS/ },
  { name: 'Linux', re: /Linux/ }
];

function detectDevice(ua) {
  if (/iPad|Tablet|Nexus 7|Nexus 10|SM-T/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|Android.+Mobile/i.test(ua)) return 'mobile';
  if (/bot|crawler|spider|curl|wget|python-requests|Postman/i.test(ua)) return 'bot';
  return 'desktop';
}

function parseUserAgent(uaHeader) {
  const ua = String(uaHeader || '');
  if (!ua) return { browser: 'unknown', os: 'unknown', device: 'unknown' };
  let browser = 'unknown';
  for (const b of BROWSERS) {
    const m = ua.match(b.re);
    if (m) { browser = m[1] ? `${b.name} ${m[1].split('.')[0]}` : b.name; break; }
  }
  let os = 'unknown';
  for (const o of OSES) {
    const m = ua.match(o.re);
    if (m) { os = m[1] ? `${o.name} ${m[1].replace(/_/g, '.')}` : o.name; break; }
  }
  return { browser, os, device: detectDevice(ua) };
}

/** Everything the audit log needs about the incoming request. */
function clientInfo(req) {
  const ua = String(req.headers['user-agent'] || '');
  return {
    ip: getClientIp(req),
    userAgent: ua.slice(0, 512),
    ...parseUserAgent(ua),
    requestId: String(req.headers['x-request-id'] || '') || `req_${crypto.randomUUID()}`,
    endpoint: req.originalUrl || req.url,
    method: req.method
  };
}

module.exports = { getClientIp, isPrivateIp, parseUserAgent, clientInfo };
