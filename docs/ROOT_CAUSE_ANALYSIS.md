# Root Cause Analysis

Two production-facing defects were reported: orders being placed without any card/UPI details, and `POST /api/invoices` returning `400 Bad Request`. A third, related weakness — audit logs recording internal Docker IPs instead of client IPs — was found during the investigation. This document explains each root cause and how it was fixed.

## 1. Orders placed without card / UPI details

The checkout flow in `services/frontend/index.html` created the order first and then called the mock payment endpoint with nothing but `{ orderId, amount, method: 'card' }`. The payment service accepted that request and unconditionally returned `status: 'succeeded'` — it never asked for, validated, or even looked at an instrument. The Razorpay endpoints that do perform real verification existed in the payment service but were never called by the frontend. Finally, the order service never checked that a successful payment existed before treating an order as placed, so even a failed or missing payment left a fully placed order behind.

In short, the system had a payment *page* but no payment *gate*: the order was committed before money was ever verified, and the mock gateway rubber-stamped every request.

**Fix.** The flow is now pay-before-place. Orders are created in `pending_payment` / `awaiting_payment` (COD is the only exception, created as `received` / `cod_pending`). The mock gateway validates instruments like a real one — Luhn check, expiry, and CVV for cards; VPA format for UPI — and rejects invalid requests with a reason. Only brand + last4 (or a masked VPA) is stored, keeping PANs out of the database. An order only becomes `received` via `POST /orders/:id/confirm`, which verifies server-to-server with the payment service that the referenced payment exists, belongs to that order, succeeded, and matches the amount to within €0.01. A unique partial index on `orders.payment_id` prevents one payment from confirming two orders. Razorpay verification/webhook paths now also call the confirm endpoint, so both providers pass through the same gate.

## 2. `POST /api/invoices` → 400 Bad Request

The invoice service required both `orderId` **and** `amount` in the request body, but the frontend only ever sent `{ orderId }`. Every invoice request therefore failed validation with a 400. This was a contract mismatch between frontend and service, invisible in the happy-path demo because the error was swallowed in the checkout promise chain.

**Fix.** The frontend now sends `orderId`, `amount`, `currency`, and `customer`. Independently, the invoice service was made robust: when `amount` is omitted it resolves the total from the order service; it refuses to invoice unpaid orders (409); it returns a 422 with field-level details when an amount truly cannot be determined; and invoice creation is idempotent per order. Invoices are also now persisted in Postgres instead of process memory.

## 3. Audit logs showing internal Docker IPs

The API gateway forwarded only `content-type` and `x-request-id` to upstream services, stripping `X-Forwarded-For`, `X-Real-IP`, and `User-Agent`; nginx in front of the frontend did not set forwarding headers either. Services therefore only ever saw the gateway container's IP (e.g. `172.18.0.x`).

**Fix.** nginx now sets `X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Proto`, and `User-Agent`; the gateway appends its socket peer to `X-Forwarded-For` and forwards `x-real-ip`, `user-agent`, `authorization`, and `x-razorpay-signature`. A shared `client-info` helper picks the left-most **public** hop from `X-Forwarded-For` — skipping RFC1918, CGNAT, and Docker ranges — so audit rows record the real client IP alongside parsed browser/OS/device.

## Verification

31 automated tests (`npm test` in auth/order/payment/invoice services) cover login lockout and unlock, OTP-verified password change, instrument validation, payment-gated order confirmation (wrong order, wrong amount, failed status, replay), and invoice resolution including the original 400 scenario.
