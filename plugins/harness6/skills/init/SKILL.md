---
name: init
description: >
  Initialize the shared harness6 infrastructure stack after installing the plugin. Resolve the
  plugin cache root from the active harness, choose a container runtime, scaffold infrastructure/.env
  without overwriting it, start Compose, start the Mem0 agentic-memory stack, register the bundled
  MCP servers (including the `memory` MCP server), and set up memsearch.
---

## 1. Resolve the plugin root

In source layout the plugin lives at `plugins/harness6/`, so `infrastructure/` and `skills/`
sit directly under the plugin dir. Installed into a harness, the harness sets `PLUGIN_ROOT` /
`CLAUDE_PLUGIN_ROOT` to that same plugin dir. Check `PLUGIN_ROOT` first because that is the Codex
plugin-root variable. If it is unset or empty, check `CLAUDE_PLUGIN_ROOT`:

```bash
if [ -n "${PLUGIN_ROOT:-}" ]; then
  HARNESS6_PLUGIN_ROOT="$PLUGIN_ROOT"
elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  HARNESS6_PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT"
else
  printf '%s\n' 'init: no plugin root found. Run this skill from an installed harness6 plugin (PLUGIN_ROOT or CLAUDE_PLUGIN_ROOT must be set).' >&2
  exit 1
fi
```

Set `INFRA_ROOT` to `<HARNESS6_PLUGIN_ROOT>/infrastructure`. Halt with a clear error if that
directory does not exist:

> **init: infrastructure directory not found at `<HARNESS6_PLUGIN_ROOT>/infrastructure`.** Run this skill from an installed harness6 plugin. Aborting.

## 2. Choose the container runtime

Before doing any setup or attempting to start Compose, check that the runtime executables exist:

```bash
DOCKER_AVAILABLE=false
PODMAN_AVAILABLE=false
command -v docker >/dev/null 2>&1 && DOCKER_AVAILABLE=true
command -v podman >/dev/null 2>&1 && PODMAN_AVAILABLE=true
```

- If neither is available, stop: `init: neither docker nor podman was found on PATH. Install one and retry.`
- If only Docker is available, use `docker compose`.
- If only Podman is available, use `podman compose`.
- If both are available, ask the user which runtime to use and wait for an explicit choice. Default to
  Docker only when the user does not have a choice to make (Docker is the default when it is the
  sole available runtime); never silently choose when both are installed.

Store the selected executable as `CONTAINER_RUNTIME` and invoke Compose as
`$CONTAINER_RUNTIME compose` for every subsequent Compose command. Do not run any Compose command
before the environment confirmation in the next section.

## 3. Scaffold and confirm the environment

Set:

```bash
ENV_EXAMPLE="$INFRA_ROOT/.env.example"
ENV_FILE="$INFRA_ROOT/.env"
```

If `ENV_EXAMPLE` is missing, halt and report its path. If `ENV_FILE` does not exist, copy the
example without overwriting any existing file:

```bash
if [ ! -f "$ENV_FILE" ]; then
  cp -- "$ENV_EXAMPLE" "$ENV_FILE"
fi
```

After copying, tell the user that the new file is at `<HARNESS6_PLUGIN_ROOT>/infrastructure/.env`
and show assignment lines from the current `.env.example` verbatim:

```bash
sed -n -E '/^[[:space:]]*#?[A-Z][A-Z0-9_]*=/p' "$ENV_EXAMPLE"
```

Ask the user to fill or review every key shown and explicitly confirm when the secrets and other
values are ready. Do not run Compose until the user confirms. If the user does not confirm, stop
with `init was not started`. Never overwrite an existing `ENV_FILE`.

Do not run any Compose command before the environment confirmation in the next section.

## 3b. Choose the deployment target

After the environment is scaffolded and confirmed (section 3), ask the user once:

> **Docker Compose or Kubernetes?**

- Default is **Docker Compose** — when the user does not answer or does not need a choice made
  for them, proceed with Compose.
- If the user chooses **Kubernetes**, skip sections 4–5 (Compose) and run the Kubernetes path
  in section 3c, then continue at section 6 (`.mcp.json` registration) and section 7 (memsearch)
  — those are shared by both paths.
- The Compose path (sections 4–5) is unchanged by the Kubernetes path existing; do not alter
  its behavior for Compose users.

## 3c. Kubernetes deployment path

All commands in this section run from `"$INFRA_ROOT/kubernetes"`. The deploy scripts are
idempotent (`helm upgrade --install`, `kubectl apply`), so a re-run resumes safely.

### Verify the toolchain first (halt early)

Before anything else, verify `kubectl`, `helm`, and cluster reachability, halting with a clear
error when missing:

```bash
command -v kubectl >/dev/null 2>&1 || { echo 'init: kubectl not found on PATH. Install kubectl and retry.' >&2; exit 1; }
command -v helm   >/dev/null 2>&1 || { echo 'init: helm not found on PATH. Install helm and retry.' >&2; exit 1; }
kubectl cluster-info >/dev/null 2>&1 || { echo 'init: no reachable Kubernetes cluster (kubectl cluster-info failed). Check kubeconfig and retry.' >&2; exit 1; }
```

### 1. Namespace, Secrets, values-user.yaml (bootstrap)

```bash
cd "$INFRA_ROOT/kubernetes"
bash bootstrap.sh
```

bootstrap.sh creates the `harness6-system` namespace (override with `HARNESS6_NAMESPACE`),
creates the `harness6-secrets` Secret via `kubectl create secret generic` from `.env` keys
at deploy time, derives the non-secret `values-user.yaml` (flat camelCase keys), and warns
(not fails) when `OPENAI_API_URL` or `EMBEDDER_API_URL` contains `host.docker.internal` or
`localhost` — surface that warning to the user, since Compose-only URLs will not resolve from
inside the cluster. Halt on its errors (missing/empty required keys).

### 2. Helm installs in dependency order (SigNoz → Milvus → Neo4j/graphiti)

Run each script and confirm its rollout completes before starting the next; later components
never start against uninitialized dependencies:

```bash
bash deploy-signoz.sh   # SigNoz/charts 0.129.0; waits for rollouts, health-gates the UI
bash deploy-milvus.sh   # upstream Milvus chart; waits, prints the 19530 NodePort
bash deploy.sh          # Neo4j community chart 5.26.30 + graphiti-mcp manifests; waits
```

If a script fails, report its output, gather diagnostics (`kubectl get pods -n harness6-system`,
`kubectl describe`/`logs` on the failing resource), and stop — do not patch manifests by hand.

### 3. Report endpoints

deploy-signoz.sh and deploy-milvus.sh print the auto-assigned NodePorts. Verify and report:

```bash
kubectl get svc -n harness6-system \
  -o 'jsonpath={range .items[*].metadata.name}{"\t"}{range .spec.ports[*]}{.port}={.nodePort}{" "}{end}{"\n"}{end}'
```

Report to the user (replace `<node>` with any reachable node IP):

- SigNoz UI: `http://<node>:<nodePort-of-8080>`
- OTLP endpoints: `<node>:<nodePort-of-4317>` (gRPC) and `<node>:<nodePort-of-4318>` (HTTP)
- graphiti-mcp: `http://<node>:30800/mcp/` (health: `/health`). `deploy.sh` still deploys
  Graphiti here, but the `agentic-memory-*` skills no longer point at it (ADR 0009). Mem0 is
  Compose-only — it has no Kubernetes manifests — so section 5b below applies on this path too,
  if the user has a local container runtime and wants agentic memory.
- Milvus (memsearch URI): `<node>:<nodePort-of-19530>`

Then continue with `.mcp.json` registration and memsearch setup (sections 6–7), using the
reported Milvus NodePort URI for memsearch.

## 4. Discover and start Compose

There must be exactly one top-level Compose file matching `*compose*.yml` or `*compose*.yaml`:

```bash
mapfile -t COMPOSE_FILES < <(
  find "$INFRA_ROOT" -maxdepth 1 -type f \
    \( -name '*compose*.yml' -o -name '*compose*.yaml' \) -print | sort
)
if [ "${#COMPOSE_FILES[@]}" -ne 1 ]; then
  printf '%s\n' "init: expected exactly one Compose file in $INFRA_ROOT; found:" >&2
  printf '  %s\n' "${COMPOSE_FILES[@]}" >&2
  exit 1
fi
COMPOSE_FILE="${COMPOSE_FILES[0]}"
```

Validate and start from the plugin's infrastructure directory. Both the env file and Compose file
are explicit arguments on every command; this avoids accidentally loading a different project or
environment from the caller's working directory:

```bash
cd "$INFRA_ROOT"
$CONTAINER_RUNTIME compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config >/dev/null
$CONTAINER_RUNTIME compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d
```

If either command fails, report its error and stop.

## 5. Wait for health and report URLs

Use the discovered Compose file and the selected runtime to identify the `signoz` container, then
poll its health status until it is `healthy`. Do not treat `starting` as success:

```bash
SIGNOZ_CONTAINER_ID="$($CONTAINER_RUNTIME compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q signoz)"
if [ -z "$SIGNOZ_CONTAINER_ID" ]; then
  printf '%s\n' 'init: signoz container was not created. Aborting.' >&2
  exit 1
fi
for attempt in $(seq 1 60); do
  HEALTH_STATUS="$( $CONTAINER_RUNTIME inspect --format '{{.State.Health.Status}}' "$SIGNOZ_CONTAINER_ID" 2>/dev/null || true )"
  case "$HEALTH_STATUS" in
    healthy) break ;;
    unhealthy)
      $CONTAINER_RUNTIME logs --tail 50 "$SIGNOZ_CONTAINER_ID" >&2 || true
      printf '%s\n' 'init: signoz healthcheck is unhealthy. Aborting.' >&2
      exit 1 ;;
    *)
      if [ "$attempt" -eq 60 ]; then
        $CONTAINER_RUNTIME logs --tail 50 "$SIGNOZ_CONTAINER_ID" >&2 || true
        printf '%s\n' "init: timed out waiting for signoz healthcheck (status: ${HEALTH_STATUS:-unknown}). Aborting." >&2
        exit 1
      fi
      sleep 5 ;;
  esac
done
```

Only after `healthy`, report the SigNoz UI as `http://localhost:${SIGNOZ_UI_PORT:-8080}` (or the
Compose-declared host port; if none is declared, report `http://localhost:3301` with a note that
3301 is the default).

## 5b. Start the Mem0 agentic-memory stack (both paths)

The `agentic-memory-read` / `agentic-memory-write` skills use a self-hosted Mem0 stack
(OpenMemory MCP server + Qdrant, plus Mem0's REST API with Postgres/pgvector and Neo4j). It is its
own Compose project (`harness6-mem0`) in `<HARNESS6_PLUGIN_ROOT>/infrastructure/mem0/`, with its
own `.env`, container names (`mem0-*`) and loopback host ports (`8765`, `8888`, `6333`, `8432`,
`8474`, `8687`; all overridable). It coexists with the Graphiti services of the main Compose file
(`mem-graphiti-mcp`, `mem-neo4j`) and does not modify them, so section 4 is unaffected: its
single-Compose-file check only looks at the top level of `$INFRA_ROOT`.

Ask the user whether to start it; skip with a one-line note if they decline. Then, with
`CONTAINER_RUNTIME` from section 2:

```bash
MEM0_ROOT="$INFRA_ROOT/mem0"
MEM0_ENV="$MEM0_ROOT/.env"
[ -f "$MEM0_ROOT/.env.example" ] || { echo "init: $MEM0_ROOT/.env.example not found. Aborting." >&2; exit 1; }
if [ ! -f "$MEM0_ENV" ]; then
  cp -- "$MEM0_ROOT/.env.example" "$MEM0_ENV"
fi
```

Show the assignment lines of `.env.example` (same `sed` as section 3) and ask the user to fill
`OPENAI_API_KEY`, `OPENAI_API_URL`, the model/embedder values, and the two passwords. The variable
names match the main `.env`, so values can be copied across. Never overwrite an existing `.env`;
do not start anything until the user confirms. Then validate and start:

```bash
cd "$MEM0_ROOT"
$CONTAINER_RUNTIME compose --env-file "$MEM0_ENV" -f "$MEM0_ROOT/docker-compose.yml" config >/dev/null
$CONTAINER_RUNTIME compose --env-file "$MEM0_ENV" -f "$MEM0_ROOT/docker-compose.yml" up -d --build
```

The first start builds two small patched images on top of the upstream Mem0 images and pulls
several more, so it takes a few minutes. If a command fails, report the error and stop. To run
only the MCP surface the skills need, append `openmemory-mcp` to the `up` command.

Verify with the real signals, not HTTP status alone (the failure mode of this stack is HTTP 200
with `{"error":"Memory client is not available"}`):

```bash
MEM0_MCP_PORT="${MEM0_MCP_PORT:-8765}"
curl -fsS -o /dev/null -w 'docs: %{http_code}\n' "http://localhost:$MEM0_MCP_PORT/docs"
curl -sS -m 3 -o /dev/null -D - "http://localhost:$MEM0_MCP_PORT/mcp/claude-code/sse/<user>" | grep -i '^content-type'   # expect text/event-stream
```

`Memory client initialized successfully` appears in `docker logs mem0-openmemory-mcp` only after
the first memory call, so it is checked after section 6c registers the server and a first
`add_memories`/`search_memory` call has been made. A log line `Failed to initialize memory client`
means the Qdrant sidecar (which must stay named `mem0_store`) is unreachable. A live memory write
also needs a working `OPENAI_API_KEY`/`OPENAI_API_URL`; report it plainly if that has not been
exercised.

## 6. Register the repository MCP servers (both paths)

The repository `.mcp.json` is the source configuration. Ask the user which Claude Code scope to
install it at: **user** or **project**. Explain the targets before proceeding:

- User scope: `~/.claude.json` (shared across projects).
- Project scope: `<repo>/.mcp.json` (the current repository; this is the portable, project-local
  configuration).

Do not silently overwrite an existing target. Read the source and target first, show any conflicting
server names, and ask for confirmation before writing. Preserve unrelated existing JSON keys and
servers by merging rather than replacing the target. For a project target that is the same file as
the source, report that it is already installed and do not copy it. If the source `.mcp.json` cannot
be found at the repository root, report the path and skip registration rather than inventing config.
The copied entries must retain their HTTP URLs. The `memory` MCP server is not part of this
copy — it is registered separately in section 6c.

## 6b. Register the aurora MCP server at user scope (both paths)

Aurora is the artifact-review web server (see `skills/report/SKILL.md`). Unlike the repository
servers above, it is deliberately registered at **user scope, globally** — artifact review is not
repo-specific, and every session that produces a report or diagram should be able to hand the user
a review deep link. This registration is separate from, and additional to, the `.mcp.json` copy in
section 6, and happens even when the user picked **project** scope there.

Before registering, verify the service is reachable (on the Compose path it is published at
`http://localhost:${AURORA_HTTP_PORT:-7634}/mcp` by docker-compose.yml): probe
`${AURORA_MCP_URL:-http://localhost:7634/mcp}` and expect HTTP 405 on a bare GET or a valid MCP
`initialize` response on POST. If it is unreachable, report the URL and stop before registering —
never register an MCP server that is not responding.

Then check for an existing registration first and do not silently overwrite one:

```bash
current=$(claude mcp get aurora 2>/dev/null || true)
```

If `current` already names the aurora server, show its existing URL and ask whether to update it
(`claude mcp remove aurora --scope user` then re-add) or leave it. If absent, register it:

```bash
claude mcp add --scope user --transport http aurora "${AURORA_MCP_URL:-http://localhost:7634/mcp}"
```

Note for the Kubernetes path (section 3c): the Kubernetes manifests do not currently deploy aurora —
it exists only in the Compose stack. If the user chose Kubernetes and has no locally-running aurora,
skip this registration with a one-line explanation rather than registering a dead URL.

## 6c. Register the `memory` MCP server (both paths)

Registers the OpenMemory MCP endpoint from section 5b as the `memory` MCP server. Ask the user for
the memory user id (any stable per-person string; default `MEM_USER_ID` from `mem0/.env`) and the
scope (`user` or `project`; user scope is typical since the server is not repo-specific). Before
registering, probe the SSE URL (expect `200` and `text/event-stream`); if it is unreachable, report
the URL and stop — never register an MCP server that is not responding. Check for an existing
registration and do not silently overwrite one:

```bash
claude mcp get memory 2>/dev/null || true
```

If `memory` already exists and points at a different URL (for example the old Graphiti endpoint
`http://localhost:8121/mcp/`), show it and ask whether to replace it
(`claude mcp remove memory --scope <scope>` then re-add). Otherwise register:

```bash
claude mcp add --scope user --transport sse memory "http://localhost:${MEM0_MCP_PORT:-8765}/mcp/claude-code/sse/<user>"
```

Keep the user id identical across machines and sessions that should share memory: the user
segment of the URL is the only partition the server enforces.

## 7. Set up memsearch (both paths)

Offer to run the `memsearch-init` skill from the repository root. Follow that skill's confirmation
and indexing steps; do not invent a collection or paths without presenting them to the user. Before
indexing, ensure memsearch has an explicit Milvus store and embedding provider configured. Ask the
user to confirm or provide these values:

- Milvus URI — on the Compose path use the reachable Milvus URI appropriate to the user's
  installation, such as `http://localhost:19530`; on the Kubernetes path use the NodePort URI
  reported by section 3c (`<node-host>:<milvus-nodePort>`). Do not assume a local Lite database
  when a deployed Milvus service is intended.
- Embedding provider (for example `openai`), model, and its OpenAI-compatible base URL.
- API key via an environment reference (for example `env:OPENAI_API_KEY`), never by placing a
  secret in a committed file.

If values are missing, use `memsearch config set` to configure the global memsearch settings, for
example (after the user confirms the values):

```bash
memsearch config set milvus.uri "$MILVUS_URI"
memsearch config set embedding.provider "$EMBEDDING_PROVIDER"
memsearch config set embedding.model "$EMBEDDING_MODEL"
memsearch config set embedding.base_url "$EMBEDDING_BASE_URL"
memsearch config set embedding.api_key "env:$EMBEDDING_API_KEY_ENV"
```

Verify `memsearch config get milvus.uri`, `embedding.provider`, and `embedding.model` return
non-empty values, then invoke `memsearch-init`. If the user declines or indexing fails, report the
raw error and leave the infrastructure setup result separate from the memsearch result.
