# Live experiment findings (#64)

Run 2026-10-08. Script: `run-experiment.ts` (`node docs/experiments/run-experiment.ts [latency] [cache] [live]`). Raw output: `results-*.json`.

Setup: `pi --mode rpc` with the extension, Execution `tailnet/@preset/glm-flash`, Deliberation `tailnet/@preset/glm-max`, System-1 `typesafe/jev-1.13` via OpenRouter (real key from the environment, never logged). `dual_models.gate` spans went to a **local OTLP/HTTP receiver** inside the script, not SigNoz: the throwaway agent dir does not load pi-otel, so the `pi.assistant.message` log is unavailable. Cache reuse is read from the same source value, the assistant message `usage.cacheRead`, as reported over RPC.

## 1. System-1 latency (client to OpenRouter, n=30 each, sequential, warm connection)

| Digest | p50 | p90 | max | over 1500 ms |
|---|---|---|---|---|
| ~11 tokens | 490 ms | 553 ms | 629 ms | 0 |
| ~4000 tokens (16k chars) | **509 ms** | 603 ms | 718 ms | 0 |

- A 4k Digest adds about 20 ms at p50. The ~570 ms from the earlier probes was network noise, not Digest size.
- Live `dual_models.gate` span durations (n=13): min 459, p50 541, max 846 ms (the first call, a cold connection).

## 2. Cache reuse on return to a role

Scripted System-1 forced flash, max, flash, max, flash on a 16.5k-token first prompt (same shape as `npm run test:e2e`).

| Turn | Served by | input | cacheRead |
|---|---|---|---|
| 1 | flash | 16565 | 0 |
| 2 | max | 9036 | 7552 |
| 3 | flash (return) | 77 | **16512** |
| 4 | max (return) | 36 | **16576** |
| 5 | flash (return) | 37 | **16576** |

- **Hit for both roles.** A returning role reads essentially its whole earlier prefix, against the #58 baseline of 8640 tokens.
- Turn 2 read 7552 tokens on its first visit to max. That is a provider-side cache seeded by an earlier run with the identical prefix, so treat it as a lower-confidence data point. Turns 3 to 5 are the clean evidence.
- In the live session the same pattern holds: every turn after the first reads 7.4k to 9.3k cached tokens regardless of which role serves it, including turns right after a switch.

## 3. Live Gate (8 prompts: trivial, ambiguous, mid-loop escalation; 13 Gate calls)

- Spans carried `service.name=pi`, all attributes present, 0 fallbacks, 0 errors. All 13 spans arrived (8 prompt + 5 turn_end, one per tool round trip), so no loss at exit with an 8 s wait.
- 6 of 13 Gate calls switched role (2 at turn_end).
- Observed probabilities on the other role were bimodal: prompt-event switches were all at 0.94 or above, stays at 0.24 or below. The only mid-range values were two turn_end escalations: **0.76** and **0.80**.
- Offline sweep of the hysteresis over the recorded probabilities (counterfactual: later digests would differ in a real run):

| theta_switch | switches | turn_end switches |
|---|---|---|
| 0.55 to 0.75 | 6 | 2 |
| 0.80 | 6 | 1 |
| 0.85, 0.90 | 6 | 1 |
| 0.95 | 4 | 0 |
| 0.99 | 3 | 0 |

## Recommendation

- **thetaSwitch: keep 0.75.** Prompt-level decisions are insensitive from 0.55 to 0.9. Only the mid-loop escalation (0.76) is threshold-sensitive, and the escalation scenario is the one the hysteresis must not suppress. Evidence is n=13 on one session, so revisit with more mid-loop data.
- **timeoutMs: keep 1500.** Worst observed call was 846 ms live and 718 ms with a 4k Digest, so 1500 has about 2x headroom.
- No defaults change, so no follow-up ticket for defaults.

## Nits from earlier reviews

- Span shows under `service.name=pi`: confirmed. Global provider registration conflict with another extension: not exercised (pi-otel not loaded).
- pi-otel virtual vs physical model in `gen_ai.request.model`: **not confirmed live**, because pi-otel was not loaded. Physical model is visible in the assistant message `model` over RPC.
- Identical deliberation and execution models and a previous model outside both roles: not exercised.
- Per-turn System-1 load: 13 calls for 8 prompts, 5 of them turn_end. At about 0.5 s each, a tool-heavy turn adds 0.5 s per round trip.
