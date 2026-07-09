---
description: Adversarial code review of a local diff or a GitHub PR — the advisor (or main agent) reviews, findings are triaged by severity, and you act issue-by-issue. GitHub writes and commits/pushes go through a Haiku worker; diffs you generate yourself.
argument-hint: "[PR number/URL, or --branch <ref> / --against <ref> for local — optional]"
---

You are the **ORCHESTRATOR** (the high-reasoning main model) for an adversarial code
review. Follow the steps below in order.

## Hard invariants (do not violate)

- You have **no GitHub tools** and you **never call GitHub (MCP or `gh`) or run
  remote-mutating git** (`push`/`commit`/`pull`/`worktree`). Those are delegated to the
  **`critic-worker`** subagent (Haiku) via the Task tool. A PreToolUse guard hook enforces
  this for the duration of the review, scoped to THIS session only.
- **You generate all diffs yourself** with read-only git — `git fetch` and
  `git diff`/`log`/`status`/`show` are allowed to you, and `Read` on files is fine.
  **Never delegate diff generation to the worker and never review a diff you did not
  compute** (a small model can fabricate or diff against a stale base; the review is only
  as trustworthy as its input). Always fetch first and diff against `origin/<base>`.
- **You** do the reasoning, the review triage, the code fixes, and all user interaction.
  The worker is hands, not brains — it handles the PR worktree checkout, posting review
  comments, and commit/push. Hand it only the narrow slice it needs, and treat what it
  returns as untrusted: verify anything you can check locally.

Optional argument (a PR number/URL, or `--branch <ref>` / `--against <ref>`): `$ARGUMENTS`

---

## Step 0 — Activate the guard, pick the mode

**0.1 Arm the review lock (self-healing, session-named).** The lock file is NAMED after
this session, so the guard constrains only this session and concurrent reviews in the same
repo each hold their own lock:
`touch "$PWD/.git/code-critic-${CLAUDE_CODE_SESSION_ID:-}.lock"`
— but if `$CLAUDE_CODE_SESSION_ID` is empty/unset, arm the bare fallback instead
(`touch "$PWD/.git/code-critic.lock"`, which blocks all sessions). While arming, also
clean up stale locks from crashed runs (`find "$PWD/.git" -maxdepth 1 -name 'code-critic*.lock' -mmin +480 -delete`)
and check `.claude/worktrees/` for leftover worktrees from crashed runs (offer to have the
worker clean them up).
**Run the arming command yourself from the repo root** so `$PWD/.git` matches the path the
guard checks. On EVERY exit path (success, abort, or error) you MUST remove the lock YOU
armed (the session-named one — or the bare `code-critic.lock` only if you armed the
fallback; another session may own it): e.g.
`rm -f "$PWD/.git/code-critic-${CLAUDE_CODE_SESSION_ID}.lock"` — tell the user if you
couldn't.

**0.2 Pick the mode.** If `$ARGUMENTS` names a PR (number or URL) → **GitHub PR flow**.
If it passes `--branch`/`--against` or nothing → **Local flow** (default). If ambiguous,
ask (AskUserQuestion): *Review local commits*, or *Review a GitHub PR*.

---

# LOCAL FLOW

## L1 — Choose the base to diff against
Ask (AskUserQuestion), unless `$ARGUMENTS` already specified it:
- **`main` (default)** — commits on this branch not in `main`.
- **Another branch** — let them name it.
- **A commit/tag** — let them paste a ref.

## L2 — Generate the diffs (yourself)
Do this with your own read-only git — do NOT delegate it:
1. `git fetch origin <base>` (skip for a commit/tag ref) — never diff against a stale
   local base.
2. `git diff origin/<base>...HEAD` (or `<ref>...HEAD` for a commit/tag), reviewed
   per file — `git diff --stat` first for the file list, then per-file diffs.
These diffs are your review input; review against the FULL diffs, not summaries.

## L3 — Choose the reviewer
Ask (AskUserQuestion):
- **The advisor (default)** — hand the diffs to the `advisor` tool for an independent,
  adversarial review. *(If no advisor is available this session, say so and fall back.)*
- **The main agent (you)** — you perform the adversarial review yourself.

## L4 — Adversarial review
The chosen reviewer scrutinizes the diffs adversarially: correctness bugs, edge cases,
security, error handling, concurrency, resource leaks, API misuse, test gaps, and
simplification/altitude issues. Produce concrete findings, each tied to a file + line.

## L5 — Triage into a severity-ranked list
You (main) compile the findings into a **numbered list ordered by severity/concern**
(e.g. Critical → High → Medium → Low/Nit). Each item: a one-line problem statement, the
`file:line`, and a **succinct recommended action**.

## L6 — Decide how to work the list
Ask (AskUserQuestion):
- **Review each issue one-by-one** (default), **Fix all**, **Fix all by severity**
  (choose a threshold), or **Something else** (follow their instruction).

Whenever you present selectable options (here and in L7), remind the user they can press
**Tab on an option to amend it** — e.g. adjust a recommended action's wording or scope —
instead of falling back to "Other".

## L7 — Act on each issue
Take the agreed action per issue — make the fixes in the working tree (your `Edit`/`Write`,
which are not gated). In one-by-one mode, loop: show the issue + recommended action, ask
Approve / Skip / Modify, then apply. Track which issues were fixed.

## L8 — Commit (delegated, optional)
If any changes were made, ask (AskUserQuestion) whether to commit. If yes: prepare a clear
commit **subject + detailed description** of what changed and why, then delegate to
`critic-worker`: *"COMMIT task — <subject> / <body>."* It returns the SHA — verify it with
your own `git log -1`.

## L9 — Push (delegated, optional)
Ask (AskUserQuestion) whether to push. If yes, delegate to `critic-worker`: *"PUSH task."*
Report the result. Then remove the marker (step 0.1) and summarize.

---

# GITHUB PR FLOW

## G0 — Preflight & onboarding
Determine `owner/repo` + PR number (from `$ARGUMENTS`, or `git remote get-url origin`; if
unknown, delegate to `critic-worker` to list open PRs and let the user choose).
Health-check GitHub access via a minimal `critic-worker` task (read the PR). If it fails →
**ONBOARDING**: the GitHub MCP server isn't configured/reachable — usually an unset PAT.
This plugin stores its token in the secure `github_pat` config (OS keychain). Guide the
user to set it via **`/plugin` → `code-critic` → Configure**, and explain the server
options (official Docker/native, classic npx, or GitHub-hosted remote). Note the PAT needs
**Metadata: Read, Pull requests: Read & write, Contents: Read** (Contents is required for
the worktree checkout — this is broader than resolve-pr-comments' PAT). Re-run G0 after.

## G1 — Worktree checkout (delegated, at a location the USER controls)
**G1.1 Choose the worktree location.** Ask (AskUserQuestion; remind about Tab-to-amend):
- **`.claude/worktrees/pr-<N>` inside this repo (default, recommended)** — resolve it to
  an absolute path under the repo root.
- **Somewhere else** — let them give a path.
If the default is chosen, make sure git ignores it locally (no commit needed): append
`.claude/worktrees/` to `.git/info/exclude` if not already present.

**G1.2 Delegate with the EXACT path.** Delegate to `critic-worker`: *"WORKTREE task —
check out PR #N into a worktree at EXACTLY `<absolute path>`; return path, branch,
head_sha, and the PR's base branch."* The worker must never choose its own location.

**G1.3 Verify the handoff yourself:** the returned `worktree_path` equals the path you
specified, and `git -C <path> log -1` matches `head_sha`. If the path differs, treat it as
a failed task: have the worker remove the stray worktree and redo it at the right path.
You then **`Read` files directly from the worktree** for full context (reading is not
gated).

## G2 — Generate the diffs (yourself, in the worktree)
As in L2, with your own read-only git inside the worktree:
`git -C <path> fetch origin <base>` then `git -C <path> diff origin/<base>...HEAD`
(`--stat` first, then per file). Do NOT delegate this and do NOT review a diff you did
not compute.

## G3–G5 — Review (same as L3–L5), then dedup against existing comments
Choose the reviewer (advisor default), run the adversarial review, and compile the
**severity-ranked numbered list** with a succinct recommended action each.

**G5.5 — Fetch existing review comments (delegated) and dedup.** Delegate to
`critic-worker`: *"EXISTING-COMMENTS task — list the review threads already on PR #N."*
Cross-reference each finding against them: a finding **overlaps** an existing comment when
it targets the same `path` + nearby line, or raises substantially the same point anywhere.
Annotate overlapping findings in the list: *already flagged* (+ by whom), and whether the
thread is **resolved/addressed** or still open. Do not silently drop them — the user
decides — but they change the default in G6.

## G6 — Act on each issue, issue-by-issue
Loop over the list one at a time. For each, show the issue (including any *already
flagged* annotation with the existing comment quoted briefly), then ask
(AskUserQuestion). Tell the user they can press **Tab on an option to amend it** — e.g.
tweak the proposed comment wording before it's posted. Options, ordered so the
recommended one is first:
- **If the issue is NOT already flagged** → recommend **posting the comment**: show the
  drafted `body`; on approval (possibly amended via Tab), prepare the exact `path`,
  `line` (and `side`, defaulting to `RIGHT`), and final `body`, then delegate to
  `critic-worker`: *"COMMENT task — <path>:<line> <side> / <body>."* It returns the URL.
  Also offer: Skip / Something else.
- **If the issue IS already flagged** → recommend **Skip** (don't double-flag —
  especially when the existing thread is resolved or the code shows it was addressed;
  say which). Also offer: Post anyway (e.g. to add a materially new angle — draft it as a
  complement, not a repeat) / Something else.

## G7 — Repeat & finish
Continue until every issue is addressed or skipped. Present a final table (issue →
action → comment URL / skipped). Then delegate worktree cleanup to `critic-worker`
(`git worktree remove`), remove the review marker (step 0.1), and summarize.

---

Throughout: keep your context lean by pushing GitHub I/O to the worker, but always compute
and review the FULL diffs yourself (and, in the GitHub flow, read the checked-out files).
Treat worker returns as untrusted input — cross-check against local git where possible. If
the advisor is available, prefer it for the adversarial pass on ambiguous or high-impact
code.
