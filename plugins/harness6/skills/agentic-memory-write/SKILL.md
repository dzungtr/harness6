---
name: agentic-memory-write
description: >
  Use whenever you hit a blocker, discover drift between ticket intent and delivered result,
  reach a stopping point (session end, context-limit handoff, done-pending-verification),
  silently descope something, or resolve a previously-noted blocker/drift, to persist that
  ambient progress-state for the next cold start. Backed by the hosted Mem0 platform via the
  `mem0-mcp` MCP server, which supersedes stale facts automatically. Event-driven — not
  continuous per-step logging, not session-end-only.
---

# agentic-memory-write (Mem0 platform)

Persists **ambient progress-state** — a standup note to the next developer — so a later cold
start (yours or someone else's) can pick up smoothly. This is not a decision log: no
`Decision`/`Outcome` typed shape, no schema file. Backed by the same hosted Mem0 platform as
`agentic-memory-read`, exposed as the `mem0-mcp` MCP server. Decision record:
`docs/adr/0009-mem0-agentic-memory-substrate.md`.

Scope, kind and status travel as **real fields** on each memory: `run_id` carries the scope key
and `metadata` carries `scope`, `kind` and `status`. `agentic-memory-read` filters on them
server-side.

## When to write (event-driven, not continuous)

Write at these events only — not on every step, and not only at session end:

- **Blocker** — you're stuck (external dependency, missing access, failing infra, etc.).
- **Drift** — what you delivered doesn't fully match ticket intent (partial completion, an
  interpretation that diverged, etc.).
- **Stopping point** — session end, context-limit handoff, or "done pending human
  verification."
- **Silent descope** — you quietly dropped or deferred part of the ask without it being
  reflected in the ticket.
- **Resolution** — a previously-noted blocker or drift is now cleared. This is a first-class
  event, not an afterthought — see "Resolution as event" below.
- **ADR amended** — an ADR's `## Decision` or `## Considered Options` section changed. Write
  the full rationale deliberately kept OUT of the ADR file itself: what was believed before,
  what changed it (evidence, incident, PR), and why the new decision is correct. See "ADR
  scope" below — this is still standup-prose, not a typed shape.

## Content model: standup prose, coverage not schema

Don't force a rigid field template. Write natural prose that lets the next reader answer, for
whatever applies:

- **Where does it stand** — what's actually done vs. ticket intent.
- **What's the catch** — the blocker, drift, or gotcha, if any.
- **Where to pick up** — branch, PR, file, or next concrete step.

Include only what's relevant — a pure blocker note doesn't need a full "where it stands"
essay; a clean resolution doesn't need to restate the whole ticket.

### Examples (deliberately different shapes)

**Blocker:**

> Ticket #78: implementation done, but can't verify against staging — staging API is
> returning 500s on the endpoint this depends on. Not our bug; filed with infra. Picking back
> up once staging is healthy again.

**Drift at a stopping point:**

> Ticket #142: ~78% done — the core migration path works and is tested. The remaining 22%
> (backfill for archived records) turned out to need a schema change I didn't want to make
> unreviewed, so I left it out. Ticket should probably stay open or get a follow-up filed;
> code is on `feat/142-migration`, PR #150 (draft).

**Silent descope / gotcha:**

> Ticket #96: shipped without the CSV export the ticket mentions — the existing export lib
> doesn't support the requested column set, and adding that felt out of scope for this
> ticket. Didn't call this out in the PR description; flagging here in case someone expects
> it.

## Write scope

Write to your **most-specific** scope:

- On a ticket → `owner_repo_<issue>` (that ticket).
- Genuinely cross-ticket note (affects the whole epic, not one child) → the epic scope,
  `owner_repo_<epic>`.
- Orphan/ad-hoc work with no issue → project scope, `owner_repo`.
- Amending an ADR → the ADR scope, `owner_repo_adr_<NNNN>`, derived from the ADR filename
  (`docs/adr/NNNN-slug.md`) plus the git remote, using the same joining rule as above.
  Example: `dzungtr/harness6` + ADR 0003 → `dzungtr_harness6_adr_0003`. This scope sits
  **outside** the GitHub work hierarchy the other three keys are built on — see "ADR scope"
  below.

The scope key is underscore-joined, not slash/hash-joined and not dash-joined. Normalize
**every component** before joining: replace any `-`, `.`, `#`, or whitespace inside the
owner/repo names with `_`, then lowercase — e.g. `acme-org/payments-service` →
`acme_org_payments_service`. The final key must contain no character other than `[a-z0-9_]`
plus `<issue>`/`<NNNN>` digits. This matches the project rule "repo `my-repo` → `my_repo`" and
`agentic-memory-read`'s "Scope resolution" — keep them identical. It is the `run_id` of the
memory.

Don't write epic-level notes for single-ticket concerns — that breaks read-wide/write-narrow
and pollutes every sibling ticket's epic-level read.

## `add_memory` call

```
add_memory(
  text="<standup prose, third person, naming the ticket and what it concerns>",
  run_id="<scope key>",
  metadata={"scope": "<scope key>",
            "kind": "<blocker|drift|stopping-point|descope|resolution|adr-amendment>",
            "status": "<open|resolved|current>"}
)
```

- Omit `user_id`: the server applies the authenticated account's default (per the tool schema).
  Pass it only when a team agreed on a shared id.
- `run_id` and `metadata.scope` are always set to the single, explicit resolved scope — there is
  no server-side default scope to fall back on.
- Write plain third-person statements and name the ticket/PR in the text. The platform's
  extractor rewrites the text and anchors it in time ("As of November 3, 2026, …"), so say in
  the prose when the event happened if that differs from today.
- **The write is asynchronous.** The call returns `{"event_id": "...", "status": "PENDING"}`,
  not the stored memory. Call `get_event_status(event_id)` until `status` is `SUCCEEDED` (a few
  seconds), then read `results`: each entry has `id`, the stored `data.memory`, and `event`
  (`ADD`, `UPDATE`, `DELETE`, `NONE`). `FAILED` carries an `error`. **`results: null` or `[]`
  after success means the extractor stored nothing** — rephrase more concretely and retry once,
  then tell the human.
- After your first write in a session, confirm it with
  `search_memories(query=..., filters={"AND": [{"run_id": "<scope key>"}]})` to check that
  `run_id` and metadata landed as intended.

## Resolution as event (temporal supersession)

When a blocker clears or drifted work gets finished, write a new memory that **names what it
resolves**, with `kind: resolution`, `status: resolved`:

```
add_memory(
  text="Ticket #78 blocker resolved: the staging API 500s (the blocker noted 2026-07-09) were a wrong env var; infra fixed it. Verification against staging passes, so #78 is no longer blocked.",
  run_id="owner_repo_78",
  metadata={"scope": "owner_repo_78", "kind": "resolution", "status": "resolved"}
)
```

The platform compares the new memory with existing ones for the same user and scope. When it
contradicts one, the older memory becomes `lifecycle_state: "superseded"` with `replaced_by` set
to the new one. Verified live: a blocker note flipped to `superseded` within seconds of a
resolution note in the same `run_id`.

What to rely on, and what not to:

- The pass is a **model judgement** and **asynchronous**; it can lag by seconds to minutes and
  is not guaranteed. A read straight after a write may still show the old note as `active`.
- The wording is what lets the platform spot the contradiction: name the thing you resolve
  ("the staging API 500s blocker") and say it is no longer true. Never write a terse "fixed"
  with no reference to what it fixes.
- Readers still get superseded memories from search and must check `lifecycle_state` with
  `get_memory` (see `agentic-memory-read`). That is why the explicit `resolves:`-style wording
  stays in the text: it is the fallback when the platform has not yet flipped the old note.

## Correcting or removing a single memory

The platform has per-memory tools, so you never need a wipe to retire one note:

- **Fix a note in place** — `update_memory(memory_id, text=..., metadata=...)`; metadata is
  merged. Use it to correct a wrong detail or flip `status`, not to record a new event (a new
  event is a new memory, so the history is kept).
- **Remove a note** — `delete_memory(memory_id)`, only after the human confirms the exact id
  (the tool itself says so). Prefer superseding to deleting.
- **`delete_all_memories`** deletes every memory in the given user/agent/app/run. Never call it
  without a `run_id` you mean to wipe, and never with only `user_id`: that erases the account's
  memory across all projects. Get the human's confirmation first.

## ADR scope

Memory naming follows the same convention as any other write: `run_id` of
`owner_repo_adr_0003`, `metadata.kind` of `adr-amendment`, and a first line "Amendment: ADR-0003
scope-token normalization fix". The body is still standup-prose — where it stood, what changed
it, why the new decision is correct — never a typed `Decision`/`Outcome`/`SUPERSEDES` shape.

ADR-scope memories are not ticket-scoped: unlike the other three scopes, never reconcile them
against a GitHub issue's open/closed status (there usually isn't one), and never treat them as
resolved. Amendment history is durable by design — it's the whole reason this trigger exists —
so the "Resolution as event" mechanism above doesn't apply here. Write ADR-scope notes with
`infer=false` (stores the text as written, with no extraction), and readers ignore
`lifecycle_state` for this scope, so a later amendment can never hide an earlier one.

## Rules

- Memory is **non-authoritative** and never substitutes for ticket/ADR hygiene: if a fact
  should update or close the ticket, update the ticket; a real architectural decision still
  goes to an ADR. Memory is the tacit catch-net for what falls between those — the small
  stuff that evaporates today.
- **Everything you write is stored on Mem0's hosted service**, outside this machine. Never store
  secrets, tokens, credentials, customer data or private incident details in memories.
- Event-driven: not continuous (don't log every step) and not session-end-only (write
  blockers/drift/resolutions as they happen).

## Loading context first

If you haven't already loaded progress-state for this scope this session, use the
`agentic-memory-read` skill first.

## Relationship to file-based memory

If the current work is scoped to a GitHub issue/PR (not ad-hoc/no-ticket work), prefer this
skill over writing to the generic per-project `memory/*.md` auto-memory files for
progress-state, blockers, or drift. Those files are for durable facts about the user, project,
or feedback that outlive a single ticket; this skill is the ticket-scoped ambient catch-net —
use it whenever a stopping point, blocker, drift, or resolution falls inside a ticket's scope.
