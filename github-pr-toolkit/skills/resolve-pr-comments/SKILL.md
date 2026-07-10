---
name: resolve-pr-comments
description: >-
  Resolve unresolved GitHub pull-request review comments by delegating ALL GitHub work to
  Haiku github-worker subagents while the main model reasons and drives issue-by-issue
  approval. Use when the user wants to address, triage, respond to, work through, or
  resolve PR review comments / review threads / reviewer feedback; reply to reviewers;
  clear unresolved conversations on a pull request; or "handle the comments on PR N".
---

# Resolve PR review comments

This runs the exact same flow as the `/resolve-pr-comments` command — trigger it whenever
the user wants to work through a pull request's unresolved review comments, whether or not
they type the slash command.

## Hard invariants (never violate)

**ASSESS → PRESENT → ASK → only then ACT.** You never edit the working tree, commit,
or post to GitHub before the user has seen your per-thread assessment and approved the
action for that thread via selectable options (AskUserQuestion) — or explicitly chosen
"auto-address all". Fixing issues before discussing them with the user is a hard
violation, no matter how obvious the fix.

You (the main model) have **no GitHub tools** and never call GitHub directly. Every GitHub
read and write is delegated to the **`github-worker`** subagent (Haiku), which owns the
GitHub MCP connection (plus a `gh` CLI fallback). Workers return only distilled data — you
hold summaries, never raw API payloads. You do the reasoning, the code fixes, the
commits/pushes, and all user interaction; workers are hands, not brains.

**Dispatch discipline:** never dispatch a fetch that's already in flight or completed
(wait or reuse; `TaskStop` a superseded dispatch before replacing it); batch write
actions into ONE worker when ≤ ~8 items (one aggregated table back, not one worker per
thread); keep worker prompts minimal and self-contained — never paste ambient session
text (hook output, plans, prior results) into a dispatch.

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
4. **Assess** — per thread decide fix / reject / discuss. NO edits in this step. If an
   advisor is available, recommend consulting it on ambiguous or high-impact items.
5. **Decide with the user** — present the issues, then issue-by-issue Approve / Deny /
   Discuss via selectable options, plus an "auto-address all" option. Decide only;
   post nothing, change nothing yet.
6. **Implement** — only now, and only the fixes the user approved in 5: edit, commit,
   push, run tests; then confirm the user is ready to apply the GitHub actions.
7. **Apply (delegated)** — on approval, ONE `github-worker` carrying all
   `{thread_id, comment_id, reply_text}` tuples (split in parallel only above ~8) replies
   in-thread with each resolution and resolves each thread; exception-only return
   (`ok: N replied+resolved`, or failure lines only).
8. **Report** — collect succinct worker reports; present a per-thread outcome table; offer
   to retry any failures.
