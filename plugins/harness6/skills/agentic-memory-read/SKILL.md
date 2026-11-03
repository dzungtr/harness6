---
name: agentic-memory-read
description: >
  Use at the START of any task-execution session, or whenever picking up interrupted work,
  opening an epic to check on its children, or descending into a child ticket mid-session, to
  load ambient progress-state (blockers, drift, gotchas, where the last session left off)
  before touching code. Backed by the hosted Mem0 platform via the `mem0-mcp` MCP server.
---

# agentic-memory-read (Mem0 platform)

Loads **ambient progress-state** so a cold-started session knows where the last one left off:
blockers, drift, gotchas, where to pick up. Not a decision log. Server: `mem0-mcp`
(`https://mcp.mem0.ai/mcp`). Decision record: `docs/adr/0009-mem0-agentic-memory-substrate.md`.
Write counterpart: `agentic-memory-write`.

## How the store behaves

- **Scope is a filter.** Every memory is written with `run_id` = scope key. Filter on it; no
  text matching.
- **Omit `user_id`.** The server defaults to the authenticated account.
- **Search returns superseded memories.** When a newer memory contradicts an older one, Mem0
  marks the old one `lifecycle_state: "superseded"`, but search and `get_memories` still return
  it, and `lifecycle_state` is not a filter key. Only `get_memory(id)` shows it. The flip is
  asynchronous and can lag seconds to minutes.
- **Ranking is semantic, not recency.**

## Scope key

- **Project:** `owner_repo`, from `gh repo view --json nameWithOwner -q .nameWithOwner` (or
  `git remote get-url origin`).
- **Epic / ticket:** `owner_repo_<issue>`, issue taken from the branch name, then the open PR,
  then the task brief.
- **ADR:** `owner_repo_adr_<NNNN>` from the filename `docs/adr/NNNN-slug.md`.
- **Normalize** each of owner and repo: replace `-`, `.`, `#`, whitespace with `_`, lowercase.
  `acme-org/payments-service` -> `acme_org_payments_service`. The key contains only `[a-z0-9_]`.
  Must match `agentic-memory-write`.

## What to read (wide downward, never upward)

1. **Ticket cold start:** that ticket's scope only. The common case.
2. **Epic cold start:** list child sub-issues with `gh`, then read the epic and each child in one
   `OR` filter. Keep a bounded per-child summary (newest status, open blockers, open drift).
3. **Project cold start:** `owner_repo` plus a bounded index of active epics. Never dump every
   child of every epic.
4. **ADR with an `## Amendments` section:** read `owner_repo_adr_<NNNN>` before acting on or
   re-amending it, and before reviving an option its `## Considered Options` rejects.

## How to read

1. Search inside the scope:

   ```
   search_memories(query="blocked, drift, where to pick up",
                   filters={"AND": [{"run_id": "<scope key>"}]}, top_k=10)
   ```

   Epic: `{"AND": [{"OR": [{"run_id": "<epic>"}, {"run_id": "<child>"}]}]}`. Run two or three
   queries for breadth. `get_memories` with the same filter lists a small scope without a query.
2. Sort by `created_at`, newest first; keep about the newest five per scope.
3. Call `get_memory(id)` on each kept hit and drop it unless `lifecycle_state == "active"`. The
   `replaced_by` memory is the current statement; make sure it is in your set. **Skip this for
   ADR scope:** amendment history is durable, read it whatever the state.
4. Lag fallback: a newer note that says it resolves or supersedes an older one that still reads
   `active` makes the older one historical.
5. Empty `results` means nothing stored. An `error` string is a rejected call (for example
   `Unknown filter key`); fix the filter, do not retry it unchanged. Say which one you got.

## Reconcile with GitHub

Memory is non-authoritative. Check `gh issue view <n> --json state` for each scope's issue.
Memory tied to a **closed** ticket is history; live ticket state wins. If two `active` notes in
one scope contradict, say so and prefer the newer.

## Setup

`claude mcp add --scope user --transport http mem0-mcp https://mcp.mem0.ai/mcp`, then `/mcp` to
authenticate (`init` does this). Tools missing or auth errors mean the OAuth session is not
live. Everything read here lives on Mem0's service, not this machine.

## Next

After the work, record blockers, drift, stopping points or resolutions with
`agentic-memory-write`.
