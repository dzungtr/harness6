---
name: harness6-init
description: >
  Initialize the shared harness6 infrastructure stack after installing the plugin. Resolve the
  plugin cache root from the active harness, choose a container runtime, scaffold infrastructure/.env
  without overwriting it, start Compose, register the bundled MCP servers, and set up memsearch.
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
  printf '%s\n' 'harness6-init: no plugin root found. Run this skill from an installed harness6 plugin (PLUGIN_ROOT or CLAUDE_PLUGIN_ROOT must be set).' >&2
  exit 1
fi
```

Set `INFRA_ROOT` to `<HARNESS6_PLUGIN_ROOT>/infrastructure`. Halt with a clear error if that
directory does not exist:

> **harness6-init: infrastructure directory not found at `<HARNESS6_PLUGIN_ROOT>/infrastructure`.** Run this skill from an installed harness6 plugin. Aborting.

## 2. Choose the container runtime

Before doing any setup or attempting to start Compose, check that the runtime executables exist:

```bash
DOCKER_AVAILABLE=false
PODMAN_AVAILABLE=false
command -v docker >/dev/null 2>&1 && DOCKER_AVAILABLE=true
command -v podman >/dev/null 2>&1 && PODMAN_AVAILABLE=true
```

- If neither is available, stop: `harness6-init: neither docker nor podman was found on PATH. Install one and retry.`
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
with `harness6-init was not started`. Never overwrite an existing `ENV_FILE`.

## 4. Discover and start Compose

There must be exactly one top-level Compose file matching `*compose*.yml` or `*compose*.yaml`:

```bash
mapfile -t COMPOSE_FILES < <(
  find "$INFRA_ROOT" -maxdepth 1 -type f \
    \( -name '*compose*.yml' -o -name '*compose*.yaml' \) -print | sort
)
if [ "${#COMPOSE_FILES[@]}" -ne 1 ]; then
  printf '%s\n' "harness6-init: expected exactly one Compose file in $INFRA_ROOT; found:" >&2
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
  printf '%s\n' 'harness6-init: signoz container was not created. Aborting.' >&2
  exit 1
fi
for attempt in $(seq 1 60); do
  HEALTH_STATUS="$( $CONTAINER_RUNTIME inspect --format '{{.State.Health.Status}}' "$SIGNOZ_CONTAINER_ID" 2>/dev/null || true )"
  case "$HEALTH_STATUS" in
    healthy) break ;;
    unhealthy)
      $CONTAINER_RUNTIME logs --tail 50 "$SIGNOZ_CONTAINER_ID" >&2 || true
      printf '%s\n' 'harness6-init: signoz healthcheck is unhealthy. Aborting.' >&2
      exit 1 ;;
    *)
      if [ "$attempt" -eq 60 ]; then
        $CONTAINER_RUNTIME logs --tail 50 "$SIGNOZ_CONTAINER_ID" >&2 || true
        printf '%s\n' "harness6-init: timed out waiting for signoz healthcheck (status: ${HEALTH_STATUS:-unknown}). Aborting." >&2
        exit 1
      fi
      sleep 5 ;;
  esac
done
```

Only after `healthy`, report the SigNoz UI as `http://localhost:${SIGNOZ_UI_PORT:-8080}` (or the
Compose-declared host port; if none is declared, report `http://localhost:3301` with a note that
3301 is the default).

## 6. Register the repository MCP servers

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
The copied entries must retain the HTTP URLs (including `/mcp/` for agentic-memory).

## 7. Set up memsearch

Offer to run the `memsearch-init` skill from the repository root. Follow that skill's confirmation
and indexing steps; do not invent a collection or paths without presenting them to the user. Before
indexing, ensure memsearch has an explicit Milvus store and embedding provider configured. Ask the
user to confirm or provide these values:

- Milvus URI (for this stack, use the reachable Milvus URI appropriate to the user's installation,
  such as `http://localhost:19530`; do not assume a local Lite database when the Compose Milvus
  service is intended).
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
