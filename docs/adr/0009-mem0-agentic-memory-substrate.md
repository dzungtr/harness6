# 9. Mem0 (OpenMemory MCP) is the agentic-memory substrate

Date: 2026-11-03

## Status

Accepted. Supersedes the substrate decision in ADR 0003 ("Substrate: keep Graphiti"); the rest of
ADR 0003 (ambient progress-state, scope keys, write narrow / read wide, event-driven writes) stands.

## Context

ADR 0003 reframed the `memory` MCP server as ambient progress-state memory and kept Graphiti as
the substrate. A Mem0-backed implementation was built and compared against the Graphiti one
("Approach B" in `tillpos-tony/my-claude` PR 82) and is adopted here as the backend the
`agentic-memory-read` and `agentic-memory-write` skills use.

The Graphiti services in `infrastructure/docker-compose.yml` (`graphiti-mcp`, `neo4j`), their
`config.yaml`, and the Kubernetes manifests are existing deployed infrastructure. Removing them
is a separate, riskier change than repointing the skills.

## Decision

**The skills use a self-hosted Mem0 stack through the OpenMemory MCP server, registered as the
`memory` MCP server over SSE.** Concretely:

1. **Separate Compose project.** `infrastructure/mem0/` holds its own `docker-compose.yml`
   (project `harness6-mem0`), `.env.example` and build files: OpenMemory MCP + Qdrant (`mem0_store`)
   for the MCP surface, and Mem0's REST API + Postgres/pgvector + Neo4j for programmatic access.
   Container names, volumes and host ports (`8765`, `8888`, `6333`, `8432`, `8474`, `8687`,
   loopback, overridable) do not overlap the existing stack. It coexists with the Graphiti
   services and does not modify them.
2. **Direct OpenAI-compatible endpoints**, reusing the variable names of `infrastructure/.env.example`
   (`OPENAI_API_KEY`, `OPENAI_API_URL`, `MEM_EXTRACTOR_MODEL`, `MEM_EMBED_MODEL`,
   `EMBEDDER_API_URL`, `EMBEDDER_DIMENSIONS`). The upstream images hardcode their models and read
   only the key and base URL, so two small build-time patches map the rest and fail the build if
   upstream changes shape.
3. **Scope keys are unchanged** (`owner_repo`, `owner_repo_<issue>`, `owner_repo_adr_<NNNN>`), but
   they are a header token in the memory text, not a Graphiti `group_id`. The OpenMemory tools
   take text only (`add_memories(text)`, `search_memory(query)`), so scope, kind and status travel
   in-band and are filtered client-side.
4. **Staleness is handled by convention, not by the store.** Mem0 has no bi-temporal invalidation,
   and search ranks by semantic similarity, not recency. A resolution or reversal is written as a
   new memory that names what it `resolves:` or `supersedes:`; readers sort by
   `updated_at`/`created_at` and discard what a newer note resolves.

## Considered Options

**Keep Graphiti as the skills' backend.** Rejected by this decision (see Context). The Graphiti
services stay deployed and untouched; only the skills, docs and registration step stop pointing
at them.

**Use `mem0-api` (REST) as the agent surface.** Not chosen: it has real metadata filters, but
Claude Code registers MCP servers, and `mem0-api` and `openmemory-mcp` do not share storage.
`mem0-api` stays in the stack for scripts and SDK use.

**Route Mem0 through a model gateway.** Not applicable: this stack runs no gateway; Mem0 calls the
configured OpenAI-compatible endpoint directly.

## Consequences

- **Capability loss versus Graphiti, accepted:** no bi-temporal fact invalidation, no scope-filtered
  retrieval on the MCP tools, no per-memory delete or edit through MCP (only `delete_all_memories`,
  which is unscoped and destructive), `list_memories` capped at 100 and `search_memory` at 10 hits.
- **Not verified end to end with a real LLM:** whether Mem0's default fact extractor keeps header
  tokens or stores engineering notes at all (it is tuned for personal facts; `{"results": []}`
  means nothing was stored). The skills tell agents to check each response.
- The published `mem0/mem0-api-server` and `mem0/openmemory-mcp` images are old and tagged
  `:latest`; the stack should pin digests before use beyond local development.
- Existing Graphiti data is not migrated. `GRAPHITI_*` and `SEMAPHORE_LIMIT` have no Mem0
  equivalent.
- `init` gains a Mem0 bring-up and `memory` MCP registration step. Mem0 is Compose-only; the
  Kubernetes path (ADR 0008) still deploys Graphiti.
- The three `signoz-*` skills that cached schema facts through Graphiti tool names now use the
  Mem0 tools with a `global` scope token.
- Removing the Graphiti services, `config.yaml` and the Kubernetes Graphiti manifests is a
  deliberate follow-up, not part of this decision.
