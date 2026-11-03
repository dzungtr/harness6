# 9. The hosted Mem0 platform, read and written through its CLI, is the agentic-memory substrate

Date: 2026-11-03

## Status

Accepted. Supersedes the substrate decision in ADR 0003 ("Substrate: keep Graphiti"); the rest of
ADR 0003 (ambient progress-state, scope keys, write narrow / read wide, event-driven writes) stands.

## Context

ADR 0003 reframed the `memory` MCP server as ambient progress-state memory and kept Graphiti as
the substrate, mainly for its bi-temporal invalidation: a resolved blocker should stop reading as
current. A Mem0-backed implementation was built and compared against the Graphiti one
("Approach B" in `tillpos-tony/my-claude` PR 82).

This PR went through three iterations: a self-hosted OpenMemory stack (text-only tools, no
temporal invalidation), then the hosted Mem0 platform through its MCP server, then the same
platform through its CLI. The platform was exercised live on 2026-11-03 with throwaway memories:

| Probe | Result |
|---|---|
| Add memory A, then memory B that contradicts A (MCP, same user, no `run_id`) | Both `ADD`. A later `get_memory` showed A `lifecycle_state: "superseded"`, `replaced_by` = B. Not visible after about a minute. |
| Blocker, then resolution, same `run_id` (MCP) | Blocker `superseded` within seconds. |
| MCP `search_memories` / `get_memories` after supersession | Return **both** memories; `replaced_by` can still read `null` in list payloads. |
| MCP filter by `lifecycle_state` | Rejected (`Unknown filter key` / `Invalid key`). Keys listed as allowed, `temporal_relation` and `memory_type`, fail with `Unsupported field`. |
| MCP filters by `run_id`, `metadata`, `OR` of `run_id`s | Work and are exact. |
| MCP `add_memory` | Asynchronous: `event_id` / `PENDING`, then `get_event_status`. |
| Mem0 docs and blog (2026-09-28) | The API read flag `latest_only` returns only current memories. The MCP tool schema does not expose it. |
| CLI v0.2.7, `search --latest-only` | `unknown option`. |
| CLI v0.2.14, blocker then resolution in one `--run-id` | Default `search` and `list`: 2 results. With `--latest-only`: 1 (the resolution). |
| CLI `event status`, `--filter` with `OR` of `run_id`s, default user from `mem0 init` | All work. |

The Graphiti services in `infrastructure/docker-compose.yml` (`graphiti-mcp`, `neo4j`), their
`config.yaml`, and the Kubernetes manifests are existing deployed infrastructure. Removing them
is a separate, riskier change than repointing the skills.

## Decision

**The skills use the hosted Mem0 platform through the official `mem0` CLI** (`npm install -g
@mem0/cli` or `pip install mem0-cli`), always as `mem0 --agent <command>` for JSON output. No MCP
server is registered. Concretely:

1. **Active-only reads are a server-side flag.** `search` and `list` take `--latest-only`, which
   drops memories a newer one superseded. This replaces the Graphiti bi-temporal mechanism ADR
   0003 relied on, for the same job: aging out resolved blockers and drift. Readers no longer
   need a per-hit `get_memory` check. Resolution notes still name what they resolve, so the
   platform has something to match and readers have a fallback for lag.
2. **Scope keys are unchanged** (`owner_repo`, `owner_repo_<issue>`, `owner_repo_adr_<NNNN>`), but
   they are the memory's `--run-id` plus `scope` in `-m` metadata, filtered server-side. Epic
   reads use `--filter` with `OR`.
3. **User identity is the CLI default** set by `mem0 init --user-id`; calls omit `--user-id`.
4. **Writes are asynchronous.** The write skill polls `mem0 --agent event status` and treats empty
   `results` as "nothing stored".
5. **ADR scope opts out of supersession handling.** Notes are added with `--no-infer` and read
   without `--latest-only`, so amendment history is never hidden.
6. **Auth is an API key** saved in the CLI's config by the user running `mem0 init`. Agents never
   see or pass the key.
7. **No self-hosted Mem0 stack in this repo.** `infrastructure/mem0/` is removed. `init` installs
   or upgrades the CLI and asks the user to authenticate, so Mem0 works on the Kubernetes path
   too. The CLI needs a build that has `--latest-only` (v0.2.14 does, v0.2.7 does not).

## Considered Options

**Keep Graphiti as the skills' backend.** Rejected (see Context). The Graphiti services stay
deployed and untouched; only the skills, docs and registration step stop pointing at them.

**Self-hosted OpenMemory MCP.** Rejected: text-only tools, no metadata, filters or per-memory
edit, no temporal invalidation, hardcoded upstream models patched at build time, months-old
`:latest` images, and a five-container stack to run.

**Hosted Mem0 MCP server (`https://mcp.mem0.ai/mcp`).** Tried and dropped. It supports scope and
metadata filters and per-memory tools, but it cannot return active-only results: `lifecycle_state`
is not a filter, `latest_only` is not a parameter, and only `get_memory` reveals supersession, so
every kept hit needs an extra call. Its OAuth sign-in is also separate from the API key the CLI
uses.

**Mem0 REST API called directly.** Not chosen: the CLI wraps it with the same flags and JSON
output, so there is no client code to maintain.

**Route Mem0 through a model gateway.** Not applicable: the platform runs its own extraction and
embedding.

## Consequences

- **Data leaves the machine.** Every memory is stored on Mem0's hosted service. The write skill and
  `init` say so and forbid secrets, credentials, customer data and private incident details.
- **An API key lives on disk** in the CLI's config. Rotation and revocation are the user's job.
- **Supersession is a model judgement, asynchronous, and not guaranteed.** It lagged by over a
  minute in one probe and by seconds in others. A read just after a write can still see both
  notes. A loosely worded note can supersede something it should not, which is why
  `mem0 update` and `mem0 delete` exist and why ADR scope opts out.
- **Shell-outs, not tool calls.** Agents run `mem0` through Bash, so the text is passed on stdin
  to avoid quoting problems, and a missing, old or unauthenticated CLI shows up as a command
  failure rather than a missing tool.
- **Agent Mode accounts.** `mem0 --agent` output can carry a `mem0_notice` telling the agent to
  ask the user to claim an unclaimed Agent Mode account. It is a CLI feature, not memory data.
  The skills tell agents to ignore the text and `init` tells the user to authenticate with their
  own key. A CLI that was bootstrapped in Agent Mode points at a throwaway account, not the
  user's.
- **Availability and cost now depend on a third party.** Quota and pricing are Mem0's. Not
  measured here.
- **Not verified:** behaviour at scale, extractor quality on long engineering notes, whether
  `--no-infer` memories are exempt from supersession, whether `--latest-only` combines with
  `--filter` on large result sets (only the `OR` syntax was checked, on an empty scope), and the
  `init` section on a clean machine.
- Existing Graphiti data is not migrated. `GRAPHITI_*` and `SEMAPHORE_LIMIT` have no Mem0
  equivalent.
- The three `signoz-*` skills that cached schema facts through Graphiti tool names now call the
  CLI with `--run-id global`.
- Removing the Graphiti services, `config.yaml` and the Kubernetes Graphiti manifests is a
  deliberate follow-up, not part of this decision.
