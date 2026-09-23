# Changelog

## [0.3.11] - 2026-09-10

Patch release making the SigNoz self-improvement skill agent-agnostic.

### Changed

- **Skills dropped the `harness6-` prefix** — installed skill names are already plugin-namespaced, so the redundant prefix is removed: `harness6-init` → `init` (folder, frontmatter name, error-message prefixes, and all doc/manifest references), and the signoz-self-improvement-queries frontmatter name fixed to match its folder.
- **`signoz-self-improvement-queries` rewritten as a discover → query → cache skill** — dropped all hardcoded agent telemetry (`claude-code` service name, `claude_code.*` span names, `decision`/`session.id` attributes), which had drifted out of existence and made 4 of 5 recipes fail live. The skill now: (1) reads previously verified schema facts from agentic memory (`group_id="global"`) with a cheap spot-check to detect staleness, (2) discovers the actual telemetry structure via `signoz_list_services` / `signoz_get_service_top_operations` / `signoz_get_field_keys` / `signoz_get_field_values`, (3) maps self-improvement questions (permission friction, latency, tokens/cache, workflow patterns, session cadence) to discovered span names via an intent→aggregation table, and (4) persists structural findings back to agentic memory so future sessions skip discovery and save tokens.
- **Anti-staleness rules added** — never cache result numbers (only schema structure), never use a name not confirmed in-session or spot-checked from memory, and note that attribute coverage varies per span kind (e.g. gate spans may carry a decision but not a tool name).

## [0.3.10] - 2026-09-10

Patch release redesigning the design-session flow and scope-review into a verdict-routed, context-safe pipeline.

### Changed

- **`design-session` scope gate routes on the scope-review verdict** — `TASK` grills to a single crisp PR with no tracker machinery (spec/tickets/epic/triage skipped; one Workflow A dispatch); `EPIC` runs the full grill → `/to-spec` → `/to-tickets` → triage → docs-PR flow; `INITIATIVE` decomposes into ordered epic issues, halts, and requests one child `/design-session` per epic (each child re-enters the gate). A mega-session that blows model context is never attempted.
- **`scope-review` rewritten as a pure upfront estimator** — was PR-boundary gate, now sizes any goal (task → initiative). Three estimation axes (concern count, coupling & dependency shape, session-fit/context risk) yield a `TASK` / `EPIC` / `INITIATIVE` tier verdict plus PR-count and session-count estimates. All routing text removed: the verdict only; the caller routes.
- **`design-session` grilling gains a live-research rule (model-/agent-agnostic)** — any load-bearing external fact must be verified via available web research tooling before entering the spec or an ADR; inconclusive or toolless facts are tagged `UNVERIFIED:` instead of silently asserted. ADR authority is the `domain-modeling` skill (three gates + ADR-FORMAT/CONTEXT-FORMAT).
- **Matt Pocock vocabulary adopted** — `/to-prd` → `/to-spec`, `/to-issues` → `/to-tickets`; blocking edges replace parent-child linking; tracker-specific parent-link instructions removed.
- **HITL/AFK classification moved to the triage step** — ticketing quizzes granularity and dependencies only; triage classifies (`ready-for-human` = HITL) and flags the spec issue's child checklist.
- **Spec-issue ledger slimmed** — Results section, Definition-of-done promotion, ADR "Measured results" stub and results-promotion-at-close removed; the Handoffs table (cross-slice value ledger) stays.
- **All skills agent-invokable except `autobot`** — `autobot` keeps `disable-model-invocation` as the one deliberate human-only exception (autonomous orchestrator must never self-trigger); no other harness6 skill carries a gate.
- **Plugin version bump** — manifests, `hooks/validate.py` `EXPECTED_VERSION`, and the marketplace entry to `0.3.10`.

## [0.3.9] - 2026-09-10

Patch release: the 0.3.8 hooks-path fix didn't actually fix Claude Code loading, because Claude Code auto-loads `hooks/hooks.json` unconditionally — `manifest.hooks` only registers *additional* hook files, it never replaces the canonical one. So `hooks/hooks.json` (still using the Codex-only bare `$PLUGIN_ROOT`, unset under Claude Code) kept loading and erroring on every Claude Code session, alongside the correctly-wired `hooks/claude/hooks.json`, regardless of restarts.

### Fixed

- **`hooks/hooks.json` command** — now resolves the plugin root via `${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}`, so the one file both agents auto-discover works under either. Was bare `$PLUGIN_ROOT`, which Claude Code never sets, expanding to `/hooks/loader.py` and failing with `SessionStart:startup hook error`.
- **Removed `hooks/claude/hooks.json`** and the `.claude-plugin/plugin.json` `hooks` field that pointed to it — redundant now that the shared file works standalone, and having both meant the `SessionStart` hook fired twice per Claude Code session.

### Changed

- **`hooks/validate.py`** — `manifest-hooks-field` now asserts `.claude-plugin/plugin.json` has *no* `hooks` field (an explicit one would only add a second file); `hooks-json-valid` checks the single `hooks/hooks.json` and requires its command contain the `${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}` fallback, to catch this regression again.
- **Plugin version bump** — `plugins/harness6` manifests (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`), `hooks/validate.py` `EXPECTED_VERSION`, and the marketplace plugin entry bumped to `0.3.9`.

## [0.3.8] - 2026-09-10

Patch release fixing a broken plugin load path and bumping the harness6 plugin version to 0.3.8.

### Fixed

- **`.claude-plugin/plugin.json` `hooks` path** — declared `./claude/hooks.json`, which Claude Code resolves relative to the plugin root (`plugins/harness6/`). No `claude/` directory exists there — the real file lives at `hooks/claude/hooks.json` — so Claude Code failed to load the plugin's hooks (and the plugin as a whole). Manifest now points to `./hooks/claude/hooks.json`.
- **`hooks/validate.py` self-check encoded the same wrong path** — `CLAUDE_HOOK_PATH` and the docstring expected `./claude/hooks.json`, so the validator's `manifest-hooks-field` check passed even though the plugin couldn't actually load in Claude Code. Updated the constant, docstring, and `test_validate.py`'s `EXPECTED_CLAUDE_HOOKS` to the real path.

### Changed

- **Plugin version bump** — `plugins/harness6` manifests (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`), `hooks/validate.py` `EXPECTED_VERSION`, and the marketplace plugin entry bumped to `0.3.8`.

## [0.3.7] - 2026-09-02

Patch release bumping the harness6 plugin version to 0.3.7.

### Fixed

- **`references/harness6.md` header** — the intro line and numbered list said "five pillars" and omitted Pillar 6 (Guardrail and constraints sandbox), even though the pillar's own section already existed further down the file. Header now lists all six pillars.

### Changed

- **Plugin version bump** — `plugins/harness6` manifests (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`), `hooks/validate.py` `EXPECTED_VERSION`, and the marketplace plugin entry bumped to `0.3.7`. No functional behaviour change beyond the fix above.

## [0.3.6] - 2026-08-24

Patch release bumping the harness6 plugin version to 0.3.6.

### Removed

- **`self-improvement` skill** — removed entirely.

### Added

- **Three signoz query skills**, cloned verbatim (frontmatter and body unchanged) from the global reference skills, replacing `self-improvement`: `signoz-self-improvement-queries` (permission friction, slow tools, token/cache usage, workflow patterns, session cadence), `signoz-session-lookback-queries` (replaying a past session, retrieving untruncated prompt/completion bodies), and `signoz-token-cost-queries` (LiteLLM gateway token usage and cost).

### Changed

- **Plugin version bump** — `plugins/harness6` manifests (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`), `hooks/validate.py` `EXPECTED_VERSION`, and the marketplace plugin entry bumped to `0.3.6`.
- **`README.md` and `hooks/references/harness6.md`** — updated the skills list and observability-reflection guidance to reference the three new signoz-*-queries skills instead of `self-improvement`.

## [0.3.5] - 2026-08-24

Patch release bumping the harness6 plugin version to 0.3.5.

### Added

- **ADR scope for agentic memory** — a fourth `agentic-memory-write`/`agentic-memory-read` scope key, `owner_repo_adr_<NNNN>`, for ADR-amendment rationale that sits outside the GitHub issue/epic/project hierarchy and is exempt from status reconciliation and aging-out.
- **`docs/ADR-FORMAT.md`** — tracked reference for this repo's ADR format and amendment convention (present-tense snapshot body, `## Amendments` pointer table, dead approaches as standing prohibitions).

### Changed

- **Plugin version bump** — `plugins/harness6` manifests (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`), `hooks/validate.py` `EXPECTED_VERSION`, and the marketplace plugin entry bumped to `0.3.5`. No functional behaviour change beyond the additions above.

## [0.3.4] - 2026-08-23

Patch release updating the `autobot` skill's post-merge flow, the `design-session` skill's frontmatter, and the bundled plugin version.

### Added

- **autobot post-merge cleanup** — after a PR merges, the main session now pulls the local main workspace up to date, tears down the merged PR's worktree (and deletes its branch), and triggers `/memsearch-index` when the merged PR touched a path listed in `.memsearch.toml`.

### Removed

- **autobot results promotion step** — dropped the standalone "Results promotion" loop step (formerly step 7); results are no longer promoted into ADR stubs via a separate docs PR.

### Fixed

- **design-session frontmatter** — quoted the `description` field so the embedded `SKIP for:` colon no longer breaks YAML parsing (`mapping values are not allowed in this context`).

## [0.3.6] - 2026-08-29

Patch release fixing the agentic-memory group_id normalization spec and scrubbing
third-party organization references.

### Changed

- **Explicit group_id normalization** — `agentic-memory-read` (Scope resolution) and
  `agentic-memory-write` (Write scope) now require normalizing every component before
  joining: replace `-`, `.`, `#`, whitespace with `_` and lowercase, e.g.
  `acme-org/payments-service` → `acme_org_payments_service`. Previously only the join
  separator was specified, so owner/repo names containing dashes could yield
  non-compliant group_ids. Convention matches the project-wide naming rule.
- **Third-party reference scrub** — replaced `oolio-group/oolio-one-gitops` and
  `oolio-one/sandbox` examples in the memory skills and hook reference with generic
  placeholders (`acme-org/payments-service`).
- **Plugin version bump** — `0.3.5` → `0.3.6` across `.claude-plugin/plugin.json`,
  `.codex-plugin/plugin.json`, `hooks/validate.py`, `hooks/test_validate.py`, and the
  marketplace plugin entry.

## [0.3.3] - 2026-08-23

Patch release bumping the harness6 plugin version to 0.3.3.

### Changed

- **Plugin version bump** — `plugins/harness6` manifests (`.claude-plugin/plugin.json`,
  `.codex-plugin/plugin.json`), `hooks/validate.py` `EXPECTED_VERSION`, and the marketplace
  plugin entry bumped to `0.3.3`. No functional behaviour change.
- **harness6-init setup** — selects Docker or Podman interactively when both are installed,
  starts Compose with explicit environment and Compose file arguments, safely registers the
  repository MCP configuration at user or project scope, and guides explicit Milvus and embedding
  provider configuration through `memsearch-init`.

## [0.3.2] - 2026-08-09

Patch release for the harness6-init setup workflow.

### Changed

- Added runtime selection, safe MCP registration, and memsearch setup guidance to harness6-init.

### Removed

- Removed the obsolete `graphsearch`, `awsctx`, `sentry-cli`, `multi-task`, and `standup` skills and their supporting files.


All notable changes to the `harness6` plugin.

## [0.3.1] - 2026-08-09

Patch release removing provider-specific model assumptions from the
`design-session` skill.

### Changed

- **Model-agnostic design session** — removed vendor-specific model-switching
  instructions while preserving the design workflow.

## [0.3.0] - 2026-08-09

Renames the plugin from `harness5` to `harness6` to align with the
repository name (`dzungtr/harness6`) and the `harness6` branding already
used throughout the repo and ADRs. This is a **breaking change**: the
plugin install name changes from `harness5` to `harness6`.

### Changed

- **Plugin rename** — `plugins/harness5/` renamed to `plugins/harness6/`.
  All manifest names, marketplace entries, skill names, env vars, hooks,
  references, tests, and documentation updated to `harness6`.
- **Skill rename** — `harness5-init` → `harness6-init`. The
  `HARNESS5_PLUGIN_ROOT` env var is now `HARNESS6_PLUGIN_ROOT`.
- **Hook env var** — `HARNESS5_INSTRUCTIONS_FILE` →
  `HARNESS6_INSTRUCTIONS_FILE`. The loader stderr prefix changed from
  `harness5:` to `harness6:`.
- **References file** — `hooks/references/harness5.md` →
  `hooks/references/harness6.md`. Title updated from "Harness 5" to
  "Harness 6".
- **Self-check** — `harness5-md-present` check renamed to
  `harness6-md-present`; `EXPECTED_VERSION` bumped to `0.3.0`.
- **Version bump** — `0.2.2` → `0.3.0` (minor; breaking).

### Breaking

- `claude plugin install harness5` no longer works — use `claude plugin
  install harness6`.
- `codex plugin install harness5` no longer works — use `codex plugin
  install harness6`.
- Users who set `HARNESS5_INSTRUCTIONS_FILE` or `HARNESS5_PLUGIN_ROOT`
  must update to the `HARNESS6_` prefix.

### Notes

- Historical ADRs (`0005-harness5-plugin-distribution.md`,
  `0007-multi-plugin-layout.md`) are left unchanged — they are historical
  decision records and accurately describe the state at the time they were
  written.
- Previous `[0.2.x]` changelog entries are preserved as-is; they describe
  releases of the plugin when it was named `harness5`.

## [0.2.2] - 2026-07-25

Patch release. Adds the shared SELinux label (`z`) to the `graphiti-mcp`
config bind mount in `infrastructure/docker-compose.yml` so the MCP
server starts cleanly on Fedora/RHEL hosts with SELinux enforcing.

### Fixed

- **graphiti-mcp crash on SELinux-enforcing hosts** — the host bind
  mount of `config.yaml` into the `zepai/knowledge-graph-mcp` container
  was declared `:ro` only. The host file lives under `/home/...` and
  carries the `user_home_t` SELinux label, so the container process was
  denied `stat()` and the MCP server crashed with
  `PermissionError: [Errno 13] Permission denied:
  '/app/mcp/config/config.yaml'`. Adding the `z` relabel brings the
  mount into line with every other bind mount in the file (memgraph,
  clickhouse, otel collector) and unblocks the container without
  changing read-only semantics. SELinux-disabled hosts are unaffected
  (`z` is a no-op there).

### Notes

- Same-day patch release against `0.2.1`. No manifest schema, skill, or
  hook behaviour change.

## [0.2.1] - 2026-07-25

Adds a `SessionStart` hook that injects the bundled `references/harness5.md`
operating instructions into every Codex and Claude Code session.

### Added

- **SessionStart hook** — `plugins/harness5/hooks/hooks.json` (Codex,
  auto-discovered) and `plugins/harness5/hooks/claude/hooks.json` (Claude
  Code, declared via `.claude-plugin/plugin.json`). Both wire to the same
  shared loader at `plugins/harness5/hooks/loader.py`.
- **Bundled instructions file** —
  `plugins/harness5/hooks/references/harness5.md`. Carries the harness5
  operating instructions verbatim so every Codex/Claude Code session with
  harness5 installed starts with them loaded.
- **Loader script** — `plugins/harness5/hooks/loader.py` (Python 3 stdlib
  only, `+x`). Emits the canonical
  `{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ...}}`
  shape that both harnesses consume identically.
- **Plugin self-check** — `plugins/harness5/hooks/validate.py` (six
  checks: manifest version, manifest hooks field, hooks files present,
  hooks JSON valid, loader executable, bundled markdown present) plus
  `test_loader.py` and `test_validate.py` (`unittest`, 21 tests total).

### Loader contract

- **Failure mode**: missing or unreadable `harness5.md` → no JSON on
  stdout, single-line warning on stderr, exit 0. The hook never blocks
  a session.
- **Size cap**: soft warning on stderr when `harness5.md` exceeds 32,768
  characters, but the file is still injected without truncation.

### Notes

- The repo-root `CLAUDE.md` was removed in slice #10 so the
  hook becomes the sole source of truth and there is no window where a
  user's CLAUDE.md auto-load and the hook injection disagree (pre-0.2.2).

## [0.2.0] - 2026-07-25

Relocated the plugin from repo-root-native manifests into `plugins/harness5/`,
sibling with `plugins/auto-review/`. The repo is now a multi-plugin
distribution repo rather than a personal `~/.claude` config.

### Changed

- **Layout** — `skills/` and `infrastructure/` moved into
  `plugins/harness5/`. The `.codex-plugin/plugin.json` and
  `.claude-plugin/plugin.json` manifests moved alongside them. The plugin is
  now fully self-contained under `plugins/harness5/`, matching the
  `plugins/auto-review/` pattern.
- **Manifests** — descriptions updated to drop the "single installable
  plugin" framing and the personal-`~/.claude` references; version bumped to
  0.2.0. The `"skills"` path fields still resolve relative to the plugin
  dir (`./skills/`), so no install-side change is required.
- **Marketplaces** — `.claude-plugin/marketplace.json` and
  `.agents/plugins/marketplace.json` now list both `harness5` and
  `auto-review`, each with `source` pointing at its `plugins/<name>/`
  subfolder.
- **ADR 0007** supersedes ADR 0005's "root-native manifests, one plugin"
  decision for the multi-plugin layout.

### Notes

- `harness5-init` is unaffected: it resolves the plugin root from
  `PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT`, so the path-depth change is absorbed
  automatically. The bare `infrastructure/...` paths inside skills still
  resolve correctly because an installed plugin's root is its own dir.
- The repo no longer ships `settings.json`, `agents/`, `hooks/`, `scripts/`,
  or `docs/` as part of any plugin; those remain at repo root as
  development-only content.

## [0.1.1] - 2026-07-19

Initial release as a root-native plugin (per ADR 0005). See
`docs/adr/0005-harness5-plugin-distribution.md` for the original decision and
measured results.
