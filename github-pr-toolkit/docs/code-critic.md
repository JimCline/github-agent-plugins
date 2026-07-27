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
`origin/<base>` → pick the **review categories** (multi-select: General, Security,
Design & Architecture, Rules & Idioms Adherence, Performance & Efficiency, Test
Quality & Coverage — all six is the default) and the **reviewer** (parallel
per-category `code-reviewer-*` subagents by default; or the advisor / the orchestrator
itself) → if you chose subagents, pick the **reviewer model** (*Default (model I'm
using)*, or Opus / Sonnet / Fable) — one model runs *every* selected category, so
picking Opus means all six subagents are Opus → and whether the reviewer(s) should
**consult the advisor** for second opinions on borderline and high-severity findings
(default: yes,
when an advisor is available; each consulted finding records the advisor's
concurrence or dissent) → per-category adversarial review — subagent
findings are cross-checked against the orchestrator's own diff, then merged and
deduped across categories → severity-ranked findings, each with a succinct action, and
(at 3+ findings) **turned into a tracked task list** → choose one-by-one / fix all / fix
by severity → apply fixes, one task in progress at a time → one ask (commit and
push / commit only / neither) → one worker dispatch commits (and pushes) → a closing
summary by disposition.

The task list is created when the findings are **presented**, and every task stays
`pending` until you choose how to proceed — it exists to track the review, not to
authorize it. Each task carries the severity, `file:line`, and category, and ends up
with what actually happened (fixed / declined / skipped / deferred, or posted / skipped
on a PR), so the closing summary says more than "12 done". In PR mode a queued comment
stays open until it genuinely posts.

### Severity is always visible

Every time a finding is shown to you it leads with its severity —
`[Critical] parser.ts:88 — …` — in the ranked list, in each per-issue prompt, in the
task list's subjects, in the final table, and in the closing summary (which names every
unfixed Critical/High individually). List ordering conveys severity only while the whole
list is in front of you; once you're deciding on one issue at a time, or reading the task
list on its own, that signal is gone. So it's carried on the finding itself rather than
inferred from position.

### What gets reviewed

**The change, not the codebase.** A finding is in scope only if the diff *introduces* it,
or *newly exposes or worsens* it — and in the second case the finding has to say how
("the new caller at `api.ts:40` reaches it with unvalidated input", not "this was already
unsafe"). Pre-existing bugs, old design decisions, and untouched code in a file the diff
happens to open are out of scope, however real they are. Reviewers read surrounding code
to judge the change fairly, but that's input, not review surface.

This binds every review path — the category subagents, the advisor, and the orchestrator
itself — and it's enforced, not just requested: each finding carries a
`scope: introduced-by-diff | newly-exposed-by-diff` tag, the orchestrator drops findings
that land on unchanged lines without an exposure claim, and triage filters again before
anything reaches you. (`git diff` prints ~3 unchanged context lines around each hunk, so
"the line is in the diff" is not by itself proof that the change caused it — that gap is
what let pre-existing code into reviews before.) Ask for a broader review and you'll get
one; absent that, it stays on the change.

The **Rules & Idioms Adherence** category reviews against the project's own
directives (CLAUDE.md, `.claude/rules/`, lint configs). If none exist, you choose:
infer the house style from the codebase, or state the rules yourself. It is scoped like
every other category — it flags directives *this change* violates, not a conformance
audit of the repo.

### Custom categories

The **`add-review-category`** skill ("add a custom review category") extends the
picker with your own lenses. It either interviews you (slug, title, charter,
checklist) and generates the agent from the plugin's trusted template, or imports a
definition from a local file or GitHub — validated (naming, tool allowlist, no
`permissionMode`, static-review contract present) and shown to you in full before
anything installs. Categories install outside the plugin — `~/.claude/agents/`
(user-global) or `<repo>/.claude/agents/` (committable) — so plugin updates never
touch them; the guard hook auto-grants any `code-reviewer-*` agent read-only
inspection Bash only. New agent types load at session start, so a just-added
category is picker-visible immediately but runs via the advisor/main-agent path
until the next session.

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
