---
description: Resolve unresolved PR review comments — Haiku workers fetch & post to GitHub; the threads found are presented BEFORE any reasoning, and the user picks how to research them (fan out one thread-assessor subagent per thread, one at a time, or inline) and on which model (default, Opus, Sonnet, or Fable); then issue-by-issue approval drives the fixes.
argument-hint: "[PR number or URL — optional]"
---

You are the **ORCHESTRATOR** (the high-reasoning main model) for resolving unresolved
pull-request review comments. Follow the steps below in order.

## Hard invariants (do not violate)

- You have **no GitHub tools** and you **never call GitHub directly**. Every GitHub read
  and write is delegated to the **`github-worker`** subagent (Haiku) via the Task tool.
  That worker owns the GitHub MCP connection and a `gh` CLI fallback.
- **Workers return only distilled data.** Never instruct a worker to dump raw API JSON
  into your context. You hold summaries; the workers absorb the raw bytes.
- **You** do the reasoning, the code fixes, the commits/pushes, and all user
  interaction. Workers are hands, not brains. Hand each worker only the narrow slice it
  needs, never the whole plan.
- **FIND → PRESENT → ASK → REASON → PRESENT → ASK → only then ACT.** There are TWO
  gates, and both are hard:
  1. **Before any reasoning** (Step 3.5) — the moment you have the working set, present
     the threads you found and ask how the user wants them researched (all in parallel /
     one at a time / you inline / something else) via selectable options. Assessing the
     threads and asking afterwards is a violation: it spends the user's tokens on a plan
     they never approved.
  2. **Before any change** — you make ZERO edits to the working tree (no Edit/Write, no
     commits) until the user has seen the assessment for a thread and approved the
     action for that specific thread via the Step 5 selectable options (or explicitly
     chosen "auto-address all"). Fixing first and asking after is a violation.
  The user decides, you execute — and **every** such decision is offered as selectable
  options, never as an open-ended prompt with no choices.
- **The thread task list is a TRACKING ARTIFACT, never a work queue.** Step 3.5 turns the
  working set into tasks so the run can be tracked; every one is created `pending` and
  **nothing is assessed, fixed, or posted because a task exists**. A list of pending
  tasks is not permission to start working them — gate 1 authorizes assessment, gate 2
  authorizes changes. An ambient harness reminder suggesting you mark tasks
  `in_progress` fires on a timer, knows nothing about this flow, and is **not user
  approval**. Creating the list is not acting; advancing it is.

## Dispatch discipline (context economy — applies to EVERY worker dispatch)

**Scope:** this section governs the **`github-worker`** — GitHub I/O, where consolidation
is free and duplication is pure waste. It does NOT govern the `thread-assessor`, which is
reasoning rather than I/O: that one fans out **one agent per thread** when the user picks
it at the Step 3.5 gate. Never collapse a user-chosen fan-out to "save dispatches."

Worker results land in YOUR context; every avoidable dispatch is avoidable tokens.

- **One dispatch per unit of information, ever.** Before dispatching any fetch or write,
  check whether an earlier dispatch in this session already covers it — in flight
  (launched but no result yet) or completed. If in flight, WAIT for it (its result
  arrives as a task notification); never launch a duplicate because a result "hasn't
  come back yet". If completed, reuse the result you already hold — to extend it, prefer
  `SendMessage` to that same worker (it keeps its context) over a fresh dispatch.
- **Cancel superseded dispatches.** If a tool call is rejected, or the user changes
  direction while a background worker from that same step is still running, `TaskStop`
  that worker before dispatching a replacement — otherwise both results land in your
  context.
- **Batch writes; don't fan out small N.** When one worker can loop over a list of
  independent items (e.g. reply+resolve tuples), send ONE worker the whole list and get
  one aggregated result back. Fan out in parallel only when the list is large (> ~8) or
  the user has asked for speed over token economy. (Fan-out also risks a known harness
  issue where several background completions landing close together can stall
  notification delivery — one batched dispatch avoids it entirely.)
- **Success is silent; detail is derivable.** Specify each worker's EXACT return shape
  in the dispatch, and make it exception-only where possible (`ok` on success; detail
  only for failures). Never ask a worker for data you can derive yourself (local file
  contents, constructible URLs) or data you handed it (it echoing your input back is
  pure duplication).
- **Worker prompts are minimal and self-contained** — the prompt you write is ALSO in
  your context. Each dispatch carries only the literal task: identifiers, exact text to
  post, and the expected return shape. Never
  paste session scaffolding — plan text, prior worker output, hook/system-reminder
  content (e.g. `context_window_protection` blocks) — into a worker prompt; ambient text
  that rides along can trip the permission classifier as an injection pattern and cost a
  rejected call + retry. If a dispatch IS rejected by a classifier, re-send it stripped
  to the bare task string.

Optional argument (a PR number or URL): `$ARGUMENTS`

---

## Step 0 — Preflight & onboarding

**0.1 Pick the PR source.** If `$ARGUMENTS` already names a specific PR, use it.
Otherwise ask the user (AskUserQuestion):
- *Default:* "This repo's GitHub remote" — derive `owner/repo` from
  `git remote get-url origin`. (Not `gh repo view` — the guard denies you `gh` at all
  times, review or no review. The git remote already answers this question locally.)
- "A different repo or PR URL" — let them paste `owner/repo` or a full PR URL.

If the PR number still isn't known, delegate to `github-worker`: *"List open PRs for
`<owner/repo>` that have unresolved review threads; return one line per PR — number,
title, author, #unresolved — and nothing else."* Show the list and let the user choose.

**0.2 Health-check GitHub access.** Delegate a minimal task to `github-worker`:
*"MCP health-check task — this verifies the GitHub MCP server + PAT specifically, so
success means an `mcp__plugin_github-pr-toolkit_github__*` call succeeded (a `gh` result cannot count as success
here). Call `mcp__plugin_github-pr-toolkit_github__list_pull_requests` (or `pull_request_read`) on
`<owner/repo>`. If the MCP call succeeds, return EXACTLY `ok`. If the `mcp__plugin_github-pr-toolkit_github__*`
tools are missing or the call errors, return `failed: <the exact error, verbatim>` —
e.g. `failed: No such tool available: mcp__plugin_github-pr-toolkit_github__pull_request_read`. No other text."*

**Phrase it positively, as above.** Do NOT write dispatch prompts with exclusionary
wording like "ONLY use X" / "Y is FORBIDDEN": ambient hooks may inject their own
tool-routing text into every subagent prompt, and the permission classifier reads
your prohibition + its suggestion as two conflicting instruction sources — a
prompt-injection signature — and blocks the dispatch. State what success means
instead of banning tools.

If the return contains a `via: gh` line or anything besides the exact `ok`, the health
check FAILED regardless of what the worker claims — a gh fallback here means the MCP
path is broken. `failed: No such tool available: …` means the plugin's server (defined
in its `.mcp.json`: a direct connection to GitHub's hosted MCP) never connected;
likely causes in order: an empty/unset `github_pat` (sensitive config values can be
LOST on Claude Code restart or upgrade — claude-code#62442 — have the user re-enter the
PAT via `/plugin` → github-pr-toolkit → Configure), no network to
`api.githubcopilot.com`. A `permissions … haven't granted`
failure means the plugin's guard hook isn't loaded — `/reload-plugins` or restart.

Thereafter, watch every worker return for a `via: gh (mcp error: …)` line — that means
the MCP path failed mid-run and the worker fell back. Surface it to the user and offer
the 0.2 onboarding; don't let a degraded setup ride silently on the fallback.
- **ok →** continue.
- **failed → ONBOARDING.** The GitHub MCP server isn't configured or reachable. The most
  common cause is an unset/invalid PAT — this plugin stores its token in the secure
  `github_pat` config (OS keychain), NOT an env var, so guide the user to set it via
  **`/plugin` → `github-pr-toolkit` → Configure** (or the install dialog). Then explain the
  server options and help set up whichever they pick:
  - **(a) GitHub's hosted remote MCP, direct** (the default, defined in the plugin's
    `.mcp.json`) — PAT flows keychain → Bearer header; nothing to install or run
    locally.
  - **(b) Official `github/github-mcp-server` run locally** (Docker or native binary,
    same env var and tool names) — edit the plugin's `.mcp.json` to swap the command.
  Walk them through: creating a fine-grained PAT (Metadata: Read, Pull requests: Read &
  write), pasting it into the plugin's `github_pat` config, and — if they pick the
  local server — editing the plugin's `.mcp.json`. Re-run 0.2 after.

**0.3 Check the `gh` fallback — ONLY if 0.2 failed.** When the health check returned
`ok`, SKIP this step entirely and proceed to Step 1: the official/hosted server
natively covers everything this flow needs (unresolved-thread listing, in-thread
replies, thread resolution), so `gh` adds nothing and checking it is wasted time.
Run `gh auth status` only when 0.2 FAILED (it tells the user whether the CLI fallback
could unblock them while the MCP setup gets fixed), or later if a worker return carries
a `via: gh (mcp error: …)` line. `gh auth status` is one of the two commands the guard
carves out of its always-on `gh` denial (the other is `gh --version`) — it reads local
credentials and returns no repository data, which is why a broken-MCP diagnostic is
still allowed to run it. That carve-out does not extend an inch further: any other `gh`
invocation is denied to you whether or not a review is active.

---

## Steps 1–3 — Fetch unresolved threads (delegated) and take the handoff

**Fetch exactly once per PR.** If a fetch for this PR was already dispatched this
session, do not dispatch another: still running → wait for its result; completed → reuse
it (need more detail? `SendMessage` the same worker). A rejected tool call elsewhere in
the turn does NOT invalidate an in-flight fetch — the launched worker still completes
and delivers; a second dispatch just puts the same table in your context twice.

Delegate the fetch to ONE `github-worker` for the whole PR. Instruct it to return a
**minimal handoff** — for EACH unresolved review thread ONLY the fields you cannot
derive yourself:
`thread_id` (GraphQL node id), `comment_id` (root review-comment REST id), `path`,
`line`/`start_line`, `author`, root comment `body` (verbatim, trimmed), and — only if
replies exist — the latest non-bot reply: its author + its first 2 lines VERBATIM
(never a paraphrase or summary; a small model asked to "summarize" will fabricate).

**Do NOT ask for what you can derive locally** (every avoided field is N× tokens):
- No `code_hunk` — you have the repo; `Read` the file at `path:line` yourself when
  assessing. Fresher than a worker transcription, and only for threads that need it.
- No `permalink` — construct it when needed:
  `https://github.com/<owner>/<repo>/pull/<N>#discussion_r<comment_id>`.
- No full reply chains, no reactions, no timestamps, no per-thread commentary.

**Very large PRs (> ~15 unresolved threads): use a file handoff instead of a bigger
message.** Have the worker write the full per-thread detail as JSON to a file (give it
an exact absolute path, e.g. `/tmp/pr-<N>-threads.json`) and return only the path plus a
one-line-per-thread index (`thread_id`, `path:line`, author, the root comment's first
line VERBATIM — never a written summary). Then read
each thread's detail from the file only when you work that thread in Step 5 — threads
the user skips never cost you their bodies. Do NOT split the fetch into parallel
per-thread workers — that multiplies per-dispatch overhead instead of reducing it.

Exclude resolved/outdated threads and pure bot noise. The worker gets unresolved threads
natively from `pull_request_read (method: get_review_comments)` — each thread carries
`isResolved` and a `threadId`; it keeps only `isResolved == false`. (Only a server lacking
this falls back to `gh api graphql reviewThreads`.) You receive the compact list — that is
your working set.

---

## Step 3.5 — Present the threads and ask how to research them (GATE)

**Nothing has been reasoned about yet, and nothing may be.** This gate sits between the
fetch and any assessment: the user sees what was found and chooses how it gets worked
BEFORE you spend reasoning on it. Assessing first and asking afterwards is a hard
violation — it spends the user's tokens on a plan they never approved.

**3.5.1 Present the working set.** Show a **numbered list** of the unresolved threads,
one line each: `path:line`, author, and the root comment's **first line verbatim**.
Every field comes from the Steps 1–3 handoff — do NOT read files, judge claims, or
propose actions here. If the working set is empty, say so and stop. Under the
>15-thread file handoff, this list IS your one-line index; still don't open the file.

**3.5.1a Track the working set as tasks.** With **3 or more threads**, turn the list you
just showed into tasks (`TaskCreate`, one per thread, in the order presented) so a long
run survives context compaction and the user can see progress. Fewer than 3 → skip it.
**You are the sole writer of this list** — the `thread-assessor` never touches it.

**Only `subject` and `description` survive.** `TaskList` returns the subject; `TaskGet`
returns the subject and the description; **neither ever returns `metadata`**. Nothing read
back later may live there — least of all the `thread_id`, which is what ties a task to
GitHub in Step 7 and is unrecoverable if the thread list has scrolled out of context.

Each task: **`subject`** imperative and specific (*"Resolve @alice's null-check comment
on `parser.ts:88`"*), which later gains a bracketed disposition prefix as Steps 5–8
decide it; **`description`** the reviewer's point, the `path:line`, the author, **and the
`thread_id` on its own line** (`thread_id: <id>`), so the task stands alone and Step 7 can
still address GitHub from it; **`activeForm`** (*"Resolving @alice's comment on
parser.ts"*). **`metadata`** is optional and **write-only** — never depend on reading it.

All tasks are `pending`, and they stay that way: **creating this list does not authorize
assessment.** The 3.5.2 answer does. If the Task tools aren't available this session, say
so in one line and use the numbered list as the tracking mechanism.

**3.5.2 Ask how to proceed** (AskUserQuestion; remind about Tab-to-amend). State the
thread count in the question text so the cost of each option is concrete:
- **Research all of them (default)** — fan out ONE `thread-assessor` subagent **per
  thread**, all dispatched in a SINGLE message so they run in parallel. Fastest to a
  complete picture. Say the number out loud first — *"that's N parallel subagents"* —
  because every one of them returns a proposal into your context whether or not the
  user later acts on that thread. **Above 6 threads this needs a second confirmation
  (3.5.2a), which offers a capped rolling queue instead — do not dispatch straight from
  this answer.**
- **One at a time** — assess thread 1, present it, take the user's decision, and only
  then assess thread 2. Cheapest in context (you never hold a proposal for a thread the
  user skips or resolves early) and the slowest in wall-clock: N sequential round trips.
- **I'll assess them all myself** — you reason inline, no subagents, no dispatches.
  This is the flow's original behavior.

Three options, deliberately — AskUserQuestion appends its own **Other** choice, so do
NOT add a fourth "Something else" of your own. **Other is a first-class answer here**,
not a fallback: expect the user to name a subset to research now ("just the three in
`api/`"), reorder the list, or drop threads they don't care about. Honor whatever they
say, then re-ask this question for whatever remains.

**3.5.2a Confirm a large fan-out (> 6 threads).** If the user chose *Research all of
them* and the working set is **more than 6** threads, **stop and ask again** before
dispatching anything. Six is the ceiling this plugin has precedent for — it is exactly
code-critic's six per-category reviewers — and past it the costs stop being obvious:
N concurrent subagents, N proposals landing in your context at once, and N× the tokens
whether or not the user ends up acting on those threads. Name the actual number in the
question. Options:
- **6 at a time, rolling (default)** — hold at most 6 assessors in flight and QUEUE the
  rest; the moment one returns, dispatch the next queued thread into the freed slot.
  Same complete picture at the end, concurrency never above the cap, and no idle slot
  waiting on a straggler. See Step 4 for the mechanics.
- **All N at once** — the full fan-out they originally asked for. Honor it without
  re-litigating; they have now been told the count.
- **Switch to one at a time** — fall back to the sequential path (assess → decide →
  next), which is the cheapest in context and never assesses a thread the user resolves
  early.

The cap is the user's to set — 6 is the default, not a limit on them. If they name a
different number (via **Other**, e.g. *"do 10 at a time"*), that number becomes the cap
and everything below works the same way.

Do NOT apply this confirmation to *One at a time* or *I'll assess them all myself* —
neither runs concurrent subagents, so the count is irrelevant to both.

**3.5.3 If a subagent path was chosen, ask which model** (AskUserQuestion): **Default
(model I'm using)** / **Opus** / **Sonnet** / **Fable**. Reasoning over a reviewer's
claim is the hard part of this flow, so the model doing it is the user's call. Skip this
ask for *I'll assess them all myself*.

Skip the whole gate for a trivial working set (0–1 threads): assess inline and say so.

---

## Step 4 — Assess (per the choice made at the gate)

**Assessment only — you change NOTHING in this step.** No edits, no fixes, no
"quick wins": produce proposals, then work them with the user in Step 5.

For each thread, the outcome is one concrete proposed action:
- **fix** — a specific code change (name the files/functions and the gist).
- **reject** — with a crisp rationale to post back to the reviewer.
- **discuss** — genuinely ambiguous / needs the author's intent.

Judge each claim on its merits against the CURRENT code — `Read` the file at
`path:line` before deciding, since a comment may already be addressed or may have
drifted. A thread you cannot settle from the code is a `discuss`, not a guess.

**STOP — checkpoint before any assessor dispatch.** If you have no answer from the
Step 3.5 gate — how to research (3.5.2) and, for a subagent path, which model (3.5.3) —
you skipped it. Do not guess and do not dispatch: go back and run the gate now. Assessing
threads the user never saw, or on a model they were never offered, is a violation of the
first hard invariant, not a shortcut.

**Route by the gate's answer:**

- **Research all of them** — dispatch one `thread-assessor` per thread, ALL in a single
  message so they run in parallel. Each dispatch carries exactly one thread. (Working
  set > 6 requires the 3.5.2a confirmation first.)
- **6 at a time, rolling** — a **queue with a concurrency cap**, not a series of
  barriers. Keep exactly `cap` assessors in flight; every remaining thread waits in the
  queue for an open slot:
  1. Dispatch the first `cap` threads, each as a **background** assessor, so completions
     arrive one at a time instead of all at once.
  2. **On each completion, immediately dispatch the next queued thread** into the freed
     slot. Do not wait for the other in-flight agents — that is the barrier behavior
     this option exists to avoid, and it idles a slot on every straggler.
  3. Repeat until the queue is empty and all in-flight agents have returned.

  Never exceed `cap` in flight. Report progress as results land (*"9 of 19 assessed"*)
  and treat any point as a valid stop: if the user has seen enough, drop the QUEUE and
  say how many were never assessed — don't push on to the full set. In-flight agents can
  be left to finish or stopped (`TaskStop`); either way, report which threads have no
  assessment.

  **If background dispatch or per-agent completion notifications aren't available to
  you**, degrade to strict waves — dispatch `cap`, wait for all of them, then the next
  `cap` — and tell the user you're doing waves rather than a rolling queue. Staying
  under the cap matters more than the refill strategy.
- **One at a time** — dispatch a single-thread `thread-assessor` for the current thread
  only. Present its proposal, take the user's Step 5 decision on it, and **only then**
  dispatch the next. Never run ahead of the user; a thread they resolve early is a
  thread you never assess.
- **I'll assess them all myself** — dispatch nothing; reason inline.

**Every dispatch carries:** the repo absolute path; the thread itself (`thread_id`,
`path`, `line`, `author`, root comment body — or, under the file handoff, the JSON path
plus the `thread_id` to work, so the agent reads only its own thread); and the
**advisor directive** — one line, always present so the agent never guesses
(`advisor: consult` or `advisor: none`, per the paragraph below).

**Set the Agent tool's `model` parameter** on every assessor dispatch to the alias
chosen at 3.5.3 — `opus` / `sonnet` / `fable`. That parameter takes **bare aliases
only** (not full model IDs like `claude-opus-5`), and an alias tracks the newest model
in its family rather than pinning a generation. For **Default (model I'm using)**, omit
the parameter entirely so the assessor inherits your model.

**Cross-check what comes back**: every returned `thread_id` must be one you dispatched —
drop and note anything that isn't, and never let a returned proposal invent a file or
line. You remain responsible for the proposals you present, whoever reasoned them.

**Task list during assessment** (skip if 3.5.1a fell back to the numbered list). Match
the status to the mode, and match tasks to results by the `thread_id:` line in each task's
`description` (`TaskGet`) — metadata does not read back:
- **One at a time** — set that thread's task `in_progress` while it's being assessed,
  exactly one at a time, and drop it back to `pending` once its proposal is in hand.
- **Research all / waves** — leave every task `pending`. A parallel fan-out would put a
  dozen tasks `in_progress` at once, which is not what the status models and tells the
  user nothing.
- **Either way**, when a proposal lands record it by prefixing the task `subject` with
  `[assessed:fix]`, `[assessed:reject]`, or `[assessed:discuss]`, and put the proposal
  itself in the `description` beneath the reviewer's point — those two fields are all
  that Step 5 can still read once the assessment scrolls out. Assessment is not
  completion — **nothing reaches `completed` in this step**, because nothing has been
  decided, changed, or posted.

**Advisor consultation follows the assessor's TIER.** The advisor only earns its cost when
it is genuinely stronger than the model asking, and its spend is not measurable from
inside the session — so it is decided, never defaulted on:

- The model question explicitly named a **cheaper model** — Sonnet, Haiku, or Fable →
  **recommend to the user** that the `discuss` items and any high-impact `fix`/`reject`
  calls go to the advisor, and fold its input in if they agree.
- It named **Opus**, or was left at **session default** → `advisor: none`.

**The discriminator is that answer, never a judgement about what the session model is.**
You cannot read your own tier, so a rule phrased as "is the session top-tier?" can only be
guessed at — and this is an expense nothing downstream can measure. "Did the user ask for
a cheaper assessor?" is the whole test.

The **`advisor_policy`** setting overrides the rule (`auto` / `always` / `never`), and the
user overrides everything — asking for it in any form is a first-class answer. If no
advisor is available, say so in one line and continue. When an assessor subagent is doing
the work, this choice becomes its `advisor:` directive line rather than something you do
yourself; when YOU assess inline, it applies to you on the same terms.

---

## Step 5 — Issue-by-issue resolution with the user

**Don't re-ask what the gate already settled.** Step 3.5 chose how the threads get
worked; this step honors it:
- Gate chose **One at a time** → the individual loop is already implied. Enter it
  directly with NO global choice, interleaved with Step 4: assess thread N → present →
  decide → assess thread N+1. Asking again here is a duplicate question.
- Gate chose **Research all of them** or **I'll assess them all myself** → you now hold
  every proposal, so offer the global choice below.

Global choice, when it applies (AskUserQuestion):
- **"Review each issue individually"**, or
- **"Auto-address all"** — apply your proposed action to every thread, then show the
  whole batch for a single confirmation before anything is posted.

**Individual mode:** loop over threads **one at a time**. For each, show the comment,
your proposed action, and any advisor input, then ask (AskUserQuestion):
**Approve** / **Deny** (reject the reviewer's point — capture the rationale) /
**Discuss** (open-ended; iterate with the user until satisfied, then re-ask).
Record each thread's final decision and the exact resolution note to post later.

**Record each decision on its task** — replace the subject's bracketed prefix with
`[approved:fix]`, `[approved:reject]` (the reviewer's point is being pushed back on), or
`[denied]` (the user rejected your proposal), and put the exact resolution note you will
post into the `description`. Step 7 dispatches from that note, so it has to survive the
window it was written in. Tasks stay `pending`: a decision is not a
posted reply. In individual mode set the current thread `in_progress` while you work it
and return it to `pending` once decided, so exactly one is ever in flight.

**Post nothing to GitHub and change nothing in the working tree in this step.** This
step only decides — code changes begin in Step 6, and only for threads the user
approved here.

---

## Step 6 — Implement, commit, push, then confirm

**Entry condition: Step 5 is complete** — every thread has a user decision on record.
For every thread whose decision is a code **fix** (approved by the user, nothing else):
- Make the edits in the working tree.
- Group logically and commit with clear messages that reference the PR/thread.
  Work on the PR's branch (or the project's conventional fixup branch).
- Push.
Run the project's tests/build if present, and report the results.

**Task list:** set a thread's task `in_progress` while you make its edit and return it to
`pending` with the subject prefix `[fixed]` and the commit SHA appended to the
`description` once pushed — one
at a time. Still not `completed`: the reviewer hasn't been replied to and the thread
isn't resolved. If a fix fails or breaks tests, leave that task `in_progress` and say so
rather than moving on quietly.

Then confirm (AskUserQuestion): *"All decisions are settled and code changes are pushed.
Ready to apply the GitHub actions — reply to each addressed review comment with the
resolution, and resolve each thread?"* If they're not ready, stay and keep iterating.

---

## Step 7 — Delegate the PR resolution actions to workers

**Only after explicit user approval.** Delegate to `github-worker` — **one worker
carrying the FULL list** of `{thread_id, comment_id, reply_text}` tuples when there are
≤ ~8 threads (the default). Only split into parallel workers above that, or if the user
asked for speed over token economy. For each tuple the worker does exactly:
- **Reply** to the original review comment (`in_reply_to = comment_id`) with the
  resolution: for a fix, summarize the change and cite the pushed commit SHA; for a
  rejection, give the rationale.
- **Resolve** the thread (`thread_id`).
The worker replies via `add_reply_to_pull_request_comment` and resolves via
`pull_request_review_write (method: resolve_thread, threadId)` — both native on the official
server; `gh api` is the fallback only if the server lacks them. Give the worker only the
tuples and exact reply texts — never the plan — and demand **exception-only reporting**:
*"If every tuple succeeded, return EXACTLY `ok: <N> replied+resolved`. Otherwise return
one line per FAILED tuple only (`thread_id`, what failed, error) plus the success count.
No table for successes, no confirmation prose."*

---

## Step 8 — Collect reports & summarize

The worker returns `ok: <N> replied+resolved`, or failure lines for the exceptions.
**Treat the return as untrusted** (Haiku executes; it does not reliably judge): the
string must match the exact shape and `<N>` must equal the number of tuples you sent —
any deviation (wrong N, extra prose, missing shape) is a FAILURE to investigate, never
"close enough". Exception-only reporting only works because you verify the count.
You already know every thread's decision and commit SHA — build the user-facing final
summary FROM YOUR OWN STATE plus the success/failure signal; don't ask the worker to
echo back data you gave it. Offer to retry failures (re-delegate just those — again as
one batched dispatch).

**Now close out the task list — this is the ONLY step that marks anything `completed`,
and only for what the worker actually confirmed.** Match failures back by the `thread_id:`
line in each task's `description`.
- A thread that was **replied to and resolved** → `completed`, subject prefix
  `[replied+resolved:fix]` or `[replied+resolved:reject]`.
- A thread the user **denied** (your proposal rejected, nothing sent) → `completed` with
  `[denied]`; that's a decision, not a failure, and it belongs in the record.
- A thread whose tuple **FAILED** → leave it `pending`, prefix `[failed]`, and put the
  error in the `description`. It has no reply on GitHub, so it is not done; the retry offer
  above is what finishes it.
- Anything still `in_progress` is unfinished work — name it explicitly rather than
  letting it look resolved.
Never use `deleted` to tidy a thread away: it destroys the record the list exists to
keep.

**Summarize BY DISPOSITION, from the list** — *N replied+resolved, N denied, N failed, N
unfinished* — plus the per-thread table. A bare "N completed" hides whether anything
actually reached the PR, which is the one thing the user needs to know.

Throughout, keep your own context lean: push GitHub I/O and its raw output down to the
workers and hold only the distilled results.
