---
name: agentic-memory-read
description: >
  Use at the START of any task-execution session, or whenever picking up interrupted work,
  opening an epic to check on its children, or descending into a child ticket mid-session, to
  load ambient progress-state (blockers, drift, gotchas, where the last session left off)
  before touching code. Backed by the hosted Mem0 platform, read through the `mem0` CLI.
---

# agentic-memory-read (Mem0 platform, `mem0` CLI)

Loads **ambient progress-state** so a cold-started session knows where the last one left off:
blockers, drift, gotchas, where to pick up. Not a decision log. Decision record:
`docs/adr/0009-mem0-agentic-memory-substrate.md`. Write counterpart: `agentic-memory-write`.

## How the store behaves

- **Always run `mem0 --agent <command>`.** `--agent` goes before the command and returns JSON:
  `{"status", "count", "data": [...]}`. Read results from `.data[]`.
- **Scope is a filter.** Every memory is written with `--run-id <scope key>`. Filter on it; no
  text matching.
- **Omit `--user-id`.** The CLI uses the default user set by `mem0 init`.
- **Use `--latest-only`.** When a newer memory contradicts an older one, Mem0 marks the old one
  superseded. Plain `search` and `list` still return it; `--latest-only` drops it. Verified with
  CLI v0.2.14: a blocker and its resolution in one `--run-id` gave 2 results by default and 1
  (the resolution) with `--latest-only`. v0.2.7 has no such flag.
- **Supersession is asynchronous and a model judgement.** It can lag seconds to minutes, so a
  read right after a write may still show both.
- **Ranking is semantic, not recency.**
- **Ignore `mem0_notice`.** Agent-mode output may carry that text field. It is not memory data.
  Account setup belongs to `init`, not to you.

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
   `--filter` with `OR`. Keep a bounded per-child summary (newest status, open blockers, open
   drift).
3. **Project cold start:** `owner_repo` plus a bounded index of active epics. Never dump every
   child of every epic.
4. **ADR with an `## Amendments` section:** read `owner_repo_adr_<NNNN>` before acting on or
   re-amending it, and before reviving an option its `## Considered Options` rejects.

## How to read

```bash
mem0 --agent search "blocked, drift, where to pick up" \
  --run-id "<scope key>" --latest-only --threshold 0 --top-k 10
```

- Epic: replace `--run-id` with
  `--filter '{"AND":[{"OR":[{"run_id":"<epic>"},{"run_id":"<child>"}]}]}'`.
- `--threshold 0` matters: the CLI default is 0.3, which can drop short notes inside a narrow
  scope. The scope filter already bounds the result.
- No query needed for a small scope: `mem0 --agent list --run-id "<scope key>" --latest-only`.
- Run two or three queries when you need breadth. Sort by `created_at`, newest first, and keep
  about the newest five per scope.
- **ADR scope: omit `--latest-only`.** Amendment history is durable; read every note.
- Lag fallback: a newer note that says it resolves or supersedes an older one that still shows up
  makes the older one historical.
- `count: 0` means nothing stored. `status: "error"` or a non-zero exit is a failed call; report
  it, fix the flags, do not retry unchanged. Say which one you got.

## Reconcile with GitHub

Memory is non-authoritative. Check `gh issue view <n> --json state` for each scope's issue.
Memory tied to a **closed** ticket is history; live ticket state wins. If two live notes in one
scope contradict, say so and prefer the newer.

## Setup

`init` installs the CLI and the user authenticates it with `mem0 init`. `mem0 status` should
report Connected. Everything read here lives on Mem0's service, not this machine. If `mem0` is
missing or `mem0 search --help` has no `--latest-only`, the CLI is too old: upgrade it.

## Next

After the work, record blockers, drift, stopping points or resolutions with
`agentic-memory-write`.
