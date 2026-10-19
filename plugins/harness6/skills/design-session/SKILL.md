---
name: design-session
description: "Use when the human asks to design, plan, or build a non-trivial feature, refactor, or change that needs upfront design (multiple files, architectural decisions, ambiguous requirements, \"let's build/design/plan X\"). Runs scope-review first and routes on its verdict: TASK grills to a single crisp PR, EPIC runs the full grill → spec → tickets → triage → docs-PR flow, INITIATIVE splits into epics and halts for child sessions. SKIP for: small bugfixes, single-file edits, well-scoped changes with clear requirements, or pure questions."
---

# design-session

Run the scope-review-gated design flow in this main session. The verdict routes to one of three paths:

- **TASK** — grill → docs-PR (no tracker machinery)
- **EPIC** — grill → `/to-spec` → `/to-tickets` → triage → docs-PR (full flow)
- **INITIATIVE** — decompose into epics → halt (child sessions per epic)

## The handoff is the product

The grill's *reasoning* — settled decisions, contract shapes, verified evidence, rejected alternatives — is this session's primary asset. The spec and tickets are consumed by cold-start implementing agents that are typically **less capable than the designing model and hold none of this session's context**. Artifacts that preserve only conclusions fail those agents twice: they re-litigate questions the grill already settled, or they silently violate constraints whose rationale they never saw.

Two rules govern everything this session publishes:

1. **No open options.** Anything you publish carries decisions in their settled form — never "Option A / Option B", never "TBD". If a question is still open, the artifact is not ready to publish.
2. **Carry what cannot be inferred.** The value of the handoff is the technical context an implementer *cannot* reconstruct from the repository: why the design is shaped this way, what was weighed and rejected, which facts were verified. Code-derivable facts are worth a pointer; reasoning is worth full sentences.

The standing test for anything you publish: **could an agent that was not in the room execute this without re-deriving — worse — what the grill already settled?** When compressing for length, cut prose; never cut contracts, rationale, rejections, or evidence anchors.

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

### 2. Scope gate (route on the scope-review verdict)

Invoke the `scope-review` skill on the goal as stated, then route on its tier verdict:

- **TASK** → **lightweight session.** Continue to step 3 and grill until the single-PR scope is crisp. Then skip steps 4–6 entirely — no spec issue, no tickets, no epic, no triage — and go straight to step 7 (docs PR, only if ADRs/glossary crystallised during grilling). The grilled conversation is the spec: dispatch implementation afterwards as a single Workflow A background agent carrying the sharpened scope **plus the decision log and module contracts from step 4's formats** — the implementing agent never sees this conversation.
- **EPIC** → **full session.** Run steps 3–7 in order: grill with live research → spec → tickets → triage → docs-PR.
- **INITIATIVE** → **decomposition mode, then halt.** Apply the research rule (step 3) to any domain facts you lean on while decomposing — verify, don't assume. Grill the human on scope boundaries and epic order ONLY — never design inside any epic. Publish one epic issue per resulting epic, in order, on the tracker. Then **halt** and request one fresh `/design-session` per epic. Each child re-runs this gate on its epic; a well-split epic verdicts EPIC and proceeds through the full flow.

### 3. Grill with live research

Invoke the `grill-with-docs` skill directly in this session. Interview the human relentlessly about every aspect of the design, challenge decisions against the domain model, and crystallise terminology in CONTEXT.md/ADRs. Do not stop grilling until the human signals they are satisfied.

While grilling, **capture the rationale, not just the verdict.** When the human disambiguates between options, record their reasoning in their own words — those sentences are the handoff material steps 4–5 will ship. When an option is rejected, record *why it loses* at the moment it is rejected; reconstructing rejection rationale after the fact produces plausible-sounding inventions.

**Research rule (model- and agent-agnostic, active throughout the grilling):** hallucinated facts are the biggest risk in a design session. Never let an external fact into the spec or an ADR on model memory alone.

- Any **load-bearing external fact** — API behavior, version limits, quotas, pricing, error semantics, benchmark numbers, third-party library contracts — must be verified via the agent's available web research tooling (e.g. `/research`, `/bx`, `find-docs` — use whatever search capability this agent has) **before** it enters the spec or an ADR.
- **Codebase facts** are verified by reading the code, not by memory.
- If research tooling is unavailable or results are inconclusive, record the fact in the spec explicitly tagged `UNVERIFIED:` as an assumption to verify during implementation — never silently asserted.

**ADR authority:** ADRs are created only under the `domain-modeling` skill's three gates (hard to reverse, surprising without context, result of a real trade-off) and its `ADR-FORMAT.md`; CONTEXT.md follows `CONTEXT-FORMAT.md` and holds glossary only. Do not invent ad-hoc ADR formats.

### 4. Write the spec (and make it the coordination home)

Invoke `/to-spec` to synthesize the grilling into a spec and publish it to the project issue tracker. The spec is the durable "what & why" (problem, solution, user stories) plus the Implementation Decisions and Testing Decisions sections. Present it to the human for approval and iterate until approved.

The spec carries two mandatory structures beyond the `/to-spec` template. Both exist to be **lifted from**: tickets quote these records verbatim, so write them in their final, quotable form.

**A. Decision log.** Record each locked decision from the grill with five fields:

- **Decision** — what is locked, stated as an imperative.
- **Why** — the trade-off reasoning from the grill, preferring the human's own disambiguating words where they settled it.
- **Rejected** — the alternatives considered and why each loses. This negative knowledge is what stops an implementer from "simplifying" the design back into a shape the grill already weighed and rejected.
- **Evidence** — the verification anchor: link plus status/date for external facts, file:line for codebase facts, spike/finding reference, or the `UNVERIFIED:` tag from step 3. A decision without an anchor is an assertion.
- **Consequences** — what this binds for implementers: constraints it imposes, moves it forbids, ordering it requires.

Decisions whose rationale is "obvious" to you are exactly the ones a colder implementer gets wrong — record them anyway.

**B. Module contracts.** For each module built or modified, record:

- **Interface** — the signature (`Render(CR, resolvedSecrets) → DesiredState{...}` style), plus a **pure/impure** flag.
- **Contract** — one line each of **precondition** (what the caller must guarantee), **postcondition** (what the module guarantees), **invariant** (what stays true across all calls). If a module genuinely has no invariant, write `invariant: none` — an explicit empty, never a missing field.
- **Data model** — the schemas, field shapes, env keys, and naming conventions this module owns.

Contracts are written at the level the grill settled: interfaces, semantics, ordering. Internals stay free. Codebase anchors (file:line) are allowed **only** dated — `verified YYYY-MM-DD, re-verify` — because locations drift while contracts don't; instruct readers to trust the contract over the location.

The published spec issue is **also the live coordination home and working ledger** for the initiative — the single object that answers "where is this initiative as a whole, and where do executing agents record what they produce." Once the spec is approved, append these sections to its issue body:

- **Child checklist** — a placeholder section (populated in step 5 once tickets are published) using the tracker's native task-list syntax. HITL (`ready-for-human`) flags are added by the triage step (step 6), not here.
- **Handoffs** — a table with one row per *cross-slice* value that one slice produces and a sibling slice consumes (e.g. an export timestamp a downstream consumer must start from, baseline counts a validation slice checks against, root-caused rejects a loader must handle). Leave the values **blank**; the executing agents fill each in as its slice completes. This is what stops per-run state from stranding in ad-hoc files or dying in a closed child ticket.

Record the spec issue's URL/ID — you will pass it to `/to-tickets` in the next step.

### 5. Break into tickets and establish blocking edges

Invoke `/to-tickets` to break the approved spec into tracer-bullet vertical-slice tickets on the project issue tracker. Quiz the human on granularity and dependencies until they approve the breakdown, then publish the tickets in dependency order using the tracker's native **blocking-edges** mechanism — each ticket declares the tickets that block it. Do not classify HITL vs AFK in this step — that decision belongs to triage (step 6). Do not use parent-child linking; the spec issue's child checklist is the flat index, and the epic issue (if this session was launched from a decomposition) carries the higher-level slice structure.

**Tickets must stand alone.** An implementing agent will often read only its ticket, skimming or skipping the spec. Beyond the `/to-tickets` template sections (Parent / What to build / Acceptance criteria / Blocked by), every ticket carries one mandatory section, **`## Design contract (slice of #N)`** — the how, **lifted verbatim** from the spec's decision log and module contracts (quote, never re-summarize; re-summarizing is where rationale gets lost), sliced to what this ticket touches. Six fixed sub-fields:

- **Modules & contracts** — this slice's rows from the spec's module contracts: interface signature, pure/impure flag, and the pre/post/invariant one-liners.
- **Data model** — the schemas, env shapes, and naming this slice owns.
- **Context you cannot infer from the repo** — the slice-relevant verified facts and spike findings, each with its evidence anchor (dated: `verified YYYY-MM-DD, re-verify`).
- **Rejected (settled)** — one line per forbidden move that intersects this slice's solution space, with its why, drawn from the decision log's *Rejected* fields. If the grill rejected nothing touching this slice, say so in one line rather than omitting the sub-field — that too is information.
- **Validation scenarios** — quickstart-style: the concrete sequence that proves this slice works end-to-end (the human-runnable version of the acceptance criteria).
- **Trace** — one line: which user stories this slice covers, which decision-log records constrain it, which handoff IDs it fills.

A complete worked example lives in [`ticket-contract-example.md`](ticket-contract-example.md) beside this skill — read it when writing your first ticket of a session and match its shape.

**Cold-start gate — run on every ticket before publishing.** Verify, and fix failures by editing the ticket (never by assuming the implementer will ask):

1. Every imperative in *What to build* traces to a contract row or a validation scenario in the ticket's *Design contract*.
2. Every *Rejected (settled)* line from the decision log that intersects this slice is present.
3. Every load-bearing external fact carries a dated evidence anchor or an `UNVERIFIED:` tag.
4. Every pointer the ticket relies on (spec issue ID, handoff IDs, linked tickets, decision numbers) resolves to something that exists.

After all tickets are published, update the spec issue's child checklist section with links to every ticket in dependency order — without HITL flags; triage adds them next.

### 6. Triage tickets

Invoke `/triage` for each published ticket. For each one: recommend a category (`bug` / `enhancement`) and state (`ready-for-agent` / `ready-for-human` / `needs-info`), post an agent brief if moving to `ready-for-agent`. This is where HITL vs AFK classification happens — `ready-for-human` is HITL, `ready-for-agent` is AFK. Each brief **must name the spec issue and point writers at its Handoffs section**, so executing agents know where to record what they find. The brief adds **execution logistics only** — access pre-flight results, worktree rules, which handoff IDs this ticket fills — building on the ticket's own Design contract, never re-deriving, compressing, or contradicting the design reasoning. Work through all tickets, then flag the `ready-for-human` tickets in the spec issue's child checklist.

### 7. Docs PR

Raise a PR for any ADR and docs changes (CONTEXT.md, ADRs, or other documentation) crystallised during the grilling session — in the `domain-modeling` skill's formats, per step 3. Create a worktree, commit the changed docs files, open the PR, and report the PR URL.

## Notes

- Do NOT execute any implementation — that is dispatched separately from the main session as a Workflow A background agent after this design session completes.
- The INITIATIVE route (step 2) halts the session after the epics are published. Implementation still flows through child sessions — never resume a halted parent session to design epic internals.
- TASK sessions skip the tracker machinery by design: the grilled conversation is the spec, handed to a single Workflow A implementer — and the handoff principle still applies: the dispatch brief carries the decision log and module contracts, not just the sharpened scope.
- The audience of every published artifact is a colder, less-contextual agent than the one designing. Structure and templates are the skeleton; the reasoning is the payload. A ticket that only carries conclusions has failed its reader even when every box is ticked.
