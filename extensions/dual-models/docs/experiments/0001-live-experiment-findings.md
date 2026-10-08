# Live experiment findings (#64)

Run 2026-10-08. Script: `run-experiment.ts` (`node docs/experiments/run-experiment.ts [latency] [cache] [live]`). Raw output: `results-*.json`.

Setup: `pi --mode rpc` with the extension, Execution `tailnet/@preset/glm-flash`, Deliberation `tailnet/@preset/glm-max`, System-1 `typesafe/jev-1.13` via OpenRouter (real key from the environment, never logged). `dual_models.gate` spans went to a **local OTLP/HTTP receiver** inside the script, not SigNoz: the throwaway agent dir does not load pi-otel, so the `pi.assistant.message` log is unavailable. Cache reuse is read from the same source value, the assistant message `usage.cacheRead`, as reported over RPC.

## 1. System-1 latency (client to OpenRouter, n=30 each, sequential, warm connection)

| Digest | p50 | p90 | max | over 1500 ms |
|---|---|---|---|---|
| ~11 tokens | 490 ms | 553 ms | 629 ms | 0 |
| ~4000 tokens (16k chars) | **509 ms** | 603 ms | 718 ms | 0 |

- A 4k Digest adds about 20 ms at p50. The ~570 ms from the earlier probes was network noise, not Digest size.
- Live `dual_models.gate` span durations: see section 3.

## 2. Cache reuse on return to a role

Scripted System-1 forced flash, max, flash, max, flash on a ~16.5k-token first prompt. Re-run twice with a per-run nonce at the start of the padding (`results-cache-run1.json`, `-run2.json`), after the first un-nonced run was found confounded by earlier runs sharing the same prompt.

| Turn | Served by | run 1 cacheRead | run 2 cacheRead |
|---|---|---|---|
| 1 | flash | 0 | 0 |
| 2 | max (first visit) | 7552 | 7552 |
| 3 | flash (return) | **0** | **0** |
| 4 | max (return) | **16576** | **16576** |
| 5 | flash (return) | **0** | **16576** |

- **max: hit on return** (2 of 2), about the whole prefix.
- **flash: mixed** (1 hit of 4 returns across the two runs). The un-nonced run had hit on flash returns, so flash hits depend on something other than role switching (possibly cache fill lag or provider-side routing of the preset); not diagnosed.
- First visit to max read 7552 tokens even with the nonce. 9064 uncached + 7552 cached equals the full prompt, so the 7552 is the static prefix (system prompt and tool definitions, identical across runs), cached provider-side from earlier runs. It is not conversation reuse. This differs from the #58 baseline (0 on the first request after a switch), which probably saw no warm static prefix.
- The 8640 baseline is not reproduced for flash returns; max returns exceed it.
- Live sessions (section 3): turns after a switch mostly show cacheRead of 7.5k to 9.3k, but some turns read 0 (run 2 one max turn, run 3 four flash turns). Cache reuse is real but unreliable on these presets.

## 3. Live Gate (3 live sessions, each 8 prompts: trivial, ambiguous, mid-loop escalation)

Sessions are in `results-live-run{1,2,3}.json`; `python3 docs/experiments/analyze.py` prints the summary.

- 37 Gate calls (13, 12, 12 spans), 0 fallbacks, 0 errors, all `service.name=pi`. Span durations: p50 541 to 560 ms, max 846 to 1084 ms. Run 2 had 13 turns but 12 spans (one turn probably a retry, which does not call System-1); not investigated.
- 6 to 7 switches per session.
- Prompt-event probabilities were bimodal: switches at 0.94 or above, stays at 0.24 or below.
- Mid-range values appear only at turn_end. Other-role probability on the escalations that fired: 0.76, 0.77, 0.79, 0.79, 0.80, 0.83, 0.87. Counted statically, theta 0.80 would have suppressed 4 of those 7 and 0.90 all 7; 0.75 keeps all. One turn_end value of 0.69 correctly stayed.
- An offline replay of the hysteresis over each session (`analyze.py`) gives 6 switches per session for theta 0.60 to 0.90 and 4 to 6 at 0.95; it is path-dependent (later digests would differ) so the static count above is the more reliable figure.

## Coverage and limits

- **Sessions:** 3 live sessions, 37 Gate calls, one scripted scenario set, one repository fixture. Small n; no real-world long sessions.
- **Providers:** only `tailnet` presets (glm-flash, glm-max) measured. No Kimi or zai runs, so cache behaviour on those providers is untested.
- **No long Deliberation stretch:** the longest run on one role was a few turns. TTL expiry and long-stretch cache behaviour were not exercised.
- pi-otel was not loaded, so `pi.assistant.message` in SigNoz was not used.

## Recommendation

- **thetaSwitch: keep 0.75.** Prompt-level decisions are insensitive from 0.55 to 0.9. Mid-loop escalations are the threshold-sensitive case, ranging 0.76 to 0.87 across 3 sessions, so anything above 0.75 starts suppressing them. Low-n evidence; revisit with real sessions.
- **timeoutMs: keep 1500.** Worst Gate call 1084 ms live and 718 ms at 4k Digest.
- No defaults change, so no follow-up ticket for defaults. Follow-up worth filing only if flash cache misses on return matter for cost.

## Nits from earlier reviews

- Span shows under `service.name=pi`: confirmed. Global provider registration conflict with another extension: not exercised (pi-otel not loaded).
- pi-otel virtual vs physical model in `gen_ai.request.model`: **not confirmed live**, because pi-otel was not loaded. Physical model is visible in the assistant message `model` over RPC.
- Identical deliberation and execution models and a previous model outside both roles: not exercised.
- Per-turn System-1 load: about 12 to 13 Gate calls per 8 prompts, roughly 5 of them turn_end. At about 0.5 s each, a tool-heavy turn adds 0.5 s per round trip.
