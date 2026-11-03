---
name: agentic-memory-write
description: >
  Use whenever you hit a blocker, discover drift between ticket intent and delivered result,
  reach a stopping point (session end, context-limit handoff, done-pending-verification),
  silently descope something, or resolve a previously-noted blocker/drift, to persist that
  ambient progress-state for the next cold start. Backed by the hosted Mem0 platform, written
  through the `mem0` CLI. Event-driven, not per-step logging and not session-end-only.
---

# agentic-memory-write (Mem0 platform, `mem0` CLI)

Persists **ambient progress-state**, a standup note to the next developer. Not a decision log:
no typed `Decision`/`Outcome` shape. Decision record:
`docs/adr/0009-mem0-agentic-memory-substrate.md`. Read counterpart: `agentic-memory-read`
(load context there first if you have not this session; it also defines the scope key and the
`--agent` / `mem0_notice` rules).

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

Write to the most specific scope, as the memory's `--run-id`:

- On a ticket: `owner_repo_<issue>`.
- Cross-ticket note for a whole epic: the epic's `owner_repo_<epic>`. Never put single-ticket
  notes there.
- No issue: `owner_repo`.
- ADR amendment: `owner_repo_adr_<NNNN>`.

Normalization is defined in `agentic-memory-read` ("Scope key"); keep the two identical.

## Call

Pass the text on stdin so quotes and newlines in the prose cannot break the shell:

```bash
printf '%s' "<prose>" | mem0 --agent add \
  --run-id "<scope key>" \
  -m '{"scope":"<scope key>","kind":"<blocker|drift|stopping-point|descope|resolution|adr-amendment>","status":"<open|resolved|current>"}'
```

- Omit `--user-id` (the CLI default). Always set `--run-id` and `scope` in the metadata; there
  is no default scope.
- **The write is async.** `.data[0]` is `{"status": "PENDING", "event_id": "..."}`. Poll
  `mem0 --agent event status <event_id>` until `.data.status` is `SUCCEEDED` (a few seconds),
  then read `.data.results` (each has `id`, `data.memory`, `event`). `FAILED` carries an error.
  **Empty `results` after success means the extractor stored nothing:** rephrase more
  concretely, retry once, then tell the human.
- After your first write in a session, confirm with
  `mem0 --agent list --run-id "<scope key>"` that `run_id` and metadata landed as intended.

## Resolution as event

When a blocker clears, write a new memory that **names what it resolves** and says it is no
longer true, with `kind: resolution`, `status: resolved`:

```bash
printf '%s' "Ticket #78 blocker resolved: the staging API 500s were a wrong env var, infra fixed it, verification against staging passes, so #78 is no longer blocked." |
  mem0 --agent add --run-id owner_repo_78 \
  -m '{"scope":"owner_repo_78","kind":"resolution","status":"resolved"}'
```

Mem0 then marks the contradicted note superseded, and `mem0 search/list --latest-only` stops
returning it. Verified with CLI v0.2.14. The pass is a model judgement, asynchronous, and not
guaranteed, so the wording is what lets it match, and what readers fall back on. Never write a
terse "fixed".

## One note, not a new event

- **Correct in place:** `mem0 update <id> "<new text>" -m '{...}'` (metadata). For fixing a
  detail or status only; a new event is a new memory so history stays.
- **Remove one:** `mem0 delete <id>`, only after the human confirms the exact id. Prefer
  superseding.
- **Wipe a scope:** `mem0 delete --all --run-id "<scope key>" --force`, only with a `run_id` you
  mean to wipe and after the human confirms. List it first (`mem0 --agent list --run-id ...`);
  do not rely on `--dry-run`. **Never** use `--project` or `--all` without `--run-id`: that
  erases memory across every project.

## ADR scope

ADR-scope notes are durable history. Never reconcile them against a GitHub issue and never treat
them as resolved. Add them with `--no-infer` (stored as written, no extraction), and read them
without `--latest-only`, so a later amendment cannot hide an earlier one.

## Rules

- Memory is **non-authoritative**. If a fact should update or close a ticket, update the ticket;
  a real architectural decision goes in an ADR.
- **Everything written is stored on Mem0's hosted service.** Never store secrets, tokens,
  credentials, customer data or private incident details.
- Never put a secret on the command line (`--api-key`); the CLI reads its saved config.
- For ticket-scoped work, prefer this skill over the generic `memory/*.md` auto-memory files.
