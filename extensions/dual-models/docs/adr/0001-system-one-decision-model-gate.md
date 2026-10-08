# ADR-0001: Route serving roles through a System One decision model, not a chat-LLM classifier

**Status:** Accepted **Date:** 2026-10-08

## Decision

The Dual Models extension picks the serving role (Deliberation Model or Execution Model)
for each request by asking a purpose-built **decision model** one mode-agnostic Gate
question over the OpenRouter System One API (`POST /api/v1/systemone`, request
`{model, state, questions}`, typed `choice` answer with probabilities). The model id is
configurable; the default is `typesafe/jev-1.13`. The Gate runs on every new prompt and
every `turn_end`, inside a Pi Virtual Model `route()`; code switches roles only when the
other role's probability reaches a configurable `θ_switch` (> 0.5), so the cost of a
prompt-cache miss is priced into every switch without making the Gate question
role-aware.

Decision models return typed probabilities and no generated text, so the per-turn check is
fast (p50 ≈ 174 ms for Jev via OpenRouter, 2026-10-08), output is free, and a threshold
can be tuned from logged decisions instead of parsing prose.

## Considered Options

**Small chat LLM as classifier** (e.g. llama-3.1-8b on Groq, gpt-oss-120b on Cerebras,
≈ 0.24–0.31 s estimated for 4k in / 50 out). Rejected: output must be parsed from text,
reasoning models emit hidden thinking tokens, and there is no calibrated probability to
threshold for hysteresis.

**Workhorse self-reports via an `escalate` tool.** Rejected: the serving model does not
know it is being routed, and it cannot detect being lost from inside the loop.

**Fork an existing Pi router package** (`@yeliu84/pi-model-router` and forks).
Rejected: they route by tier heuristics or LLM prompt classification, not a decision
model.

## Consequences

- System-1 is a third party on the hot path; on timeout or error the request falls back to
  the configured `defaultRole`, and the extension disables itself for the session after
  repeated failures.
- System prompt and tool list must be byte-identical across both roles, or every switch
  back loses the returning role's cached prefix.
- Solar Decide and the System One schema are beta upstream; the schema may change before
  GA.
