#!/usr/bin/env bash
# Offline tests for bootstrap.sh (slice #43): validation halts, URL warnings,
# and the namespace/Secret/values-user derivation, with kubectl stubbed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K8S_DIR="$(dirname "$HERE")"
BOOTSTRAP="${K8S_DIR}/bootstrap.sh"

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

# Fake kubectl: records invocations and satisfies the dry-run pipeline.
FAKE_BIN="$(mktemp -d)"
cat > "${FAKE_BIN}/kubectl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "kubectl $*" >> "${KUBECTL_LOG:?}"
exit 0
EOF
chmod +x "${FAKE_BIN}/kubectl"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$FAKE_BIN"' EXIT

run_bootstrap() { # run_bootstrap <env-file> <extra args...>
  local env_file="$1"; shift
  local log="${TMP}/kubectl.log"
  : > "$log"
  (
    export PATH="${FAKE_BIN}:${PATH}"
    export KUBECTL_LOG="$log"
    bash "$BOOTSTRAP" --env-file "$env_file" --namespace harness6-system "$@" 2> "${TMP}/stderr"
  )
  echo "$?"
}

# --- case 1: missing .env halts ---
out="$(bash "$BOOTSTRAP" --env-file "${TMP}/nope.env" 2>&1)"; rc=$?
check "missing .env halts" "1" "$rc"
grep -q "not found" <<<"$out"; check "missing .env mentions the path" "0" "$?"

# --- case 2: empty required key halts ---
cat > "${TMP}/empty.env" <<'EOF'
OPENAI_API_KEY=sk-test
OPENAI_API_URL=https://api.openai.com/v1
MEM_EXTRACTOR_MODEL=claude-haiku-4-5
EMBEDDER_API_URL=https://api.openai.com/v1
MEM_EMBED_MODEL=text-embedding-3-small
EMBEDDER_DIMENSIONS=1536
NEO4J_PASSWORD=
SIGNOZ_JWT_SECRET=jwt
SIGNOZ_USER_ROOT_PASSWORD=pass
EOF
out="$(bash "$BOOTSTRAP" --env-file "${TMP}/empty.env" 2>&1)"; rc=$?
check "empty NEO4J_PASSWORD halts" "1" "$rc"
grep -q "NEO4J_PASSWORD is empty" <<<"$out"; check "halt names the empty key" "0" "$?"

# --- case 3: Compose-only URL warns but does not fail ---
cat > "${TMP}/warn.env" <<'EOF'
OPENAI_API_KEY=sk-test
OPENAI_API_URL=https://api.openai.com/v1
MEM_EXTRACTOR_MODEL=claude-haiku-4-5
EMBEDDER_API_URL=http://host.docker.internal:11434/v1
MEM_EMBED_MODEL=nomic-embed-text
EMBEDDER_DIMENSIONS=768
NEO4J_PASSWORD=password123
SIGNOZ_JWT_SECRET=jwt
SIGNOZ_USER_ROOT_PASSWORD=pass
EOF
out="$(bash "$BOOTSTRAP" --env-file "${TMP}/warn.env" --dry-run 2>&1)"; rc=$?
check "host.docker.internal URL is a warning, not a failure" "0" "$rc"
grep -q "^warning: EMBEDDER_API_URL" <<<"$out"; check "warning names EMBEDDER_API_URL" "0" "$?"

# --- case 3b: localhost URL warns too ---
cat > "${TMP}/warn-local.env" <<'LOCALEOF'
OPENAI_API_KEY=sk-test
OPENAI_API_URL=https://api.openai.com/v1
MEM_EXTRACTOR_MODEL=claude-haiku-4-5
EMBEDDER_API_URL=http://localhost:11434/v1
MEM_EMBED_MODEL=nomic-embed-text
EMBEDDER_DIMENSIONS=768
NEO4J_PASSWORD=password123
SIGNOZ_JWT_SECRET=jwt
SIGNOZ_USER_ROOT_PASSWORD=pass
LOCALEOF
out="$(bash "$BOOTSTRAP" --env-file "${TMP}/warn-local.env" --dry-run 2>&1)"; rc=$?
check "localhost URL is a warning, not a failure" "0" "$rc"
grep -q "^warning: EMBEDDER_API_URL" <<<"$out"; check "warning names EMBEDDER_API_URL for localhost" "0" "$?"

# --- case 4: happy path derives namespace + secret + values-user ---
out="$(run_bootstrap "${TMP}/warn.env")"; rc=$?
check "happy path exits 0" "0" "$rc"
log="$(cat "${TMP}/kubectl.log")"
grep -q "create namespace harness6-system" <<<"$log"; check "namespace created" "0" "$?"
grep -q "create secret generic harness6-secrets -n harness6-system" <<<"$log"; check "secret created" "0" "$?"
vu="${K8S_DIR}/values-user.yaml"
grep -q "^namespace: harness6-system$" "$vu"; check "values-user namespace" "0" "$?"
grep -q "^embedderApiUrl: 'http://host.docker.internal:11434/v1'$" "$vu"; check "values-user embedder URL" "0" "$?"
grep -q "^neo4jDatabase: 'neo4j'$" "$vu"; check "values-user default applied" "0" "$?"
grep -qE "PASSWORD|API_KEY|JWT_SECRET" "$vu"; check "values-user has no secret values" "1" "$?"
rm -f "$vu"

# --- case 5: per-stack default values expose the namespace parameter ---
for f in signoz milvus neo4j; do
  grep -q "^namespace: harness6-system$" "${K8S_DIR}/values/${f}.yaml"
  check "values/${f}.yaml namespace parameter" "0" "$?"
done

echo
echo "passed: ${PASS}, failed: ${FAIL}"
[[ "$FAIL" -eq 0 ]]
