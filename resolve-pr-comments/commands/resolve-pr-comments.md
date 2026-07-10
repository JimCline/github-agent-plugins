---
description: Resolve unresolved PR review comments — Haiku workers fetch & post to GitHub, you reason & drive issue-by-issue user approval.
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

## Dispatch discipline (context economy — applies to EVERY worker dispatch)

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
  `git remote get-url origin` (or `gh repo view --json nameWithOwner`).
- "A different repo or PR URL" — let them paste `owner/repo` or a full PR URL.

If the PR number still isn't known, delegate to `github-worker`: *"List open PRs for
`<owner/repo>` that have unresolved review threads; return one line per PR — number,
title, author, #unresolved — and nothing else."* Show the list and let the user choose.

**0.2 Health-check GitHub access.** Delegate a minimal task to `github-worker`:
*"Confirm GitHub access to `<owner/repo>` using ONLY your `mcp__github__*` tools —
`gh`/Bash is FORBIDDEN for this task (it verifies the MCP server + PAT specifically;
a gh success would mask a broken server). Read its pull requests (list/search PRs, or
read one PR). Fetch nothing else. Return EXACTLY `ok` on success, or `failed:
<one-line reason>` — no other text."*

Thereafter, watch every worker return for a `via: gh (mcp error: …)` line — that means
the MCP path failed mid-run and the worker fell back. Surface it to the user and offer
the 0.2 onboarding; don't let a degraded setup ride silently on the fallback.
- **ok →** continue.
- **failed → ONBOARDING.** The GitHub MCP server isn't configured or reachable. The most
  common cause is an unset/invalid PAT — this plugin stores its token in the secure
  `github_pat` config (OS keychain), NOT an env var, so guide the user to set it via
  **`/plugin` → `resolve-pr-comments` → Configure** (or the install dialog). Then explain the
  server options and help set up whichever they pick:
  - **(a) Official `github/github-mcp-server`** (Docker or native binary) + a GitHub PAT — recommended, token-based, works headless.
  - **(b) Classic `@modelcontextprotocol/server-github`** via npx + PAT.
  - **(c) GitHub-hosted remote MCP** (OAuth) — most capable, but not for headless/scheduled runs.
  Walk them through: creating a fine-grained PAT (Metadata: Read, Pull requests: Read & write),
  pasting it into the plugin's `github_pat` config, and — if they pick a non-default server —
  editing `agents/github-worker.md`'s `mcpServers` block (and the `mcp__github__*` tool
  names to match that server). Re-run 0.2 after.

**0.3 Check the `gh` fallback.** Run `gh auth status`. If `gh` is authenticated, workers
may use `gh api` / `gh api graphql` for operations the MCP server doesn't expose
(unresolved-thread listing, in-thread replies, thread resolution). If `gh` is missing,
warn the user that thread *resolution* and *unresolved filtering* may be limited to what
the MCP server natively supports, and offer to help install/auth `gh`.

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

## Step 4 — Assess, and (if available) consult the advisor

For each thread, decide a concrete proposed action:
- **fix** — a specific code change (name the files/functions and the gist).
- **reject** — with a crisp rationale to post back to the reviewer.
- **discuss** — genuinely ambiguous / needs the author's intent.

If an **advisor** capability is available to you this session (an advisor tool/model),
**recommend to the user** that you consult it on the `discuss` items and any high-impact
`fix`/`reject` calls, and fold its input in if they agree. If no advisor is available,
say so in one line and continue.

---

## Step 5 — Issue-by-issue resolution with the user

First offer a global choice (AskUserQuestion):
- **"Review each issue individually"**, or
- **"Auto-address all"** — apply your proposed action to every thread, then show the
  whole batch for a single confirmation before anything is posted.

**Individual mode:** loop over threads **one at a time**. For each, show the comment,
your proposed action, and any advisor input, then ask (AskUserQuestion):
**Approve** / **Deny** (reject the reviewer's point — capture the rationale) /
**Discuss** (open-ended; iterate with the user until satisfied, then re-ask).
Record each thread's final decision and the exact resolution note to post later.

**Post nothing to GitHub in this step.** This step only decides.

---

## Step 6 — Implement, commit, push, then confirm

For every thread whose decision is a code **fix**:
- Make the edits in the working tree.
- Group logically and commit with clear messages that reference the PR/thread.
  Work on the PR's branch (or the project's conventional fixup branch).
- Push.
Run the project's tests/build if present, and report the results.

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

Throughout, keep your own context lean: push GitHub I/O and its raw output down to the
workers and hold only the distilled results.
