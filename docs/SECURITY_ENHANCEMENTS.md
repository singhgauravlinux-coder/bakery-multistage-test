# Security & Audit Enhancements

This release hardens authentication, adds full security audit logging, gates orders behind verified payments, and fixes the invoice contract. All schema changes ship both as versioned migrations in `db/migrations/` and idempotently self-applied by each service on startup (and appended to `db/init.sql` for fresh boots).

## Audit logging

Every security-relevant event — registration, login, logout, forgot/reset password, change password (request + confirm), email verification (request + confirm), account unlock, payments, orders, order confirmation, invoices, and profile updates — writes a row to `security_audit_logs` with: user id, email, public client IP, user agent, parsed browser/OS/device, endpoint, HTTP method, request id, timestamp, status code, success/failure, and a machine-readable failure reason. Structured pino logs carry the same context plus `failedAttempts`, `remainingAttempts`, and `locked` on auth events. Audit writes are fire-and-forget so they can never block or fail a user request; without a database they fall back to an in-memory ring buffer (also used by the tests).

Public IP extraction (`services/*/lib/client-info.js`) takes the left-most public address in `X-Forwarded-For`, skipping private (RFC1918), CGNAT, loopback, link-local, and Docker ranges, then falls back to `X-Real-IP` and finally the socket address. The gateway and nginx were fixed to actually forward these headers (see the RCA).

## Login protection & account lockout

- `accounts` gains `failed_login_attempts`, `last_failed_login_at`, `locked_at`, `unlock_token_hash`, `unlock_token_expires_at`, `email_verified` (migration `0001`).
- After **5** consecutive failures (`AUTH_MAX_FAILED_ATTEMPTS`) the account locks: further logins return **423 Account Locked** even with the correct password.
- On lock, a 32-byte unlock token is generated, stored **as a SHA-256 hash**, expires in 30 minutes, and is emailed via the notification service. `POST /auth/unlock` redeems it, clearing the lock and counters. A successful password reset also clears any lock.
- Failed logins return `remainingAttempts`; the UI surfaces "N attempts left before the account locks."
- Successful logins reset the counter and append to `login_history` (migration `0002`).

## Change password = forgot password

`POST /auth/password` no longer accepts a current password alone. The flow now mirrors forgot-password: `POST /auth/password/request` (authenticated) emails a 6-digit OTP (crypto.randomInt) and returns a short-lived `changeToken` binding the OTP hash to the user; `POST /auth/password` requires `{ changeToken, otp, newPassword }` and compares the OTP with `timingSafeEqual`. Email verification uses the same scoped-token machinery (`/auth/verify-email/request` + `/confirm`).

All purpose-scoped tokens (session, reset, change, verify-email, unlock) go through one signer/verifier, so a reset token can never be replayed as a session token.

## Payment-gated orders

Covered in detail in `ROOT_CAUSE_ANALYSIS.md`. Summary: orders start `pending_payment`; the mock gateway validates card (Luhn/expiry/CVV) and UPI (VPA) instruments and stores only masked summaries; `POST /orders/:id/confirm` verifies the payment server-to-server (existence, order match, success, amount ±0.01); a unique index prevents payment replay across orders; Razorpay verify/webhook paths confirm through the same gate. `payment_events` (migration `0005`) records created/captured/rejected/webhook events with IP and request id.

## Database migrations

| File | Purpose |
|---|---|
| `0001_account_security.sql` | lockout + verification columns on `accounts` |
| `0002_login_history.sql` | successful-login history |
| `0003_security_audit_logs.sql` | central audit table |
| `0004_orders_payment_gating.sql` | payment columns on `orders` + unique payment index (legacy rows backfilled as `paid`) |
| `0005_payment_logs.sql` | `instrument_summary` + `payment_events` |
| `0006_invoices.sql` | persistent invoices |

## Production notes

- **`AUTH_RETURN_DEBUG_TOKENS` must be `false` in production.** It defaults to `true` because the mailer is a mock; when true, reset/unlock/verify tokens and dev OTPs are returned in API responses for demo purposes.
- The Razorpay **webhook should bypass the API gateway** and hit the payment service directly at the ingress: the gateway re-serialises JSON, which would break the HMAC computed over raw bytes. The payment service keeps `req.rawBody` for exact-byte verification.
- Migration `0004` backfills pre-existing orders as `paid` so historical orders aren't retroactively blocked.
- Run tests with `npm test` inside `services/{auth,order,payment,invoice}-service` (Node 22, no database required — memory mode).
