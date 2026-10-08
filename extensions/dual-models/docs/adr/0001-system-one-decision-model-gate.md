# ADR-0001: Route serving roles through a System One decision model, not a chat-LLM classifier

**Status:** Accepted **Date:** 2026-10-08

## Decision

The Dual Models extension picks the serving role (Deliberation Model or Execution Model)
for each request by asking a purpose-built **decision model** one mode-agnostic Gate
question over the OpenRouter System One API (`POST /api/v1/systemone`, request
`{model, state, questions}`, typed `choice` answer with probabilities). The model id is
configurable; the default is `typesafe/jev-1.13`. The Gate runs on every new prompt and
every `turn_end`, inside a Pi Virtual Model `route()`. Code serves the role System-1
prefers (argmax of the two probabilities; a tie goes to the high-reasoning role) and adds no
threshold of its own. Role preference is tuned only through the per-role `criteria` text
sent with the Gate question, and the question stays mode-agnostic.

Decision models return typed probabilities and no generated text, so the per-turn check is
fast (p50 ≈ 174 ms for Jev via OpenRouter, 2026-10-08), output is free, and routing is
tuned from logged probabilities instead of parsing prose.

## Considered Options

**Small chat LLM as classifier** (e.g. llama-3.1-8b on Groq, gpt-oss-120b on Cerebras,
≈ 0.24–0.31 s estimated for 4k in / 50 out). Rejected: output must be parsed from text,
reasoning models emit hidden thinking tokens, and there is no calibrated probability to
choose a role by.

**Workhorse self-reports via an `escalate` tool.** Rejected: the serving model does not
know it is being routed, and it cannot detect being lost from inside the loop.

**Fork an existing Pi router package** (`@yeliu84/pi-model-router` and forks).
Rejected: they route by tier heuristics or LLM prompt classification, not a decision
model.

**Hysteresis threshold (`θ_switch`) on the other role's probability.** Rejected: it
overrode System-1's preferred role, e.g. staying in Deliberation when Execution scored
0.6 (#75). A static count over the live escalations
(`docs/experiments/0001-live-experiment-findings.md`) shows θ 0.80 would have suppressed
4 of 7 escalations that System-1 chose. An offline replay of 3 live sessions gave 6
switches per session for θ 0.60–0.90, but the replay is path-dependent and low-n, so it
is weaker evidence than the static count and is not the basis for rejection. Do not
reintroduce. Switch churn stays observable via `switched=true` on `dual_models.gate`
spans.

**Per-role or asymmetric switch thresholds** (#73). Rejected in favour of per-role
`criteria` text (#75): one tuning knob, applied where System-1 forms its preference.

## Consequences

- System-1 is a third party on the hot path; on timeout or error the request falls back to
  the configured `defaultRole`, and the extension disables itself for the session after
  repeated failures.
- System prompt and tool list must be byte-identical across both roles, or every switch
  back loses the returning role's cached prefix.
- Solar Decide and the System One schema are beta upstream; the schema may change before
  GA.

## Amendments

_Pointers only; the current decision is above. Full rationale in temporal memory (ADR scope);
fallback `git log -p` on this file._

| Date | PR | Change |
|---|---|---|
| 2026-10-08 | #79 | `θ_switch` hysteresis dropped (#75); Gate takes argmax, preference tuned via per-role `criteria`. |
