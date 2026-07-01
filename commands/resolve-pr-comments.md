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

Optional argument (a PR number or URL): `$ARGUMENTS`

---

## Step 0 — Preflight & onboarding

**0.1 Pick the PR source.** If `$ARGUMENTS` already names a specific PR, use it.
Otherwise ask the user (AskUserQuestion):
- *Default:* "This repo's GitHub remote" — derive `owner/repo` from
  `git remote get-url origin` (or `gh repo view --json nameWithOwner`).
- "A different repo or PR URL" — let them paste `owner/repo` or a full PR URL.

If the PR number still isn't known, delegate to `github-worker`: *"List open PRs for
`<owner/repo>` that have unresolved review threads; return number, title, author,
#unresolved."* Show the list and let the user choose.

**0.2 Health-check GitHub access.** Delegate a minimal task to `github-worker`:
*"Confirm GitHub access to `<owner/repo>`: read its pull requests (list/search PRs, or read
one PR) and return ok/failed + reason. Fetch nothing else."*
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

Delegate the fetch to `github-worker` (one worker for the PR; split into parallel
workers per-thread only if the PR is very large). Instruct it to return a **succinct
handoff** — for EACH unresolved review thread only:
`thread_id` (GraphQL node id), `comment_id` (root review-comment REST id), `path`,
`line`/`start_line`, `author`, root comment `body` (verbatim, trimmed), any `replies`
(author + trimmed body), a short quoted `code_hunk` (a few lines of context — never the
whole file), and `permalink`.

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

**Only after explicit user approval.** For each addressed thread, delegate to
`github-worker` — fan out in parallel, one thread (or a small batch) per worker. Each
unit does exactly:
- **Reply** to the original review comment (`in_reply_to = comment_id`) with the
  resolution: for a fix, summarize the change and cite the pushed commit SHA; for a
  rejection, give the rationale.
- **Resolve** the thread (`thread_id`).
The worker replies via `add_reply_to_pull_request_comment` and resolves via
`pull_request_review_write (method: resolve_thread, threadId)` — both native on the official
server; `gh api` is the fallback only if the server lacks them. Give each worker only its
thread(s) and the exact reply text — never the plan.

---

## Step 8 — Collect reports & summarize

Each worker returns a succinct report: `thread_id`, `reply_posted`, `resolved`, `error`.
Compile a final table for the user: per-thread outcome, commit SHAs for fixes, and any
failures. Offer to retry failures (re-delegate just those).

Throughout, keep your own context lean: push GitHub I/O and its raw output down to the
workers and hold only the distilled results.
