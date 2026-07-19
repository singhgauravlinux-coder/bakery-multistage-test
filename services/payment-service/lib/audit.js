'use strict';
/**
 * Security / audit trail writer. Persists one row per security-relevant
 * event (registration, login, logout, password flows, payments, orders,
 * invoices, profile updates) to `security_audit_logs`.
 *
 * Fire-and-forget by design: an audit failure must never break the user
 * flow, so errors are logged and swallowed. Falls back to an in-memory
 * ring buffer when no Postgres pool is configured (local dev / tests).
 */
const MEMORY_LIMIT = 1000;

function createAuditLogger({ pool, logger, service }) {
  const memory = [];

  async function write(entry) {
    const row = {
      service,
      action: entry.action,
      user_id: entry.userId || null,
      email: entry.email || null,
      ip: entry.ip || null,
      user_agent: entry.userAgent || null,
      browser: entry.browser || null,
      os: entry.os || null,
      device: entry.device || null,
      endpoint: entry.endpoint || null,
      method: entry.method || null,
      request_id: entry.requestId || null,
      status_code: entry.statusCode || null,
      success: entry.success !== false,
      failure_reason: entry.failureReason || null,
      metadata: entry.metadata || {}
    };
    if (!pool) {
      memory.push({ ...row, created_at: new Date().toISOString() });
      if (memory.length > MEMORY_LIMIT) memory.shift();
      return;
    }
    try {
      await pool.query(
        `INSERT INTO security_audit_logs
           (service, action, user_id, email, ip, user_agent, browser, os, device,
            endpoint, method, request_id, status_code, success, failure_reason, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
        [row.service, row.action, row.user_id, row.email, row.ip, row.user_agent,
         row.browser, row.os, row.device, row.endpoint, row.method, row.request_id,
         row.status_code, row.success, row.failure_reason, JSON.stringify(row.metadata)]
      );
    } catch (err) {
      logger.warn({ event: 'audit_write_failed', action: row.action, message: err.message },
        'audit row could not be persisted');
    }
  }

  return {
    /** Fire-and-forget audit write; never throws, never blocks the response. */
    record(entry) { write(entry).catch(() => { /* swallowed by design */ }); },
    /** Awaitable variant for tests. */
    recordAsync(entry) { return write(entry); },
    /** In-memory rows (empty when Postgres-backed). Exposed for tests. */
    memoryRows() { return memory.slice(); }
  };
}

module.exports = { createAuditLogger };
