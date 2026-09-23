---
name: signoz-session-lookback-queries
description: Use when asked to look back over a past agent session/conversation, or to retrieve the full untruncated prompt/completion body of a past LLM request or tool call — investigated from SigNoz via the cc-observability MCP server, over traces and logs. Agent-agnostic: discover the telemetry schema first, then investigate.
---

# SigNoz Session Look-back & Full-I/O Queries

## Overview

Three related jobs, each with a different data path:

1. **Session look-back** — find every span/log belonging to one conversation.
   Works over whatever session-identifying attribute exists (`session.id` is
   the OTel convention; it may live on traces, logs, or both).
2. **Full I/O retrieval (traces side)** — the complete prompt/completion as
   span attributes when the LLM gateway export is healthy (e.g.
   `gen_ai.input.messages` / `gen_ai.output.messages` on gateway spans).
3. **Full I/O retrieval (logs side)** — full request/response body events in
   **logs** for the same session id, which work independently of the
   gateway-export route.

This skill is **agent agnostic**: it does not hardcode agent/gateway service
names, span names, or attribute names — telemetry shapes have repeatedly
changed (traces-side session ids and full-I/O message attributes have
previously existed and later disappeared, while the logs side kept flowing).
Follow the **discover → query → cache** loop.

## Step 0: read cached knowledge from agentic memory first

```
agentic-memory_search_memory_facts(query="SigNoz session id full I/O schema", group_ids=["global"])
```

Spot-check any cached names with one cheap 1h call before trusting them.

## Step 1: discover the telemetry structure

1. **Where does the session id live?** —
   `signoz_get_field_keys(signal="traces", searchText="session")` **and**
   `signoz_get_field_keys(signal="logs", searchText="session")`. The key can
   exist on one signal but not the other.
2. **Are the needed services exporting?** — direct
   `signoz_aggregate_traces` / `signoz_aggregate_logs` counts on
   `service.name = '<agent-service>'` and `service.name = '<gateway-service>'`
   over a generous window. Remember `signoz_list_services` under-reports —
   confirm absence with a direct count.
3. **Do full-I/O attributes exist?** — `signoz_get_field_keys(signal="traces",
   searchText="gen_ai")` for message attributes on the gateway side. For the
   logs side, `signoz_get_field_keys` with `fieldContext: "body"` returns an
   empty `{"keys":{}}` — it does **not** enumerate JSON nested inside log
   bodies/attributes. The only way to discover the log payload shape is to
   pull a handful of real rows with `signoz_search_logs` and inspect them
   directly.
4. **Which log event types carry payloads?** —
   `signoz_get_field_values(signal="logs", fieldContext="attribute",
   name="event.name")` (when the key exists) lists the event taxonomy, then
   pull sample rows per candidate event and check which carry a full payload
   vs metadata only.

## Step 2: query by goal

| Question | Path | How |
|---|---|---|
| Every span/log of one session | logs or traces | filter on the discovered session attribute (`<attr> = '<uuid>'`) with a generous `timeRange` |
| Shape of the conversation | traces | `signoz_aggregate_traces`, `aggregation: count`, `groupBy: "name"` |
| Full request/response I/O (traces side, only if message attributes exist) | traces | `signoz_aggregate_traces` with `aggregation: count` and the attributes to read in `groupBy` — group keys carry the literal attribute values, giving a free "select" over attribute-only data |
| Full tool-call I/O (logs side) | logs | filter by session id, extract payload rows (see below) |

Rules and hard-won gotchas:

- **Raw list tools drop custom attributes.** `signoz_search_traces` /
  `signoz_get_trace_details` project a fixed set of intrinsic/resource
  columns only; custom attributes never appear in row output no matter how
  you filter. To *read* attributes, use `signoz_aggregate_traces` with
  `aggregation: count` and the attributes listed in `groupBy` — the group
  keys in the response are the literal attribute values.
- **`get_trace_details` can exceed the tool's output size limit** on a busy
  trace (observed: 891 spans → >1MB → hard error). Narrow first; only pull
  full trace detail once the trace is known to be small.
- **Logs payload row shape** (verify per environment, but typical):
  `signoz_search_logs` returns rows at
  `<file>.data.data.results[0].rows[].data`, where `.data` has
  `attributes_string` (flat map — event name and the real payload usually
  live here), `attributes_number`, `attributes_bool`, `body` (often just a
  short event label, **not** the payload), `timestamp`, `trace_id`,
  `span_id`, `resources_string`.
- **Volume warning:** a real session's `signoz_search_logs` pull routinely
  exceeds the tool's output-size limit and is redirected to a saved file.
  Go straight to `jq` on the saved file rather than expecting inline output.
- **Gateway export can silently drop spans** — an entire session may have
  zero gateway-side spans while requests succeeded at the caller. If the
  traces-side path comes up empty, verify gateway export health (Step 1
  count) before hunting historical spans, and prefer the logs-side path.
- **`filter` must be a query-builder expression string**, not a bare object.

## Step 3: cache verified findings to agentic memory

Persist structural facts only — which signal carries the session id, which
services export, which event types carry full payloads vs metadata only, the
logs row shape, verification date — to `group_id="global"` via
`agentic-memory_add_memory`. Never cache session contents or query results.

## Common Mistakes

- **Hardcoding `service.name = 'claude-code'` / `session.id` on traces /**
  **`gen_ai.input.messages`.** These have all existed and later disappeared
  from live data. Session ids can move between the traces and logs signals —
  check both.
- **Assuming the logs event taxonomy is stable.** Verify the current
  `event.name` values before relying on a full-payload event type existing.
- **Reading attributes from `signoz_search_traces` output** — impossible; use
  the aggregate `groupBy`-as-select trick.
- **`signoz_get_field_keys` with `fieldContext: "body"` returns empty on
  logs** — no shortcut to discovering nested payload shapes; inspect real
  rows instead.
- **`cc-observability` needs a one-time human approval** before any session —
  including a headless/background agent — can use its tools. If the MCP
  server shows as pending approval, stop and surface it to the user. Do not
  attempt to self-approve or register a workaround — that defeats the
  control's purpose.