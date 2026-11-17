---
name: pr-merged-cleanup
description: Use when a PR raised by a background team agent is open or has merged — watches an unmerged PR until it merges or closes, and once merged (whether the user reports it, or the coordinating agent notices the MERGED state itself via a task-completion notification, an agent/task listing, or a `gh pr view`/`gh pr list` result) handles worktree removal, pulling the merge into the local repo, agent shutdown, and task completion.
---

# pr-merged-cleanup — Post-Merge Cleanup

## Overview

A PR raised by a background agent is either already merged or still open. If it is still open, watch it until it merges or closes. Once it is merged, five cleanup actions are required in order: mark any associated task done, remove the agent's worktree, pull the merge into the local repo, shut the agent down, then persist progress-state if the work was ticket-scoped.

## Detecting a merge without being told

A merge confirmed by the coordinating agent's own observation is just as actionable as one the user reports — don't wait for the user to say "it's merged" once the state is already visible.

Treat any of these as confirmation, in the course of normal work:

- A background-agent task-completion notification that mentions a merged PR's URL or number.
- Listing active agents or tasks and noticing that one with an open PR is now merged.
- Running `gh pr view <number-or-branch> --json state,mergedAt -q .state` or `gh pr list --state merged` while checking on a background agent's status, and seeing `MERGED`.

Once MERGED is confirmed by either path, proceed straight into the cleanup steps below — don't ask the user to confirm a fact you've already observed. Normal judgment about confirming destructive actions still applies to the worktree-remove, branch-delete, and shutdown steps themselves.

## Watching a PR that is not merged yet

If the PR state is `OPEN` (not `MERGED`, not `CLOSED`), watch it instead of stopping or asking the user to come back.

```bash
gh pr view <number-or-branch> --json state,mergedAt,mergeStateStatus,reviewDecision -q '{state,mergedAt,mergeStateStatus,reviewDecision}'
```

- Re-check every few minutes using the harness's own wait/schedule mechanism; never block on a foreground `sleep`.
- `MERGED` → stop watching and run the cleanup steps below.
- `CLOSED` without a merge → stop watching and report to the user. Do not run cleanup: the worktree and branch still hold unmerged work, so leave them for the user to decide.
- `OPEN` → keep watching. Surface a state change worth acting on (failing checks, `CHANGES_REQUESTED`, merge conflict) to the user once, rather than re-reporting every poll.
- Stop watching when the user says so, and don't leave a watcher running after the PR resolves.

## Steps

Run these in order once a PR merge is confirmed, whether by the user, by the coordinating agent's own detection, or by watching the PR (above).

### 1. Mark the task complete (if one exists)

If the harness tracks this work as a task, find the task owned by the agent and mark it complete.

### 2. Remove the worktree

Worktrees live at `.worktrees/<branch-name>` inside the repo. Derive the branch name from the PR (the agent reports it on completion, or check the PR). Then:

```bash
git -C <repo-root> worktree remove --force .worktrees/<branch-name>
```

Use `--force` on the worktree remove only if the branch is already merged. Delete the local branch in step 3, after the pull.

### 3. Pull the merge into the local repo

Bring the merged change into the local repo so it doesn't lag behind the remote. Get `<base>` from the PR (`gh pr view <number> --json baseRefName -q .baseRefName`), then check which branch the main workspace is on:

```bash
git -C <repo-root> branch --show-current
```

- On `<base>`: fast-forward in place — `git -C <repo-root> pull --ff-only`.
- On any other branch: never switch branches in the main workspace without the user's permission. Update the local base ref only if it is not checked out anywhere (`git -C <repo-root> fetch origin <base>:<base>`), otherwise just `git -C <repo-root> fetch origin` and tell the user the base branch is behind.
- If `--ff-only` refuses (diverged local commits), stop and report; don't merge or rebase on the user's behalf.

Then delete the local branch if it still exists:

```bash
git -C <repo-root> branch -d <branch-name>
```

Never force-delete unmerged local branches.

### 4. Shut down the agent

Send the agent a stop/shutdown request through the harness's agent-messaging mechanism, addressed by name, and wait for its acknowledgment before reporting done to the user — don't assume it stopped just because the request was sent.

### 5. Persist progress-state (if ticket-scoped)

If this cleanup is for a ticket/issue-scoped background agent, invoke `agentic-memory-write`
to record the resolution before considering cleanup done — resolving a tracked task is one of
that skill's trigger conditions, and this is the last chance to do it before the agent shuts
down.

## Quick Reference

| Step | How | Key detail |
|------|------|-----------|
| Watch unmerged PR | `gh pr view --json state` on a schedule | stop on MERGED or CLOSED; cleanup only on MERGED |
| Mark task done | harness task tracker | mark it completed |
| Remove worktree | `git worktree remove` | `--force` only if merged |
| Pull merge locally | `git pull --ff-only` | only on `<base>`; never switch branches unasked |
| Delete local branch | `git branch -d` | after the pull; never `-D` on unmerged |
| Shutdown agent | harness agent-messaging | request stop, wait for acknowledgment |
| Persist progress-state | `agentic-memory-write` skill | only if ticket-scoped |

## Common Mistakes

- **Running cleanup on a `CLOSED` PR** — closed without merging means the work is unmerged; leave the worktree and branch alone and report.
- **Switching the main workspace's branch to pull** — pull only when it is already on the base branch; otherwise fetch and tell the user.
- **Deleting the branch before the worktree** — always remove the worktree first; git won't let you delete a branch with a live worktree.
- **Skipping task update** — if a task was tracking this work and stays open, it pollutes future task listings.
- **Forgetting to wait for the shutdown acknowledgment** — the agent may still be doing final writes; confirm termination before reporting clean.
