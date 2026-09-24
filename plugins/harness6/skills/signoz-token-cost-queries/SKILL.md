---
name: signoz-token-cost-queries
description: Use when asked about LLM gateway token usage or cost — "how many tokens", "what's this costing", "cost breakdown by model" — investigated from SigNoz via the cc-observability MCP server. Agent-agnostic: discover the telemetry schema first, then investigate.
---

# SigNoz Token/Cost Queries

## Overview

LLM token usage and cost data usually lands as **span attributes on trace
data** from an LLM gateway (e.g. a LiteLLM proxy emitting `gen_ai.*`
attributes), not as a Prometheus-style metric — use the traces tools
(`signoz_aggregate_traces`), not `signoz_query_metrics`, unless discovery
proves otherwise.

This skill is **agent agnostic**: it does not hardcode gateway service names
or attribute names. Gateway exports and attribute sets change over time (the
`gen_ai.cost.*` native-cost attributes and the `litellm` service have
previously existed and later disappeared from live data). Follow the
**discover → query → cache** loop.

## Step 0: read cached knowledge from agentic memory first

```
agentic-memory_search_memory_facts(query="SigNoz gateway token cost schema", group_ids=["global"])
```

If memory names the gateway service, its token/cost attributes, and a
verification date, spot-check with one cheap 1h count on
`service.name = '<gateway-service>'`. Zero rows ⇒ treat memory as stale and
discover fresh.

## Step 1: discover the telemetry structure

1. **Is any gateway service reporting?** — `signoz_list_services` over `7d`.
   Note: it under-reports (only surfaces top-level/root spans and can miss a
   gateway service even when `aggregate_traces` finds data for the same
   filter), so confirm any "no data" verdict with a direct
   `signoz_aggregate_traces` count on `service.name = '<candidate>'` before
   believing it.
2. **Which token/cost attributes exist?** —
   `signoz_get_field_keys(signal="traces", fieldContext="attribute",
   searchText="gen_ai")` (or `"token"` / `"cost"` for non-OTel-convention
   exporters). Record each hit's `fieldDataType`. **Never aggregate on an
   attribute not confirmed here** — unknown keys hard-error.
3. **Check for cost attributes specifically** — search for `"cost"`. If
   dollar-cost attributes do not exist, say so: **do not derive dollars by
   multiplying tokens by a guessed price**. Report usage, and route "what did
   it cost" questions to the provider's billing surface instead.

## Step 2: query by goal

With discovered names plugged in:

| Question | Aggregation |
|---|---|
| Total token usage | `sum` on the total/input/output token attribute, filter `service.name = '<gateway-service>'` |
| Input/output/cache breakdown | swap `aggregateOn` per discovered attribute (only if the attribute exists) |
| Per-model split | `groupBy` the model attribute (e.g. `gen_ai.request.model` when present), `orderBy: "count() desc"` |
| Cost | `sum` on the cost attribute — **only if discovery found one** |

Rules:

- **`filter` is a query-builder expression string** (`"service.name =
  'litellm'"`), not a bare object like `{"service": "litellm"}` — the latter
  silently returns `rowsScanned: 0` instead of erroring.
- The gateway route can **silently drop spans**: a request may succeed at the
  caller while producing zero gateway spans (observed historically with a
  LiteLLM-internal pydantic validation error). If a known request has no
  spans, verify whether gateway export is currently broken before concluding
  "no usage happened". For agent-side usage numbers, use
  `skills/signoz-self-improvement-queries` (token attributes on the agent
  service) — it is independent of gateway export health.

## Step 3: cache verified findings to agentic memory

Persist **structural facts only** (gateway service name, attribute names with
`fieldContext`/`fieldDataType`, existence of cost attributes, gotchas,
verification date) back to `group_id="global"` via `agentic-memory_add_memory`.
Never cache result numbers or dollar amounts.

## Common Mistakes

- **Hardcoding `litellm` or `gen_ai.cost.*`.** The gateway service may not be
  exporting at all, and cost attributes have existed and later disappeared.
  Discovery in-session (or a memory spot-check) is mandatory.
- **Trusting `signoz_list_services` for absence** — it under-reports; confirm
  with a direct aggregate count.
- **Deriving cost from tokens × price.** If no cost attribute exists, don't
  fabricate one.
- **`filter` must be a query-builder expression string**, not a bare object.
- **`cc-observability` needs a one-time human approval** before any session —
  including a headless/background agent — can use its tools. If the MCP
  server shows as pending approval, stop and surface it to the user. Do not
  attempt to self-approve or register a workaround — that defeats the
  control's purpose.