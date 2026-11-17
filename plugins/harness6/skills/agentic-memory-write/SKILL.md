---
name: agentic-memory-write
description: >
  Use whenever you hit a blocker, discover drift between ticket intent and delivered result,
  reach a stopping point (session end, context-limit handoff, done-pending-verification),
  silently descope something, or resolve a previously-noted blocker/drift, to persist that
  ambient progress-state for the next cold start. Backed by a remote Graphiti temporal
  knowledge graph via the `memory` MCP server. Event-driven — not continuous per-step logging,
  not session-end-only.
---

# agentic-memory-write (Graphiti)

Persists **ambient progress-state** — a standup note to the next developer — so a later cold
start (yours or someone else's) can pick up smoothly. This is not a decision log: no
`Decision`/`Outcome` typed shape, no schema file. Backed by the same self-hosted Graphiti +
Neo4j stack as `agentic-memory-read`, exposed as the `memory` MCP server.

Tool names and signatures below are **verified against the upstream source at the pinned
image tag** (`getzep/graphiti`, `mcp_server/src/graphiti_mcp_server.py`, tag `mcp-v1.1.3` =
image `zepai/knowledge-graph-mcp:1.1.3-standalone`, checked 2026-11-17) — keep them accurate,
don't invent params.

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
  amendments" below — this is still standup-prose, not a typed shape.

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

> payments-service#78: implementation done, but can't verify against staging — staging API is
> returning 500s on the endpoint this depends on. Not our bug; filed with infra. Picking back
> up once staging is healthy again.

**Drift at a stopping point:**

> payments-service#142: ~78% done — the core migration path works and is tested. The remaining 22%
> (backfill for archived records) turned out to need a schema change I didn't want to make
> unreviewed, so I left it out. Ticket should probably stay open or get a follow-up filed;
> code is on `feat/142-migration`, PR #150 (draft).

**Silent descope / gotcha:**

> payments-service#96: shipped without the CSV export the ticket mentions — the existing export lib
> doesn't support the requested column set, and adding that felt out of scope for this
> ticket. Didn't call this out in the PR description; flagging here in case someone expects
> it.

## Group resolution

Every repo has one memory group, recorded in a git-ignored metadata file at the root of the
repo's **main** worktree: `.harness6.json`, written by the `init` skill.

```json
{ "memory": { "group_id": "acme_org" } }
```

Resolve it before any `memory` call — from a linked worktree too, since the file is untracked
and exists only in the main one:

```bash
REPO_ROOT="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
jq -r '.memory.group_id // empty' "$REPO_ROOT/.harness6.json" 2>/dev/null
```

- **Pass it explicitly on every call** (`group_ids=[<group>]` on reads, `group_id=<group>` on
  writes). A call without it silently uses the server default group `main`, which holds
  nothing — reads come back empty and writes are stranded.
- **File missing or `group_id` empty** — make no `memory` call. Ask the user to create the
  file by running the `init` skill's section 8 ("Record this repository's harness6
  metadata"), which proposes a group and lets them choose. Continue the memory write once the
  file exists. Don't guess a group and don't write the file yourself: a guessed group splits
  the repo's memory across two graphs. If the user declines, carry on with the task without
  memory and say so.
- A `group_id` contains only `[a-z0-9_]`.

Several repos normally share one group (the `init` default is the git remote owner, not the
repo), so
entities and facts are deduplicated and invalidated across every ticket and repo in it.
`global` is a separate group reserved for the `signoz-*-queries` skills' telemetry-schema
notes.

This section matches `agentic-memory-read`; keep the two in step.

## Ticket identity lives in the data

One group holds every ticket, so each episode must say which one it is about. Build the
**reference** first:

| Work | Reference |
| --- | --- |
| Ticket or epic | `<repo>#<issue>` — `payments-service#424` |
| ADR amendment | `<repo> ADR <NNNN>` — `harness6 ADR 0003` |
| No issue (ad-hoc) | `<repo>` |

`<repo>` is the repository name as GitHub shows it, without the owner. Resolve the issue
number from, in order: the task brief, the branch name, the issue linked from the branch's
open PR. A PR number is not an issue number — don't use it as one.

Put the reference in three places, because each feeds a different read:

- **`name`** — `<reference> — <Kind>: <title>`, so an episode is identifiable when listed.
- **`source_description`** — `repo=<owner/repo> issue=<n> kind=<kind>` (`adr=<NNNN>` in place
  of `issue=` for an ADR; omit `issue=` when there is none). `<kind>` is one of `blocker`,
  `drift`, `stopping-point`, `descope`, `resolved`, `gotcha`, `adr-amendment`.
- **First sentence of `episode_body`** — name the reference in prose (`payments-service#424:
  implementation done, but …`). `agentic-memory-read` reads facts, and facts are extracted
  from the body alone, so a body that never names its ticket yields facts no ticket search can
  find.

A note about one ticket references that ticket, not its epic. Reference the epic only for
something that genuinely affects all of its children.

## Resolution as event

When a blocker clears or drifted work gets finished, write a new episode that **names what it
resolves**, e.g.:

> The payments-service#78 blocker noted 2026-07-09 is cleared: staging was misconfigured (wrong env var),
> infra fixed it. Verified against staging now, all green.

Naming the prior state explicitly gives Graphiti's bi-temporal extraction what it needs to
recognize the contradiction and age out (invalidate, not delete) the stale note — don't rely
on a terse "fixed" with no reference to what it fixes.

## ADR amendments

An ADR amendment uses the ADR reference, e.g. `"harness6 ADR 0003 — Amendment: one memory
group per repo"`. The episode body is still standup-prose — where it stood,
what changed it, why the new decision is correct — never a typed `Decision`/`Outcome`/
`SUPERSEDES` shape.

ADR episodes are not tied to a ticket: never reconcile them
against a GitHub issue's open/closed status (there usually isn't one), and never age them out.
Amendment history is durable by design — it's the whole reason this trigger exists — so the
"Resolution as event" aging-out mechanism above doesn't apply here.

## `add_memory` call

- `name`: reference, kind, short title — e.g. `"payments-service#78 — Blocker: staging 500s"`
  or `"payments-service#78 — Resolved: staging blocker"`.
- `group_id`: the repo's group from `.harness6.json` (see "Group resolution" above) — never
  rely on the server's configured default (`GRAPHITI_GROUP_ID`, `main`).
- `source_description`: `"repo=acme-org/payments-service issue=78 kind=blocker"`.
- `reference_time`: ISO-8601 (e.g. `2026-07-11T14:30:00Z`) — when the event actually
  happened, not just when you happened to write it. Timezone-naive is read as UTC; a malformed
  value is rejected up front with `Invalid reference_time`. This is what anchors the extracted
  facts' `valid_at`, which `agentic-memory-read`'s temporal filters query — so set it whenever
  the event time differs from now.
- `episode_body`: the prose note itself (see examples above).
- `source`: `"text"` (default) unless feeding structured JSON, in which case `"json"` with a
  properly-escaped JSON string.

## Other write/delete tools

- `delete_episode(uuid=..., group_id=<group>)` / `delete_entity_edge(uuid=...,
  group_id=<group>)`: remove a mistaken write. `delete_episode` cascades to entities and facts
  that episode alone created; anything other episodes also support is kept.
- `add_triplet`, `summarize_saga`, `build_communities`, and `add_memory`'s `saga` /
  `update_communities` / `custom_extraction_instructions` params exist on the server but are
  **not part of this workflow** — `add_triplet` bypasses episode extraction (no prose note, no
  bi-temporal invalidation), and `build_communities` reprocesses every entity in the group.
  Don't reach for them to record progress-state.

## Rules

- Memory is **non-authoritative** and never substitutes for ticket/ADR hygiene: if a fact
  should update or close the ticket, update the ticket; a real architectural decision still
  goes to an ADR. Memory is the tacit catch-net for what falls between those — the small
  stuff that evaporates today.
- Never store secrets, tokens, or credentials in memory episodes.
- Event-driven: not continuous (don't log every step) and not session-end-only (write
  blockers/drift/resolutions as they happen).

## Loading context first

If you haven't already loaded progress-state for this ticket this session, use the
`agentic-memory-read` skill first.

## Relationship to file-based memory

If the current work is scoped to a GitHub issue/PR (not ad-hoc/no-ticket work), prefer this
skill over writing to the generic per-project `memory/*.md` auto-memory files for
progress-state, blockers, or drift. Those files are for durable facts about the user, project,
or feedback that outlive a single ticket; this skill is the ticket-scoped ambient catch-net —
use it whenever a stopping point, blocker, drift, or resolution falls inside a ticket's scope.
