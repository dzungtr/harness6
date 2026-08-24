# ADR Format

ADRs live in `docs/adr/` and use sequential numbering: `0001-slug.md`, `0002-slug.md`, etc.

## Template

```md
# {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why.}
```

That's it. An ADR can be a single paragraph. The value is in recording *that* a decision was made and *why* — not in filling out sections.

## Optional sections

Only include these when they add genuine value. Most ADRs won't need them.

- **Status** frontmatter (`proposed | accepted | deprecated | superseded by ADR-NNNN`) — useful when decisions are revisited. `superseded by` is reserved for a change of *subject*; see "Amending an ADR" for why a changed answer is not a supersession
- **Considered Options** — only when the rejected alternatives are worth remembering
- **Consequences** — only when non-obvious downstream effects need to be called out
- **Amendments** — a pointer table, once an accepted ADR has been revised

## Numbering

Scan `docs/adr/` for the highest existing number and increment by one.

## When to offer an ADR

All three of these must be true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will look at the code and wonder "why on earth did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If a decision is easy to reverse, skip it — you'll just reverse it. If it's not surprising, nobody will wonder why. If there was no real alternative, there's nothing to record beyond "we did the obvious thing."

### What qualifies

- **Architectural shape.** "We're using a monorepo." "The write model is event-sourced, the read model is projected into Postgres."
- **Integration patterns between contexts.** "Ordering and Billing communicate via domain events, not synchronous HTTP."
- **Technology choices that carry lock-in.** Database, message bus, auth provider, deployment target. Not every library — just the ones that would take a quarter to swap out.
- **Boundary and scope decisions.** "Customer data is owned by the Customer context; other contexts reference it by ID only." The explicit no-s are as valuable as the yes-s.
- **Deliberate deviations from the obvious path.** "We're using manual SQL instead of an ORM because X." Anything where a reasonable reader would assume the opposite. These stop the next engineer from "fixing" something that was deliberate.
- **Constraints not visible in the code.** "We can't use AWS because of compliance requirements." "Response times must be under 200ms because of the partner API contract."
- **Rejected alternatives when the rejection is non-obvious.** If you considered GraphQL and picked REST for subtle reasons, record it — otherwise someone will suggest GraphQL again in six months.

## Amending an ADR

One ADR per decision subject, amended in place. Never raise a superseding ADR because the
answer changed — a new ADR is warranted only when the *subject* changes, and reversing an
existing ADR's answer still means editing that ADR. Proliferating ADRs that contradict each
other defeats the "hard to reverse" property that makes an ADR worth writing.

Why the body must then stay clean: `memsearch` indexes all of `docs/` with no staleness
awareness, and RAG retrieves **chunks, not documents**. A chunk narrating a belief that no
longer holds reads as current guidance and is simply false. Hence the governing rule —
**every indexed chunk must be true standing alone.**

### The body is a present-tense snapshot

Write it as if today's decision were the first and only one. No `Revised again:`, no
`Revised a third time:`, no "until X happened", no narration of what was previously believed.

### Dead approaches become standing prohibitions

A superseded approach moves into `## Considered Options` as a present-tense prohibition
carrying its evidence, date, and PR — never as a story:

> **Leave `user_emails` unmanaged.** Rejected: wiped a production approval group to zero
> members on apply (2026-08-14, #726). Module derives it from `members`. Do not retry.

This is the half that must stay in the file. It's what stops the next reader re-proposing a
dead idea, and it has to survive being retrieved on its own.

### `## Amendments` is a pointer table

One row per amendment, each a terse factual statement of what changed and why — no prose
narrative. The header stays `**Status:**` + `**Date:**` only. Do **not** add `Amended:` or
`History:` header lines: the dates and PRs already live in the table, so a header copy is a
second place to drift, and the memory scope key below is derived rather than stored, so
hardcoding it breaks on repo rename and repeats boilerplate across every ADR.

The presence of `## Amendments` is itself the signal that expandable history exists. An ADR
that has never been amended has no such section.

### Where the full rationale lives

The reasoning deliberately kept out of the file — what was believed before, what changed it,
why the new decision is correct — goes to temporal memory under the ADR scope,
`owner_repo_adr_<NNNN>`, derived from the ADR filename plus the git remote. See the
`agentic-memory-write` skill's "ADR amended" trigger.

Authoritative fallback when that store is empty or unavailable:
`git log -p -- docs/adr/NNNN-*.md` and `gh pr view <n>`.

### Worked example

```md
# ADR-0018: Harness approval group membership boundary
**Status:** Accepted   **Date:** 2026-08-12

## Decision
<present tense only — reads as if today's decision were the first and only>

## Considered Options
**Leave `user_emails` unmanaged.** Rejected: wiped a production approval group to
zero members on apply (2026-08-14, #726). Module derives it from `members`. Do not retry.

## Amendments
_Pointers only — current decision above. Full rationale in temporal memory (ADR scope);
fallback `git log -p` on this file._

| Date | PR | Change |
|---|---|---|
| 2026-08-13 | #748 | Custom approver role dropped; `CUSTOM_ROLES` unlicensed, use managed `_project_admin`. |
| 2026-08-14 | #752 | `user_emails` permanently managed; unsetting it wiped live membership. |
```
