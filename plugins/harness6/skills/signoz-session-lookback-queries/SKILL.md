---
name: signoz-session-lookback-queries
description: Use when asked to look back over a past Claude Code session/conversation, or to retrieve the full untruncated prompt/completion body of a past LLM request or tool call — queried from SigNoz via the cc-observability MCP server, including via logs when litellm trace export is unavailable.
---

# SigNoz Session Look-back & Full-I/O Queries

## Overview

Three related recipes. Recipes 1 and 2 are against `traces` data only; Recipe 3
covers the same ground (full tool-call I/O) via `logs` instead, and is now in
scope alongside traces:

1. **Session look-back** — Claude Code emits a `session.id` string attribute on
   every span (`service.name = 'claude-code'`). Filtering on it returns every
   span from one conversation, in order.
2. **Full I/O retrieval (traces)** — LiteLLM gateway spans (`service.name =
   'litellm'`) carry the complete prompt and completion as **span attributes**
   (`gen_ai.input.messages` / `gen_ai.output.messages`, string-typed), per ADR
   0003. There is no documented truncation limit, and none was observed on a
   46k-token exchange (below). Still valid when the gateway route is healthy,
   but see Recipe 3 for when it isn't.
3. **Full tool-call I/O (logs)** — `claude-code`-service logs for the same
   `session.id` carry `api_request_body`/`api_response_body` events whose
   `body` attribute is the raw Anthropic Messages-API JSON, including every
   `tool_use` block with its full, untruncated input (e.g. the literal Bash
   command run). Works independently of the litellm gateway — a more robust
   fallback when Recipe 2 comes up empty.

Recipes 1 and 2 were verified live against real ingested data on 2026-07-21
(epic #84, issue #100). Recipe 3 was verified live on 2026-07-30 (see its
"Verified result" below).

## Prerequisite: confirm attribute names

```json
{ "signal": "traces", "fieldContext": "attribute", "searchText": "session" }
{ "signal": "traces", "fieldContext": "attribute", "searchText": "gen_ai" }
```

via `signoz_get_field_keys` — confirms `session.id` (string, on `claude-code`
spans) and `gen_ai.input.messages` / `gen_ai.output.messages` (string, on
`litellm` spans) exist before filtering on them.

## Recipe 1: session/conversation look-back

Use `signoz_search_traces` (or `signoz_aggregate_traces`) filtered on
`service.name = 'claude-code' AND session.id = '<uuid>'`. The session id is
whatever Claude Code assigned at session start (visible as `session.id` on any
span from that run, or from `CLAUDE_SESSION_ID`/hook context if you're inside
the session itself).

```json
{
  "filter": "service.name = 'claude-code' AND session.id = '4d07d96c-6c3f-46a1-a1c7-7a4de5c062ee'",
  "timeRange": "7d"
}
```

**Verified result:** this exact query returned 2 real spans for a known
fixed-session-id gateway request made 2026-07-21T04:22 UTC (body marker
`ISSUE_100_VERIFICATION_MARKER_7f3a2e`, left by a prior pass at this issue) —
a `claude_code.interaction` span and its child `claude_code.llm_request` span,
both on `trace_id = c0db8ff4a279e9c0e156b00b1f8a755c`, still present in
retention 2 days later. Confirms `session.id` is real, queryable, and
retained — the look-back half of ADR 0003's deferred item 3.

Swap in `groupBy: "name"` on `signoz_aggregate_traces` (`aggregation: count`)
to get a shape-of-the-conversation view (how many of each span type) instead
of the raw row list.

## Recipe 2: full, untruncated request/response I/O

**The raw list tools (`signoz_search_traces`, `signoz_get_trace_details`) do
NOT return custom attributes** — they project a fixed set of intrinsic/resource
columns only (`service.name`, `duration_nano`, `http.*`, etc.); `session.id`
and `gen_ai.*` never appear in that row shape no matter how you filter.
`get_trace_details` is also dangerous to reach for on a busy trace — it can
return every span+event in the time range and blow past the tool's output
size limit (hit this while investigating: a single trace with 891 spans
produced a >1MB response and errored out).

The reliable path is `signoz_aggregate_traces` with `aggregation: count` and
the attributes you want to *read* (not just filter on) listed in `groupBy` —
the group keys in the response are the literal attribute values, giving you a
free "select" over otherwise attribute-only data:

```json
{
  "aggregation": "count",
  "filter": "service.name = 'litellm' AND trace_id = '<trace_id>' AND gen_ai.input.messages EXISTS",
  "groupBy": "gen_ai.input.messages, gen_ai.output.messages, gen_ai.usage.total_tokens",
  "start": 1783900800000,
  "end": 1783987200000
}
```

Find the target `trace_id` first with a narrower search, e.g.
`signoz_search_traces` with `service: "litellm"` and a time window, looking for
the `chat <model>` client span (`kind = 3`) under a `Received Proxy Server
Request` root — that's the span carrying the `gen_ai.*` attributes.

**Verified result:** run against the historical `litellm` spans from
2026-07-13 (PR #111's own SigNoz-fan-out verification run), `trace_id =
6f916f10ee85e948918f30dc131b752b`. Returned the complete `gen_ai.input.messages`
array — every system-reminder block, the full skills listing, all of
`CLAUDE.md`, verbatim — and `gen_ai.output.messages` = `"4"`, with
`gen_ai.usage.total_tokens = 46659`. Nothing was cut off: the returned input
message array ends exactly at the real final user turn, matching ADR 0003's
"no observed truncation on the 46k-token run" claim. This closes ADR 0003's
deferred item 1.

## Recipe 3: full tool-call I/O via logs (works even when litellm export is broken)

When Recipe 2 comes up empty — zero `litellm` spans for the trace_id(s) in
question, e.g. because of the gateway-drop bug in Common Mistakes below —
`claude-code`-service **logs** for the same `session.id` carry the same
tool-call I/O independently, and more directly (no need to locate a
`litellm`-side trace at all).

**`event.name` taxonomy** (from `attributes_string["event.name"]` on each log
row) — 10 values observed:

| `event.name` | Payload |
|---|---|
| `user_prompt` | metadata only |
| `tool_result` | metadata only — `tool_name`, `success`, `duration_ms`, `tool_input_size_bytes`, `tool_result_size_bytes`; **not** the command text |
| `tool_decision` | metadata only |
| `api_request` | metadata only |
| `api_request_body` | **full payload** — entire raw request JSON in `body`, re-embeds the whole growing conversation history every turn (large) |
| `api_response_body` | **full payload** — entire raw response JSON in `body` (smaller than `api_request_body`, one assistant turn) |
| `assistant_response` | metadata only |
| `hook_execution_start` | metadata only |
| `hook_execution_complete` | metadata only |
| `hook_plugin_metrics` | metadata only |

Only `api_request_body` and `api_response_body` carry the full payload; every
other event type is metadata-only (tool name, sizes, durations — never the
actual command or content).

**Dead end — don't waste a call on this:** `signoz_get_field_keys` with
`fieldContext: "body"` returns an empty `{"keys":{}}`. It does not enumerate
the JSON structure nested inside log bodies/attributes. The only way to
discover the shape below is to pull a handful of real rows via
`signoz_search_logs` and inspect them directly (e.g. with `jq` on the
saved-to-file output).

**Row shape:** `signoz_search_logs` returns one row per log line at
`<file>.data.data.results[0].rows[].data`, where `.data` has
`attributes_string` (flat string-keyed map — this is where `event.name` and
`body` live), `attributes_number`, `attributes_bool`, `body` (misleadingly
just a short label like `"claude_code.tool_result"`, **not** the payload —
the real payload is `attributes_string.body`), `timestamp`, `trace_id`,
`span_id`, `resources_string` (`service.name` etc).

**Volume warning:** a modest session (148 log rows) produced a
`signoz_search_logs` response of ~1.3MB — over the tool's own output-size
limit, redirected to a saved file per the harness's standard fallback. Expect
this on any non-trivial session; go straight to `jq` on the saved file rather
than expecting an inline result.

**Step-by-step recipe:**

1. Sanity-check logs exist for the session before pulling the big payload:
   `signoz_aggregate_logs`, `aggregation: count`, grouped by `service.name`.
2. Pull the rows: `signoz_search_logs` filtered on `session.id`, generous
   `timeRange` (session age may be unknown), `limit` ~200. Expect this to
   overflow to a saved file for any real session.
3. Extract the actual text payload — the tool result is a `[{type, text}]`
   array where `text` is itself JSON-encoded.
4. Filter to `event.name == "api_response_body"` rows (assistant turns —
   smaller than `api_request_body`, which re-embeds the entire growing
   conversation history every turn), sort by
   `.data.attributes_string["event.timestamp"]`, and collect
   `.data.attributes_string.body` (each one a JSON-encoded Anthropic
   Messages-API response object) into a `.jsonl` file, one response body per
   line.
5. Extract every tool call, in chronological order, with full untruncated
   input:

```json
{ "aggregation": "count", "filter": "session.id = '<uuid>'", "groupBy": "service.name" }
```
```json
{ "filter": "session.id = '<uuid>'", "timeRange": "7d", "limit": 200 }
```
```bash
# 3. extract the payload text from the saved search_logs result
jq -r '.[0].text' saved_result.json > extracted.json

# 4. pull api_response_body rows, sorted chronologically, one JSON body per line
jq -c '.data.data.results[0].rows[]
  | select(.data.attributes_string["event.name"] == "api_response_body")
  | .data.attributes_string
  | {ts: .["event.timestamp"], body}' extracted.json \
  | jq -s 'sort_by(.ts) | .[].body' -r > responses.jsonl

# 5. list every tool call across the whole session, in order, full input
jq -c '.content[]? | select(.type=="tool_use") | {name, input}' responses.jsonl
```

For a Bash tool call this yields `{name: "Bash", input: {command: "<literal
shell command that ran>", description: "..."}}` — the real command text, not
just the tool name.

**Verified result:** verified live on 2026-07-30 against a real session — 148
log rows total (`claude-code` service only), 29 `tool_use` blocks extracted
across `api_response_body` events, matching the 29 Bash-tool spans seen in
the corresponding trace query, in the correct chronological order, with real
shell commands (not just tool names) recovered. This was for a session where
the trace-side Recipe 2 path returned **zero** `litellm` spans for both
trace_ids in that session — confirming Recipe 3 as a working fallback (and
arguably the more robust primary path) when the gateway-drop bug is in play.

## Common Mistakes

- **Raw list tools drop custom attributes.** See Recipe 2 above — don't expect
  `session.id` or `gen_ai.*` in `signoz_search_traces` / `get_trace_details`
  row output; use `signoz_aggregate_traces` (`groupBy` on the attribute) or a
  `signoz_execute_builder_query` with an explicit attribute select instead.
- **`get_trace_details` can exceed the tool's output size limit** on a busy
  trace (observed: 891 spans, >1MB, hard error). Narrow with
  `signoz_search_traces`/`signoz_aggregate_traces` first; only pull full trace
  detail once you know the trace is small.
- **`filter` must be a query-builder expression string**, not a bare object —
  same gotcha as `skills/signoz-token-cost-queries`.
- **The current live gateway route can silently drop LiteLLM-side export —**
  **and this can affect an entire session's worth of spans, not just one
  request.** A fresh request through `openai/minimax/minimax-m3` (via
  Aperture) returns `200 OK` to the caller but never lands a `litellm`-service
  span in SigNoz — re-confirmed 2026-07-21: zero `litellm` spans in the
  04:20–04:50 UTC window around a request that should have produced one.
  Re-confirmed again 2026-07-30 at session scope: zero `litellm` spans for
  *either* trace_id in a full live session. Root cause (from a prior pass at
  this issue): a LiteLLM-internal `AnthropicResponse` pydantic validation
  error inside `async_success_handler`. This is a real gateway bug, tracked
  separately — not fixed here. Route around it: use the Claude Code side
  (`service.name = 'claude-code'`) for session look-back (Recipe 1 is
  unaffected) and, for full tool-call I/O, prefer **Recipe 3 (logs)** over
  hunting for historical `litellm` spans that predate the broken route.
- **`signoz_get_field_keys` with `fieldContext: "body"` returns an empty**
  **`{"keys":{}}` on logs.** It does not enumerate the JSON structure nested
  inside log bodies/attributes — there's no shortcut to discovering the shape
  of `api_request_body`/`api_response_body` payloads. Pull real rows with
  `signoz_search_logs` and inspect with `jq` instead (see Recipe 3).
- **`cc-observability` needs a one-time human approval** before any
  session — including a headless/background agent — can use its tools.
  `claude mcp list` shows `⏸ Pending approval` until a human interactively
  approves it once; this is a deliberate Claude Code trust control, not a
  bug. If you hit this, stop and surface it to the user. Do not attempt to
  self-approve or register a workaround — that defeats the control's purpose.
