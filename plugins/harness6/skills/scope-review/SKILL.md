---
name: scope-review
description: Estimate and evaluate the scope of any goal upfront — task, feature, epic, or initiative. Evaluates three estimation axes (concern count, coupling shape, session-fit) and returns a tier verdict — TASK, EPIC, or INITIATIVE — with PR and session estimates. Pure evaluation: no decomposition, no routing, no goal modification. The caller routes on the verdict.
---

# scope-review — Upfront Scope Estimation

## When to invoke

**Always invoke before `/design-session`** (it is that skill's scope gate). Also invoke whenever the human or an agent needs an upfront sizing of a goal before committing to a session, plan, or breakdown. Especially when:

- The goal describes a project phase, a multi-capability feature, an epic, an initiative, or infra work spanning several concerns
- You are uncertain how much machinery the goal needs (one PR? tickets? multiple sessions?)
- A previous session on a similar goal blew up mid-flight from oversized scope

**Skip when:**
- The goal already carries a scope-review verdict and nothing material has changed
- It is a pure question with no implementation intent

## The Three Estimation Axes

Evaluate the goal against all three. Any goal, any size — the axes are scale-free; the tier falls out of them.

### 1. Concern count
How many distinct capabilities, services, or config areas does the goal touch? ~1 coherent concern is single-PR territory; several independent concerns point toward breakdown. This axis drives the PR-count estimate.

### 2. Coupling & dependency shape
Can the work proceed as independent slices with clean interfaces between them, or is it one entangled web? This determines whether a decomposition would be clean or forced — and whether slices can land and be reviewed separately.

### 3. Session-fit / context risk
Can one design-session — grilling plus spec plus breakdown — hold this goal without blowing the model's context? This is the TASK/EPIC vs INITIATIVE boundary: a goal no single session can hold must be split before any session designs any part of it.

## Tier definitions

- **TASK** — one coherent concern; a single PR with clear scope (or a handful of tightly-coupled changes that must land together). Needs a lightweight design-session: grill to sharpen, no tracker machinery.
- **EPIC** — multiple concerns and multiple PRs, but with clean slice boundaries and enough session-fit that ONE design-session can spec it and break it down into tickets. Needs the full design-session flow.
- **INITIATIVE** — a program of multiple epics. No single session can hold it; it must be split into epics before any session designs anything.

## Model selection

Run this evaluation with the highest-capability available model. Tier boundaries are high-stakes judgment calls: too small wastes ceremony on trivial work, too big blows the context mid-session and strands the work.

## Process

1. Read the goal as stated. Do not reframe, decompose, or design it.
2. Evaluate each axis, stating your reasoning in one sentence per axis.
3. Output the verdict using the exact format below.
4. Stop. **The caller routes on the verdict — this skill never does.** Do not suggest next steps; do not invoke any other skill.

## Output format

```
VERDICT: <TASK | EPIC | INITIATIVE> — <one-line sizing summary>

Concerns:    <one sentence — distinct capabilities/systems touched, PR-count driver>
Coupling:    <one sentence — how cleanly the work slices>
Session-fit: <one sentence — one-session holdable, or context blowout risk>

Estimate: ~<n> PRs · ~<n> design sessions
```

## Examples

**TASK example:**
```
/scope-review "add liveness probe to kape-ingestion deployment"

VERDICT: TASK — single coherent concern, one small PR.

Concerns:    one concern — a probe on a single deployment's manifest
Coupling:    nothing to slice; the change is atomic
Session-fit: trivially holdable; grilling alone will settle any open details

Estimate: ~1 PR · ~1 lightweight session
```

**EPIC example:**
```
/scope-review "set up observability for kape phase 2"

VERDICT: EPIC — several concerns, but one session can spec and break it down.

Concerns:    metrics, logs, and alerting — three concerns across collector, SigNoz, and dashboards (~4-6 PRs)
Coupling:    slices cleanly by concern; each lands and reviews separately
Session-fit: holdable — one grilling plus one spec/tickets pass fits a session

Estimate: ~5 PRs · ~1 full session
```

**INITIATIVE example:**
```
/scope-review "make the platform multi-tenant"

VERDICT: INITIATIVE — a program of multiple epics; no single session can hold it.

Concerns:    auth/tenancy model, data isolation, billing, migration of existing tenants — each is epic-sized on its own
Coupling:    epics are sequenced (tenancy model first, isolation second) but each slices internally
Session-fit: not holdable — grilling all of it would blow the session's context

Estimate: ~15+ PRs · ~3-4 design sessions after decomposition
```

## What this skill does NOT do

- Does not decompose the goal or produce slice/epic lists
- Does not route or suggest next steps — routing belongs to the caller (e.g. `/design-session`)
- Does not modify or reframe the goal
- Does not invoke other skills or ask clarifying questions about the goal
