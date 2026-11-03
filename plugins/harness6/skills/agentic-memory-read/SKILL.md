---
name: agentic-memory-read
description: >
  Use at the START of any task-execution session, or whenever picking up interrupted work,
  opening an epic to check on its children, or descending into a child ticket mid-session, to
  load ambient progress-state (blockers, drift, gotchas, where the last session left off)
  before touching code. Backed by the hosted Mem0 platform via the `mem0-mcp` MCP server, which
  supplies temporal memory (stale facts are superseded automatically). Trigger on cold start,
  resuming a backlog ticket/epic, or picking up any work that a prior (possibly context-limited)
  session may have partially completed.
---

# agentic-memory-read (Mem0 platform)

Loads **ambient progress-state** — not prior "decisions" — so a cold-started session (yours or
someone else's) knows where the last session left off: blockers, drift between ticket intent
and delivered result, gotchas, and where to pick up. Backed by the hosted Mem0 platform, exposed
as the `mem0-mcp` MCP server (`https://mcp.mem0.ai/mcp`). Decision record:
`docs/adr/0009-mem0-agentic-memory-substrate.md`.

## What the platform gives you

Tool names below are the server's own; Claude Code shows them as `mcp__mem0-mcp__<tool>`.

| Tool | Use |
|---|---|
| `search_memories(query, filters, top_k, rerank)` | semantic search; `filters` take `user_id`, `run_id`, `metadata`, `created_at`, `OR`/`AND`/`NOT` |
| `get_memories(filters, page, page_size)` | page through memories by filter, no query |
| `get_memory(memory_id)` | one memory, **including `lifecycle_state`** (`active` / `superseded`) and `replaced_by` |
| `add_memory`, `update_memory`, `delete_memory`, `get_event_status` | writes — see `agentic-memory-write` |

What that means for every read:

- **Scope is a real filter.** Each memory is written with `run_id` = the scope token and
  `metadata.scope` = the same token (see `agentic-memory-write`). Filter by `run_id`; no
  client-side substring matching is needed, so `owner_repo_7` can never match `owner_repo_78`.
- **User is implicit.** Omit `user_id`: the server adds the authenticated account's default
  (per the tool schemas). Pass it explicitly only when a team agreed on a shared memory id.
- **Temporal supersession is automatic but invisible in search.** When a new memory contradicts
  an older one in the same user/scope, the platform marks the older one
  `lifecycle_state: "superseded"` with `replaced_by` pointing at the newer one. Search and
  `get_memories` **still return superseded memories**, and `lifecycle_state` is **not** a
  filterable key — only `get_memory` shows it. Verified live: a blocker note flipped to
  `superseded` within seconds of a resolution note in the same `run_id`; in an earlier test
  (two notes with no `run_id`) the flip was not visible for over a minute, and list/search
  payloads kept showing `replaced_by: null`. Treat `get_memory` as the authority and expect lag.
- **Ranking is semantic, not recency.** Sort what you keep by `created_at`, newest first.

## Scope resolution

Memory is scoped to the GitHub work hierarchy, project-namespaced (the platform account is
shared across projects):

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

These scope keys are the `run_id` of each memory — underscore-joined, not `owner/repo` or
`owner/repo#<issue>`, and not dash-joined. Both this skill and `agentic-memory-write` must stay
consistent on it.

## Read model: read wide (downward only), write narrow

Reads widen *downward* into child tickets of whatever scope you're cold-starting into — never
upward into parents. An orphan ticket's memory shouldn't leak epic-level notes, and the
reverse isn't needed because writes always go to the most-specific scope (see
`agentic-memory-write`).

1. **Ticket cold-start** (you're picking up a specific issue): read only that ticket's scope,
   `owner_repo_<issue>`. This is the common case.
2. **Epic cold-start** (you're opening a parent epic to see where its children stand):
   enumerate child sub-issues live via `gh` (e.g. `gh issue view <epic> --json ...` / the
   sub-issue listing for that issue), then read the epic scope and each child's scope in one
   `OR` filter. Keep only a **bounded per-child summary** — newest status, open blockers, open
   drift — not every hit for every child. Fetch a specific child's full detail on demand only
   when you actually descend into working that child ticket.
3. **Project cold-start** (no specific issue — ad-hoc/orphan work, or scanning what's active):
   read your own project scope (`owner_repo`) plus a bounded index of active epics. Never
   recursively dump every epic's every child — that defeats "bounded."
4. **ADR read** (you're reading an ADR that has an `## Amendments` section): read the ADR scope
   `owner_repo_adr_<NNNN>` (see `agentic-memory-write`'s "Write scope") before acting on, or
   re-amending, that ADR. The Amendments table's presence is the signal that expandable history
   exists in memory; an ADR with no such section has none to fetch. **ADR-scope notes are
   durable history: read them whatever their `lifecycle_state`.**
5. **Rejected-option check** (you're about to propose something an ADR's
   `## Considered Options` already marks rejected): read that ADR's scope for the full
   reasoning before reviving it — the ADR body only carries the terse standing prohibition and
   its evidence, not the whole story.

## How to read

1. Search inside the scope:

   ```
   search_memories(
     query="<topic or 'blocked / drift / where to pick up'>",
     filters={"AND": [{"run_id": "<scope key>"}]},
     top_k=10
   )
   ```

   Epic read: `{"AND": [{"OR": [{"run_id": "<epic>"}, {"run_id": "<child1>"}, ...]}]}`.
   Run two or three queries when you need breadth (`"blocked"`, `"drift descope"`,
   `"where to pick up"`). To list a small scope without a query, use `get_memories` with the
   same filter.
2. Sort the hits by `created_at`, newest first, and keep a bounded set (about the newest five
   per scope).
3. **Drop superseded notes.** For each kept hit call `get_memory(memory_id)` and keep it only if
   `lifecycle_state == "active"`. A `superseded` note is history: the `replaced_by` memory is
   the current statement, so make sure that one is in your set. (Skip this step for ADR scope.)
4. Safety net for lag: if a newer note in the same scope says it **resolves** or **supersedes**
   an older one that still reads `active` (the platform's pass may not have run yet), treat the
   older note as historical and do not report it as current.
5. If a search returns `{"results": []}`, say so rather than assuming there is nothing to load —
   an `error` string means the server rejected the call (see "Health").

## Read-time reconciliation

Memory is not authoritative — cross-check against live GitHub state before trusting a note:

- Check the open/closed status of the scope's issue(s) (e.g. `gh issue view <n> --json
  state`).
- Treat memory tied to a **CLOSED** ticket as historical context, not current state — the work
  may have shipped, or the note may predate a resolution that never made it back into memory.
  Live ticket status is the tiebreaker, not the memory note.
- When two `active` notes in the same scope contradict each other, say so and prefer the newer
  one; do not silently pick.

## Health

- The server uses OAuth. Unauthenticated calls fail or the tools do not appear; run `/mcp`, pick
  `mem0-mcp`, and authenticate.
- A response `{"error": "..."}` carries the platform's validation message, for example
  `Unknown filter key '...'. Allowed: [...]` — fix the filter rather than retrying it unchanged.
- Everything you read here lives on Mem0's hosted service, not on this machine.

## MCP client registration

This repo doesn't track a committed MCP client-config file, so registration happens in your own
Claude Code MCP settings (the `init` skill walks through it):

```bash
claude mcp add --scope user --transport http mem0-mcp https://mcp.mem0.ai/mcp
```

Then run `/mcp` and authenticate. The server name is `mem0-mcp`, not `memory`, so it does not
collide with a legacy Graphiti registration named `memory`.

## Next step

Once you've loaded progress-state and done the work, use the `agentic-memory-write` skill to
record a blocker, drift, stopping point, silent descope, or resolution before ending the
session.
