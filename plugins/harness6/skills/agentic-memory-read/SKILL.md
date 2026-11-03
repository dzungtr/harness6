---
name: agentic-memory-read
description: >
  Use at the START of any task-execution session, or whenever picking up interrupted work,
  opening an epic to check on its children, or descending into a child ticket mid-session, to
  load ambient progress-state (blockers, drift, gotchas, where the last session left off)
  before touching code. Backed by a self-hosted Mem0 store (OpenMemory MCP server) via the
  `memory` MCP server. Trigger on cold start, resuming a backlog ticket/epic, or picking up any
  work that a prior (possibly context-limited) session may have partially completed.
---

# agentic-memory-read (Mem0 / OpenMemory MCP)

Loads **ambient progress-state** — not prior "decisions" — so a cold-started session (yours or
someone else's) knows where the last session left off: blockers, drift between ticket intent
and delivered result, gotchas, and where to pick up. Backed by the self-hosted Mem0 stack in
`infrastructure/mem0/docker-compose.yml` (OpenMemory MCP server + Qdrant), exposed as the
`memory` MCP server. Decision record: `docs/adr/0009-mem0-agentic-memory-substrate.md`.

## What the tool surface can and cannot do

The OpenMemory MCP server exposes exactly four tools. Their parameters were read from a running
server (`tools/list`), not assumed:

| Tool | Parameters | Returns |
|---|---|---|
| `add_memories` | `text` | `{"results":[{"id","memory","event"}]}` (`event`: `ADD`, `UPDATE`, `DELETE` or `NONE`) |
| `search_memory` | `query` | up to 10 hits: `id`, `memory`, `hash`, `created_at`, `updated_at`, `score` |
| `list_memories` | none | the user's memories (upstream caps at 100): `id`, `memory`, `metadata`, `created_at`, `updated_at` |
| `delete_all_memories` | none | deletes **every** memory the user's app can access — never use it to retire one note |

Consequences that shape every read:

- **No metadata and no filter on the MCP tools.** `add_memories` takes only text and
  `search_memory` only a query, so a scope cannot be a metadata field here. Scope travels
  in-band as a header token in the memory text (see `agentic-memory-write`) and you filter
  client-side.
- **Search is not scoped.** `search_memory` returns the top hits across everything stored for
  the user, so notes for other tickets and repos will appear. Drop any hit that does not carry
  your scope token.
- **Ranking is semantic similarity, not recency.** A stale note can outrank the note that
  resolved it. There is no server-side recency order; sort by `updated_at`, falling back to
  `created_at` (`updated_at` is `null` until a memory is updated), newest first.
- **There is no temporal invalidation.** Unlike a bi-temporal graph, nothing marks a note as no
  longer true. Staleness is handled by resolution notes (see `agentic-memory-write`) plus the
  reconciliation step below.
- The `memory` server is partitioned by the `<user>` segment of its registration URL
  (`/mcp/<client>/sse/<user>`); a different user sees nothing of yours. It is a coarse
  partition, not a per-ticket scope.

## Scope resolution

Memory is scoped to the GitHub work hierarchy, project-namespaced (the infra is shared across
projects):

- **Project scope** — `owner_repo`. Derive from the git remote: `gh repo view --json
  nameWithOwner -q .nameWithOwner`, or parse `git remote get-url origin` if `gh` isn't
  available.
- **Normalize every component** before joining: replace any `-`, `.`, `#`, or whitespace
  inside the owner and repo names with `_`, then lowercase. E.g. `acme-org/payments-service`
  → `acme_org_payments_service`; `dzungtr/harness6` → `dzungtr_harness6`. The result must
  contain no character other than `[a-z0-9_]` and `<issue>`/`<NNNN>` digits.
- **Epic/ticket scope** — `owner_repo_<issue>`. Append the issue number resolved from (in
  order of preference) the current branch name, the open PR for the branch, or the task brief
  you were given.

These scope keys are the **scope token** in the memory header — underscore-joined, not
`owner/repo` or `owner/repo#<issue>`, and not dash-joined. The form is a single unbroken
`[a-z0-9_]` token, which is what makes it safe to match as a literal string in search results.
Both this skill and `agentic-memory-write` must stay consistent on it.

## Read model: read wide (downward only), write narrow

Reads widen *downward* into child tickets of whatever scope you're cold-starting into — never
upward into parents. An orphan ticket's memory shouldn't leak epic-level notes, and the
reverse isn't needed because writes always go to the most-specific scope (see
`agentic-memory-write`).

1. **Ticket cold-start** (you're picking up a specific issue): read only that ticket's scope
   token, `owner_repo_<issue>`. This is the common case.
2. **Epic cold-start** (you're opening a parent epic to see where its children stand):
   enumerate child sub-issues live via `gh` (e.g. `gh issue view <epic> --json ...` / the
   sub-issue listing for that issue), then read the epic token and each child's token. Keep
   only a **bounded per-child summary** — newest status, open blockers, open drift — not every
   hit for every child. Fetch a specific child's full detail on demand only when you actually
   descend into working that child ticket.
3. **Project cold-start** (no specific issue — ad-hoc/orphan work, or scanning what's active):
   read your own project-scope notes (`owner_repo`) plus a bounded index of active epics.
   Never recursively dump every epic's every child — that defeats "bounded."
4. **ADR read** (you're reading an ADR that has an `## Amendments` section): derive the ADR
   scope token — `owner_repo_adr_<NNNN>`, per `agentic-memory-write`'s "Write scope" — and
   read it before acting on, or re-amending, that ADR. The Amendments table's presence is the
   signal that expandable history exists in memory; an ADR with no such section has none to
   fetch.
5. **Rejected-option check** (you're about to propose something an ADR's
   `## Considered Options` already marks rejected): read that ADR's scope for the full
   reasoning before reviving it — the ADR body only carries the terse standing prohibition and
   its evidence, not the whole story.

## How to read

1. `search_memory(query="<scope token> <topic>")` — put the literal scope token first, then the
   topic. Run a few queries instead of one when you need breadth (e.g. `"<token> blocked"`,
   `"<token> drift descope"`, `"<token> where to pick up"`); each returns at most 10 hits.
2. Keep only hits whose `memory` text carries the scope token you are reading, matched as a
   **whole token** — the `[scope: <token>]` header, or the token bounded by characters outside
   `[a-z0-9_]` if the extractor reformatted the header. A plain substring match is wrong:
   `owner_repo_7` is a prefix of `owner_repo_78`, and `owner_repo` is a prefix of every ticket
   scope. Discard the rest.
3. Sort what is left by `updated_at` (else `created_at`), newest first.
4. Apply the supersession rule: if a newer note says it **resolves** or **supersedes** an older
   one (see `agentic-memory-write`), treat the older note as historical and do not report it as
   current.
5. `list_memories()` is a fallback for a small store only — it is capped at 100 entries,
   unordered, and returns the user's whole memory, so on a busy store it silently truncates.
6. If `search_memory` returns `[]` or an error string, say so rather than assuming there is
   nothing to load — an `Error: Memory system is currently unavailable` string means the stack
   is down (see "Health").

## Read-time reconciliation

Memory is not authoritative — cross-check against live GitHub state before trusting a note:

- Check the open/closed status of the scope's issue(s) (e.g. `gh issue view <n> --json
  state`).
- Treat memory tied to a **CLOSED** ticket as historical context, not current state — the work
  may have shipped, or the note may predate a resolution that never made it back into memory.
  Live ticket status is the tiebreaker, not the memory note.
- When two non-superseded notes in the same scope contradict each other, say so and prefer the
  newer one; do not silently pick.

## Health

The failure mode to know: with the Qdrant sidecar unreachable, the OpenMemory REST endpoints
return **HTTP 200** with `{"error":"Memory client is not available"}`, and the MCP tools return
an `Error: Memory system is currently unavailable` string. HTTP status alone proves nothing —
check `docker logs mem0-openmemory-mcp` for `Memory client initialized successfully` (logged
on first use, not at boot).

## MCP client registration

This repo doesn't track a committed MCP client-config file, so registration happens in your
own Claude Code MCP settings (the `init` skill walks through it). The compose stack publishes
the endpoint on loopback port `8765` by default (`MEM0_MCP_PORT`), SSE transport; the final
path segment is the memory user:

```bash
claude mcp add --transport sse memory http://localhost:8765/mcp/claude-code/sse/<user>
```

`<user>` is any stable per-person string (the stack's `MEM_USER_ID` is just the default user
created at boot). Keep it the same across sessions and machines you want to share memory
between, because the user segment is the only partition the server enforces.

## Next step

Once you've loaded progress-state and done the work, use the `agentic-memory-write` skill to
record a blocker, drift, stopping point, silent descope, or resolution before ending the
session.
