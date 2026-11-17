---
name: agentic-memory-read
description: >
  Use at the START of any task-execution session, or whenever picking up interrupted work,
  opening an epic to check on its children, or descending into a child ticket mid-session, to
  load ambient progress-state (blockers, drift, gotchas, where the last session left off)
  before touching code. Backed by a remote Graphiti temporal knowledge graph via the `memory`
  MCP server. Trigger on cold start, resuming a backlog ticket/epic, or picking up any work
  that a prior (possibly context-limited) session may have partially completed.
---

# agentic-memory-read (Graphiti)

Loads **ambient progress-state** — not prior "decisions" — so a cold-started session (yours or
someone else's) knows where the last session left off: blockers, drift between ticket intent
and delivered result, gotchas, and where to pick up. Backed by a self-hosted Graphiti +
Neo4j stack — the `graphiti-mcp` service in `infrastructure/docker-compose.yml`, with
entity-type schema at `infrastructure/config.yaml` — exposed as the `memory` MCP server.

Tool names and signatures below are **verified against the upstream source at the pinned
image tag** (`getzep/graphiti`, `mcp_server/src/graphiti_mcp_server.py`, tag `mcp-v1.1.3` =
image `zepai/knowledge-graph-mcp:1.1.3-standalone`, checked 2026-11-17) — keep them accurate,
don't invent params.

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
- **File missing or `group_id` empty** — use the default `init` would propose: the git remote
  owner, lowercased, with every character outside `[a-z0-9]` replaced by `_`
  (`acme-org/payments-service` → `acme_org`). Tell the user to run the `init` skill to pin it;
  don't create the file yourself.
- A `group_id` contains only `[a-z0-9_]`.

Several repos normally share one group (the `init` default is per owner, not per repo), so
entities and facts are deduplicated and invalidated across every ticket and repo in it.
`global` is a separate group reserved for the `signoz-*-queries` skills' telemetry-schema
notes.

## Ticket identity lives in the data

The group says nothing about which ticket a note belongs to. That is carried by the episode
itself (written by `agentic-memory-write`):

- **Reference** — `<repo>#<issue>` for a ticket or epic (`payments-service#424`), `<repo> ADR
  <NNNN>` for an ADR, bare `<repo>` for work with no issue. `<repo>` is the repository name
  as GitHub shows it, without the owner.
- Episode `name` starts with the reference; `source_description` repeats it as
  `repo=<owner/repo> issue=<n> kind=<kind>`; the body names it in its first sentence, so
  extracted facts carry it too.

Resolve the issue number from, in order: the task brief, the branch name, the issue linked
from the branch's open PR. A PR number is not an issue number — don't use it as one.

## Read model

All reads go to the one group; the reference narrows them.

1. **Ticket cold-start** (the common case):
   `search_memory_facts(query="<repo>#<issue> <topic>", group_ids=[<group>])`, then
   `get_episodes(group_ids=[<group>], max_episodes=30)` and keep the episodes whose `name`
   starts with `<repo>#<issue>`.
2. **Epic cold-start**: list the child issues live via `gh`, then run the ticket fact search
   once for the epic and once per child with a small `max_facts` — a bounded per-child
   summary of status, open blockers, and open drift. Read a child's episodes only when you
   descend into working it.
3. **Project cold-start** (no specific issue): `get_episodes(group_ids=[<group>],
   max_episodes=20)` and keep the names starting with `<repo>`; that is the recent activity
   across the repo's tickets.
4. **ADR read** (the ADR has an `## Amendments` section): `search_memory_facts(query="<repo>
   ADR <NNNN>", group_ids=[<group>])` before acting on, or re-amending, that ADR. An ADR
   without that section has no history in memory.
5. **Rejected-option check** (you're about to propose something an ADR's
   `## Considered Options` marks rejected): run the ADR read first — the ADR body carries
   only the terse prohibition and its evidence.

`get_episodes` has no name filter and returns only the newest `max_episodes` of the whole
group, so an older ticket's episodes fall outside the window. Facts have no such window: when
the episode read finds nothing for a ticket, the fact search is the read. To tighten a fact
search around one ticket, find its entity with `search_nodes(query="<repo>#<issue>",
group_ids=[<group>])` and pass that node's uuid as `center_node_uuid`.

### Memory written before `.harness6.json` existed

Earlier versions wrote one group per ticket: `<owner>_<repo>_<issue>`, `<owner>_<repo>`, and
`<owner>_<repo>_adr_<NNNN>`, each component normalized like the default above. Those episodes
are not in the shared group. When a ticket or ADR that predates the switch returns nothing,
query its old group once with `get_episodes` before concluding there is no history.

## Read-time reconciliation

Memory is not authoritative — cross-check against live GitHub state before trusting a note:

- Check the open/closed status of the referenced issue(s) (e.g. `gh issue view <n> --json
  state`).
- Treat memory tied to a **CLOSED** ticket as historical context, not current state — the work
  may have shipped, or the note may predate a resolution that never made it back into memory.
  Live ticket status is the tiebreaker, not the memory note.

## Tools

Primary read is **ticket reference + recency**, not open-ended semantic search:

- `get_episodes(group_ids=[...], max_episodes=<n>)`: the most recent raw episodes of the
  group, newest first (default 10).
- `search_memory_facts(query=<topic>, group_ids=[...], max_facts=<n>)`: search over extracted
  facts (edges) when you need something more targeted than "most recent." Each fact carries
  `valid_at` / `invalid_at`; see "Temporal filters" below.
- `search_nodes(query=<topic>, group_ids=[...], entity_types=[...])`: SECONDARY — semantic
  entity search. Use when reference+recency reads don't surface what you need, not as the first
  call. `center_node_uuid=<uuid>` ranks results by graph distance to a known entity;
  `search_memory_facts` accepts it too.
- `get_episode_entities(episode_uuids=[...], group_id=<group>)`: provenance — the entities and
  facts a given episode produced. Use to check what a note actually asserted before trusting
  a fact that looks stale.
- `get_status()`: confirm the server + database connection are healthy before assuming a read
  silently failed (or returned stale/empty results).

`group_ids` accepts a single string or a list. `get_episode_entities` takes a singular
`group_id`; omitting it falls back to the server default (`main`), so always pass the group.

### Temporal filters on `search_memory_facts`

Four optional ISO-8601 bounds (timezone-naive is read as UTC; a malformed value returns
`Invalid date filter` instead of results):

| Param | Keeps facts whose |
| --- | --- |
| `valid_at_after` | `valid_at` ≥ bound — became true at or after this time |
| `valid_at_before` | `valid_at` ≤ bound — became true at or before this time |
| `invalid_at_after` | `invalid_at` ≥ bound — were superseded at or after this time |
| `invalid_at_before` | `invalid_at` ≤ bound — were superseded at or before this time |

- **What changed since I last looked** — `valid_at_after=<last session time>`.
- **What was resolved/superseded recently** — `invalid_at_after=<time>`; this is how a cleared
  blocker shows up.
- **State as of a past date** — `valid_at_before=<date>`, then drop results whose `invalid_at`
  is earlier than that date.

There is **no "currently valid only" filter**: the bounds are `>=`/`<=` comparisons, so they
cannot select `invalid_at IS NULL`, and any `invalid_at_*` bound returns *only* superseded
facts. To get current state, search without `invalid_at_*` bounds and discard results whose
`invalid_at` is set. Facts with no `valid_at` are likewise excluded by any `valid_at_*` bound.

`edge_types=[...]` also exists, but this stack configures no custom edge types
(`infrastructure/config.yaml`), so there is nothing useful to filter on — leave it unset.

## MCP client registration

This repo doesn't track a committed MCP client-config file, so registration happens in your
own Claude Code MCP settings (not part of this PR). Point it at the compose stack's HTTP
endpoint (default host port from `infrastructure/.env.example` is `8121`, overridable):

```json
{
  "mcpServers": {
    "memory": {
      "type": "http",
      "url": "http://localhost:8121/mcp/"
    }
  }
}
```

Note the trailing `/mcp/` and `"http"` transport — verified against the upstream server's
default transport (SSE is listed as deprecated upstream, not the recommended path used here).

## Next step

Once you've loaded progress-state and done the work, use the `agentic-memory-write` skill to
record a blocker, drift, stopping point, silent descope, or resolution before ending the
session.
