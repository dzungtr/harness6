---
name: harness6-signoz-self-improvement-queries
description: Use when conversations involve self-improvement topics — permission friction, slow tool responses, high token usage, cache efficiency, recurring workflow patterns, or session cadence — investigated from SigNoz via the cc-observability MCP server. Agent-agnostic: discover the telemetry schema first, then investigate.
---

# SigNoz Self-Improvement Queries

## Overview

This skill answers self-improvement questions ("why am I getting permission
prompts?", "why is it slow?", "how much am I spending in tokens?") from the
SigNoz instance backed by the `cc-observability` MCP server. It is **agent
agnostic**: it does NOT hardcode agent service names, span names, or
attribute names. Different agents emit different telemetry shapes (an
OpenTelemetry-instrumented CLI agent, a gateway like LiteLLM, etc.), and the
schema drifts over time.

Instead, follow the **discover → query → cache** loop:

1. **Discover** the actual telemetry structure with schema tools.
2. **Query** with the discovered names.
3. **Cache** verified structural findings in agentic memory so future
   sessions skip the discovery phase (lower token consumption).

## Step 0: read cached knowledge from agentic memory first

Before any discovery call, search the shared memory graph for previously
verified schema facts:

```
agentic-memory_search_memory_facts(query="SigNoz traces schema <topic>", group_ids=["global"])
```

If the memory already names the service, span names, and attributes relevant
to the question (with a verification date), **spot-check one cheap call**
(e.g. a 1h-window count on the named span) to confirm it still resolves, then
go straight to Step 2. If the spot-check 404s or returns zero rows, treat the
memory as stale and fall through to Step 1.

Use group_id `global` for all reads and writes here — this knowledge is
project- and agent-independent.

## Step 1: discover the telemetry structure

Run these in order; stop once you have what the question needs.

1. **Which agents report data?** — `signoz_list_services` over a wide window
   (e.g. `timeRange: "7d"`). Look for the agent runtime service, plus any
   gateway service (e.g. `litellm`) that carries cost attributes.
2. **What spans does the agent emit?** —
   `signoz_get_service_top_operations(service=<agent-service>,
   timeRange="7d")` lists span names with call counts and latency. This
   answers "is there a permission-gate span? a tool-execution span?" without
   guessing names.
3. **Which attributes exist?** — `signoz_get_field_keys(signal="traces", ...)`
   with targeted `searchText` probes per topic: `"tool"`, `"token"`,
   `"cache"`, `"decision"`, `"session"`, `"model"`. Record the exact
   `fieldContext` (attribute vs resource vs span) and `fieldDataType` of each
   hit. **Do not filter or aggregate on an attribute you have not confirmed
   here** — unknown keys hard-error.
4. **What values does a key attribute take?** —
   `signoz_get_field_values(signal="traces", name=<attr>)` for enumerations
   (e.g. tool names, gate decisions) before grouping by it.

## Step 2: query by goal — map the question to spans

With the schema in hand, translate each self-improvement question into an
aggregation over the **discovered** span names. The mapping below is the
stable *intent → span kind* shape; plug in the discovered concrete names:

| Question | Intent | Aggregation |
|---|---|---|
| Permission friction | permission-gate / denial spans (or errored tool executions if no gate span exists) | `count` grouped by decision attribute, ratio vs total tool-call spans |
| Slow tool responses | tool-call wrapper vs actual execution spans | `p90` on `duration_nano`, grouped by span name |
| Token usage & cache efficiency | LLM-request spans, agent side | `sum`/`avg` on cache-read / cache-creation / input / output token attributes |
| Recurring workflow patterns | tool-call spans | `count` grouped by tool-name attribute, ordered by frequency |
| Session cadence | session/session-id attribute | `count_distinct` on the session attribute; `requestType: "time_series"` + `stepInterval: 86400` for per-day trend |

Rules that apply to every query:

- **`filter` is a query-builder expression string** (e.g.
  `"service.name = '<agent-service>' AND name = '<span-name>'"`), never a
  bare object.
- **`duration_nano` is nanoseconds** — divide by `1e9` for seconds.
- **Agent-side vs gateway-side:** token attributes on the agent service
  answer "what did the agent consume"; `gen_ai.usage.*` / `gen_ai.cost.*` on
  the gateway service answer "what did it cost". Same questions, different
  services — pick per the user's phrasing and the discovered services. When
  cost dollars are wanted, prefer `skills/signoz-token-cost-queries`.
- **Per-session drill-downs** ("what happened in session X") are a different
  job — use `skills/signoz-session-lookback-queries`.

## Step 3: cache verified findings to agentic memory

After a successful investigation — or whenever discovery revealed schema
facts not yet in memory — persist them so the next session saves the
discovery tokens. Write **structural facts only** (names, contexts, types,
existence), never query results that age:

```
agentic-memory_add_memory(
  name="SigNoz traces schema — <agent-service>",
  episode_body="...service name; span names and what each covers; attribute
    names with fieldContext/fieldDataType; confirmed gaps (attrs that do NOT
    exist); filter syntax gotchas; verified YYYY-MM-DD ...",
  group_id="global",
  source="text",
  source_description="SigNoz schema discovery via cc-observability"
)
```

Keep the write compact — one episode per service, updated by adding a fresh
episode when the schema drifts (add a new one rather than silently
overwriting; staleness is detected by the Step 0 spot-check).

## Common Mistakes

- **Hardcoding service/span/attribute names.** Agents rename and re-scope
  instrumentation. Any name not confirmed by `signoz_get_field_keys` /
  `signoz_get_service_top_operations` in this session (or spot-checked from
  memory this session) must not be used.
- **Skipping the Step 0 memory read** and re-running full discovery every
  session — wasteful and the main reason this skill's token cost grows.
- **Confusing duration units** (`duration_nano` → seconds requires ÷1e9).
- **Grouping by an attribute that doesn't exist on the target span kind** —
  e.g. gate spans may carry a decision attribute but not a tool-name
  attribute; verify attribute-per-span rather than assuming coverage.
- **Caching result numbers** ("5957 gate hits") to memory. Numbers rot within
  days; only cache schema structure and syntax facts.
- **`cc-observability` needs a one-time human approval** before any session —
  including a headless/background agent — can use its tools. If the server is
  pending approval, stop and surface it to the user. Do not attempt to
  self-approve or register a workaround — that defeats the control's purpose.