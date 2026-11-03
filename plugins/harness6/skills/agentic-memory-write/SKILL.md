---
name: agentic-memory-write
description: >
  Use whenever you hit a blocker, discover drift between ticket intent and delivered result,
  reach a stopping point (session end, context-limit handoff, done-pending-verification),
  silently descope something, or resolve a previously-noted blocker/drift, to persist that
  ambient progress-state for the next cold start. Backed by the hosted Mem0 platform via the
  `mem0-mcp` MCP server. Event-driven, not per-step logging and not session-end-only.
---

# agentic-memory-write (Mem0 platform)

Persists **ambient progress-state**, a standup note to the next developer. Not a decision log:
no typed `Decision`/`Outcome` shape. Server: `mem0-mcp`. Decision record:
`docs/adr/0009-mem0-agentic-memory-substrate.md`. Read counterpart: `agentic-memory-read`
(load context there first if you have not this session).

## When to write

Only at these events:

- **Blocker:** stuck on a dependency, access, or failing infra.
- **Drift:** delivered work does not fully match ticket intent.
- **Stopping point:** session end, context-limit handoff, or done pending human verification.
- **Silent descope:** you dropped or deferred part of the ask without the ticket saying so.
- **Resolution:** a noted blocker or drift is cleared. First-class, see below.
- **ADR amended:** its `## Decision` or `## Considered Options` changed. Record the rationale
  kept out of the ADR file: what was believed, what changed it (evidence, incident, PR), why the
  new decision is right.

## Content

Third-person standup prose that lets the next reader answer what applies of: where it stands,
what the catch is, where to pick up (branch, PR, file, next step). Name the ticket or PR. If the
event happened on another day, say when. Include only what is relevant.

> Ticket #142: about 78% done. Core migration works and is tested. The archived-records backfill
> needs a schema change I did not want to make unreviewed, so it is left out. Keep the ticket
> open or file a follow-up. Code is on `feat/142-migration`, PR #150 (draft).

## Scope

Write to the most specific scope, as the memory's `run_id`:

- On a ticket: `owner_repo_<issue>`.
- Cross-ticket note for a whole epic: the epic's `owner_repo_<epic>`. Never put single-ticket
  notes there.
- No issue: `owner_repo`.
- ADR amendment: `owner_repo_adr_<NNNN>`.

Normalization is defined in `agentic-memory-read` ("Scope key"); keep the two identical.

## Call

```
add_memory(
  text="<prose>",
  run_id="<scope key>",
  metadata={"scope": "<scope key>",
            "kind": "<blocker|drift|stopping-point|descope|resolution|adr-amendment>",
            "status": "<open|resolved|current>"}
)
```

- Omit `user_id` (server default). Always set `run_id` and `metadata.scope`; there is no default
  scope.
- **The write is async.** It returns `{"event_id", "status": "PENDING"}`. Poll
  `get_event_status(event_id)` until `SUCCEEDED`, then read `results` (each has `id`,
  `data.memory`, `event`). `FAILED` carries an `error`. **Empty or null `results` means nothing
  was stored:** rephrase more concretely, retry once, then tell the human.
- After your first write in a session, confirm it with `search_memories` filtered on the
  `run_id`.

## Resolution as event

When a blocker clears, write a new memory that **names what it resolves** and says it is no
longer true, with `kind: resolution`, `status: resolved`:

```
add_memory(
  text="Ticket #78 blocker resolved: the staging API 500s were a wrong env var, infra fixed it, verification against staging passes, so #78 is no longer blocked.",
  run_id="owner_repo_78",
  metadata={"scope": "owner_repo_78", "kind": "resolution", "status": "resolved"}
)
```

Mem0 then marks the contradicted note `lifecycle_state: "superseded"` (`replaced_by` -> the new
one). It is a model judgement, asynchronous, and not guaranteed, so the wording is what lets it
match, and what readers fall back on. Never write a terse "fixed".

## One note, not a new event

- **Correct in place:** `update_memory(memory_id, text=..., metadata=...)` (metadata merges).
  For fixing a detail or status only; a new event is a new memory so history stays.
- **Remove:** `delete_memory(memory_id)` only after the human confirms the exact id. Prefer
  superseding.
- **`delete_all_memories`:** never call it with only `user_id` (wipes every project). Use a
  `run_id` you mean to wipe, and confirm with the human first.

## ADR scope

ADR-scope notes are durable history. Never reconcile them against a GitHub issue and never treat
them as resolved. Write them with `infer=false` (stored as written, no extraction), and readers
ignore `lifecycle_state` for this scope, so a later amendment cannot hide an earlier one.

## Rules

- Memory is **non-authoritative**. If a fact should update or close a ticket, update the ticket;
  a real architectural decision goes in an ADR.
- **Everything written is stored on Mem0's hosted service.** Never store secrets, tokens,
  credentials, customer data or private incident details.
- For ticket-scoped work, prefer this skill over the generic `memory/*.md` auto-memory files.
