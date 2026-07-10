# /code-critic (github-pr-toolkit)

**Adversarially review a local diff or a GitHub PR — then act on the findings.**

> **Companion to [`/resolve-pr-comments`](../README.md), not a duplicate.** That command
> *resolves* the review threads reviewers already opened. code-critic **authors** the
> review: it critiques a diff, triages the findings by severity, and either fixes them
> locally or posts inline review comments on the PR. Both ship in the
> **github-pr-toolkit** plugin and share its setup, PAT, and architecture — see the
> [main README](../README.md) for installation.

Same clean split of labor as /resolve-pr-comments:

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

A **PreToolUse guard hook** enforces the split. The plugin's GitHub MCP tools
(`mcp__plugin_github-pr-toolkit_github__*`) are **always** denied to the main agent and
granted to the workers. The Bash rules — `gh` and remote-mutating git
(`push`/`commit`/`pull`/`worktree`) blocked, `git fetch` and read-only git allowed —
apply only for the duration of a review and are **scoped to the initiating session**:
the self-healing lock file is *named* after that session
(`.git/code-critic-<session_id>.lock`), so other Claude Code sessions in the same repo
are never blocked — and two concurrent reviews each hold their own lock.

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
fix by severity → apply fixes → one ask (commit and push / commit only / neither) →
one worker dispatch commits (and pushes).

**GitHub PR:** preflight/onboard the PAT → choose the worktree location (default:
`.claude/worktrees/pr-<N>` inside the repo, excluded via `.git/info/exclude`; or a path
you pick) → **one** worker dispatch checks out a worktree at exactly that path *and*
returns the PR's existing review threads (orchestrator verifies the handoff, path
included) → orchestrator diffs in the worktree vs `origin/<base>` → same review →
findings are deduped against the existing threads (an already-flagged issue — especially
one already resolved/addressed — gets **Skip** as the recommended option instead of
double-flagging) → issue-by-issue: queue the comment / skip / other, with Tab-to-amend
on the proposed wording (nothing posts mid-loop) → **one** final worker dispatch
publishes every approved comment as **a single PR review** and removes the worktree.

Batching everything into ~3 worker dispatches keeps the orchestrator's context lean:
each dispatch carries fixed harness overhead (and, under the context-mode plugin, a
~1.1k-token injected routing block), so the flow pays it three times instead of once
per finding — and the PR gets one review event instead of N single-comment reviews.

---

## Requirements

Same as the rest of the toolkit (recent Claude Code; the GitHub MCP server is GitHub's
hosted remote, connected directly from the plugin's `.mcp.json` — nothing to install;
`gh` optional). The PAT scope `/code-critic` specifically needs beyond
`/resolve-pr-comments`:

| Fine-grained PAT scope | Why |
|---|---|
| **Metadata: Read** | Base access |
| **Pull requests: Read & write** | Read the diff; post inline review comments |
| **Contents: Read** | Check out the PR branch into a worktree |

Set the token in **`/plugin` → `github-pr-toolkit` → Configure** (stored in your OS
keychain as `github_pat`) — **once for the whole toolkit**; both commands share it.
**Re-enter it after Claude Code restarts or plugin upgrades if GitHub access breaks**
(sensitive config values can be lost — claude-code#62442); an empty PAT surfaces as
`No such tool available: mcp__plugin_github-pr-toolkit_github__*`. Run
**`/github-pr-toolkit:doctor`** to verify the MCP wiring for both workers without
starting a review.
