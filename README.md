# github-agent-plugins

**A Claude Code plugin marketplace for GitHub pull-request workflows** — built on one
architecture: a **higher-reasoning orchestrator** that reasons, decides, and talks to you,
delegating all GitHub I/O to **Haiku worker subagents** that own the GitHub MCP connection
and hand back only distilled results. Raw API payloads never enter the expensive model's
context, and the expensive model is never spent driving tools it doesn't need.

## Plugins

| Plugin | Commands | What they do |
|---|---|---|
| **[github-pr-toolkit](github-pr-toolkit/README.md)** | `/resolve-pr-comments` | Respond to and **resolve** the review comments reviewers left on your PRs — assess each thread, reply, fix or reject, resolve. |
| | `/code-critic` | **Author** an adversarial code review of a local diff or a GitHub PR — severity-triaged findings, fix locally or post inline comments as one review, deduped against existing threads. ([docs](github-pr-toolkit/docs/code-critic.md)) |
| | `/github-pr-toolkit:doctor` | Diagnose (and help fix) the GitHub MCP wiring without running either flow. |

The two flows are complements: **code-critic writes reviews; resolve-pr-comments works
through the reviews others wrote.** One plugin, one PAT config for both.

> `github-pr-toolkit` replaces the former separate `resolve-pr-comments` and
> `code-critic` plugins — uninstall those, install this, enter the PAT once.

## Install

```
/plugin marketplace add JimCline/github-agent-plugins
/plugin install github-pr-toolkit@jimcline
```

The install dialog prompts for a single **GitHub PAT** (stored in your OS keychain),
shared by both commands. Fine-grained scopes: **Metadata: Read, Pull requests: Read &
write, Contents: Read** — see the [plugin README](github-pr-toolkit/README.md#github-token-requirements).

## Requirements (common)

- **Claude Code** with subagent `mcpServers` + `permissionMode` frontmatter support
  (verified on v2.1.197+).
- **A GitHub MCP server** — default: **GitHub's hosted remote MCP**
  (`api.githubcopilot.com/mcp/x/pull_requests`), authenticated with the plugin's PAT as
  a Bearer header — nothing to install or run locally. Local alternatives (official
  server via Docker or native binary) are commented in each worker's agent file.
- **`gh` CLI** *(optional)* — gated fallback for servers lacking a native capability.

## Architecture (shared)

- The GitHub MCP server is scoped **inline** in each worker agent's `mcpServers`
  frontmatter — it connects only while that worker runs, so the orchestrator physically
  cannot call GitHub (an architectural gate, not a permission rule).
- Workers run on **Haiku** with a locked tool allowlist, the server narrowed to the
  pull-request toolset, and explicit never-fabricate rules; the orchestrator
  cross-checks worker returns. Haiku executes, it never judges: trimming is verbatim
  truncation (never summarization), failure sequencing in combined tasks is pinned, and
  the `gh` CLI is a **gated** fallback — allowed only after the MCP call for the same
  operation failed, and flagged in the return (`via: gh (mcp error: …)`) so a broken
  MCP setup can't hide behind it.
- **Dispatch economy:** workers take batched/combined tasks with exception-only,
  exact-string returns (`ok: <N> …`, verified against the count sent), so a full flow
  costs ~3 worker dispatches instead of one per thread/finding — each avoided dispatch
  saves fixed harness overhead plus anything ambient hooks inject into subagent prompts.
- code-critic adds a session-scoped **PreToolUse guard** for the `gh`/git surface during
  an active review.

See the [plugin README](github-pr-toolkit/README.md) for setup, flows, security notes,
and troubleshooting.
