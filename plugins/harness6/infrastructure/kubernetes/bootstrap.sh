#!/usr/bin/env bash
# bootstrap.sh — namespace + Secrets + values-user derivation for the
# harness6-system Kubernetes stack (spec #42, slice #43).
#
# One source of truth: the existing infrastructure/.env. This script
#   1. creates the target namespace (default harness6-system),
#   2. derives the non-secret values-user.yaml from .env,
#   3. creates the `harness6-secrets` Secret via `kubectl create secret
#      generic` from .env keys at deploy time (no Secret YAML is ever
#      committed).
# Consumed by harness6-init's Kubernetes path (slice #47) after the
# kubectl/helm/cluster-reachability checks.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE_DEFAULT="${SCRIPT_DIR}/../.env"

NAMESPACE="${HARNESS6_NAMESPACE:-harness6-system}"
SECRET_NAME="harness6-secrets"
VALUES_USER="${SCRIPT_DIR}/values-user.yaml"
ENV_FILE="${ENV_FILE_DEFAULT}"
DRY_RUN=0

# Keys that must be present and non-empty in .env. Secret keys additionally
# go into the harness6-secrets Secret; the rest are non-secret and are
# derived into values-user.yaml.
SECRET_KEYS=(OPENAI_API_KEY NEO4J_PASSWORD SIGNOZ_JWT_SECRET SIGNOZ_USER_ROOT_PASSWORD)
NONSECRET_KEYS=(OPENAI_API_URL MEM_EXTRACTOR_MODEL EMBEDDER_API_URL MEM_EMBED_MODEL EMBEDDER_DIMENSIONS NEO4J_DATABASE GRAPHITI_GROUP_ID SEMAPHORE_LIMIT SIGNOZ_IDENTN_IMPERSONATION_ENABLED SIGNOZ_IDENTN_TOKENIZER_ENABLED SIGNOZ_IDENTN_APIKEY_ENABLED SIGNOZ_USER_ROOT_EMAIL SIGNOZ_USER_ROOT_ORG_NAME)
REQUIRED_KEYS=("${SECRET_KEYS[@]}" OPENAI_API_URL MEM_EXTRACTOR_MODEL EMBEDDER_API_URL MEM_EMBED_MODEL EMBEDDER_DIMENSIONS)
# URL keys that must be cluster-reachable; warn (not fail) on Compose-only values.
URL_WARN_KEYS=(OPENAI_API_URL EMBEDDER_API_URL)

# Non-secret keys with sane defaults so a minimal .env still works; the
# required list above is the minimal set without defaults.
declare -A ENV_DEFAULTS=(
  [NEO4J_DATABASE]="neo4j"
  [GRAPHITI_GROUP_ID]="main"
  [SEMAPHORE_LIMIT]="5"
  [SIGNOZ_IDENTN_IMPERSONATION_ENABLED]="true"
  [SIGNOZ_IDENTN_TOKENIZER_ENABLED]="false"
  [SIGNOZ_IDENTN_APIKEY_ENABLED]="false"
  [SIGNOZ_USER_ROOT_EMAIL]="admin@local.dev"
  [SIGNOZ_USER_ROOT_ORG_NAME]="default"
)

# camelCase targets in values-user.yaml, positional per NONSECRET_KEYS.
declare -A VALUES_USER_KEY=(
  [OPENAI_API_URL]="openaiApiUrl"
  [MEM_EXTRACTOR_MODEL]="memExtractorModel"
  [EMBEDDER_API_URL]="embedderApiUrl"
  [MEM_EMBED_MODEL]="embedderModel"
  [EMBEDDER_DIMENSIONS]="embedderDimensions"
  [NEO4J_DATABASE]="neo4jDatabase"
  [GRAPHITI_GROUP_ID]="graphitiGroupId"
  [SEMAPHORE_LIMIT]="semaphoreLimit"
  [SIGNOZ_IDENTN_IMPERSONATION_ENABLED]="signozIdentnImpersonationEnabled"
  [SIGNOZ_IDENTN_TOKENIZER_ENABLED]="signozIdentnTokenizerEnabled"
  [SIGNOZ_IDENTN_APIKEY_ENABLED]="signozIdentnApikeyEnabled"
  [SIGNOZ_USER_ROOT_EMAIL]="signozUserRootEmail"
  [SIGNOZ_USER_ROOT_ORG_NAME]="signozUserRootOrgName"
)

declare -A ENV=()

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
warn() { printf 'warning: %s\n' "$*" >&2; }
info() { printf '%s\n' "$*"; }

# Parse KEY=VALUE lines; comments and blanks skipped, surrounding single or
# double quotes stripped. Never sources the file.
load_env() {
  local file="$1" line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^[[:space:]]*export[[:space:]]+ ]] && line="${line#*export}" && line="${line#\" \"}" && line="${line#"${line%%[![:space:]]*}"}"
    [[ "$line" != *=* ]] && continue
    key="${line%%=*}"
    key="${key#"${key%%[![:space:]]*}"}"; key="${key%"${key##*[![:space:]]}"}"
    value="${line#*=}"
    value="${value#"${value%%[![:space:]]*}"}"
    [[ "$value" == \"*\" && "$value" == *\" ]] && value="${value#\"}" && value="${value%\"}"
    [[ "$value" == \'*\' && "$value" == *\' ]] && value="${value#\'}" && value="${value%\'}"
    ENV["$key"]="$value"
  done < "$file"
}

validate_env() {
  local key
  for key in "${REQUIRED_KEYS[@]}"; do
    [[ -n "${ENV[$key]:-${ENV_DEFAULTS[$key]:-}}" ]] || die "required key ${key} is empty in ${ENV_FILE}"
  done
  local url
  for url in "${URL_WARN_KEYS[@]}"; do
    if [[ "${ENV[$url]}" == *host.docker.internal* || "${ENV[$url]}" == *localhost* ]]; then
      warn "${url}=${ENV[$url]} contains host.docker.internal/localhost — a Compose-only value that will not resolve from inside the cluster. Point it at a cluster-reachable or host-IP URL."
    fi
  done
}

run_kubectl() {
  if (( DRY_RUN )); then
    info "+ kubectl $*"
  else
    kubectl "$@"
  fi
}

ensure_namespace() {
  local ns="$1"
  if (( DRY_RUN )); then
    info "+ kubectl create namespace ${ns} (apply via dry-run pipeline)"
    return
  fi
  kubectl create namespace "$ns" --dry-run=client -o yaml 2>/dev/null | kubectl apply -f - >/dev/null
  info "namespace ${ns} ready"
}

ensure_secret() {
  local ns="$1" args=() key
  args=(--from-literal)
  local literals=()
  for key in "${SECRET_KEYS[@]}"; do
    literals+=("--from-literal=${key}=${ENV[$key]}")
  done
  if (( DRY_RUN )); then
    info "+ kubectl create secret generic ${SECRET_NAME} -n ${ns} <redacted literals>"
    return
  fi
  kubectl create secret generic "$SECRET_NAME" -n "$ns" "${literals[@]}" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  info "secret ${SECRET_NAME} ready in namespace ${ns}"
}

# Derive the non-secret values layer consumed by the per-stack Helm values.
write_values_user() {
  local key target value
  {
    echo "# Generated by bootstrap.sh from ${ENV_FILE} — do not edit or commit."
    echo "# Non-secret values only; secrets live in the ${SECRET_NAME} Secret."
    echo "namespace: ${NAMESPACE}"
    for key in "${NONSECRET_KEYS[@]}"; do
      target="${VALUES_USER_KEY[$key]}"
      value="${ENV[$key]:-${ENV_DEFAULTS[$key]:-}}"
      printf '%s: %s\n' "$target" "$value"
    done
  } > "$VALUES_USER"
  info "wrote ${VALUES_USER}"
}

usage() {
  cat <<EOF
usage: bootstrap.sh [--env-file PATH] [--namespace NAME] [--dry-run]

Creates the namespace, derives values-user.yaml from .env, and creates the
harness6-secrets Secret. Requires kubectl.
EOF
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --env-file) ENV_FILE="$2"; shift 2 ;;
      --namespace) NAMESPACE="$2"; shift 2 ;;
      --dry-run) DRY_RUN=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown argument: $1 (see --help)" ;;
    esac
  done

  [[ -f "$ENV_FILE" ]] || die ".env not found at ${ENV_FILE} — copy ../.env.example to ../.env and fill it in first"
  load_env "$ENV_FILE"
  validate_env

  if (( ! DRY_RUN )); then
    command -v kubectl >/dev/null 2>&1 || die "kubectl not found on PATH — install kubectl before deploying the Kubernetes stack"
  fi

  ensure_namespace "$NAMESPACE"
  write_values_user
  ensure_secret "$NAMESPACE"
}

main "$@"
