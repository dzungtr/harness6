---
name: agentic-memory-write
description: >
  Use whenever you hit a blocker, discover drift between ticket intent and delivered result,
  reach a stopping point (session end, context-limit handoff, done-pending-verification),
  silently descope something, or resolve a previously-noted blocker/drift, to persist that
  ambient progress-state for the next cold start. Backed by a self-hosted Mem0 store (OpenMemory
  MCP server) via the `memory` MCP server. Event-driven — not continuous per-step logging,
  not session-end-only.
---

# agentic-memory-write (Mem0 / OpenMemory MCP)

Persists **ambient progress-state** — a standup note to the next developer — so a later cold
start (yours or someone else's) can pick up smoothly. This is not a decision log: no
`Decision`/`Outcome` typed shape, no schema file. Backed by the same self-hosted Mem0 stack as
`agentic-memory-read` (`infrastructure/mem0/docker-compose.yml`), exposed as the `memory` MCP
server. Decision record: `docs/adr/0009-mem0-agentic-memory-substrate.md`.

The `memory` tools take **text only** — `add_memories(text)` has no metadata or id parameter
(read from a running server's `tools/list`; see `agentic-memory-read` for the full table). Scope,
kind and status therefore travel in a header line inside the text, and `agentic-memory-read`
filters on it client-side.

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
`agentic-memory-read`'s "Scope resolution" — keep them identical. It is used as the **scope
token** in the header below.

Don't write epic-level notes for single-ticket concerns — that breaks read-wide/write-narrow
and pollutes every sibling ticket's epic-level read.

## Resolution as event

When a blocker clears or drifted work gets finished, write a new memory that **names what it
resolves**, with `kind: resolution` and a `resolves:` clause, e.g.:

```
[scope: owner_repo_78] [kind: resolution] [status: resolved] [at: 2026-07-12T09:00:00Z]
Resolves the 2026-07-09 blocker on #78 (staging API returning 500s): staging was misconfigured
(wrong env var), infra fixed it. Verified against staging now, all green.
```

Mem0 has no temporal invalidation: nothing marks the old blocker as no longer true, and
retrieval ranks by semantic similarity, so the stale blocker can outrank its resolution. The
`resolves:` text is what lets `agentic-memory-read` discard the older note. Never write a terse
"fixed" with no reference to what it fixes.

Mem0's add step also lets the extractor LLM compare the new fact with similar existing ones and
choose `ADD`, `UPDATE`, `DELETE` or `NONE` (the `event` in the response). That sometimes merges
or removes the stale note for you, but it is a model judgement, not a guarantee — do not rely on
it, and do not assume a note was removed.

## Supersession discipline (reversing an earlier note)

The MCP tools cannot edit or delete a single memory, so you cannot mark an old note
`superseded` in place. Instead:

1. Search for the note you are reversing first (`search_memory`), so you can quote it.
2. Write the replacement with `kind` set to the new state, `status: current`, and a
   `supersedes:` clause that quotes the key words of the old note.
3. Check the `add_memories` response `event`. `UPDATE`/`DELETE` entries mean Mem0 already
   merged or removed the old note; `ADD` alone means both notes now exist and the reader will
   rely on your `supersedes:` text.
4. **Never** use `delete_all_memories` to retire one note: it wipes every memory the user's app
   can access, across all projects. If a single memory must be physically removed or edited,
   use OpenMemory's REST API (per-memory update/delete routes under `/api/v1/memories/`, listed
   at `http://localhost:8765/docs`) or ask the human.

## ADR scope

Memory naming follows the same convention as any other write, e.g. a header of
`[scope: owner_repo_adr_0003] [kind: adr-amendment]` and a first line "Amendment: ADR-0003
scope-token normalization fix". The body is still standup-prose — where it stood, what changed
it, why the new decision is correct — never a typed `Decision`/`Outcome`/`SUPERSEDES` shape.

ADR-scope memories are not ticket-scoped: unlike the other three scopes, never reconcile them
against a GitHub issue's open/closed status (there usually isn't one), and never treat them as
resolved. Amendment history is durable by design — it's the whole reason this trigger exists —
so the "Resolution as event" mechanism above doesn't apply here.

## `add_memories` call

`add_memories(text=...)` — the only parameter. Build `text` as a header line followed by the
prose, with a short natural-language lead that repeats the scope key so the extractor has a
reason to keep it:

```
[scope: <scope key>] [kind: <blocker|drift|stopping-point|descope|resolution|adr-amendment>] [status: <open|resolved|current>] [at: <ISO-8601>]
<scope key>: <standup prose — where it stands / the catch / where to pick up>
```

- `scope`: the single, explicit resolved scope (see "Write scope" above) — always set it; there
  is no server-side default scope to fall back on.
- `at`: ISO-8601 (e.g. `2026-07-11T14:30:00Z`) — when the event actually happened. The server's
  `created_at` records when you wrote it, which can differ.
- Write in plain third-person statements. Mem0's default extractor is tuned for personal facts
  and preferences and may rewrite or drop engineering notes.

**Always inspect the response.** `{"results": []}` means the extractor found nothing worth
storing and **nothing was saved**; rephrase more concretely and retry once, then tell the human.
After your first write in a session, `list_memories` (or `search_memory` on the scope token) once
to confirm the header survived extraction — if the extractor stripped the scope token, reads
cannot filter by scope and you should say so.

## Other tools

- `list_memories()` and `search_memory(query)` read; see `agentic-memory-read`.
- `delete_all_memories()` is destructive and unscoped — see "Supersession discipline". There
  is no per-note delete tool.

## Rules

- Memory is **non-authoritative** and never substitutes for ticket/ADR hygiene: if a fact
  should update or close the ticket, update the ticket; a real architectural decision still
  goes to an ADR. Memory is the tacit catch-net for what falls between those — the small
  stuff that evaporates today.
- Never store secrets, tokens, or credentials in memories.
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
