---
name: code-critic
description: >-
  Run an adversarial code review of a local diff or a GitHub PR, triage the findings by
  severity, and act on them — fix locally, or post inline PR review comments — delegating
  ALL GitHub and outbound-git work to a Haiku critic-worker while the main model (or the
  advisor) reasons. Use when the user wants to review, critique, or adversarially review
  their local changes / current diff / commits vs main; do a code review of a GitHub PR
  and comment on it; "red-team this diff"; or "critique PR N". This AUTHORS a review; for
  resolving reviewer comments already on a PR, use the resolve-pr-comments plugin instead.
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

## How to run

Execute the full, authoritative procedure in this plugin's command file:
**`${CLAUDE_PLUGIN_ROOT}/commands/code-critic.md`** — read it and follow every step in
order. That file is the single source of truth for the flow; do not improvise past it.

Outline (same steps): **0** arm the session-scoped guard marker (write
`$CLAUDE_CODE_SESSION_ID` into `.git/code-critic.lock`) + pick mode (local vs GitHub PR) →
**local:** choose base ref → YOU fetch + generate per-file diffs vs `origin/<base>` →
choose reviewer (advisor default / main) → adversarial review → severity-ranked numbered
findings with a succinct action each → choose how to work the list (one-by-one / fix all /
by severity) → apply fixes → optionally worker commits → optionally worker pushes.
**GitHub PR:** preflight + onboard the `github_pat` (Metadata:Read, Pull requests:R/W,
Contents:Read) → worker checks out a worktree (verify its handoff) → YOU diff in the
worktree vs `origin/<base>` → same review → issue-by-issue, take recommended action
(worker posts an inline PR comment) / skip / other → repeat → worker cleans up the
worktree. Always remove the review marker on exit.
