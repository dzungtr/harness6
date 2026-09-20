#!/usr/bin/env bash
# deploy.sh — deploy the Neo4j + graphiti-mcp stack into the harness6-system
# namespace (spec #42, slice #46).
#
# Prerequisites (run bootstrap.sh first, or slice #47's orchestration):
#   - values-user.yaml derived from infrastructure/.env
#   - harness6-secrets Secret present in the target namespace
#   - kubectl + helm on PATH, cluster reachable
#
# Order (spec #42 deploy-order contract): Neo4j chart (wait for rollout) →
# graphiti ConfigMaps + manifests (wait for rollout) → report endpoints.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMESPACE="${HARNESS6_NAMESPACE:-}"
NEO4J_CHART_VERSION="5.26.30" # matches Compose's neo4j:5.26-community
NEO4J_RELEASE="neo4j"
NEO4J_AUTH_SECRET="neo4j-auth"
GRAPHITI_NODEPORT="30800"
VALUES_USER="${SCRIPT_DIR}/values-user.yaml"
CONFIG_FILE_DEFAULT="${SCRIPT_DIR}/../config.yaml"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }

[[ -f "$VALUES_USER" ]] || die "values-user.yaml not found at ${VALUES_USER} — run bootstrap.sh first"
[[ -f "$CONFIG_FILE_DEFAULT" ]] || die "config.yaml not found at ${CONFIG_FILE_DEFAULT} — entity-type schema missing"
command -v kubectl >/dev/null 2>&1 || die "kubectl not found on PATH"
command -v helm >/dev/null 2>&1 || die "helm not found on PATH"

# values-user.yaml has `namespace: <ns>` as its first value; HARNESS6_NAMESPACE
# overrides it.
if [[ -z "$NAMESPACE" ]]; then
  NAMESPACE="$(sed -n 's/^namespace: //p' "$VALUES_USER" | head -n1 | tr -d "'\"")"
fi
[[ -n "$NAMESPACE" ]] || die "namespace missing — set HARNESS6_NAMESPACE or re-run bootstrap.sh"

# Single-quoted KEY: 'VAL' lines as written by bootstrap.sh's write_values_user.
# Never fails — returns empty when the key is absent (pipefail-safe).
values_get() {
  grep -m1 "^$1: '" "$VALUES_USER" | sed "s/^$1: '//;s/'\$//" || true
}
# values_get for required keys — dies with a clear message when absent/empty.
value() {
  local v
  v="$(values_get "$1")"
  [[ -n "$v" ]] || die "key $1 missing or empty in ${VALUES_USER} — re-run bootstrap.sh"
  printf '%s' "$v"
}
INGRESS_CLASS="$(values_get ingressClassName 2>/dev/null || true)"

# Deploy-time wrapper Secret for the Neo4j chart: passwordFromSecret requires
# a NEO4J_AUTH key of the form "neo4j/<password>"; derive it from
# harness6-secrets (imperative, like bootstrap.sh — never rendered to the repo).
NEO4J_PW="$(kubectl get secret harness6-secrets -n "$NAMESPACE" -o jsonpath='{.data.NEO4J_PASSWORD}' | base64 -d)"
[[ -n "$NEO4J_PW" ]] || die "harness6-secrets/NEO4J_PASSWORD is empty in namespace ${NAMESPACE}"
kubectl create secret generic "$NEO4J_AUTH_SECRET" -n "$NAMESPACE" \
  --from-literal="NEO4J_AUTH=neo4j/${NEO4J_PW}" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
info "secret ${NEO4J_AUTH_SECRET} ready in namespace ${NAMESPACE}"

# 1. Neo4j community chart, wait for rollout.
helm upgrade --install "$NEO4J_RELEASE" neo4j/neo4j \
  --version "$NEO4J_CHART_VERSION" \
  -n "$NAMESPACE" \
  -f "${SCRIPT_DIR}/values/neo4j.yaml" \
  -f "$VALUES_USER" \
  --wait --timeout 10m
info "neo4j chart rollout complete"

# 2. Graphiti configuration: non-secret env literals from values-user.yaml and
# the entity-type schema from the Compose stack's config.yaml.
kubectl create configmap graphiti-env -n "$NAMESPACE" \
  --from-literal="OPENAI_API_URL=$(value openaiApiUrl)" \
  --from-literal="OPENAI_BASE_URL=$(value openaiApiUrl)" \
  --from-literal="MODEL_NAME=$(value memExtractorModel)" \
  --from-literal="EMBEDDER_API_URL=$(value embedderApiUrl)" \
  --from-literal="EMBEDDER_MODEL=$(value embedderModel)" \
  --from-literal="EMBEDDER_DIMENSIONS=$(value embedderDimensions)" \
  --from-literal="NEO4J_DATABASE=$(value neo4jDatabase)" \
  --from-literal="GRAPHITI_GROUP_ID=$(value graphitiGroupId)" \
  --from-literal="SEMAPHORE_LIMIT=$(value semaphoreLimit)" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl create configmap graphiti-config -n "$NAMESPACE" \
  --from-file="config.yaml=${CONFIG_FILE_DEFAULT}" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
info "graphiti ConfigMaps ready"

# 3. graphiti-mcp raw manifests, wait for rollout (gates on Neo4j above).
kubectl apply -n "$NAMESPACE" -f "${SCRIPT_DIR}/manifests/graphiti-mcp.yaml"
kubectl wait --for=condition=available --timeout=10m deployment/graphiti-mcp -n "$NAMESPACE"
info "graphiti-mcp rollout complete"

# 4. Optional Ingress when the user configured an ingress controller.
if [[ -n "$INGRESS_CLASS" ]]; then
  sed "s|@@INGRESS_CLASS@@|${INGRESS_CLASS}|" \
    "${SCRIPT_DIR}/manifests/graphiti-mcp-ingress.yaml.template" \
    | kubectl apply -n "$NAMESPACE" -f -
  info "graphiti-mcp Ingress applied (class ${INGRESS_CLASS})"
fi

info "graphiti-mcp reachable at http://<node>:${GRAPHITI_NODEPORT}/mcp/ (health: /health)"
