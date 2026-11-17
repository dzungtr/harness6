# 3. Agentic memory is ambient progress-state, not a decision store

Date: 2026-07-11

## Status

Accepted

## Context

An earlier iteration originally built the `memory` MCP server layer (Graphiti + FalkorDB,
`infrastructure/config.yaml`) as a **decision manager**: a `Decision`/`Outcome` entity schema
(`skills/agentic-memory-write/schema.py`) with a `SUPERSEDES` edge type, registered as custom
`entity_types`/`edge_types`/`edge_type_map` in `infrastructure/config.yaml`, retrieved primarily
via semantic search (`search_nodes`).

A grilling/design session surfaced that this framing solves the wrong problem. The actual gap: a
long-running agent frequently finishes work that only *partially* matches its ticket — say 78%
done, with the remainder blocked, drifted from ticket intent, or pending human verification. The
ticket stays open, but the next session (possibly a different agent entirely, since the prior
session is context-limited and can't be resumed) cold-starts with no idea what happened. Today a
human manually reconstructs this state by re-reading code, diffs, and PR comments. The verbose,
sub-ticket reality — blockers, drift, gotchas, silent descopes — never lands in a ticket and
evaporates.

A decision-manager schema doesn't address this: decisions are relatively rare and already have a
home (ADRs); what's actually missing is a place for the *tacit, in-flight* state that's too
granular for a ticket and too undecided to be an ADR.

## Decision

**Reframe the layer as ambient progress-state memory** — a self-service, agent-initiated store of
tacit progress state, referenced to GitHub issues, that makes cold-start handover smooth.
It is explicitly **non-authoritative**: a catch-net beside the ticket system, never a replacement.
The process still works without it; with it, any agent can ask "what's the state of this epic /
where do I pick up?" and get an answer.

Concretely:

1. **Not a decision-manager.** Drop the `Decision`/`Outcome` entity types, the `SUPERSEDES` edge
   type, `edge_type_map`, and `schema.py` entirely. `config.yaml` now registers only Graphiti's
   upstream built-in entity types (Preference, Requirement, Procedure, Location, Event,
   Organization, Document, Topic, Person, Object). Retire the "G1/G2/G3 decision-drift" framing
   from the original spec.
2. **Substrate: keep Graphiti (Path A).** No infra change. Primary read is **scope + recency**
   (`get_episodes` / `search_memory_facts` filtered by `group_ids`), not semantic search;
   `search_nodes` becomes secondary. Bi-temporal invalidation is kept and is now the mechanism for
   aging out resolved blockers/drift (see "Resolution as event" in
   `skills/agentic-memory-write/SKILL.md`), not for superseding decisions.
3. **One memory group per repository, recorded in a metadata file.** Each repo's Graphiti
   `group_id` is read from `.harness6.json` — a git-ignored file at the root of the repo's main
   worktree, written by the `init` skill. Its default is the normalized git remote owner, so
   repos under one owner share a group unless the user chooses otherwise. Graphiti deduplicates
   entities and invalidates facts only within a group, so the group is the boundary of shared
   knowledge, not a ticket key. Every read and write passes the group explicitly; the server
   default group (`main`) is never used. When the file is absent the skills make no memory call
   and ask the user to run `init`, rather than guessing a group.
4. **Ticket identity lives in the data.** A ticket or epic is referenced as `<repo>#<issue>`, an
   ADR as `<repo> ADR <NNNN>`. The reference opens the episode `name`, is repeated in
   `source_description` (`repo=… issue=… kind=…`), and is named in the body's first sentence so
   extracted facts carry it. Reads narrow by reference inside the one group: a fact search on
   the reference, plus recent episodes filtered by name prefix. An epic read runs a bounded
   fact search per child issue enumerated live via `gh`.
5. **Writes are event-driven**, not continuous and not session-end-only: blocker, drift, stopping
   point, silent descope, and resolution. Content is standup-prose to the next developer —
   coverage of "where it stands / what's the catch / where to pick up," not a rigid field schema.
6. **Staleness** relies on resolution being a first-class write event (a superseding note that
   names what it resolves, letting Graphiti's bi-temporal extraction age out the stale state) plus
   read-time reconciliation against live GitHub issue open/closed status. An automated
   GitHub-events ingester is deferred. ADR episodes are exempt from both halves of this:
   there's no GitHub issue to reconcile against, and amendment history is durable by design, so it
   never ages out.
7. **Three homes, one boundary:** ADR (architectural *why*) / GitHub Issues (*what/whether*,
   system of record) / Memory (tacit catch-net, non-authoritative). Memory never substitutes for
   ticket or ADR hygiene — if a fact should update or close a ticket, update the ticket; a real
   architectural decision still goes to an ADR.

## Consequences

- `skills/agentic-memory-read/SKILL.md` and `skills/agentic-memory-write/SKILL.md` are rewritten
  around scope resolution, read-wide/write-narrow, and event-driven standup-prose writes instead
  of decision/outcome capture.
- `skills/agentic-memory-write/schema.py` is deleted; no code in this repo models a typed
  Decision/Outcome entity.
- `infrastructure/config.yaml` no longer registers `Decision`, `Outcome`, or `SUPERSEDES`; only
  Graphiti's upstream built-in entity types are active. `docker-compose.yml`, `.env.example`, and
  the LLM/embedder/database/server sections of `config.yaml` are unaffected by this ADR — the
  embedder-endpoint decoupling from an earlier fix stays intact.
- Any future consumer of this memory layer reads the group from `.harness6.json` and identifies
  tickets by the `<repo>#<issue>` reference, not by a `group_id` it derives itself.
- Episodes written under per-ticket groups stay in those groups until migrated; the read skill
  checks the old group when a ticket that predates the change returns nothing.

## Considered Options

**One `group_id` per ticket, epic, and ADR (`owner_repo_<issue>`, `owner_repo_adr_<NNNN>`).**
Rejected: measured on 2026-11-17 across 44 groups, 172 entity names were duplicated between
groups (`oolio-one` and `coderabbit` 13 times each), cross-ticket facts were invisible from any
other group, and cold starts queried derived groups that held no episodes. Do not key
`group_id` to the work hierarchy.

**Derive the `group_id` from the git remote on every call.** Rejected: the three memory searches
logged in the week to 2026-11-17 all omitted `group_ids` and fell through to the empty default
group. The value is stored once per repo instead, where the user can also override it.

## Measured results

_(Left empty — filled in at initiative close, per this repo's design-session convention.)_

## Amendments

_Pointers only — current decision above. Full rationale in temporal memory (ADR scope);
fallback `git log -p` on this file._

| Date | PR | Change |
|---|---|---|
| 2026-08-24 | #31 | Add ADR scope as a fourth memory scope key (§3), outside the GitHub work hierarchy; exempt it from GitHub-status reconciliation and aging-out (§6). |
| 2026-11-17 | #95 | Replace per-ticket scope keys with one group per repo read from `.harness6.json` (§3); ticket identity moves into episode name, `source_description`, and body (§4). |
