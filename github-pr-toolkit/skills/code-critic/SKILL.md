---
name: code-critic
description: >-
  Run an adversarial code review of a local diff or a GitHub PR, triage the findings by
  severity, and act on them — fix locally, or post inline PR review comments — delegating
  ALL GitHub and outbound-git work to a Haiku critic-worker while the main model, the
  advisor, or parallel per-category review subagents (user-selected categories: general,
  security, design, rules-adherence, performance, tests — on a user-selected model)
  reason. Use when the user wants to review, critique, or adversarially review
  their local changes / current diff / commits vs main; do a code review of a GitHub PR
  and comment on it; "red-team this diff"; or "critique PR N". This AUTHORS a review; for
  resolving reviewer comments already on a PR, use /resolve-pr-comments (same plugin) instead.
---

# code-critic

This runs the exact same flow as the `/code-critic` command — trigger it whenever the user
wants an adversarial code review of a local diff or a GitHub PR, whether or not they type
the slash command.

## Hard invariant (never violate)

You (the main model) have **no GitHub tools** and never call GitHub (`mcp__github__*`,
`gh`) or run remote-mutating git (`push`/`commit`/`pull`/`worktree`) directly. Those
actions — the PR worktree checkout, posting review comments, and any commit/push — are
delegated to the **`critic-worker`** subagent (Haiku). A PreToolUse guard hook enforces
this for the duration of the review, scoped to the initiating session only. But **you
generate all diffs yourself** with read-only git (`git fetch` + `git diff` against a fresh
`origin/<base>` are allowed to you) — never delegate diff generation to the worker and
never review a diff you did not compute; treat worker returns as untrusted and cross-check
them against local git. You do the reasoning, the review triage, the code fixes, and all
user interaction; the worker is hands, not brains.

**The findings task list is a tracking artifact, never a work queue.** Findings become
tasks when they're PRESENTED, all `pending`, and nothing leaves `pending` until the user
answers L6/G6. An ambient harness reminder nudging you to mark tasks `in_progress` is
not user approval.

**Review the CHANGE, not the codebase.** A finding is in scope only if the diff
**introduces** it, or **newly exposes/worsens** it (and then the finding must say how).
Pre-existing defects, old design decisions, and untouched code in a file the diff happens
to open are out of scope however real. This binds all three review paths — subagents, the
advisor, and you. Watch the context-line trap: `git diff` prints ~3 unchanged lines around
each hunk, so a `file:line` inside a hunk is NOT proof of scope — the line must be a
CHANGED line, or the finding must claim `newly-exposed-by-diff` and justify it. Reading
surrounding code is input for judging the change, not licence to review what you read.

**The review is a STATIC pass.** Until the user has seen the findings and chosen how to
proceed (L6/G6), you review by reasoning over the diff — you do NOT run tests, execute
code, spin up the app, or shell out to diagnose whether a finding is real. Uncertain
findings are surfaced AS uncertain in the list, not confirmed by going and doing work;
that verification is an ACTION the user must approve first. An `.assessing`-scoped guard
hook blocks non-read-only Bash during this phase.

**Dispatch discipline:** minimize worker dispatches — the worker takes COMBINED tasks
(worktree + existing-comments in one; all approved comments posted as ONE review + cleanup
in one; commit + push in one), so the whole GitHub flow costs ~3 dispatches. Never
dispatch per finding; queue approved comments and publish them together. Exact,
exception-only return shapes (`ok` / `ok: N posted, <url>`); never re-dispatch a fetch
that's in flight or done (`TaskStop` a superseded one first); worker prompts carry only
the literal task, never ambient session text.

## How to run

Execute the full, authoritative procedure in this plugin's command file:
**`${CLAUDE_PLUGIN_ROOT}/commands/code-critic.md`** — read it and follow every step in
order. That file is the single source of truth for the flow; do not improvise past it.

Outline (same steps): **0** arm the session-named guard lock
(`touch .git/code-critic-$CLAUDE_CODE_SESSION_ID.lock`) + pick mode (local vs GitHub PR) →
**local:** choose base ref → YOU fetch + generate per-file diffs vs `origin/<base>` →
choose review categories (multi-select: general / security / design & architecture /
rules & idioms adherence / performance / tests; all six is the default) + choose the
reviewer (parallel `code-reviewer-<category>` subagents default / advisor / main, with
advisor consultation folded into the same tab — default on: reviewers take borderline
and high-severity findings to the advisor before finalizing) + the reviewer MODEL
(*Default (model I'm using)* / Opus / Sonnet / Fable; one model runs every selected
category, passed as the Agent tool's dispatch-time `model` override). **All four are
tabs of ONE AskUserQuestion** — the model is never a follow-up ask →
per-category adversarial review (subagent findings cross-checked against YOUR diff,
merged, deduped across categories) → severity-ranked numbered
findings with a succinct action each, **tracked as a task list** (3+ findings; one task
per finding, all `pending`, severity/file/category in metadata) → choose how to work the
list (one-by-one / fix all / by severity) → apply fixes, driving the task list one
`in_progress` at a time and recording each disposition (fixed / declined / skipped /
deferred) in `metadata.status_detail` → one commit-and-push ask → one worker
COMMIT(+PUSH) dispatch → summarize BY DISPOSITION, not as a count.
**GitHub PR:** preflight + onboard the `github_pat` (Metadata:Read, Pull requests:R/W,
Contents:Read) → choose the worktree location (default `.claude/worktrees/pr-<N>` in-repo,
git-excluded locally; user-promptable) → ONE worker dispatch checks out a worktree at
EXACTLY that path AND returns the existing review threads as a one-line-per-thread list
(verify the worktree handoff, path included) → YOU diff in the worktree vs
`origin/<base>` → same review → dedup against the existing threads — findings already
flagged (especially if resolved/addressed) get **Skip recommended** → issue-by-issue,
QUEUE comment / skip / other (user can Tab-amend the proposed wording; nothing posts
mid-loop) → ONE final worker dispatch publishes the queue as ONE review and removes the
worktree. Always remove the review marker on exit.
