# code-critic

**Adversarially review a local diff or a GitHub PR — then act on the findings.**

> **Companion to [resolve-pr-comments](../README.md), not a duplicate.** resolve-pr-comments
> *resolves* the review threads reviewers already opened. code-critic **authors** the
> review: it critiques a diff, triages the findings by severity, and either fixes them
> locally or posts inline review comments on the PR.

Same clean split of labor as its sibling:

- **A higher-reasoning agent (the orchestrator)** — or, by default, **the `advisor`** —
  performs the adversarial review, then the orchestrator triages findings and drives you
  through them issue-by-issue. The orchestrator has **no GitHub tools**, but it
  **generates every diff itself** with read-only git (`git fetch` + `git diff` against a
  fresh `origin/<base>`) — the review is only as trustworthy as its input, so diffs are
  never delegated to a small model.
- **Haiku (`critic-worker`)** does the GitHub writes and repo mutations: the PR worktree
  checkout, posting inline review comments via the GitHub MCP server, and any
  `git commit`/`push`. It hands back short, verifiable results that the orchestrator
  cross-checks against local git.

A **PreToolUse guard hook** enforces the split for the duration of a review: it blocks the
main agent from `mcp__github__*`, `gh`, and remote-mutating git (`push`/`commit`/`pull`/
`worktree`) and tells it to delegate; `git fetch` and read-only git stay allowed. The
guard is inert outside an active review and **scoped to the initiating session**: the
self-healing lock file is *named* after that session
(`.git/code-critic-<session_id>.lock`), so other Claude Code sessions in the same repo are
never blocked — and two concurrent reviews each hold their own lock.

---

## Usage

```
/code-critic                      # review local commits vs main (default)
/code-critic --branch develop     # review local commits vs another branch
/code-critic --against v1.2.0     # review local commits vs a tag/commit
/code-critic 1234                  # review GitHub PR #1234 (worktree + inline comments)
```

Or just ask in natural language ("review my local changes", "critique PR 1234") — the
`code-critic` skill triggers the same flow.

### Flow

**Local:** pick a base → orchestrator fetches and generates per-file diffs vs
`origin/<base>` → pick the reviewer (advisor default) → adversarial review →
severity-ranked findings, each with a succinct action → choose one-by-one / fix all /
fix by severity → apply fixes → optionally worker commits → optionally worker pushes.

**GitHub PR:** preflight/onboard the PAT → worker checks out a worktree (orchestrator
verifies the handoff) → orchestrator diffs in the worktree vs `origin/<base>` → same
review → worker lists the PR's existing review threads and findings are deduped against
them (an already-flagged issue — especially one already resolved/addressed — gets **Skip**
as the recommended option instead of double-flagging) → issue-by-issue: post the comment /
skip / other, with Tab-to-amend on the proposed wording → repeat → worker cleans up the
worktree.

---

## Requirements

Same as resolve-pr-comments (recent Claude Code, a GitHub MCP server, Docker for the
default server, `gh` optional), **plus a PAT with a broader scope**:

| Fine-grained PAT scope | Why |
|---|---|
| **Metadata: Read** | Base access |
| **Pull requests: Read & write** | Read the diff; post inline review comments |
| **Contents: Read** | Check out the PR branch into a worktree |

Set the token in **`/plugin` → `code-critic` → Configure** (stored in your OS keychain as
`github_pat`). This is a **separate** config from resolve-pr-comments — you set the PAT
once per plugin.
