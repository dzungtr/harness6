# Dual Models (Pi extension)

A Pi extension that autonomously picks which model serves each request in a
live Pi session, using a fast decision model to move work between a
high-reasoning model and a cheaper workhorse model.

## Language

### Roles

**Deliberation Model**:
The high-reasoning model that serves Deliberation. One of exactly two serving roles.
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

**Deliberation**:
A stretch of requests served by the high-reasoning model to clarify intent,
enrich the prompt, and set a course of action.
_Avoid_: planning mode, thinking turn

**Execution**:
A stretch of requests served by the workhorse model to carry out the course
of action set in Deliberation.
_Avoid_: workhorse turn, doing phase

**Escalation**:
A switch from Execution back to Deliberation, mid agent loop, because
something has gone outside the course of action.
_Avoid_: fallback, upgrade

**Gate**:
The single, mode-agnostic question System-1 answers at every check: which
serving role should take the next request. The same Gate is asked on a new
prompt and at every turn end, whatever role served the previous turn.
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
