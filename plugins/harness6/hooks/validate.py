#!/usr/bin/env python3
"""harness6 plugin self-check.

Mirrors the subset of Codex's `validate_plugin.py` that the slice-#9
acceptance criteria require, plus plugin-specific checks that the generic
validator doesn't cover:

  1. manifest-version: both `.codex-plugin/plugin.json` and
     `.claude-plugin/plugin.json` declare version "0.3.9".
  2. manifest-hooks-field: `.claude-plugin/plugin.json` has no `hooks`
     field. Claude Code auto-loads `hooks/hooks.json` unconditionally —
     a `manifest.hooks` entry only *adds* extra hook files, it never
     replaces the canonical one — so declaring it here would just
     register a second, redundant hook file rather than fix anything.
  3. hooks-files-exist: hooks/hooks.json, loader.py, and
     references/harness6.md are all present.
  4. hooks-json-valid: hooks/hooks.json parses as JSON, has the right
     `hooks.SessionStart` shape, and its command resolves the plugin root
     through both `${CLAUDE_PLUGIN_ROOT}` and `$PLUGIN_ROOT` (Claude Code
     only sets the former, Codex only the latter — same file is
     auto-discovered by both agents).
  5. loader-executable: hooks/loader.py has the +x bit set.
  6. harness6-md-present: references/harness6.md exists and is non-empty.

Exits 0 on success, 1 on failure, and prints a per-check PASS/FAIL line
plus a stderr summary. The summary line is parseable for CI use.

Usage:
    python3 plugins/harness6/hooks/validate.py [<plugin-root>]

If <plugin-root> is omitted, the script's parent's parent is used (i.e. the
plugin directory is inferred from the location of validate.py).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Callable, List, Tuple

EXPECTED_VERSION = "0.3.9"


def default_plugin_root() -> Path:
    """Infer the plugin root from this script's location."""
    return Path(__file__).resolve().parent.parent


# ── Individual checks ──────────────────────────────────────────────────────
# Each check returns (passed: bool, message: str). No side effects beyond
# reading files. They never raise; exceptions are caught and reported as
# failures so a single broken file doesn't crash the whole validator.


def _load_manifest(plugin_root: Path, name: str, errors: List[str]) -> dict | None:
    manifest_path = plugin_root / name / "plugin.json"
    if not manifest_path.is_file():
        errors.append(f"missing {name}/plugin.json")
        return None
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        errors.append(f"{name}/plugin.json is not valid JSON: {exc}")
        return None
    if not isinstance(payload, dict):
        errors.append(f"{name}/plugin.json must be a JSON object")
        return None
    return payload


def check_manifest_version(plugin_root: Path) -> Tuple[bool, str]:
    codex = _load_manifest(plugin_root, ".codex-plugin", list())
    claude = _load_manifest(plugin_root, ".claude-plugin", list())
    problems: List[str] = []
    for label, payload in ((".codex-plugin", codex), (".claude-plugin", claude)):
        if payload is None:
            problems.append(f"{label}/plugin.json unreadable")
            continue
        version = payload.get("version")
        if version != EXPECTED_VERSION:
            problems.append(f"{label}/plugin.json version {version!r} != {EXPECTED_VERSION!r}")
    if problems:
        return False, "; ".join(problems)
    return True, f"both manifests at version {EXPECTED_VERSION}"


def check_manifest_hooks_field(plugin_root: Path) -> Tuple[bool, str]:
    """Both agents auto-discover hooks/hooks.json; an explicit override only adds files."""
    manifest = _load_manifest(plugin_root, ".claude-plugin", list())
    if manifest is None:
        return False, ".claude-plugin/plugin.json unreadable"
    if "hooks" in manifest:
        return False, f".claude-plugin/plugin.json declares hooks {manifest['hooks']!r}, expected no hooks field"
    return True, ".claude-plugin/plugin.json has no hooks field"


def _hook_files(plugin_root: Path) -> List[Path]:
    # Both Codex and Claude Code auto-discover hooks/hooks.json; no manifest field needed.
    return [
        plugin_root / "hooks" / "hooks.json",
        plugin_root / "hooks" / "loader.py",
        plugin_root / "hooks" / "references" / "harness6.md",
    ]


def check_hooks_files_exist(plugin_root: Path) -> Tuple[bool, str]:
    missing = [str(p.relative_to(plugin_root)) for p in _hook_files(plugin_root) if not p.is_file()]
    if missing:
        return False, f"missing files: {', '.join(missing)}"
    return True, f"all {len(_hook_files(plugin_root))} hook files present"


def _sessionstart_commands(payload: dict) -> List[str] | None:
    """Verify the hooks.json payload has the expected `hooks.SessionStart` shape.

    Returns the list of command strings found, or None if the shape is invalid.
    """
    if not isinstance(payload, dict):
        return None
    hooks = payload.get("hooks")
    if not isinstance(hooks, dict):
        return None
    session_start = hooks.get("SessionStart")
    if not isinstance(session_start, list) or not session_start:
        return None
    commands: List[str] = []
    for entry in session_start:
        if not isinstance(entry, dict):
            return None
        inner_hooks = entry.get("hooks")
        if not isinstance(inner_hooks, list) or not inner_hooks:
            return None
        for hook in inner_hooks:
            if not isinstance(hook, dict):
                return None
            if hook.get("type") != "command":
                return None
            command = hook.get("command")
            if not isinstance(command, str):
                return None
            commands.append(command)
    return commands


def check_hooks_json_valid(plugin_root: Path) -> Tuple[bool, str]:
    path = plugin_root / "hooks" / "hooks.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return False, f"hooks/hooks.json: {exc}"
    commands = _sessionstart_commands(payload)
    if commands is None:
        return False, "hooks/hooks.json: missing or malformed hooks.SessionStart"
    fallback = "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}"
    non_portable = [c for c in commands if fallback not in c]
    if non_portable:
        return False, (
            "hooks/hooks.json: command(s) don't resolve the plugin root under both "
            f"${{CLAUDE_PLUGIN_ROOT}} and $PLUGIN_ROOT: {non_portable!r}"
        )
    return True, "hooks/hooks.json parses with valid, dual-agent-portable SessionStart shape"


def check_loader_executable(plugin_root: Path) -> Tuple[bool, str]:
    script = plugin_root / "hooks" / "loader.py"
    if not script.is_file():
        return False, "missing hooks/loader.py"
    if not os.access(script, os.X_OK):
        return False, "hooks/loader.py is not executable (chmod +x)"
    return True, f"hooks/loader.py is executable ({script})"


def check_harness6_md_present(plugin_root: Path) -> Tuple[bool, str]:
    md = plugin_root / "hooks" / "references" / "harness6.md"
    if not md.is_file():
        return False, "missing hooks/references/harness6.md"
    try:
        text = md.read_text(encoding="utf-8")
    except OSError as exc:
        return False, f"could not read hooks/references/harness6.md: {exc}"
    if not text.strip():
        return False, "hooks/references/harness6.md is empty"
    return True, f"hooks/references/harness6.md present ({len(text)} chars)"


# Order matters for readability of the output. Each entry is (label, function).
CHECKS: List[Tuple[str, Callable[[Path], Tuple[bool, str]]]] = [
    ("manifest-version",      check_manifest_version),
    ("manifest-hooks-field",  check_manifest_hooks_field),
    ("hooks-files-exist",     check_hooks_files_exist),
    ("hooks-json-valid",      check_hooks_json_valid),
    ("loader-executable",     check_loader_executable),
    ("harness6-md-present",   check_harness6_md_present),
]


def run(plugin_root: Path) -> int:
    """Run all checks. Returns 0 on success, 1 on any failure."""
    if not plugin_root.is_dir():
        print(f"validate: {plugin_root} is not a directory", file=sys.stderr)
        return 1
    failures: List[str] = []
    for label, fn in CHECKS:
        try:
            passed, message = fn(plugin_root)
        except Exception as exc:  # belt-and-braces — checks should not raise
            passed, message = False, f"{label} raised: {exc}"
        marker = "PASS" if passed else "FAIL"
        print(f"[{marker}] {label}: {message}")
        if not passed:
            failures.append(label)
    if failures:
        print(f"\nvalidate: {len(failures)} failure(s): {', '.join(failures)}", file=sys.stderr)
        return 1
    print(f"\nvalidate: all {len(CHECKS)} checks passed for {plugin_root}")
    return 0


def main(argv: List[str]) -> int:
    if len(argv) > 2:
        print("usage: validate.py [<plugin-root>]", file=sys.stderr)
        return 2
    plugin_root = Path(argv[1]).expanduser().resolve() if len(argv) == 2 else default_plugin_root()
    return run(plugin_root)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
