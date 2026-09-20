---
name: design-session
description: "Use when the human asks to design, plan, or build a non-trivial feature, refactor, or change that needs upfront design (multiple files, architectural decisions, ambiguous requirements, \"let's build/design/plan X\"). Runs the full scope-review → grill-with-docs (with live research) → spec → tickets → triage → docs-PR flow inline in this session. Halts and splits into per-slice child sessions when scope is too large. SKIP for: small bugfixes, single-file edits, well-scoped changes with clear requirements, or pure questions."
---

# design-session

Run the full `scope-review` → `grill-with-docs` → `/to-spec` → `/to-tickets` → triage → docs-PR flow inline in this main session.

## When to invoke

**Trigger when:**
- Human says "let's design X", "plan Y", "build a new feature for Z", "I want to add ..."
- Task involves architectural decisions, spans multiple files/systems, or has ambiguous requirements
- Requirements need clarification before code can responsibly be written
- A spec or implementation plan would be more valuable than jumping straight to edits

**Skip when:**
- Small bugfix, typo, config tweak, or single-file change
- Requirements are already explicit and unambiguous
- Human is asking a question, not requesting work
- Human explicitly says "just do it" / "quick change" / "no need to plan"

## Procedure

### 1. Confirm + collect context

Pick a short kebab-case slug for the feature (e.g. `payment-retry`, `multi-tenant-auth`). Capture:

- `pwd`, current git branch, repo root.
- Any file paths, constraints, or seed goals the human mentioned so far.

### 2. Scope gate (split and conquer)

Invoke the `scope-review` skill on the goal as stated.

- **PASS** → continue to step 3.
- **FAIL** → the goal is too large for one session; a mega-session would blow the model's context. Pivot to **decomposition mode** and stop there:
  1. Apply the research rule (step 3) to any domain facts you lean on while decomposing — verify, don't assume.
  2. Grill the human **only about slice boundaries and slice order**. Never design slice internals in this session.
  3. Publish the ordered slice list to an **epic-style tracker issue** — this epic is the durable decomposition artifact; each child session takes one slice from it.
  4. **Halt.** Instruct the human to launch a fresh `/design-session` per slice. Each child session re-runs this scope gate on its own slice as its first substantive step.

### 3. Grill with live research

Invoke the `grill-with-docs` skill directly in this session. Interview the human relentlessly about every aspect of the design, challenge decisions against the domain model, and crystallise terminology in CONTEXT.md/ADRs. Do not stop grilling until the human signals they are satisfied.

**Research rule (model- and agent-agnostic, active throughout the grilling):** hallucinated facts are the biggest risk in a design session. Never let an external fact into the spec or an ADR on model memory alone.

- Any **load-bearing external fact** — API behavior, version limits, quotas, pricing, error semantics, benchmark numbers, third-party library contracts — must be verified via the agent's available web research tooling (e.g. `/research`, `/bx`, `find-docs` — use whatever search capability this agent has) **before** it enters the spec or an ADR.
- **Codebase facts** are verified by reading the code, not by memory.
- If research tooling is unavailable or results are inconclusive, record the fact in the spec explicitly tagged `UNVERIFIED:` as an assumption to verify during implementation — never silently asserted.

**ADR authority:** ADRs are created only under the `domain-modeling` skill's three gates (hard to reverse, surprising without context, result of a real trade-off) and its `ADR-FORMAT.md`; CONTEXT.md follows `CONTEXT-FORMAT.md` and holds glossary only. Do not invent ad-hoc ADR formats.

### 4. Write the spec (and make it the coordination home)

Invoke `/to-spec` to synthesize the grilling into a spec and publish it to the project issue tracker. The spec is the durable "what & why" (problem, solution, user stories) plus the Implementation Decisions and Testing Decisions sections. Present it to the human for approval and iterate until approved.

The published spec issue is **also the live coordination home and working ledger** for the initiative — the single object that answers "where is this initiative as a whole, and where do executing agents record what they produce." Once the spec is approved, append these sections to its issue body:

- **Child checklist** — a placeholder section (populated in step 5 once tickets are published) using the tracker's native task-list syntax. HITL (`ready-for-human`) flags are added by the triage step (step 6), not here.
- **Handoffs** — a table with one row per *cross-slice* value that one slice produces and a sibling slice consumes (e.g. an export timestamp a downstream consumer must start from, baseline counts a validation slice checks against, root-caused rejects a loader must handle). Leave the values **blank**; the executing agents fill each in as its slice completes. This is what stops per-run state from stranding in ad-hoc files or dying in a closed child ticket.

Record the spec issue's URL/ID — you will pass it to `/to-tickets` in the next step.

### 5. Break into tickets and establish blocking edges

Invoke `/to-tickets` to break the approved spec into tracer-bullet vertical-slice tickets on the project issue tracker. Quiz the human on granularity and dependencies until they approve the breakdown, then publish the tickets in dependency order using the tracker's native **blocking-edges** mechanism — each ticket declares the tickets that block it. Do not classify HITL vs AFK in this step — that decision belongs to triage (step 6). Do not use parent-child linking; the spec issue's child checklist is the flat index, and the epic issue (if this session was launched from a decomposition) carries the higher-level slice structure.

After all tickets are published, update the spec issue's child checklist section with links to every ticket in dependency order — without HITL flags; triage adds them next.

### 6. Triage tickets

Invoke `/triage` for each published ticket. For each one: recommend a category (`bug` / `enhancement`) and state (`ready-for-agent` / `ready-for-human` / `needs-info`), post an agent brief if moving to `ready-for-agent`. This is where HITL vs AFK classification happens — `ready-for-human` is HITL, `ready-for-agent` is AFK. Each brief **must name the spec issue and point writers at its Handoffs section**, so executing agents know where to record what they find. Work through all tickets, then flag the `ready-for-human` tickets in the spec issue's child checklist.

### 7. Docs PR

Raise a PR for any ADR and docs changes (CONTEXT.md, ADRs, or other documentation) crystallised during the grilling session — in the `domain-modeling` skill's formats, per step 3. Create a worktree, commit the changed docs files, open the PR, and report the PR URL.

## Notes

- Do NOT execute any implementation — that is dispatched separately from the main session as a Workflow A background agent after this design session completes.
- The FAIL path (step 2) halts the session after the epic issue is published. Implementation still flows through child sessions — never resume a halted parent session to design slice internals.
