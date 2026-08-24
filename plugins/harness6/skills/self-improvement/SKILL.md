---
name: self-improvement
description: Use when conversations involve self-improvement topics — permission friction, slow tool responses, high token usage, cache efficiency, recurring workflow patterns, or session cadence — queried from SigNoz via the cc-observability MCP server.
---

# SigNoz Self-Improvement Queries

## Overview

Claude Code emits every turn as `service.name = 'claude-code'` trace spans —
five span names cover the whole self-improvement surface: `claude_code.interaction`
(one user→Claude turn), `claude_code.llm_request` (one LLM API call),
`claude_code.tool` (tool invocation wrapper), `claude_code.tool.execution`
(actual tool execution), and `claude_code.tool.blocked_on_user` (permission
gate — shown to the user or auto-approved). All five recipes below use
`signoz_aggregate_traces` against this one service; no metrics or logs signal
is needed.

## Prerequisite: confirm attribute names

```json
{ "signal": "traces", "fieldContext": "attribute", "searchText": "tool" }
{ "signal": "traces", "fieldContext": "attribute", "searchText": "token" }
```

via `signoz_get_field_keys` — confirms `tool_name` / `decision` (string) and
`cache_read_tokens` / `cache_creation_tokens` / `input_tokens` / `output_tokens`
(number) exist as attributes before filtering or aggregating on them.

## Recipe 1: permission friction — "keep getting permission prompts for X"

Count of `claude_code.tool.blocked_on_user` spans, optionally broken down by
`decision` (`accept` / `reject` / `unknown`):

```json
{
  "aggregation": "count",
  "groupBy": "decision",
  "filter": "service.name = 'claude-code' AND name = 'claude_code.tool.blocked_on_user'",
  "timeRange": "7d"
}
```

**Verified result** (2026-07-21, 7d window): 5957 `accept` / 1664 `unknown` /
57 `reject` — 7678 total gate hits against 31k total spans scanned.

Compare that total against a plain count of `claude_code.tool` spans in the
same window to get a friction ratio (gate hits ÷ total tool calls).

## Recipe 2: slow tool responses — "sessions feel slow"

p50/p90 latency by span name, one call:

```json
{
  "aggregation": "p90",
  "aggregateOn": "duration_nano",
  "groupBy": "name",
  "filter": "service.name = 'claude-code'",
  "timeRange": "7d"
}
```

**Verified result** (2026-07-21, 7d window, p90 in seconds): `claude_code.interaction`
337.5s, `claude_code.llm_request` 20.5s, `claude_code.tool` 9.3s,
`claude_code.tool.execution` 3.8s, `claude_code.tool.blocked_on_user` 3.2s.
`duration_nano` is nanoseconds — divide by 1e9. The gap between
`claude_code.tool` and `claude_code.tool.execution` is time spent waiting on
the permission gate, same read as the old Langfuse recipe.

## Recipe 3: token usage & cache efficiency

Sum (or avg) over `claude_code.llm_request` spans:

```json
{
  "aggregation": "sum",
  "aggregateOn": "cache_read_tokens",
  "filter": "service.name = 'claude-code' AND name = 'claude_code.llm_request'",
  "timeRange": "7d"
}
```

Swap `aggregateOn` for `cache_creation_tokens`, `input_tokens`, or
`output_tokens` for the other breakdowns. **Verified result** (2026-07-21, 7d
window): `sum(cache_read_tokens)` = 1,022,615,679.

This is the **Claude Code side** of token accounting (per-turn, from the
agent's own perspective) — distinct from `skills/signoz-token-cost-queries`,
which reads `gen_ai.usage.*` / `gen_ai.cost.*` off the **LiteLLM gateway
side** (`service.name = 'litellm'`, per-request, with dollar cost attached).
Use this recipe for "how much is Claude Code itself using/caching"; use the
token-cost skill for "what is this costing".

## Recipe 4: recurring workflow patterns — "understand tool usage"

Count grouped by tool, ordered by frequency:

```json
{
  "aggregation": "count",
  "groupBy": "tool_name",
  "filter": "service.name = 'claude-code' AND name = 'claude_code.tool'",
  "timeRange": "7d"
}
```

**Verified result** (2026-07-21, 7d window, top 5): `Bash` 4953, `Read` 841,
`Edit` 414, `ToolSearch` 221, `Write` 196.

## Recipe 5: session cadence — "how active have my sessions been?"

Distinct session count over a window:

```json
{
  "aggregation": "count_distinct",
  "aggregateOn": "session.id",
  "filter": "service.name = 'claude-code'",
  "timeRange": "7d"
}
```

**Verified result** (2026-07-21, 7d window): 102 distinct sessions. Set
`requestType: "time_series"` with `stepInterval: 86400` on the same query for
a per-day trend instead of a single total (verified: returned one distinct
count per day over the window). To drill into one specific session's full
span list, use `skills/signoz-session-lookback-queries` instead — this
recipe only answers "how many/how often", not "what happened in session X".

## Common Mistakes

- **`tool_name` is null on `blocked_on_user` spans.** Confirmed live: adding
  `AND tool_name EXISTS` to the Recipe 1 filter returns zero rows. The
  permission gate span carries `decision` but not which tool triggered it —
  there's no attribute-level join available through these tools to recover
  per-tool gate-hit counts; `decision`-only breakdown is what's available.
- **`duration_nano` is nanoseconds, not milliseconds.** Divide by `1e9` for
  seconds (or `1e6` for ms) when reading latency aggregations.
- **`filter` must be a query-builder expression string**, not a bare object —
  same gotcha as `skills/signoz-token-cost-queries` and
  `skills/signoz-session-lookback-queries`.
- **Don't confuse Claude-Code-side token attributes with LiteLLM-side
  `gen_ai.*` attributes** — they're on different services (`claude-code` vs
  `litellm`) and answer different questions (agent-perspective usage vs
  gateway-perspective cost). See Recipe 3.
- **`cc-observability` needs a one-time human approval** before any
  session — including a headless/background agent — can use its tools.
  `claude mcp list` shows `⏸ Pending approval` until a human interactively
  approves it once; this is a deliberate Claude Code trust control, not a
  bug. If you hit this, stop and surface it to the user. Do not attempt to
  self-approve or register a workaround — that defeats the control's purpose.
