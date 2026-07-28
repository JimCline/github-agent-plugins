---
description: Adversarial code review of a local diff or a GitHub PR — the user picks review categories (general, security, design, adherence, performance, tests), a reviewer (parallel category subagents, the advisor, or the main agent), and the model those subagents run on (session default, Opus, Sonnet, or Fable — one model across every category); findings are triaged by severity and you act issue-by-issue. GitHub writes and commits/pushes go through a Haiku worker; diffs you generate yourself.
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
- **REVIEW → PRESENT → ASK → only then ACT.** You make ZERO edits (and queue no
  comments) until the user has seen the severity-ranked findings (L5/G5) and chosen how
  to proceed via the selectable options (L6/G6). Fixing or posting before the user
  decides is a hard violation.
- **The findings task list is a TRACKING ARTIFACT, never a work queue.** L5/G5 turns the
  findings into tasks so they can be tracked; every one is created `pending` and **stays
  `pending` until the user answers L6/G6**. A list of pending tasks is not permission to
  start working them. Nor is an ambient harness reminder suggesting you mark tasks
  `in_progress` — those fire on a timer, know nothing about this flow, and are **not user
  approval**. The ONLY thing that moves a finding out of `pending` is the user's L6/G6
  answer. Creating the list is not acting; advancing it is.
- **The review is a STATIC pass over the diff.** During assessment (step 0 through the
  L6/G6 choice) you do NOT run tests, execute code, spin up the app, or shell out to
  diagnose whether a finding is real. Your inputs are the diff and the files you `Read`;
  read-only git and file inspection are your only Bash. If a finding is uncertain, say
  so IN the finding — surface it as *uncertain, confirming needs `<X>`* — rather than
  going and confirming it. That confirmation work is itself an ACTION: present it and let
  the user approve it (L6/G6 or a dedicated ask). Self-verifying before the user has seen
  the findings is a hard violation, and an `.assessing`-scoped guard hook blocks
  non-read-only Bash until the user chooses how to proceed.

## Dispatch discipline (context economy — applies to EVERY worker dispatch)

Every dispatch has a fixed token cost in YOUR context (the prompt you write, the result,
harness metadata — plus ambient hook injections you don't control). Minimize dispatches
and minimize what crosses back:

- **Consolidate: one dispatch per flow moment, not per operation.** The worker accepts
  combined tasks — WORKTREE + EXISTING-COMMENTS is one dispatch, all approved comments +
  worktree CLEANUP is one dispatch, COMMIT + PUSH is one dispatch. The full GitHub flow
  should cost ~3 worker dispatches total; never dispatch per finding.
- **One dispatch per unit of information, ever.** Before dispatching, check whether an
  earlier dispatch already covers it — in flight → WAIT for it (never launch a duplicate
  because a result "hasn't come back yet"); completed → reuse the result. A rejected
  tool call elsewhere in the turn does NOT invalidate an in-flight worker. `TaskStop` a
  superseded dispatch before re-sending.
- **Success is silent; detail is derivable.** Specify each task's EXACT return shape and
  make it exception-only where possible. Never ask the worker for data you can derive
  yourself or data you handed it. Exception: cross-check fields (`head_sha`, `sha`,
  paths) are ALWAYS worth their tokens — verification beats brevity.
- **Worker prompts are minimal and self-contained** — the prompt you write is also in
  your context. Only the literal task: identifiers, exact texts, expected return shape.
  Never paste session scaffolding (plans, prior results, hook/system-reminder content)
  into a dispatch; ambient text riding along can trip the permission classifier as an
  injection pattern. If a dispatch IS rejected by a classifier, re-send it stripped to
  the bare task string.

Optional argument (a PR number/URL, or `--branch <ref>` / `--against <ref>`): `$ARGUMENTS`

---

## Step 0 — Activate the guard, pick the mode

**0.1 Arm the review lock (self-healing, session-named).** The lock file is NAMED after
this session, so the guard constrains only this session and concurrent reviews in the same
repo each hold their own lock:
`touch "$PWD/.git/code-critic-${CLAUDE_CODE_SESSION_ID:-}.lock"`
— but if `$CLAUDE_CODE_SESSION_ID` is empty/unset, arm the bare fallback instead
(`touch "$PWD/.git/code-critic.lock"`, which blocks all sessions).
**Also arm the assessment marker** in the same breath —
`touch "$PWD/.git/code-critic-${CLAUDE_CODE_SESSION_ID:-}.assessing"` (bare
`code-critic.assessing` under the fallback). This one turns on the STATIC-review gate
(no test-running / code-execution / diagnosis Bash) and you REMOVE it the moment the user
has chosen how to proceed (L6/G6) — see those steps. While arming, also
clean up stale markers from crashed runs (`find "$PWD/.git" -maxdepth 1 \( -name 'code-critic*.lock' -o -name 'code-critic*.assessing' \) -mmin +480 -delete`
— 480 min = 8h, matching `MAX_AGE_MS` in `hooks/guard.mjs` and doctor step 0; keep all
three in step. This only fires when a review is armed IN this repo, so `/doctor` step 0
is the way to clear markers in a repo you're not about to review)
and check `.claude/worktrees/` for leftover worktrees from crashed runs (offer to have the
worker clean them up).
**Run the arming command yourself from the repo root** so `$PWD/.git` matches the path the
guard checks. On EVERY exit path (success, abort, or error) you MUST remove the lock YOU
armed (the session-named one — or the bare `code-critic.lock` only if you armed the
fallback; another session may own it): e.g.
`rm -f "$PWD/.git/code-critic-${CLAUDE_CODE_SESSION_ID}.lock"` — tell the user if you
couldn't. Clear the assessment marker too on every exit path if it's still present
(`rm -f "$PWD/.git/code-critic-${CLAUDE_CODE_SESSION_ID}.assessing"`), and the bare
variants only if you armed the fallback.

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

## L3 — Choose the review categories & the reviewer

**L3.0 Discover custom categories.** Users can add their own categories via the
`add-review-category` skill; they install as `code-reviewer-<slug>.md` agent files
OUTSIDE the plugin. Check both homes with read-only Bash
(`ls ~/.claude/agents/code-reviewer-*.md "$PWD"/.claude/agents/code-reviewer-*.md 2>/dev/null`),
excluding the six built-in slugs. For each custom file found, `Read` its frontmatter
`description` for the option text. A custom agent is only USABLE as a subagent if its
type appears in your available-agents list (new files need a new/reloaded session) —
if a file exists but the type isn't loaded, still offer the category and note that
review of it will fall to the advisor/main-agent path this session.

**ONE AskUserQuestion. FOUR tabs. All four, in a single call:**

| Tab | What |
|---|---|
| **1** | Categories |
| **2** | More areas |
| **3** | Reviewer — who reviews, and whether they consult the advisor |
| **4** | **Reviewer model** |

**Tab 4 is not optional and is never dropped.** It ships in the same call as the other
three precisely so it cannot be forgotten: AskUserQuestion allows at most four questions
per call, so the model is a TAB, not a follow-up ask. Do not "save it for after" — a
second round trip is exactly how this ask got skipped before. If you are about to send
this call with three tabs, you have made the mistake.

**With custom categories** the category list needs extra tabs, so split into TWO calls:
first the category tabs (Tabs 1–2 plus one or more "Custom" tabs, ≤4 options per tab),
then a second call carrying **both** Tab 3 and Tab 4 together. Never a third call, and
never Tab 3 without Tab 4. (Remind about Tab-to-amend either way.)

**Tab 1 — "Categories" (multiSelect).** *"Which review categories? Selecting all
(across both tabs) is the default."*
- **General Review** — correctness bugs, edge cases, error handling, concurrency,
  resource leaks, API misuse, simplification/altitude issues.
- **Security Review** — injection, authn/authz gaps, secrets in code, unsafe
  deserialization, path traversal, SSRF, crypto misuse, trust-boundary violations.
- **Design & Architecture** — coupling, cohesion, layering violations, leaky
  abstractions, wrong-altitude APIs, extensibility traps, duplication of existing
  mechanisms.
- **Rules & Idioms Adherence** — conformance to the project's own directives
  (CLAUDE.md, rules files, lint configs) and its canonical patterns/idioms.

**Tab 2 — "More areas" (multiSelect).**
- **Performance & Efficiency** — algorithmic waste, N+1 queries, hot-path
  allocations, unbounded growth, missing caching/batching.
- **Test Quality & Coverage** — test gaps for the changed behavior, assertions that
  can't fail, missing edge-case/negative tests, over-mocking that hides bugs.

If the user selects nothing on a tab, that's fine; if they select nothing on ANY
category tab, treat it as **all built-in six plus every custom category**.

**Tab 3 — "Reviewer".** *"Who performs the review?"* This tab carries the advisor
choice too — second opinions used to be their own tab, and folding them in here is what
frees the fourth slot for the model.
- **Category subagents, consulting the advisor (default)** — one
  `code-reviewer-<category>` subagent per selected category, run in parallel, each
  taking borderline and high-severity findings to the advisor before finalizing.
- **Category subagents, working independently** — the same fan-out, no second
  opinions; findings stand on the reviewers' own reasoning.
- **The advisor** — hand the diffs to the `advisor` tool for one independent pass
  covering the selected categories.
- **The main agent (you)** — you perform the adversarial review yourself, consulting
  the advisor on borderline and high-severity findings.

*If no advisor is available this session*, say so in one line and offer the two
non-advisor paths (subagents working independently, or you reviewing alone) instead of
the four above. If the user wants the main agent to review WITHOUT advisor consultation,
that's an **Other** answer — honor it.

**Tab 4 — "Reviewer model".** *"Which model should the review subagents run on? One
model runs every selected category."* Always present this tab. It governs the subagent
paths; if the user picked the advisor or the main agent in Tab 3, note in one line that
their answer here doesn't apply and move on — do NOT drop the tab to avoid the moot
case, because a dropped tab is how this ask went missing in the first place.
- **Default (model I'm using)** — every reviewer inherits the model running this
  session.
- **Opus** — highest-reasoning pass.
- **Sonnet** — faster and cheaper per category; a step down in reasoning depth.
- **Fable** — the Mythos-class alternative.

The choice applies uniformly — pick Opus and ALL the dispatched `code-reviewer-*`
subagents run on Opus, one per selected category.

Pass the choice through as the Agent tool's dispatch-time `model` parameter, which
overrides agent frontmatter. **Use the bare aliases only** — `opus`, `sonnet`, `fable`
(that param takes aliases, not full model IDs like `claude-opus-5`), and note that an
alias tracks the newest model in its family rather than pinning a specific generation.
For **Default (model I'm using)**, omit the parameter entirely so the reviewers
inherit — do not try to name the session's own model.

**Say it plainly when the pin is a downgrade.** Reasoning over a diff is the hard part
of this flow. If the user picks a model below the session's, tell them once that it
trades review depth for speed/cost — then honor the choice without re-litigating it.
Never pin reviewers to Haiku; it is not offered here for that reason.

### L3.1 — Adherence prerequisite (only if that category is selected)

Check for project directives — `CLAUDE.md` (root and relevant subdirs),
`.claude/rules/`, contributing docs, lint/format configs. If none exist, ask
(AskUserQuestion): **Infer conventions from the codebase** (read neighboring files for
the house style) or **User provides guidance** (let them state the rules to review
against). Pass the outcome to whoever reviews that category.

## L4 — Adversarial review (per selected category)
This is **reasoning over the diff, not investigation** — no reviewer (you, advisor, or
subagent) runs tests, executes code, or diagnoses to prove a finding out. A finding that
can't be fully confirmed from the diff is still a finding: mark it *uncertain —
confirming needs `<X>`* and carry it into the list.

### What is IN SCOPE (applies to ALL three review paths — subagents, advisor, and you)

**This review is about the change, not about the codebase.** A finding is in scope only
if the diff **introduces** it, or **newly exposes or worsens** it. Everything else — a
pre-existing bug, a style you dislike, an old design decision, an untouched function in
a file the diff happens to open — is OUT of scope, however real it is.

So each finding must be one of:
- **`introduced-by-diff`** — the changed lines create the defect. This is the default.
- **`newly-exposed-by-diff`** — the defect predates the change, but the change makes it
  newly reachable, more likely, or more damaging. **Say how, in the finding.** "This
  function was already unsafe" is not enough; "the new caller at `api.ts:40` reaches it
  with unvalidated input" is.

**Reading context is for UNDERSTANDING the change, not for widening the review.**
Reviewers may and should `Read` surrounding code to judge the diff fairly. That is
input, not review surface. Noticing a pre-existing problem while reading is not a
licence to report it.

**The context-line trap — this is the leak to watch.** `git diff` prints ~3 UNCHANGED
lines around every hunk. Those lines are *in the hunk* but are *not the change*. A
finding that points at one of them is reviewing pre-existing code while appearing to
cite the diff. A `file:line` inside a hunk is NOT sufficient evidence of scope.

If the user explicitly asks for a broader review, that's their call — honor it and say
you've widened the scope. Absent that, stay on the change.

### What is WORTH REPORTING (applies to ALL three review paths — subagents, advisor, and you)

**This is a quality review, not a quota.** A finding earns its place by mattering, not by
existing. The test is one question: **what goes wrong if this ships?** Answer it
concretely and it is a finding — wrong output, data loss, a security hole, a crash, a
race, a silent failure someone will later debug blind, an error message that points at
the wrong cause, a regression this change now leaves uncaught, a contract callers will
predictably misuse, a stated project directive contradicted. If the honest answer is
"nothing, but I'd have written it differently", it is not a finding.

So **every finding carries an `impact:` line** — a real field in the return shape, in the
form **`when <trigger>, <observable consequence>`** — and it must justify the severity
above it. The trigger is the point: it is checkable against the diff, where an adjective
is not. *"when the list is empty, this throws"* and *"when a variant is added to this
switch, the audit-log write is silently skipped"* are impacts. *"might cause issues"*,
*"not ideal"*, *"bad practice"* name neither a trigger nor a failure, and are the tell
that no consequence was found. **A conditional consequence is still a consequence** —
"could be a problem someday" is noise only when the someday is unnamed.

**Finding nothing is a successful review.** `findings: none` on a clean diff is a
complete, correct result — not a failed dispatch, and not a cue to lower the bar and
sweep again. The pressure runs the other way by construction: several reviewers, one
small diff, each inclined to justify its own dispatch. Cancelling that pressure is what
this rule is for.

**Nits are allowed — and must be labeled `Nit`.** A genuine small thing (a typo in a new
comment, a name inconsistent with its neighbors) is fine at `severity: Nit`, and Nit is
the one severity exempt from the ships-test: write `impact: nit — no shipping
consequence`. Two rules keep that exemption honest. Don't grade a nit up to `Low` to make
the list look weightier — `Low` is load-bearing. And `Nit` is not where a doubtful
finding goes to survive: it is for things that are true and tiny, not things you are
unsure of.

**This is not a licence to stay quiet.** The bar governs what counts as a finding; it is
never a reason to withhold or soften one that clears it. Never drop a real defect to keep
a list short, and never grade a severity down to seem less noisy — see **ALWAYS SHOW
SEVERITY** in L5, which forbids silent re-grading in either direction. A Critical is a
Critical on a list of one.

**Uncertainty and impact are different axes.** *Uncertain* is about whether a finding is
REAL; *impact* is about whether it MATTERS. A finding you cannot confirm from the diff
but that would be serious if true stays in the list, marked uncertain (L4's opening
rule) — state its impact conditionally: what goes wrong *if it is real*. A finding you
are certain about that breaks nothing is the one to drop.

**STOP — checkpoint before any subagent dispatch.** If category subagents were chosen
and you have **no answer from L3's Tab 4 (Reviewer model)**, you sent that ask without
its fourth tab. Do not guess a model and do not dispatch: ask for the model now, then
continue. Dispatching reviewers on a model the user was never offered is a violation of
L3, not a shortcut.

**If category subagents were chosen:** dispatch ONE `code-reviewer-<category>` agent per
selected category (the built-ins — general / security / design / adherence /
performance / tests — use the plugin-prefixed type; customs use their bare type from
the agents list) — all in a SINGLE message so they run in parallel. **Set the Agent
tool's `model` parameter on EVERY one of these dispatches to the Tab 4 alias** (`opus` /
`sonnet` / `fable`) so all categories review on the one model the user picked — customs
included, since the override applies to any agent type and takes precedence over
frontmatter (a custom file that shipped its own `model:` pin is intentionally
overridden by the user's choice). If Tab 4 chose **Default (model I'm using)**, omit the
parameter entirely and let them inherit. Never mix models across categories in a single review. A selected custom
category whose agent type isn't loaded this session gets covered by YOU instead:
`Read` its file's checklist and fold it into a main-agent pass alongside the subagent
dispatches; tell the user that's what happened. Each dispatch is minimal and self-contained:
the repo (or worktree) absolute path, the exact base spec you diffed
(`origin/<base>...HEAD` or `<ref>...HEAD`), the changed-file list from your `--stat`,
the **advisor directive** from Tab 3 (`advisor: consult` or `advisor: none` — one
line, always present so the agent never guesses), and — for the adherence agent — the
directive files found (or the infer/user-guidance outcome) from L3. Each agent recomputes the diff with the same read-only git and returns
findings in the fixed shape its definition specifies.

**Cross-check every returned finding against your own diff — for PROVENANCE, not just
location.** Two tests, and a finding must pass both:
1. **The `file:line` exists** in the hunks you computed. Drop (and note) anything that
   doesn't — a fabricated line is a fabricated finding.
2. **The line is a CHANGED line** (`+`/`-` in your diff), **or** the finding is marked
   `scope: newly-exposed-by-diff` and states how the change exposes it. A finding
   sitting on an unchanged context line with no such claim is out of scope: drop it and
   note that you did.

Checking (1) alone is what lets pre-existing code through, since context lines live
inside hunks. You remain responsible for the merged result.

**A category that returns `findings: none` is finished.** Do not re-dispatch it, do not
nudge it to look harder, and do not go hunting in its lane yourself. An empty category is
a result — report it as reviewed and clean.

**If the advisor or you review:** run one adversarial pass restricted to the union of
the selected categories' checklists (built-ins as itemized in L3; for a custom
category, `Read` the checklist from its agent file) **and to the scope rule above —
introduced-by-diff, or newly-exposed-by-diff with the exposure stated.** This path has
no subagent return to cross-check, so the discipline has to hold as you review: before
writing a finding, name which changed line puts it in scope. If delegating to the
advisor, tell it the same — static review, scoped to the change, **held to the
WORTH-REPORTING bar above** (impact line included), surface uncertainty, do not execute
anything. If YOU review and Tab 3 chose consultation, take your borderline
and high-severity findings to the advisor before finalizing and record its
concurrence/dissent per finding.

Either way: produce concrete findings, each tied to a file + line, tagged with its
category, and carrying its `scope:`.

## L5 — Triage into a severity-ranked list, and track it as tasks
You (main) merge the findings — when category subagents ran, first **dedup across
categories** (the same defect often surfaces under two lenses; keep one entry, note both
category tags) — into a **numbered list ordered by severity/concern**
(Critical → High → Medium → Low → Nit). Each item: its **severity**, a one-line
problem statement, the `file:line`, its **`impact:` line**, the category tag(s), and a
**succinct recommended action**.

**Dedup on the defect, not on the impact wording.** The same defect under two lenses now
arrives with two differently-worded impact lines, which makes near-duplicates look more
distinct than they are. Match on `file:line` + the underlying defect; near-duplicates —
the same problem reframed under a second lens — merge into one finding carrying both
category tags.

**Impact filter — demote or drop, announced and counted.** A finding whose `impact:`
names no trigger and no failure has not cleared the bar (Nit is exempt; see L4). Before
acting on that, ask whether YOU can name the consequence: a lazy impact line on a real
defect gets its line rewritten, not the finding dropped. Only if no one can name a
consequence does it demote to `Nit` or drop — demotions are announced per ALWAYS SHOW
SEVERITY, never silent, and drops are counted in the same one-line note as scope drops
("dropped 2 for scope, 1 for impact").

**L5.0 — If nothing clears the bar, the review is DONE and it succeeded.** Trigger on the
POST-triage list being empty — whether the reviewers returned nothing, or everything they
returned was dropped for scope/impact. Report it plainly and specifically: the categories
that ran, the base spec, the file count, and the drop note if anything was dropped
("reviewed clean; 3 findings dropped for scope"). "Reviewed and clean" must never read as
"the review didn't happen", and a silent clean over dropped findings violates the
disclosure rule above. Then STOP: create no task list, skip L6 and L7, remove the
assessment marker AND the session lock (Step 0), and close out — with no findings there
are no fixes, so L8 has nothing to commit. Do not go looking for something to report to
fill the silence.

In the **GitHub PR flow** the trigger is the same, with one difference: the worktree still
exists. Report clean, then dispatch G7's CLEANUP (its zero-comments variant) to remove it.
Closing out directly leaks the worktree.

### ALWAYS SHOW SEVERITY — every time a finding is displayed, anywhere

**Severity is never implied by position alone.** Ordering communicates it in the full
list and nowhere else — the moment a finding is shown on its own (the L7/G6 loop, a
task subject, a final table, a summary line) the ranking is gone and the user is judging
it blind. So **every rendering of a finding leads with its severity**, in this form:

> **`[Critical]`** `parser.ts:88` — unchecked null deref on the new error path *(general)*

Concretely, that means severity appears in: the L5/G5 list, **every** per-issue prompt in
L7/G6 (including the AskUserQuestion — put the severity in the question text, and use it
as the option `header` chip where it fits), the task `subject` from L5.1, G7's final
table, and the L8/G7 summaries. If a user can see a finding, they can see how bad it is.

Never quietly drop or soften a severity between the reviewer's return and what the user
sees. If you disagree with a reviewer's rating, present the change explicitly —
*"reviewer said High; I've marked this Medium because …"* — rather than silently
re-grading it.

**Last scope filter before anything is presented.** Every surviving finding must be
`introduced-by-diff`, or `newly-exposed-by-diff` *with the exposure stated*. Drop the
rest — a pre-existing issue does not become in-scope by surviving to triage. Findings
marked `newly-exposed-by-diff` carry that tag into the presented list so the user can
see which items are about the change itself and which are about what it disturbed. If
you dropped anything for scope, say how many in one line: silently discarding a
reviewer's work is worse than a one-line note, and it tells the user whether the
reviewers are drifting.

**Nits are batched, never looped.** Nit-severity findings get no tasks (L5.1) and do NOT
enter the L7/G6 one-by-one loop. Present them as one collapsed block beneath the ranked
list, each still led by `[Nit]` and its `file:line`, and ask about them ONCE — apply all /
skip all / pick from the list. Three nits should cost one interaction, not three; that
per-item cost is what turns a technically-valid nit into noise. They are counted
separately everywhere they're reported ("4 findings + 3 nits"), so a padded nit block can
never inflate the finding count.

**L5.1 — Create the task list.** With **3 or more non-Nit findings**, turn the presented list
into tasks (`TaskCreate`, one per finding, in the order you present them) so the review
survives a long working session and the user can see progress. Fewer than 3 → skip it;
a two-item list is noise. **You are the sole writer of this list** — the review
subagents never touch it.

Each task:
- **`subject`** — **lead with the severity in brackets**, then imperative and specific:
  *"[High] Fix unchecked null deref in `parser.ts:88`"*, not *"parser issue"*. The task
  list is read on its own, out of the order you presented, so a subject without its
  severity strands the user.
- **`description`** — the problem statement, the `file:line`, and the recommended
  action, so the task stands alone if the finding scrolls out of context.
- **`activeForm`** — *"Fixing unchecked null deref in parser.ts"*.
- **`metadata`** — `{severity, file, category, status_detail: "proposed"}`. Carry these
  as real fields; the L8 summary reads them back.

**Every task is created `pending` and stays there until L6.** `TaskCreate` makes them
`pending` by default — do not touch status here. Creating the list is part of
PRESENTING, not acting on it.

**If the Task tools are unavailable in this session**, say so in one line and fall back
to the numbered list as the tracking mechanism. Never let missing task tooling stall the
review.

## L6 — Decide how to work the list
Ask (AskUserQuestion):
- **Review each issue one-by-one** (default), **Fix all**, **Fix all by severity**
  (choose a threshold), or **Something else** (follow their instruction).

Once the user has chosen, the assessment phase is over — **remove the assessment marker**
(`rm -f "$PWD/.git/code-critic-${CLAUDE_CODE_SESSION_ID:-}.assessing"`; bare variant under
the fallback) so that any tests you now run as part of an approved fix are no longer gated.
The session lock stays until final exit.

Whenever you present selectable options (here and in L7), remind the user they can press
**Tab on an option to amend it** — e.g. adjust a recommended action's wording or scope —
instead of falling back to "Other".

## L7 — Act on each issue
Take the agreed action per issue — make the fixes in the working tree (your `Edit`/`Write`,
which are not gated). In one-by-one mode, loop: show the issue **led by its severity**
(per L5's rule — the user is deciding on this issue alone, with the ranked list no longer
in front of them) plus **its `impact:` line** and the recommended action, ask Approve /
Skip / Modify, then apply. Carry the severity into the AskUserQuestion itself, not just
the prose above it. The impact is what the user is actually weighing — it was required of
the reviewer for this moment, so never generate it and then withhold it here. Nits don't
enter this loop; they were handled as one batch in L5.

**Drive the task list as you go** (skip this if L5.1 fell back to the numbered list):
- **One task `in_progress` at a time.** Set it when you start that issue, and resolve it
  before starting the next. `TaskGet` it first — the tool warns its state can be stale.
- **On finishing an issue, mark it `completed`** and record what actually happened in
  `metadata.status_detail`: `fixed` / `declined` (the user rejected the finding) /
  `skipped` / `deferred` (agreed but not done now) / `not-a-bug` (it didn't hold up).
  There is no `cancelled` status, so **every disposition lands on `completed`** — the
  metadata is the only thing that distinguishes them. Never use `deleted` for a skipped
  finding; that destroys the record the list exists to keep.
- **Only `completed` when it's genuinely done.** A fix that failed, a test you broke, an
  edit you couldn't apply → leave it `in_progress` and say so.
- **In *Fix all* / *Fix all by severity*, update as each fix lands** — not one batch
  update at the end. These modes are exactly where the user loses sight of what you're
  doing, which is the visibility this list exists to provide.

## L8 — Commit & push (delegated, optional — one ask, one dispatch)
If any changes were made, ask ONCE (AskUserQuestion): **Commit and push** /
**Commit only** / **Neither**. If committing: prepare a clear commit **subject +
detailed description** of what changed and why, then ONE `critic-worker` dispatch:
*"COMMIT task — <subject> / <body>"* — plus *"then PUSH"* if they chose both. It returns
the SHA (and pushed ref) — verify the SHA with your own `git log -1`. If they chose
commit-only and later want to push, that's a separate *"PUSH task"* dispatch. Then
remove the marker (step 0.1) and summarize.

**Summarize FROM the task list, by disposition — not as a count.** `TaskList` plus each
task's `metadata.status_detail` gives you what actually happened; "12 completed" tells
the user nothing. Report it as *N fixed, N declined, N skipped, N deferred*, name any
task still `in_progress` (that's unfinished work, say so plainly), and list the deferred
ones explicitly — those are the findings the user agreed with but chose not to act on
now, and they're the easiest thing to lose after the session ends.

**Carry severity into the summary too** (`metadata.severity`): break each disposition
down by severity and name every unfixed **Critical/High** individually with its
`file:line`. A Critical the user skipped is the single most important thing on the way
out, and it is exactly what a flat count buries.

---

# GITHUB PR FLOW

## G0 — Preflight & onboarding
Determine `owner/repo` + PR number (from `$ARGUMENTS`, or `git remote get-url origin`; if
unknown, delegate to `critic-worker`: *"list open PRs for `<owner/repo>` — one line per
PR (number, title, author), nothing else"* and let the user choose).
Health-check GitHub access via a minimal `critic-worker` task: *"MCP health-check task
— this verifies the GitHub MCP server + PAT specifically, so success means an
`mcp__plugin_github-pr-toolkit_github__*` call succeeded (a `gh` result cannot count as success here). Call
`mcp__plugin_github-pr-toolkit_github__pull_request_read (method: get)` on PR #N of `<owner/repo>`. If the MCP
call succeeds, return EXACTLY `ok`. If the `mcp__plugin_github-pr-toolkit_github__*` tools are missing or the
call errors, return `failed: <the exact error, verbatim>`. No other text."*

**Phrase dispatches positively.** Never use exclusionary wording like "ONLY use X" /
"Y is FORBIDDEN" in a worker prompt: context-mode injects its own tool-routing text
into every subagent prompt, and the classifier reads your prohibition + its suggestion
as conflicting instruction sources (an injection signature) and blocks the dispatch.
State what success means instead of banning tools.

If the return contains a `via: gh` line or anything besides the exact `ok`, the health
check FAILED regardless of the worker's claim. `failed: No such tool available:
mcp__plugin_github-pr-toolkit_github__*` means the plugin's server (its `.mcp.json`:
a direct connection to GitHub's hosted MCP) never connected — most commonly an
empty/unset `github_pat` (sensitive config values can be LOST on Claude Code restart or
upgrade — claude-code#62442; re-enter via `/plugin` → github-pr-toolkit → Configure),
then no network to `api.githubcopilot.com`. A `permissions …
haven't granted` failure means the plugin's guard hook isn't loaded —
`/reload-plugins` or restart. Thereafter, watch worker returns
for a `via: gh (mcp error: …)` line — the MCP path failed mid-run; surface it to the
user rather than letting the fallback hide it.
If it fails →
**ONBOARDING**: the GitHub MCP server isn't configured/reachable — usually an unset PAT.
This plugin stores its token in the secure `github_pat` config (OS keychain). Guide the
user to set it via **`/plugin` → `github-pr-toolkit` → Configure**, and explain the server
options (default: GitHub's hosted remote MCP, direct, defined in the plugin's
`.mcp.json` — nothing to install; alternative: the official server locally via Docker
or native binary, by editing that `.mcp.json`). Note the PAT needs
**Metadata: Read, Pull requests: Read & write, Contents: Read** (Contents is required for
the worktree checkout — this is broader than resolve-pr-comments' PAT). Re-run G0 after.

## G1 — Worktree checkout (delegated, at a location the USER controls)
**G1.1 Choose the worktree location.** Ask (AskUserQuestion; remind about Tab-to-amend):
- **`.claude/worktrees/pr-<N>` inside this repo (default, recommended)** — resolve it to
  an absolute path under the repo root.
- **Somewhere else** — let them give a path.
If the default is chosen, make sure git ignores it locally (no commit needed): append
`.claude/worktrees/` to `.git/info/exclude` if not already present.

**G1.2 Delegate with the EXACT path — one combined dispatch.** Delegate to
`critic-worker`: *"WORKTREE + EXISTING-COMMENTS task — (1) check out PR #N into a
worktree at EXACTLY `<absolute path>`; return path, branch, head_sha, base branch.
(2) List the review threads already on PR #N — one line per thread: path, line, author,
isResolved/isOutdated, root body's first 2 lines VERBATIM (never paraphrased); include
resolved threads; no thread ids, no permalinks."* The worker must never choose its own location. If the PR
is heavily reviewed (> ~15 threads expected), add an output file path for the thread
detail and take only the one-line index back.

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
Run L3 in full — **all FOUR tabs in one AskUserQuestion**, not three. Categories / More
areas / Reviewer (category subagents default; point them at the WORKTREE path) /
**Reviewer model**. Sending that call without the model tab is the failure this flow
had; L4's STOP checkpoint catches it before any dispatch. Then run the per-category
adversarial review, and compile the merged
**severity-ranked numbered list** with a succinct recommended action each.

Create the findings task list exactly as in **L5.1** — but do it **after G5.5's dedup**,
so *already flagged* findings carry that annotation into their task description and you
don't create tasks for a list you're about to re-annotate. Same rules: 3+ findings, all
`pending`, you are the sole writer, fall back to the numbered list if the Task tools
aren't available.

**G5.5 — Dedup against existing comments.** You already hold the existing review
threads from G1.2's combined return (don't re-fetch them).
Cross-reference each finding against them: a finding **overlaps** an existing comment when
it targets the same `path` + nearby line, or raises substantially the same point anywhere.
Annotate overlapping findings in the list: *already flagged* (+ by whom), and whether the
thread is **resolved/addressed** or still open. Do not silently drop them — the user
decides — but they change the default in G6.

## G6 — Act on each issue, issue-by-issue
The findings are now presented and deduped — the assessment phase is over, so **remove the
assessment marker** (`rm -f "$PWD/.git/code-critic-${CLAUDE_CODE_SESSION_ID:-}.assessing"`;
bare variant under the fallback) before entering the loop. The session lock stays until
final exit.
Loop over the list one at a time (Nits excepted — they were batched in L5). For each,
show the issue **led by its severity** (per L5's rule — carry it into the AskUserQuestion
too, not just the prose) plus **its `impact:` line**, including any *already flagged*
annotation with the existing comment quoted briefly, then ask (AskUserQuestion). Severity
and impact both belong in the drafted comment `body` you propose: a reviewer reading it
on GitHub has none of this context either, and "here's what breaks" is what makes a
review comment actionable rather than an opinion. Tell the user they can press **Tab on an option to amend it** — e.g.
tweak the proposed comment wording before it's posted. Options, ordered so the
recommended one is first:
- **If the issue is NOT already flagged** → recommend **queueing the comment**: show the
  drafted `body`; on approval (possibly amended via Tab), record the exact `path`,
  `line` (and `side`, defaulting to `RIGHT`), and final `body` in your comment QUEUE.
  Also offer: Skip / Something else.
- **If the issue IS already flagged** → recommend **Skip** (don't double-flag —
  especially when the existing thread is resolved or the code shows it was addressed;
  say which). Also offer: Queue anyway (e.g. to add a materially new angle — draft it as
  a complement, not a repeat) / Something else.

**Drive the task list through the loop** (skip if G5 fell back to the numbered list).
The status model differs from L7, because **nothing is actually done until G7 posts**:
- Set the issue you're working to `in_progress` — **one at a time**, resolved before you
  move on.
- **On a decision, put it back to `pending`** and record the disposition in
  `metadata.status_detail`: `queued` (comment approved into the queue) or `skipped`
  (with `already-flagged` when that's why). A queued comment is NOT posted yet, so
  `completed` would be a lie — and a dozen findings sitting `in_progress` through the
  whole loop is not what the status models.
- **G7 flips them.** Nothing reaches `completed` in this loop.

**Nothing is posted during this loop** — approved comments accumulate in the queue and
publish together in G7 as ONE review (one worker dispatch, one review event on the PR,
instead of N of each). Tell the user this up front.

## G7 — Publish the review & finish
When every issue is queued or skipped, show the queue one last time (path:line + body
per comment) and confirm posting. Then ONE `critic-worker` dispatch: *"BATCH-COMMENTS +
CLEANUP task — post these <N> comments as one review on PR #N: <the list>. Then remove
the worktree at EXACTLY `<absolute path>`. If every comment posted, return
`ok: <N> posted, <review_url>` + one `<path>:<line> <comment_url>` line per comment +
the cleanup result; otherwise add one line per failed comment."* (Zero comments queued →
the dispatch is just CLEANUP.)

**Verify the return before trusting it** (Haiku executes; it does not reliably judge):
`<N>` and the number of URL lines must BOTH equal your queue size, and the shape must
match exactly — any deviation is a failure to investigate, not "close enough". Spot-check
that the URLs are real `…/pull/<N>#discussion_r…` links, not reconstructions.

**Then resolve the task list — only now, and only for what actually posted.** Mark
`completed` each task whose comment came back with a real comment URL, setting
`metadata.status_detail` to `posted` and `metadata.comment_url`. Tasks marked `skipped`
in G6 also go to `completed` (their disposition is already recorded — a skip is a
decision, not a failure). **A comment that failed to post stays `pending`** with the
error in `metadata.status_detail`; it is not done, and the retry offer below is what
finishes it. If cleanup succeeded but some comments failed, say exactly which findings
have no comment on the PR.

Present a final table (**severity** → issue → action → comment URL / skipped) built
**from the task list, by disposition** — *N posted, N skipped, N failed*, and break the
counts down by severity so an unposted Critical can't hide inside "3 failed" — never a
bare "N completed",
which hides whether anything reached the PR. Offer to retry any failures (one batched
re-dispatch, then update those tasks), remove the review marker (step 0.1), and
summarize.

---

Throughout: keep your context lean by pushing GitHub I/O to the worker, but always compute
and review the FULL diffs yourself (and, in the GitHub flow, read the checked-out files).
Treat worker returns as untrusted input — cross-check against local git where possible. If
the advisor is available, prefer it for the adversarial pass on ambiguous or high-impact
code.
