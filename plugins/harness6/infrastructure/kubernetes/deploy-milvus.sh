#!/usr/bin/env bash
# deploy-milvus.sh — install/upgrade Milvus from the upstream zilliztech
# Helm chart with the bundled etcd + minio subcharts (spec #42, slice #45).
#
# Usage: deploy-milvus.sh [--namespace N] [--values extra-values.yaml]...
#
# - namespace defaults to the `namespace` key in values/milvus.yaml
#   (harness6-system, per the values-layer contract from slice #43).
# - storageClass is left unset everywhere → the cluster-default
#   StorageClass is used; PVCs carry the chart's default
#   helm.sh/resource-policy: keep annotation (survives uninstall).
# - After rollout the script prints the auto-assigned NodePort for the
#   Milvus gRPC endpoint (19530).
#
# Secrets come from the `harness6-secrets` Secret created by bootstrap.sh;
# the Milvus chart itself needs none of them (memsearch connects
# unauthenticated, per the Compose stack's behavior).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALUES_FILE="${SCRIPT_DIR}/values/milvus.yaml"
CHART_REPO_NAME="zilliztech"
CHART_REPO_URL="https://zilliztech.github.io/milvus-helm/"
CHART_REF="${CHART_REPO_NAME}/milvus"
RELEASE_NAME="milvus"
NAMESPACE=""
EXTRA_VALUES_ARGS=()

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --values) EXTRA_VALUES_ARGS+=(--values "$2"); shift 2 ;;
    *) die "unknown argument: $1 (use --namespace or --values)" ;;
  esac
done

command -v helm >/dev/null 2>&1 || die "helm is required but not installed"
command -v kubectl >/dev/null 2>&1 || die "kubectl is required but not installed"

[[ -f "$VALUES_FILE" ]] || die "values file not found: $VALUES_FILE"

# Read namespace from the values file when not overridden on the CLI.
if [[ -z "$NAMESPACE" ]]; then
  NAMESPACE="$(awk '$1=="namespace:" {print $2; exit}' "$VALUES_FILE" | tr -d '"')"
  [[ -n "$NAMESPACE" ]] || die "no namespace key in $VALUES_FILE; pass --namespace"
fi

info "==> namespace: ${NAMESPACE}"
kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 \
  || kubectl create namespace "$NAMESPACE" \
  || die "failed to ensure namespace ${NAMESPACE}"

# Idempotent chart-repo bootstrap (no-op when already added).
helm repo list 2>/dev/null | grep -q "^${CHART_REPO_NAME}[[:space:]]" \
  || helm repo add "$CHART_REPO_NAME" "$CHART_REPO_URL" >/dev/null
helm repo update >/dev/null

info "==> helm upgrade --install ${RELEASE_NAME} (${CHART_REF})"
helm upgrade --install "$RELEASE_NAME" "$CHART_REF" \
  --namespace "$NAMESPACE" \
  --values "$VALUES_FILE" \
  "${EXTRA_VALUES_ARGS[@]+"${EXTRA_VALUES_ARGS[@]}"}" \
  --wait --timeout 15m

info "==> waiting for ${RELEASE_NAME} rollouts"
for kind in deployment statefulset; do
  # Ignore "No resources found" — only wait on what actually exists.
  resources="$(kubectl get "$kind" -n "$NAMESPACE" -o name 2>/dev/null)" || resources=""
  for res in $resources; do
    kubectl wait "$res" -n "$NAMESPACE" --for=condition=available --timeout=10m
  done
done

# Report the reachable gRPC endpoint (memsearch target).
node_port="$(kubectl get service "${RELEASE_NAME}-milvus" -n "$NAMESPACE" \
  -o jsonpath='{.spec.ports[?(@.port==19530)].nodePort}' 2>/dev/null || true)"
if [[ -n "$node_port" ]]; then
  info "==> Milvus gRPC (19530) reachable via NodePort ${node_port} on any node"
  info "==> memsearch URI: <node-host>:${node_port}"
else
  info "==> warning: could not resolve the 19530 NodePort; inspect services in ${NAMESPACE}"
fi
