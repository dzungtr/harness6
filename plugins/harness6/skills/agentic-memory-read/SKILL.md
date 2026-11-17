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
- **File missing or `group_id` empty** — make no `memory` call. Ask the user to create the
  file by running the `init` skill's section 8 ("Record this repository's harness6
  metadata"), which proposes a group and lets them choose. Continue the memory read once the
  file exists. Don't guess a group and don't write the file yourself: a guessed group splits
  the repo's memory across two graphs. If the user declines, carry on with the task without
  memory and say so.
- A `group_id` contains only `[a-z0-9_]`.

Several repos normally share one group (the `init` default is the git remote owner, not the
repo), so
entities and facts are deduplicated and invalidated across every ticket and repo in it.
`global` is a separate group reserved for the `signoz-*-queries` skills' telemetry-schema
notes.

## Ticket identity lives in the data

The group says nothing about which ticket a note belongs to. That is carried by the episode
itself (written by `agentic-memory-write`):

- **Reference** — `<repo>#<issue>` for a ticket or epic (`payments-service#424`), bare
  `<repo>` for work with no issue. `<repo>` is the repository name as GitHub shows it,
  without the owner.
- Episode `name` starts with the reference; `source_description` repeats it as
  `repo=<owner/repo> issue=<n> kind=<kind>`; the body names it in its first sentence, so
  extracted facts carry it too.

Resolve the issue number from, in order: the task brief, the branch name, the issue linked
from the branch's open PR. A PR number is not an issue number — don't use it as one.

## Read model

All reads are fact searches against the one group. A cold start runs two kinds — by reference and
by search term — because a note filed under another ticket or repo is found only by what it
is about.

### 1. Build the search-term list

Before the first call, list what this task touches. Take the terms from the task brief, the
issue body, and the files or diff in play:

- components, services, and modules (`checkout-api`, `karpenter node pool`)
- tools, platforms, and environments (`argocd`, `staging cluster`)
- error strings and symptoms, quoted as they appear (`RediSearch syntax error`)
- domain concepts and decisions (`group_id normalization`, `approval group membership`)

Keep each term a specific noun phrase of two to five words — the search matches fact text by
keyword and by embedding, so `r6a.large vCPU memory ratio` finds what `instance sizing`
buries. Aim for three to six terms; drop any that only restate the ticket title.

### 2. Run the searches

Issue these in one batch:

- **Reference** — `search_memory_facts(query="<repo>#<issue>", group_ids=[<group>])`.
- **Each term** — `search_memory_facts(query="<term>", group_ids=[<group>], max_facts=5)`,
  one call per term, without the reference in the query so other tickets' facts can match.

Merge the results by fact `uuid`. A fact returned by a term search and not by the reference
search came from other work: read it as background on the topic, not as this ticket's state.

Every fact returned is valid at query time — the server drops superseded facts — so use the
results as they come; there is nothing to filter out.

### Variations

- **Epic cold-start**: list the child issues live via `gh`, then run the reference search
  once for the epic and once per child with `max_facts=5` — a bounded per-child summary. Run
  the term searches once for the epic, not per child.
- **Tighter ranking around one ticket**: find its entity with
  `search_nodes(query="<repo>#<issue>", group_ids=[<group>])` and pass that node's uuid as
  `center_node_uuid` to the term searches.

## Read-time reconciliation

Memory is not authoritative — cross-check against live GitHub state before trusting a note:

- Check the open/closed status of the referenced issue(s) (e.g. `gh issue view <n> --json
  state`).
- Treat memory tied to a **CLOSED** ticket as historical context, not current state — the work
  may have shipped, or the note may predate a resolution that never made it back into memory.
  Live ticket status is the tiebreaker, not the memory note.

## Tools

- `search_memory_facts(query=<text>, group_ids=[...], max_facts=<n>)`: the primary read.
  Matches `query` against fact text two ways — keyword (BM25) and embedding similarity —
  merges the two rankings, and returns the top `max_facts` (default 10). Each fact carries
  `fact`, `name`, `valid_at`, `invalid_at`, and the `episodes` uuids it came from. It makes
  one embedding request and no LLM call, so several searches in a batch are cheap.
  `center_node_uuid=<uuid>` re-ranks by graph distance to that entity.
- `search_nodes(query=<topic>, group_ids=[...], entity_types=[...])`: SECONDARY — entity
  search. Use it to find an entity's uuid for `center_node_uuid`, not as the first call.
- `get_episode_entities(episode_uuids=[...], group_id=<group>)`: provenance — the entities and
  facts a given episode produced.
- `get_status()`: confirm the server + database connection are healthy before assuming a read
  silently failed (or returned empty results).

`group_ids` accepts a single string or a list. `get_episode_entities` takes a singular
`group_id`; omitting it falls back to the server default (`main`), so always pass the group.

### Validity and history on `search_memory_facts`

By default the search returns **only facts valid at query time**: not superseded, and with no
end date in the past. This stack enforces that in the server
(`infrastructure/graphiti/type_config.py`), so pass no time parameter for a normal read.

The four optional ISO-8601 bounds are for history questions only (timezone-naive is read as
UTC; a malformed value returns `Invalid date filter`):

| Param | Keeps facts whose |
| --- | --- |
| `valid_at_after` | `valid_at` ≥ bound — became true at or after this time |
| `valid_at_before` | `valid_at` ≤ bound — became true at or before this time |
| `invalid_at_after` | `invalid_at` ≥ bound — were superseded at or after this time |
| `invalid_at_before` | `invalid_at` ≤ bound — were superseded at or before this time |

- **What changed since I last looked** — `valid_at_after=<last session time>`; still
  current-only.
- **What was resolved or superseded** — pass an `invalid_at_*` bound. That switches the
  current-only default off for the call and returns the superseded facts in that range — how
  a cleared blocker shows up.

A `valid_at_*` bound excludes facts that have no `valid_at`. `edge_types=[...]` also exists,
but this stack configures no custom edge types, so leave it unset.

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
