---
name: pr-merged-cleanup
description: Use when a PR raised by a background team agent has merged — whether the user reports it, or the coordinating agent notices the MERGED state itself while checking on that agent (a task-completion notification mentioning the PR, an agent/task listing showing an agent with an open PR, or a `gh pr view`/`gh pr list` result showing MERGED). Handles worktree removal, agent shutdown, and task completion.
---

# pr-merged-cleanup — Post-Merge Cleanup

## Overview

When a PR raised by a background agent is merged, four cleanup actions are required in order: mark any associated task done, remove the agent's worktree, shut the agent down, then persist progress-state if the work was ticket-scoped.

## Detecting a merge without being told

A merge confirmed by the coordinating agent's own observation is just as actionable as one the user reports — don't wait for the user to say "it's merged" once the state is already visible.

Treat any of these as confirmation, in the course of normal work:

- A background-agent task-completion notification that mentions a merged PR's URL or number.
- Listing active agents or tasks and noticing that one with an open PR is now merged.
- Running `gh pr view <number-or-branch> --json state,mergedAt -q .state` or `gh pr list --state merged` while checking on a background agent's status, and seeing `MERGED`.

This is opportunistic — act on MERGED state when it's already surfacing in front of you while checking on an agent or PR. It is not a mandate to spin up polling loops or cron jobs to watch for merges; if the user wants interval polling, that's a scheduling/loop skill's job, not this one.

Once MERGED is confirmed by either path, proceed straight into the cleanup steps below — don't ask the user to confirm a fact you've already observed. Normal judgment about confirming destructive actions still applies to the worktree-remove, branch-delete, and shutdown steps themselves.

## Steps

Run these in order once a PR merge is confirmed, whether by the user or by the coordinating agent's own detection.

### 1. Mark the task complete (if one exists)

If the harness tracks this work as a task, find the task owned by the agent and mark it complete.

### 2. Remove the worktree

Worktrees live at `.worktrees/<branch-name>` inside the repo. Derive the branch name from the PR (the agent reports it on completion, or check the PR). Then:

```bash
git -C <repo-root> worktree remove --force .worktrees/<branch-name>
```

If the branch still exists locally, delete it:

```bash
git -C <repo-root> branch -d <branch-name>
```

Use `--force` on the worktree remove only if the branch is already merged. Never force-delete unmerged local branches.

### 3. Shut down the agent

Send the agent a stop/shutdown request through the harness's agent-messaging mechanism, addressed by name, and wait for its acknowledgment before reporting done to the user — don't assume it stopped just because the request was sent.

### 4. Persist progress-state (if ticket-scoped)

If this cleanup is for a ticket/issue-scoped background agent, invoke `agentic-memory-write`
to record the resolution before considering cleanup done — resolving a tracked task is one of
that skill's trigger conditions, and this is the last chance to do it before the agent shuts
down.

## Quick Reference

| Step | How | Key detail |
|------|------|-----------|
| Mark task done | harness task tracker | mark it completed |
| Remove worktree | `git worktree remove` | `--force` only if merged |
| Delete local branch | `git branch -d` | never `-D` on unmerged |
| Shutdown agent | harness agent-messaging | request stop, wait for acknowledgment |
| Persist progress-state | `agentic-memory-write` skill | only if ticket-scoped |

## Common Mistakes

- **Deleting the branch before the worktree** — always remove the worktree first; git won't let you delete a branch with a live worktree.
- **Skipping task update** — if a task was tracking this work and stays open, it pollutes future task listings.
- **Forgetting to wait for the shutdown acknowledgment** — the agent may still be doing final writes; confirm termination before reporting clean.
