# github-pr-review

A Claude Code plugin that resolves **unresolved pull-request review comments** with a
clean split of labor:

- **Opus (the orchestrator)** reasons, writes the code fixes, drives issue-by-issue
  approval with you, commits, and pushes. It has **no GitHub tools**.
- **Haiku (`github-worker` subagents)** do every GitHub read/write via the GitHub MCP
  server (with a `gh` CLI fallback) and hand back only distilled results.

The point: raw GitHub API payloads never enter the high-reasoning model's context, and
the expensive model is never spent driving a tool it doesn't need.

## How the gate works

The GitHub MCP server is scoped **inline** in `agents/github-worker.md`'s `mcpServers`
frontmatter. Inline servers connect only while that subagent runs. As long as you do
**not** also register a `github` server globally (`.mcp.json` / user settings), the
orchestrator never has the connection and physically cannot call GitHub — it *must*
delegate. This is an architectural gate, not a permission rule. (`permissions.deny`
would not work here: it's global and would block the Haiku worker too.)

## Install

Add this repo as a plugin (from a marketplace, or a local `--plugin-dir` during dev),
then enable it. Commands and agents auto-load from `commands/` and `agents/`.

## Setup

1. **A GitHub MCP server + token.** The worker defaults to the official
   `github/github-mcp-server` via Docker, reading `GITHUB_PERSONAL_ACCESS_TOKEN`.
   Create a PAT with scope `repo` (add `read:org` for org repos) and export it:
   ```sh
   export GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx
   ```
   Prefer a token over interactive OAuth so the worker also works in headless/scheduled
   runs. Alternatives (native binary, classic npx server) are commented in
   `agents/github-worker.md`. **You don't have to get this right up front** — the
   `/resolve-pr-comments` preflight detects a broken setup and walks you through it.

2. **`gh` CLI (fallback).** `gh auth login`. The official server handles unresolved-thread
   listing (`pull_request_read`/`get_review_comments`), in-thread replies
   (`add_reply_to_pull_request_comment`), and thread resolution
   (`pull_request_review_write`/`resolve_thread`) natively. `gh api graphql` is only a
   fallback for servers that lack those (e.g. the classic npx server) — worth having anyway.

3. **Global context-mode allowance (if you run context-mode).** Because context-mode's
   PreToolUse hook redirects `WebFetch`/`Bash` to its own MCP tools, subagents that use
   Bash need those tools permission-allowed. This is set at the user level in
   `~/.claude/settings.json` → `permissions.allow` (the `ctx_*` tools). See the plugin
   author's notes; it's a one-time global grant, independent of this plugin.

## Usage

```
/resolve-pr-comments            # asks which PR (defaults to this repo's remote)
/resolve-pr-comments 123        # target PR #123
/resolve-pr-comments <PR URL>
```

Flow: preflight/onboarding → workers fetch unresolved threads → you assess (optionally
consulting an advisor) → issue-by-issue approve/deny/discuss (or auto-address all) →
you fix, commit, push → confirm → workers post replies and resolve each thread → final
report.

## Security note

`agents/github-worker.md` uses `permissionMode: bypassPermissions` so the non-interactive
Haiku worker can call its tools without prompts. Its blast radius is bounded by the
explicit `tools:` allowlist and by the fact that the orchestrator only hands it narrow
tasks. For tighter control, remove `permissionMode` and commit narrow allow rules
(specific `mcp__github__*` tools plus `Bash(gh api *)`) to `.claude/settings.json`
instead.

## Optional hardening

If you ever *must* register the GitHub MCP server globally (so the orchestrator can see
it), add a `PreToolUse` hook matching `mcp__github__.*` that returns
`permissionDecision: "deny"` unless the caller is the worker — the hook's stdin carries
`agent_id` (present only inside a subagent) and `agent_type` (the agent's `name`), so
"block the orchestrator, allow the Haiku fleet" is a short hook.
