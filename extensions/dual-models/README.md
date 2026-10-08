# Dual Models

A Pi extension that registers the Virtual Model `dual-models/auto`. System-1 (a fast decision model) judges a Digest of the session and the Gate picks which of two models serves the next request: the Reasoning Model or the Execution Model. See `CONTEXT.md` for the glossary and `docs/adr/0001-system-one-decision-model-gate.md` for the design.

The Gate follows System-1's argmax: the role with the higher probability serves the request, and a tie goes to reasoning. The only way to tune which role System-1 prefers is `models.<role>.criteria`.

## Config

Settings live under the `dualModels` key of `~/.pi/agent/settings.json` (user) and `<project>/.pi/settings.json` (project, once trusted). Project values override user values per key, including per key inside `models.<role>`.

```json
{
  "dualModels": {
    "models": {
      "reasoning": { "model": "provider/modelId", "criteria": "optional text" },
      "execution": { "model": "provider/modelId", "criteria": "optional text" }
    },
    "system1": { "model": "typesafe/jev-1.13", "baseUrl": "https://openrouter.ai/api/v1/systemone", "timeoutMs": 1500 },
    "digest": { "recapTokens": 2000, "toolOutputTokens": 2000 },
    "events": { "prompt": "system1", "turn_end": "system1", "retry": "previous", "compaction": "execution", "side-call": "execution" },
    "defaultRole": "reasoning",
    "forceReasoningOnPrompt": false
  }
}
```

| Key | Default | Notes |
|---|---|---|
| `models.reasoning.model` | required | `provider/modelId` string, must be in the Pi catalog |
| `models.execution.model` | required | `provider/modelId` string, must be in the Pi catalog |
| `models.<role>.criteria` | built-in text | Optional, non-empty string. Replaces that role's Gate criteria |
| `system1.model` | `typesafe/jev-1.13` | System-1 model |
| `system1.baseUrl` | OpenRouter System-1 endpoint | User settings only. https, or http for localhost |
| `system1.timeoutMs` | `1500` | Positive number |
| `digest.recapTokens`, `digest.toolOutputTokens` | `2000` | Positive integers |
| `events.<event>` | see above | One of `system1`, `reasoning`, `execution`, `previous` |
| `defaultRole` | `reasoning` | Serves the request when System-1 fails |
| `forceReasoningOnPrompt` | `false` | Skip the Gate on a new prompt |

Unknown keys, including under `models` and `models.<role>`, are reported.

### Migrating from older keys

| Old key | Replacement |
|---|---|
| `deliberationModel` | `models.reasoning.model` |
| `executionModel` | `models.execution.model` |
| `system1.thetaSwitch` | removed; tune with `models.<role>.criteria` |

## Tuning with criteria

System-1 answers one question, "Which role should take the next request?", against one criteria text per role. Rewording a role's text moves the argmax. Only the criteria differ between configs, so the system prompt and tool list stay identical across roles.

To prefer the Execution Model for small, well-specified edits, widen its criteria and narrow the reasoning one:

```json
{
  "dualModels": {
    "models": {
      "reasoning": {
        "model": "kimi/k3",
        "criteria": "The request is ambiguous or risky, spans several modules, or needs a design decision before any code is written. Do not pick this for edits whose target and outcome are already stated."
      },
      "execution": {
        "model": "zai/glm-5.3-flash",
        "criteria": "The request names what to change and what done looks like: renames, small fixes, adding a test, running a command, applying an agreed plan, or following up on a failing check. Prefer this whenever the next step is clear, even if the change touches several files."
      }
    }
  }
}
```

A project can set `criteria` alone, for example `{"dualModels": {"models": {"execution": {"criteria": "..."}}}}`, and keep the user's `model`.

## Telemetry

Each Gate call emits a `dual_models.gate` span. `gate.criteria_hash` is the first 12 hex characters of the sha256 of the effective criteria (reasoning, then execution), so runs with different criteria can be compared. The criteria text is never exported.

`model.applied` is the configured `provider/modelId` of the role the Gate chose (`models.<role>.model`), and `model.previous` is the same for the role in use before the call (`none` on the first call). Use them to map `role.chosen` to a concrete model, since the `chat` spans only carry `gen_ai.request.model="auto"`.

Each `recap` tool call emits a `dual_models.recap` span, so a session's Recap history can be reviewed in the trace. On a stored write it carries `recap.intent`, `recap.course_of_action`, `recap.event` (only when the write appended one), `recap.events.count`, `recap.tokens` and `recap.budget`. A rejected write (over budget or empty) has `recap.rejected=true` and an error status, and no Recap text. Unlike the criteria text, the Recap text is exported, so avoid putting secrets in it.
