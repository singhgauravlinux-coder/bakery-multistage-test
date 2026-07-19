#!/usr/bin/env bash
# MANUAL FALLBACK ONLY. Normal CD is Argo CD watching k8s/overlays/* — see
# docs/DEPLOYMENT.md. This script is for standing up a cluster before Argo
# CD is installed, or for debugging without it. Nothing in CI calls this.
#
# Sequential Kubernetes deployment for the bakery stack, against one of the
# dev / uat / production overlays under k8s/overlays/.
#
# Deploys the data layer first, then every microservice ONE AT A TIME in
# dependency order. Each service must pass its readiness probes
# (kubectl rollout status) before the next one is applied. If any rollout
# fails, the script stops, prints diagnostics, and exits non-zero — nothing
# after the broken service gets touched.
#
# This is the local/manual equivalent of what Argo CD does automatically
# once it's registered (see argocd/*.yaml) — useful for standing up an
# environment from scratch or for manual recovery.
#
# Usage:
#   ./scripts/deploy.sh dev              # deploy everything to dev
#   ./scripts/deploy.sh uat
#   ./scripts/deploy.sh production
#   ROLLOUT_TIMEOUT=300s ./scripts/deploy.sh production
set -euo pipefail

ENVIRONMENT="${1:-dev}"
case "$ENVIRONMENT" in
  dev)        NAMESPACE="bakery-dev" ;;
  uat)        NAMESPACE="bakery-uat" ;;
  production) NAMESPACE="bakery-prod" ;;
  *) echo "Usage: $0 {dev|uat|production}" >&2; exit 1 ;;
esac

ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-180s}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OVERLAY_DIR="${ROOT_DIR}/k8s/overlays/${ENVIRONMENT}"
RENDERED="$(mktemp)"
trap 'rm -f "$RENDERED"' EXIT

kustomize build "$OVERLAY_DIR" > "$RENDERED"

# Dependency-ordered service list: platform services first, then domain
# services, the gateway second-to-last, and the frontend last.
SERVICES=(
  auth-service
  user-service
  product-catalog-service
  inventory-service
  pricing-service
  cart-service
  order-service
  payment-service
  delivery-service
  notification-service
  review-service
  search-service
  recommendation-service
  promotion-service
  loyalty-service
  recipe-service
  baking-schedule-service
  supplier-service
  analytics-service
  media-service
  invoice-service
  currency-service
  language-service
  api-gateway
  frontend
)

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mxx  %s\033[0m\n' "$*" >&2; exit 1; }

diagnose() {
  local app="$1"
  echo "---- diagnostics for ${app} ----"
  kubectl -n "$NAMESPACE" get pods -l "app=${app}" -o wide || true
  kubectl -n "$NAMESPACE" describe pods -l "app=${app}" | tail -n 25 || true
  kubectl -n "$NAMESPACE" logs -l "app=${app}" --tail=30 --all-containers || true
}

wait_for_rollout() {
  local kind="$1" name="$2"
  if ! kubectl -n "$NAMESPACE" rollout status "${kind}/${name}" --timeout="$ROLLOUT_TIMEOUT"; then
    diagnose "$name"
    fail "${name} failed to become ready within ${ROLLOUT_TIMEOUT} — aborting (remaining services NOT deployed)"
  fi
}

# apply_kind_name KIND NAME  — pulls one resource out of $RENDERED and applies it
apply_kind_name() {
  local kind="$1" name="$2"
  yq eval "select(.kind == \"${kind}\" and .metadata.name == \"${name}\")" "$RENDERED" \
    | kubectl apply -f -
}

# apply_kinds KIND [KIND...] — applies every resource of the given kind(s)
apply_kinds() {
  local expr=""
  for k in "$@"; do expr+="${expr:+ or }.kind == \"${k}\""; done
  yq eval "select(${expr})" "$RENDERED" | kubectl apply -f -
}

# ---------------------------------------------------------------- namespace
log "Applying namespace (${NAMESPACE})"
apply_kind_name Namespace "$NAMESPACE"

# ------------------------------------------------------------------ secrets
log "Applying secrets (bakery-db-secret, razorpay-credentials)"
apply_kinds Secret

# --------------------------------------------------------------- data layer
log "Deploying data layer (postgres, redis, adminer)"
yq eval 'select(.metadata.name == "postgres" or .metadata.name == "redis" or .metadata.name == "adminer")' "$RENDERED" \
  | kubectl apply -f -
wait_for_rollout statefulset postgres
wait_for_rollout deployment redis
wait_for_rollout deployment adminer

# ------------------------------------------------- services, one at a time
for svc in "${SERVICES[@]}"; do
  log "Deploying ${svc}"
  yq eval "select(.metadata.name == \"${svc}\" and (.kind == \"Deployment\" or .kind == \"Service\"))" "$RENDERED" \
    | kubectl apply -f -
  wait_for_rollout deployment "$svc"
  echo "    ${svc} is ready ✔"
done

# ------------------------------------------------------- policies + ingress
log "Applying scaling policies (HPA, PodDisruptionBudget)"
apply_kinds HorizontalPodAutoscaler PodDisruptionBudget

log "Applying Traefik ingress"
apply_kinds Middleware Ingress

log "All ${#SERVICES[@]} services deployed and healthy in ${ENVIRONMENT} (namespace ${NAMESPACE})"
kubectl -n "$NAMESPACE" get pods
