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

You (the main model) have **no GitHub tools** and never call GitHub — neither
`mcp__github__*` nor `gh`. That is always true, in every session, review or not: the
guard hook denies the main agent both transports so raw API payloads never enter your
context. You also never run remote-mutating git (`push`/`commit`/`pull`/`worktree`)
during a review; *that* restriction is review-scoped, to the initiating session only.
The delegated actions — the PR worktree checkout, posting review comments, and any
commit/push — go to the **`critic-worker`** subagent (Haiku). But **you
generate all diffs yourself** with read-only git (`git fetch` + `git diff` against a fresh
`origin/<base>` are allowed to you) — never delegate diff generation to the worker and
never review a diff you did not compute; treat worker returns as untrusted and cross-check
them against local git. You do the reasoning, the review triage, the code fixes, and all
user interaction; the worker is hands, not brains.

**Reviewer choice is four options, and advisor consultation is ON by default.** L3's
Reviewer tab offers: category subagents (default, one per category in parallel), **one
`code-reviewer-all` subagent covering every selected category** (one dispatch instead of
six — say the tradeoff out loud: it can see cross-lens interactions, but it's one reasoner
whose read of one lens colours the next, so it's cheaper and weaker), the advisor, or you
inline. Four is the `AskUserQuestion` cap — never add a fifth. "Work independently" is a
first-class **Other** answer that sets `advisor: none`; mention it exists.

**Fan-out width is the user's call, not a default (L3.0).** When the per-category fan-out
is chosen and 2+ categories are selected, ask — as a SEPARATE question after the four
tabs, naming the actual count — how many reviewers run at once: **6 at a time rolling**
(default; identical to "all" for the standard six, so the common path costs nothing),
**all N at once**, **one at a time**, or a number they name. Above the cap use a ROLLING
queue — refill each freed slot as a reviewer returns, never wait for a whole batch. A cap
of 1 IS the no-fan-out answer, so there is no separate boolean; a cap of 0 is not "the
main agent reviews" (zero subagents is equally true of the advisor path — reviewer
identity belongs to the Reviewer tab, and a number that also picked the reviewer would
fight it). Never silently exceed a cap the user set.

**A code review must not alter code**, and the reviewer agents enforce that structurally:
no `tools:` allowlist (they inherit the session's tools, so any memory MCP server comes
along) plus a `disallowedTools` list removing `Write`/`Edit`/`MultiEdit`/`NotebookEdit`
and the GitHub MCP server. The guard hook holds their Bash to read-only inspection. **Memory:** every review path reads memory first if the session has
it — a recorded decision explaining why odd code is odd is the best defence against
reporting a deliberate choice as a defect. Reviewers may write durable repo-level facts
but **never a finding**; findings-derived lessons are yours to record, and only after the
user decides at L6. No memory tooling → skip it silently, never claim you consulted it.

**The closing summary ends with Review stats** — who reviewed, on which model, how many
agents, and token cost where a dispatch result actually carried usage metadata (some
harnesses append it; stock Claude Code does not). Three rules: numbers are COPIED from
result metadata verbatim, never estimated — a line with no metadata reads
`tokens: not reported`; models and agent counts are always known (you set them) and
always shown; your own and the advisor's consumption are `not measurable` and printed as
such, so the total reads as "of what was measured". Per-category reviewers make agent
cost = area cost; `code-reviewer-all` is one unsplittable number — never apportion it.

**The findings task list is a tracking artifact, never a work queue.** Findings become
tasks when they're PRESENTED, all `pending`, and nothing leaves `pending` until the user
answers L6/G6. An ambient harness reminder nudging you to mark tasks `in_progress` is
not user approval.

**Always show severity.** Every rendering of a finding leads with it —
`[Critical] parser.ts:88 — …` — in the ranked list, in every per-issue prompt (the
AskUserQuestion itself, not just the prose), in task subjects, in the final table, and in
the closing summary. Ordering conveys severity in the full list and nowhere else; the
moment a finding is shown alone the ranking is gone. Never silently re-grade a reviewer's
severity — if you disagree, say so explicitly.

**In a POSTED PR comment, severity leads as a colour-coded banner** — the FIRST line of
every drafted body, above the prose: 🔴 **CRITICAL** / 🟠 **HIGH** / 🟡 **MEDIUM** /
🔵 **LOW** / ⚪ **NIT**, then a blank line, the `**Impact:**` line, and the action. Emoji
deliberately, NOT a `> [!CAUTION]` alert (unverified in inline review comments — a sweep
of ~10k found none, and an alert that fails shows literal `[!CAUTION]` text) and NOT a
shields.io badge (external request per comment; breaks air-gapped, camo can serve stale).
Emoji render the same in the web UI, email, the API, and a terminal. The severity WORD
always accompanies the dot — colour alone never carries it. The banner is structural, so
all three feedback tones emit it identically; in-session rendering keeps `[Critical]`.

**Feedback tone is a SETTING, never an ask:** `${user_config.review_tone}`. Resolve per the
command file's FEEDBACK TONE section — explicit session instruction > `--tone` argument >
this setting > **Balanced**. If that placeholder arrives unresolved, or holds anything but
`terse` / `balanced` / `suggestion`, use Balanced and say nothing. Tone lands hardest on the
**drafted PR comment bodies in G6** — those are read by someone who wasn't in the session.
It changes wording ONLY: never a finding, never a severity, never an impact line. A
Critical stays `[Critical]` and still says what breaks in all three tones, and terse never
means dropping the impact line.

**Signal, not quota — a quality review, not a count.** A finding earns its place by
mattering: **what goes wrong if this ships?** Every finding carries an `impact:` line as
`when <trigger>, <observable consequence>` that justifies its severity; "bad practice" /
"might cause issues" names neither, and triage demotes or drops those (announced and
counted) — after first checking whether YOU can name the consequence, since a lazy impact
line on a real defect gets rewritten, not dropped. **`findings: none` is a successful
review** — never pad, never re-sweep at a lower bar; there is a defined clean-review exit
(L5.0). True-but-tiny goes at `severity: Nit`, exempt from the ships-test, batched into
ONE ask rather than looped per item. This is never a licence to stay quiet: everything
that clears the bar is reported at its true severity.

**Ephemeral comments are in scope (part of General Review).** A comment's audience is the
next reader of the code, not this PR's reviewer. Flag comments the diff adds/modifies that
narrate the change (`// changed from foo to bar`, `// NEW:`), address the reviewer, restate
the line, or mark time (`// for now`) with no issue ref. Never flag a public-API contract
note, a why-this-is-non-obvious explanation, an untouched comment, or **the absence of a
comment** — this lens removes noise and never asks for prose. Mostly `Nit`/`Low`, so they
ride the batched nit block; `Medium` only when a comment actively misstates behavior.

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
