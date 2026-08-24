---
name: signoz-token-cost-queries
description: Use when asked about LLM gateway token usage or cost — "how many tokens", "what's this costing", "cost breakdown by model" — queried from SigNoz via the cc-observability MCP server.
---

# SigNoz Token/Cost Queries

## Overview

LiteLLM gateway `gen_ai.*` token and cost data lands as **span attributes** on
trace data (`serviceName = litellm`), not a Prometheus-style metric — use the
traces tools (`signoz_aggregate_traces`), not `signoz_query_metrics`. Cost is
present natively (`gen_ai.cost.total_cost` + breakdown attributes) — no
tokens×price derivation needed.

## Prerequisite: confirm attribute names

```json
{ "signal": "traces", "fieldContext": "attribute", "searchText": "gen_ai" }
```

via `signoz_get_field_keys` — confirms `gen_ai.usage.*` / `gen_ai.cost.*`
exist as `number`-typed attributes before you filter on them.

## Quick Reference

| Question | Tool | Key params |
|---|---|---|
| Token usage | `signoz_aggregate_traces` | `aggregation: sum`, `aggregateOn: gen_ai.usage.total_tokens`, `filter: "service.name = 'litellm'"` |
| Cost usage | same tool | `aggregateOn: gen_ai.cost.total_cost`, same filter |
| Input/output/cache breakdown | same tool | swap `aggregateOn` for `gen_ai.usage.input_tokens` / `_output_tokens` / `_cache_creation.input_tokens`, or `gen_ai.cost.input_cost` / `_output_cost` / `_cache_creation_cost` |
| Per-model split | same tool | add `groupBy: litellm.model_group` |

Verified against real ingested data (epic #84 slice #88, issue #99): a 30-day
`sum` over `service.name = 'litellm'` returned 46675 tokens / $0.0669.

## Common Mistakes

- **`filter` must be a query-builder expression string** (`"service.name =
  'litellm'"`), not a bare object like `{"service": "litellm"}` — the latter
  silently returns `rowsScanned: 0` instead of erroring.
- **`signoz_list_services` under-reports.** It only surfaces top-level/root
  spans and can miss `litellm` even when `aggregate_traces`/`search_traces`
  return thousands of scanned rows for that same filter. Don't use it to
  decide whether a service has data.
- **`cc-observability` needs a one-time human approval** before any
  session — including a headless/background agent — can use its tools.
  `claude mcp list` shows `⏸ Pending approval` until a human interactively
  approves it once; this is a deliberate Claude Code trust control, not a
  bug. If you hit this, stop and surface it to the user. Do not attempt to
  self-approve or register a workaround — that defeats the control's purpose.
