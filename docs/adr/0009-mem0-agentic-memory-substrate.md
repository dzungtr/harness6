# 9. The hosted Mem0 platform is the agentic-memory substrate

Date: 2026-11-03

## Status

Accepted. Supersedes the substrate decision in ADR 0003 ("Substrate: keep Graphiti"); the rest of
ADR 0003 (ambient progress-state, scope keys, write narrow / read wide, event-driven writes) stands.

## Context

ADR 0003 reframed the `memory` MCP server as ambient progress-state memory and kept Graphiti as
the substrate, mainly for its bi-temporal invalidation: a resolved blocker should stop reading as
current. A Mem0-backed implementation was built and compared against the Graphiti one
("Approach B" in `tillpos-tony/my-claude` PR 82).

This PR first adopted a **self-hosted** Mem0 (OpenMemory MCP + Qdrant). That stack's MCP tools take
text only, with no metadata, no filters, no per-memory edit or delete, and no temporal
invalidation, so scope, kind and staleness had to be encoded as conventions in the text. The Mem0
**platform** (hosted, `https://mcp.mem0.ai/mcp`) exposes a richer surface, and on 2026-11-03 it was
exercised live (throwaway memories under `user_id=tony-mock-temporal-test`):

| Probe | Result |
|---|---|
| Add memory A, then memory B that contradicts A (same user, no `run_id`) | Both `ADD` events. A later read via `get_memory` showed A as `lifecycle_state: "superseded"`, `replaced_by` = B. List/search payloads still showed `replaced_by: null` for A. The flip was not visible after about a minute. |
| Add a blocker, then a resolution, both with `run_id=<scope>` | Blocker `superseded` by the resolution within seconds. |
| `search_memories` after supersession | Returns **both** the active and the superseded memory. |
| Filter by `run_id`, by `metadata`, by `OR` of two `run_id`s | All accepted and exact. |
| Filter by `lifecycle_state` | Rejected: `Unknown filter key`. The allowed list names `run_id`, `metadata`, `created_at`, `OR`/`AND`/`NOT` and others. |
| Add is asynchronous | Returns `event_id` / `PENDING`; `get_event_status` reaches `SUCCEEDED` in a few seconds and carries the stored memory. |
| Per-memory tools | `update_memory`, `delete_memory`, and `delete_all_memories` scoped by `run_id`. |

The Graphiti services in `infrastructure/docker-compose.yml` (`graphiti-mcp`, `neo4j`), their
`config.yaml`, and the Kubernetes manifests are existing deployed infrastructure. Removing them
is a separate, riskier change than repointing the skills.

## Decision

**The skills use the hosted Mem0 platform through its MCP server, registered as `mem0-mcp` (HTTP,
OAuth) at `https://mcp.mem0.ai/mcp`.** Concretely:

1. **Temporal memory comes from the platform.** Mem0 compares each new memory with existing ones
   and marks the contradicted one `superseded` (`replaced_by` -> the new memory). This replaces
   the Graphiti bi-temporal mechanism ADR 0003 relied on, for the same job: aging out resolved
   blockers and drift. Resolution notes still name what they resolve, so the platform has
   something to match and readers have a fallback.
2. **Scope keys are unchanged** (`owner_repo`, `owner_repo_<issue>`, `owner_repo_adr_<NNNN>`), but
   they are now the memory's `run_id` plus `metadata.scope`, filtered server-side. Header tokens and
   client-side substring matching are gone, and so is the prefix-collision risk
   (`owner_repo_7` vs `owner_repo_78`). `metadata` also carries `kind` and `status`.
3. **User identity is implicit.** Calls omit `user_id`, so the server uses the authenticated
   account; a team that wants shared memory agrees on an explicit id.
4. **Readers verify liveness with `get_memory`.** Search does not hide superseded memories and
   `lifecycle_state` is not a filter key, so the read skill fetches each kept hit and keeps only
   `lifecycle_state == "active"`. ADR-scope notes are exempt: they are durable history, written
   with `infer=false` and read regardless of state.
5. **Writes are asynchronous.** The write skill polls `get_event_status` and treats empty
   `results` as "nothing stored".
6. **No self-hosted Mem0 stack in this repo.** `infrastructure/mem0/` (OpenMemory MCP, Qdrant,
   `mem0-api`, Postgres, Neo4j, the two build-time patches) is removed. `init` registers the
   platform server instead of bringing up containers, so Mem0 now works on the Kubernetes path
   too.

## Considered Options

**Keep Graphiti as the skills' backend.** Rejected (see Context). The Graphiti services stay
deployed and untouched; only the skills, docs and registration step stop pointing at them.

**Self-hosted OpenMemory MCP** (this PR's first iteration). Rejected: text-only tools, no
metadata, filters or per-memory edit, no temporal invalidation, hardcoded upstream models patched
at build time, `:latest` images that are months old, and a five-container stack to run. Everything
it lacked is a first-class feature of the platform.

**Self-hosted Mem0 REST API (`mem0-api`) as the agent surface.** Not chosen: Claude Code registers
MCP servers, and `mem0-api` and `openmemory-mcp` do not share storage.

**Route Mem0 through a model gateway.** Not applicable: the platform runs its own extraction and
embedding.

## Consequences

- **Data leaves the machine.** Every memory is stored on Mem0's hosted service. The write skill and
  `init` say so and forbid secrets, credentials, customer data and private incident details. If
  that is unacceptable for a repo, the answer is not to register `mem0-mcp` there.
- **Supersession is a model judgement, asynchronous, and not guaranteed.** It lagged by over a
  minute in one probe and by seconds in another. A read just after a write can still see the old
  note as `active`; the `resolves:`-style wording in the text and the reader's fallback rule cover
  that window. It also means a loosely worded note can supersede something it should not, which is
  why `update_memory` and `delete_memory` exist and why ADR scope opts out.
- **Reads cost extra calls.** Checking `lifecycle_state` needs one `get_memory` per kept hit, so
  the read skill bounds the set (about five newest per scope). If the platform later exposes
  `lifecycle_state` in search results or as a filter, drop the extra call.
- **Availability and cost now depend on a third party**: OAuth session, quota and pricing are
  Mem0's, not ours. Not measured here.
- **Not verified:** behaviour at scale, extractor quality on long engineering notes, whether
  `infer=false` memories are exempt from supersession, and `user_id` defaulting across multiple
  accounts (taken from the tool schemas, not exercised).
- Existing Graphiti data is not migrated. `GRAPHITI_*` and `SEMAPHORE_LIMIT` have no Mem0
  equivalent.
- `init` registers `mem0-mcp` and asks the user to authenticate via `/mcp`. The server is named
  `mem0-mcp`, not `memory`, so a legacy Graphiti registration is untouched.
- The three `signoz-*` skills that cached schema facts through Graphiti tool names now use the
  Mem0 tools with `run_id="global"`.
- Removing the Graphiti services, `config.yaml` and the Kubernetes Graphiti manifests is a
  deliberate follow-up, not part of this decision.
