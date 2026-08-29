---
name: report
description: Expand the short answer just given into a detailed, evidence-backed Markdown report the user can read at their own pace. Use when the user asks for the full detail, a writeup, a deep-dive, or says they want to read something properly later — and as the escape hatch whenever the response-style line budget forced real detail out of a terminal answer.
argument-hint: "<topic or slug> — what the report should cover"
---

# report — the door behind the short answer

This harness's Response style guidance (see hooks/references/harness6.md) caps terminal answers at ~10 lines: verdict first, action second,
bullets after. That cap is right for reading speed and wrong for depth. This
skill is the other half of that contract — it takes the detail the cap forced
out and puts it somewhere the user can open later.

**A report is never a substitute for the short answer.** Give the ≤10-line
answer first, then offer or produce the report.

## Boundaries

| Use instead | When |
|---|---|
| `research` | the question is answered by **external** primary sources (docs, specs, first-party APIs) |
| `handoff` | the audience is **another agent** picking up the work, not the user reading |
| `to-spec` / `to-prd` | the output belongs on the **issue tracker** as a work item |

`report` covers work **already done or already understood in this session**,
written for the user to read, kept local.

## The shape

```
main session (holds the context)
  └─ writes  <scratchpad>/report-brief-<slug>.md
       │
       ▼
  background agent · model: haiku · run_in_background: true
       ├─ reads every pointer in the brief — and nothing else
       └─ writes <scratchpad>/reports/<slug>-YYYY-MM-DD.md
       │
       ▼
  returns: the path + a ≤5-line summary. Never the report body.
```

The point of the split: **artifact reading happens in the agent's context, not
the main session's.** That is the entire token saving. Everything else in this
skill protects it.

## Step 1 — write the brief

Write to `<scratchpad>/report-brief-<slug>.md`. Two halves, two different rules.

**Cap by kind, never by length.** The brief is as long as the context-only
knowledge requires. A dense topic may run several hundred lines — that is
correct, not a smell. It is exactly the detail the short answer dropped.

### Half A — context-only narrative (uncapped)

Everything true that is **not recoverable from disk**. The agent cannot infer any
of this, so if it is not written here it is lost:

- The reasoning behind each conclusion — not just the conclusion.
- Options considered and **rejected**, and why they were rejected.
- Predictions made and whether they held. Record failed ones; they are evidence.
- Caveats, uncertainty, and what is still unverified.
- Decisions the user made in conversation, and the constraint behind each.
- Anything the ≤10-line answer had to cut.

### Half B — pointers (terse, paths only)

Never paste file contents, log bodies, or command output into the brief. Point at
them; the agent fetches them:

- `path/to/file.ts:120-180` — what to look for there
- `owner/repo#123`, PR URLs, ADR paths
- Log/artifact paths on disk
- Exact commands the agent should re-run to capture fresh output

### Also record

- The **verbatim terminal answer** already given to the user (see report template).
- Audience and why the report exists now.

## Step 2 — dispatch the agent

One background agent. Name it after the work (`report-nats-tuning`), never
`writer` or `agent`.

- `model: haiku` by default — this is assembly, not judgment.
- **Escalate to `sonnet`** when the brief cites more than ~10 artifacts, or when
  the report requires synthesis across sources rather than expansion of claims.
- `run_in_background: true`.
- `isolation` — **not needed**; nothing is committed. Skip the worktree.

Tell the agent, in its prompt:

1. Read the brief at `<path>`.
2. Read **every pointer** in Half B. Read nothing else — no open-ended repo
   trawling; that is `research`'s job, not this one.
3. Expand each narrative claim into a section backed by concrete evidence:
   quoted lines, `file:line` refs, real command output, issue/PR state.
4. Preserve Half A's reasoning **verbatim in substance** — the agent may
   restructure and add evidence, never overwrite the reasoning with its own.
5. Where evidence contradicts a claim in the brief, **say so in the report**
   rather than silently dropping either side.
6. Write to `<scratchpad>/reports/<slug>-YYYY-MM-DD.md`.
7. Return **only** the file path plus a ≤5-line summary.

## Step 3 — hand it back

Report the path and the agent's summary. Nothing else.

## Report template

```markdown
# <Topic> — <YYYY-MM-DD>

## TL;DR
<the terminal answer, verbatim — same wording, same order, same headings>

## <Claim 1 heading — matches a bullet from the TL;DR>
<expansion: reasoning from the brief + evidence the agent gathered>
**Evidence:** `file.ts:142` · `owner/repo#123` · output of `<command>`

## <Claim 2 heading>
...

## Considered and rejected
<option, why it was rejected, what would change the answer>

## Open questions / unverified
<what is still assumption, what would settle it>

## Artifacts
<every file, PR, issue, log path, and command referenced — one line each>
```

The TL;DR being verbatim is load-bearing: the user reads ten lines in the
terminal, then opens the report at the exact spot they stopped, under the same
headings.

## Failure modes

- **Agent returns the report body.** This voids the whole design — the report
  re-enters the main context and nothing was saved. It returns a path.
- **Brief trimmed to save tokens.** Half A is uncapped for a reason. Trimming it
  deletes the only copy of the reasoning.
- **Pasting evidence into the brief.** Moves the expensive reading back into the
  main session. Point at it instead.
- **Agent exploring beyond the pointers.** Costs time and pulls in unrelated
  material. Pointers are the whole reading list.
- **Report replacing the short answer.** Answer first, always. The report is the
  door, not the doorway.
