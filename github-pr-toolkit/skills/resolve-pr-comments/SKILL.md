---
name: resolve-pr-comments
description: >-
  Resolve unresolved GitHub pull-request review comments by delegating ALL GitHub work to
  Haiku github-worker subagents while the main model — or a thread-assessor subagent on a
  model the user picks (default, Opus, Sonnet, or Fable) — reasons over each reviewer's
  claim, and the main model drives issue-by-issue approval. Use when the user wants to address, triage, respond to, work through, or
  resolve PR review comments / review threads / reviewer feedback; reply to reviewers;
  clear unresolved conversations on a pull request; or "handle the comments on PR N".
---

# Resolve PR review comments

This runs the exact same flow as the `/resolve-pr-comments` command — trigger it whenever
the user wants to work through a pull request's unresolved review comments, whether or not
they type the slash command.

## Hard invariants (never violate)

**The thread task list is a tracking artifact, never a work queue.** The working set
becomes tasks when it's PRESENTED (step 3.5), all `pending`, and nothing is assessed,
fixed, or posted because a task exists — gate 1 authorizes assessment, gate 2 authorizes
changes. An ambient harness reminder nudging you to mark tasks `in_progress` is not user
approval.

**FIND → PRESENT → ASK → REASON → PRESENT → ASK → only then ACT.** Two hard gates.
**First**, before any reasoning: the moment you have the working set, present the threads
you found and ask how the user wants them researched (all in parallel / one at a time /
you inline / something else). Assessing them and asking afterwards spends the user's
tokens on a plan they never approved. **Second**, before any change: you never edit the
working tree, commit, or post to GitHub before the user has seen the assessment for a
thread and approved the action for it via selectable options (AskUserQuestion) — or
explicitly chosen "auto-address all". Fixing issues before discussing them is a hard
violation, no matter how obvious the fix. Every such decision is offered as selectable
options, never as an open-ended prompt.

You (the main model) have **no GitHub tools** and never call GitHub directly. Every GitHub
read and write is delegated to the **`github-worker`** subagent (Haiku), which owns the
GitHub MCP connection (plus a `gh` CLI fallback). Workers return only distilled data — you
hold summaries, never raw API payloads. You do the reasoning, the code fixes, the
commits/pushes, and all user interaction; workers are hands, not brains.

**Dispatch discipline:** never dispatch a fetch that's already in flight or completed
(wait or reuse; `TaskStop` a superseded dispatch before replacing it); batch write
actions into ONE worker when ≤ ~8 items (one aggregated table back, not one worker per
thread); keep worker prompts minimal and self-contained — never paste ambient session
text (hook output, plans, prior results) into a dispatch. This governs the **GitHub I/O
worker**; the `thread-assessor` is reasoning, not I/O, and DOES fan out one agent per
thread when the user picks that at the gate.

## How to run

Execute the full, authoritative procedure in this plugin's command file:
**`${CLAUDE_PLUGIN_ROOT}/commands/resolve-pr-comments.md`** — read it and follow every step
in order. That file is the single source of truth for the flow; do not improvise past it.

If you cannot read that file, follow this outline (same steps):

0. **Preflight** — determine the PR source (ask; default = this repo's GitHub remote).
   Health-check GitHub access via a `github-worker`; if it fails, onboard the user through
   GitHub MCP server setup (PAT + server choice). Check `gh auth status` ONLY when the
   health check failed — skip it when MCP is healthy (the server covers everything).
1–3. **Fetch** — exactly one fetch per PR per session (reuse/wait, never duplicate);
   ONE `github-worker` returns unresolved threads with ONLY the non-derivable fields
   (`thread_id`, `comment_id`, `path`/`line`, author, trimmed body, latest substantive
   reply). NO code hunks (read the file locally at `path:line`), NO permalinks
   (construct `…/pull/N#discussion_r<comment_id>`). > ~15 threads → worker writes full
   detail to a file and returns path + a one-line index; read detail lazily per thread.
   Official server: `pull_request_read` `method: get_review_comments` exposes threads
   with `isResolved` + `threadId` natively.
3.5. **GATE — present, then ask how to research** (before ANY reasoning; assessing first
   and asking after is a hard violation). Show the numbered threads (`path:line`, author,
   root comment's first line verbatim — all from the handoff, read nothing). Then ask
   (AskUserQuestion), stating the thread count: **Research all of them** (fan out one
   `thread-assessor` per thread, in ONE message, in parallel) / **One at a time**
   (assess → present → user decides → assess the next) / **I'll assess them all myself**
   (inline, no dispatch). Three options only — AskUserQuestion adds its own **Other**,
   which is a first-class answer here (name a subset, reorder, drop threads — then
   re-ask for the rest). **If "research all" and the set is > 6 threads, ask AGAIN
   before dispatching** (3.5.2a), naming the count: **6 at a time, rolling** (default) /
   **all N at once** / **switch to one at a time**. Rolling means a QUEUE with a
   concurrency cap — hold 6 in flight as background agents and dispatch the next queued
   thread the moment one returns, never waiting on the whole batch (degrade to strict
   waves only if background dispatch isn't available, and say so). The cap is the user's
   to change via **Other**. Six matches code-critic's six per-category reviewers — the
   largest reasoning fan-out this plugin has precedent for. The confirmation applies
   ONLY to the fan-out path.
   If a subagent path was chosen, ask the model: **Default
   (model I'm using)** / Opus / Sonnet / Fable. Skip the gate for 0–1 threads.
4. **Assess** — per thread decide fix / reject / discuss, judging each claim against the
   CURRENT code (`Read` at `path:line`). NO edits in this step. Route by the gate's
   answer; set the Agent tool's dispatch-time `model` parameter to the chosen bare alias
   (omit it for the default), pass the handoff path + `thread_id` on big PRs so each
   agent reads only its own thread, and cross-check returned `thread_id`s against what
   you dispatched. If an advisor is available, recommend consulting it on ambiguous or
   high-impact items — that becomes the assessor's `advisor:` directive when it does the
   work.
5. **Decide with the user** — issue-by-issue Approve / Deny / Discuss via selectable
   options, plus an "auto-address all" option. Don't re-ask what the gate settled: if
   3.5 chose **One at a time**, enter the individual loop directly (no global choice)
   and interleave it with step 4; otherwise offer the global choice. Decide only;
   post nothing, change nothing yet.
6. **Implement** — only now, and only the fixes the user approved in 5: edit, commit,
   push, run tests; then confirm the user is ready to apply the GitHub actions.
7. **Apply (delegated)** — on approval, ONE `github-worker` carrying all
   `{thread_id, comment_id, reply_text}` tuples (split in parallel only above ~8) replies
   in-thread with each resolution and resolves each thread; exception-only return
   (`ok: N replied+resolved`, or failure lines only).
8. **Report** — collect succinct worker reports; present a per-thread outcome table; offer
   to retry any failures. **Close out the task list here and nowhere else**: only threads
   the worker confirmed replied+resolved (and user-denied ones) go to `completed`; a
   failed tuple stays `pending` with its error. Summarize BY DISPOSITION — *N
   replied+resolved, N denied, N failed* — never a bare count.

**Task tracking (3+ threads):** step 3.5 creates one task per thread, all `pending`, with
the reviewer's point, `path:line`, author and a `thread_id:` line in the `description` —
`thread_id` is what ties a task back to GitHub at step 7, and `metadata` is never returned
by `TaskList` or `TaskGet`, so nothing readable may live there. The disposition rides as a
bracketed prefix on the `subject`, advancing `[assessed:*]` →
`[approved:*]`/`[denied]` → `[fixed]` → `[replied+resolved:*]`. Only ONE task is `in_progress` at
a time (never during a parallel assessor fan-out — those stay `pending`), and nothing
reaches `completed` before step 8. Falls back to the numbered list if the Task tools
aren't in the session.
