# Dual Models (Pi extension)

A Pi extension that autonomously picks which model serves each request in a
live Pi session, using a fast decision model to move work between a
high-reasoning model and a cheaper workhorse model.

## Language

### Roles

**Reasoning Model**:
The high-reasoning model that serves Reasoning. One of exactly two serving roles.
(formerly Deliberation Model)
_Avoid_: high tier, planner, big model

**Execution Model**:
The cheaper workhorse model that serves Execution. One of exactly two serving roles.
_Avoid_: low tier, worker, small model

**System-1**:
A purpose-built decision model (typed answers with probabilities, no
generated text) that judges, from a Digest, which serving role takes the
next request. It never does task work itself.
_Avoid_: router model, classifier, judge, small LLM

### Phases

**Reasoning**:
A stretch of requests served by the high-reasoning model to clarify intent,
enrich the prompt, and set a course of action.
(formerly Deliberation)
_Avoid_: planning mode, thinking turn

**Execution**:
A stretch of requests served by the workhorse model to carry out the course
of action set in Reasoning.
_Avoid_: workhorse turn, doing phase

**Escalation**:
A switch from Execution back to Reasoning, mid agent loop, because
something has gone outside the course of action.
_Avoid_: fallback, upgrade

**Gate**:
The single, mode-agnostic question System-1 answers at every check: which
serving role should take the next request. The same Gate is asked on a new
prompt and at every turn end, whatever role served the previous turn. The
Gate follows System-1's argmax (a tie goes to the Reasoning Model). Each
role's criteria text is configurable (`models.<role>.criteria`) and is the
only way to tune which role System-1 prefers.
_Avoid_: escalation check, mode question

### Artifacts

**Recap**:
The running, structured record of a session's intent, course of action, and
significant events, written through a tool during turns.
_Avoid_: plan, summary, notes

**Digest**:
The bounded input System-1 judges from: the current Recap plus the last
tool output, and on a new prompt the user's prompt (as `New prompt:`).
_Avoid_: context, transcript
