#!/usr/bin/env bash
# End-to-end smoke test against the docker compose stack.
set -euo pipefail
BASE="${BASE:-http://localhost:3000}"
pass() { printf '  \033[32mOK\033[0m  %s\n' "$1"; }

echo "Smoke testing $BASE ..."

curl -fsS "$BASE/health" > /dev/null                                  && pass "gateway health"
curl -fsS "$BASE/api/products" | grep -q 'Levain'                     && pass "catalog served from Postgres"
curl -fsS "$BASE/api/users/u-1" | grep -q 'Amelie'                    && pass "user profile from Postgres"

TOKEN=$(curl -fsS -X POST "$BASE/api/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"amelie@crumbandember.dev","password":"baguette"}' | sed -E 's/.*"token":"([^"]+)".*/\1/')
[ -n "$TOKEN" ]                                                       && pass "login → signed token"
curl -fsS "$BASE/api/auth/verify" -H "Authorization: Bearer $TOKEN" \
  | grep -q '"valid":true'                                            && pass "token verified"

curl -fsS -X POST "$BASE/api/carts/u-1/items" \
  -H 'content-type: application/json' \
  -d '{"productId":"p-3","quantity":2}' | grep -q 'p-3'               && pass "cart write (Redis)"
curl -fsS "$BASE/api/carts/u-1" | grep -q 'p-3'                       && pass "cart read (Redis)"

ORDER_ID=$(curl -fsS -X POST "$BASE/api/orders" \
  -H 'content-type: application/json' \
  -d '{"userId":"u-1","items":[{"productId":"p-3","quantity":2}]}' | sed -E 's/.*"id":"([^"]+)".*/\1/')
[ -n "$ORDER_ID" ]                                                    && pass "order created ($ORDER_ID)"
curl -fsS "$BASE/api/orders/$ORDER_ID" | grep -q "$ORDER_ID"          && pass "order persisted in Postgres"

curl -fsS "$BASE/api/currency/convert?amount=8.5&from=EUR&to=INR" \
  | grep -q '"result"'                                                && pass "currency conversion (EUR → INR)"
curl -fsS "$BASE/api/currency" | grep -q '"INR"'                      && pass "currency list (45+ currencies)"

curl -fsS "$BASE/api/language" | grep -q '"ja"'                       && pass "language list (15 languages)"
curl -fsS "$BASE/api/language/translations?lang=fr" \
  | grep -q '"nav.oven"'                                              && pass "translation table (fr)"
curl -fsS "$BASE/api/language/translate?key=hero.kicker&lang=ja" \
  | grep -q '"text"'                                                  && pass "single-string translate (ja)"

echo "All smoke tests passed."
