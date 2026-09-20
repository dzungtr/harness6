#!/usr/bin/env bash
# Offline tests for deploy-signoz.sh (slice #47): tool halts, values-user
# requirement, namespace derivation, helm install arguments, the health-gate
# (failure warns + stays non-fatal), and NodePort reporting, with
# kubectl/helm stubbed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K8S_DIR="$(dirname "$HERE")"
SCRIPT="${K8S_DIR}/deploy-signoz.sh"

PASS=0
FAIL=0

check() { # check <description> <expected> <actual>
  local desc="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    PASS=$((PASS + 1)); echo "ok - ${desc}"
  else
    FAIL=$((FAIL + 1)); echo "FAIL - ${desc}"
    echo "  expected: ${expected}"
    echo "  actual:   ${actual}"
  fi
}

has() { # has <file> <fixed-string> <description>
  if grep -Fq -- "$2" "$1"; then
    PASS=$((PASS + 1)); echo "ok - $3"
  else
    FAIL=$((FAIL + 1)); echo "FAIL - $3 (missing: $2)"
    grep -n . "$1" | head -20
  fi
}

TMP="$(mktemp -d)"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$TMP" "$FAKE_BIN"' EXIT

run_script() { # run_script <values-user-file> [ENV=VAL...] [script args...]
  local vu_file="$1"; shift
  local envs=()
  while [[ $# -gt 0 && "$1" == *=* ]]; do envs+=("$1"); shift; done
  env CMD_LOG="${TMP}/cmd.log" HARNESS6_VALUES_USER="$vu_file" "${envs[@]}" \
    PATH="${FAKE_BIN}:${PATH}" HEALTH_ATTEMPTS=1 HEALTH_INTERVAL=0 \
    HELM_LOG="${TMP}/helm.log" KUBECTL_LOG="${TMP}/kubectl.log" \
    "$(command -v bash)" "$SCRIPT" "$@" 2>"${TMP}/stderr.txt" >"${TMP}/stdout.txt"
  return $?
}

# ---- stubs -----------------------------------------------------------------

# helm: log args, satisfy repo list/add/update. HELM_REPO_EMPTY=1 simulates
# a missing chart repo so `repo list` finds nothing.
cat > "${FAKE_BIN}/helm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "helm $*" >> "${HELM_LOG:?}"
case "$1" in
  repo)
    if [[ "$2" == "list" && "${HELM_REPO_EMPTY:-}" == "1" ]]; then exit 0; fi
    [[ "$2" == "list" ]] && { printf 'signoz\thttps://charts.signoz.io\n'; exit 0; }
    exit 0 ;;
esac
exit 0
EOF
chmod +x "${FAKE_BIN}/helm"

# kubectl: log args; get namespace succeeds; get deployment/statefulset lists
# the release resources; get service emits a NodePort map (and the UI port
# 8080 for the component=signoz lookup); health probes succeed unless
# KUBECTL_PROBE_FAILS is still positive (simulating slow SigNoz startup).
cat > "${FAKE_BIN}/kubectl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "kubectl $*" >> "${KUBECTL_LOG:?}"
case "$*" in
  *"get namespace"*) exit 0 ;;
  *"get deployment -n"*) printf 'deployment/signoz\n' ;;
  *"get statefulset -n"*) printf 'statefulset/chi-signoz-signoz-0\n' ;;
  *"get service -n"*)
    if [[ "$*" == *component=signoz* ]]; then printf '8080\n'
    else printf '4317 30017\n4318 30018\n8080 30016\n'; fi ;;
  *"run signoz-healthcheck"*)
    if [[ "${KUBECTL_PROBE_FAILS:-0}" -gt 0 ]]; then
      export KUBECTL_PROBE_FAILS=$((KUBECTL_PROBE_FAILS - 1))
      exit 1
    fi
    exit 0 ;;
esac
exit 0
EOF
chmod +x "${FAKE_BIN}/kubectl"

# A minimal generated values-user.yaml (bootstrap.sh contract shape).
make_values_user() {
  cat > "${TMP}/values-user.yaml" <<'EOF'
namespace: harness6-system
openaiApiUrl: 'https://api.example.com/v1'
memExtractorModel: 'gpt-4o-mini'
embedderApiUrl: 'https://api.example.com/v1'
embedderModel: 'text-embedding-3-small'
embedderDimensions: '1536'
neo4jDatabase: 'neo4j'
graphitiGroupId: 'main'
semaphoreLimit: '5'
signozIdentnImpersonationEnabled: 'true'
signozIdentnTokenizerEnabled: 'false'
signozIdentnApikeyEnabled: 'false'
signozUserRootEmail: 'admin@local.dev'
signozUserRootOrgName: 'default'
EOF
}

# ---- tests -----------------------------------------------------------------

# 1. Missing values-user.yaml halts with a clear message.
set +e
env PATH="${FAKE_BIN}:${PATH}" HELM_LOG="${TMP}/helm.log" KUBECTL_LOG="${TMP}/kubectl.log" \
  bash "$SCRIPT" >/dev/null 2>"${TMP}/err1.txt"
rc1=$?
set -e
check "missing values-user.yaml exit code" "1" "$rc1"
has "${TMP}/err1.txt" "values-user.yaml not found" "missing values-user.yaml message"

# 2. Missing kubectl halts early with a clear message. Build a stripped
#    PATH: everything from /usr/bin except kubectl and helm.
make_values_user
mkdir -p "${FAKE_BIN}/nok"
for f in /usr/bin/* /bin/*; do
  base="$(basename "$f")"
  [[ "$base" == kubectl || "$base" == helm ]] && continue
  [[ -e "${FAKE_BIN}/nok/${base}" ]] || ln -s "$f" "${FAKE_BIN}/nok/${base}" 2>/dev/null || true
done
set +e
env PATH="${FAKE_BIN}/nok" "$(command -v bash)" "$SCRIPT" >/dev/null 2>"${TMP}/err2.txt"
rc2=$?
set -e
check "missing kubectl exit code" "1" "$rc2"
has "${TMP}/err2.txt" "kubectl is required but not installed" "missing kubectl message"

# 3. Namespace derived from values-user.yaml; helm install pinned + both
#    values files passed.
: > "${TMP}/helm.log"; : > "${TMP}/kubectl.log"
set +e; run_script "${TMP}/values-user.yaml"; rc3=$?; set -e
check "happy-path exit code" "0" "$rc3"
has "${TMP}/helm.log" "helm upgrade --install signoz signoz/signoz --version 0.129.0" "helm pinned install"
has "${TMP}/helm.log" "--namespace harness6-system" "helm namespace from values-user"
has "${TMP}/helm.log" "--values ${K8S_DIR}/values/signoz.yaml" "values/signoz.yaml passed"
has "${TMP}/helm.log" "--values ${TMP}/values-user.yaml" "values-user.yaml passed"

# 4. Chart repo added only when missing.
: > "${TMP}/helm.log"; : > "${TMP}/kubectl.log"
run_script "${TMP}/values-user.yaml" >/dev/null 2>&1
if grep -Fq "helm repo add" "${TMP}/helm.log"; then
  FAIL=$((FAIL + 1)); echo "FAIL - repo add skipped when repo present"
else
  PASS=$((PASS + 1)); echo "ok - repo add skipped when repo present"
fi
: > "${TMP}/helm.log"; : > "${TMP}/kubectl.log"
HELM_REPO_EMPTY=1 run_script "${TMP}/values-user.yaml" >/dev/null 2>&1
has "${TMP}/helm.log" "helm repo add signoz https://charts.signoz.io" "repo add when repo list empty"

# 5. Health probe failure is non-fatal and warns; success logs healthy.
: > "${TMP}/helm.log"; : > "${TMP}/kubectl.log"
KUBECTL_PROBE_FAILS=1 run_script "${TMP}/values-user.yaml"
check "health-probe failure non-fatal" "0" "$?"
has "${TMP}/stdout.txt" "did not answer" "health-probe failure warns"
: > "${TMP}/helm.log"; : > "${TMP}/kubectl.log"
run_script "${TMP}/values-user.yaml" >/dev/null 2>&1
has "${TMP}/stdout.txt" "SigNoz UI healthy" "health probe success reported"

# 6. NodePorts reported for UI/OTLP.
has "${TMP}/stdout.txt" "http://<node>:30016" "UI NodePort reported"
has "${TMP}/stdout.txt" "<node>:30017" "OTLP gRPC NodePort reported"
has "${TMP}/stdout.txt" "<node>:30018" "OTLP HTTP NodePort reported"

# 7. --namespace overrides the derived namespace.
: > "${TMP}/helm.log"; : > "${TMP}/kubectl.log"
run_script "${TMP}/values-user.yaml" --namespace custom-ns >/dev/null 2>&1
has "${TMP}/helm.log" "--namespace custom-ns" "--namespace override"

# 8. --values passthrough.
: > "${TMP}/helm.log"; : > "${TMP}/kubectl.log"
extra="${TMP}/extra.yaml"; printf 'x: 1\n' > "$extra"
run_script "${TMP}/values-user.yaml" --values "$extra" >/dev/null 2>&1
has "${TMP}/helm.log" "--values ${extra}" "--values passthrough"

echo "----"
echo "pass: ${PASS} fail: ${FAIL}"
[[ "$FAIL" -eq 0 ]]
