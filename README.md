# github-agent-plugins

**A Claude Code plugin marketplace for GitHub pull-request workflows** — built on one
architecture: a **higher-reasoning orchestrator** that reasons, decides, and talks to you,
delegating all GitHub I/O to **Haiku worker subagents** that own the GitHub MCP connection
and hand back only distilled results. Raw API payloads never enter the expensive model's
context, and the expensive model is never spent driving tools it doesn't need.

## Plugins

| Plugin | Commands | What they do |
|---|---|---|
| **[github-pr-toolkit](github-pr-toolkit/README.md)** | `/resolve-pr-comments` | Respond to and **resolve** the review comments reviewers left on your PRs — assess each thread, reply, fix or reject, resolve, tracked as a task list. Assessment runs inline or on a `thread-assessor` subagent pinned to the model you pick (default, Opus, Sonnet, or Fable). |
| | `/code-critic` | **Author** an adversarial code review of a local diff or a GitHub PR — the run's first question declares what findings become (fix them, or only comment/report; comment mode makes zero code changes, and the review itself is identical either way) — across user-selected categories (general, security, design, rules-adherence, performance, tests — plus your own, via the `add-review-category` wizard skill), fanned out to parallel per-category review subagents on the model you pick (session default, Opus, Sonnet, or Fable — one model across every category; or hand the review to the advisor / main agent instead, with optional advisor second opinions) — high-signal by construction: every finding must name what breaks if it ships, and a clean diff ends in a clean report rather than a padded list. General Review also flags ephemeral comments — the `// changed from foo to bar` narration LLMs leave behind, which stops meaning anything once the diff merges. Severity-triaged findings tracked as a task list, nits batched into one ask, fix locally or post inline comments as one review, deduped against existing threads. Posted comments open with a colour-coded severity banner (🔴 CRITICAL … ⚪ NIT). Feedback tone (terse / balanced / suggestion) is a plugin setting, applied most visibly to the PR comments it drafts — wording only, never a severity or a finding. ([docs](github-pr-toolkit/docs/code-critic.md)) |
| | `/github-pr-toolkit:doctor` | Diagnose (and help fix) the GitHub MCP wiring without running either flow — and clear orphaned `/code-critic` review markers left in `.git` by a crashed run. |

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

- **Claude Code** (recent) — plugin MCP servers, subagents, PreToolUse hooks
  (verified on v2.1.206).
- **A GitHub MCP server** — default: **GitHub's hosted remote MCP**, connected
  directly from the plugin's `.mcp.json` (PAT flows keychain → Bearer header; nothing
  to install or run locally). Local alternative: edit `.mcp.json` to run the official
  server via Docker or the native binary.
- **`gh` CLI** *(optional)* — gated fallback for servers lacking a native capability.

## Architecture (shared)

- The GitHub MCP server is defined in the plugin's `.mcp.json` (Claude Code drops
  `mcpServers` declared in plugin agent frontmatter), and a **PreToolUse guard hook**
  enforces the gate: the main agent is always denied the
  `mcp__plugin_github-pr-toolkit_github__*` tools **and the `gh` CLI**, while the two
  worker subagents are actively granted them — delegation is mandatory, not advisory.
  Both transports are gated on the same always-on basis, with no review or lock
  required, because closing one door and leaving the other open only moves the mistake;
  the sole carve-outs are `gh auth status` / `gh --version`, local credential checks the
  doctor needs when MCP itself is what's broken. `github-worker` can open and update PRs
  (`create_pull_request`, `update_pull_request`, `update_pull_request_branch`) so the
  delegated path is a real alternative rather than a dead end — but **not merge one**:
  merging is irreversible and stays the user's call.
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
- code-critic adds a session-scoped **PreToolUse guard** for remote-mutating git
  (`push`/`commit`/`pull`/`worktree`) during an active review — that tier stays
  lock-scoped, since it is plain git rather than GitHub access and blocking it always
  would stop ordinary committing everywhere the plugin is installed.
- code-critic's adversarial pass can fan out to **six per-category review subagents**
  (`code-reviewer-*`, on a model you pick — session default, Opus, Sonnet, or Fable,
  applied uniformly so every category reviews on the same one; the picker never offers
  Haiku, which stays reserved for the I/O workers), or run **all categories in one
  `code-reviewer-all` subagent** when you want one dispatch instead of six — cheaper, and
  able to see cross-lens interactions, but one reasoner rather than six independent ones.
  **The fan-out width is asked, never assumed:** choosing the per-category path with 2+
  categories prompts for how many run at once (6 at a time rolling by default, all N, one
  at a time, or your own number), with a rolling queue above the cap so a freed slot
  refills immediately instead of idling on a straggler. A cap of 1 *is* the no-fan-out
  answer. Their findings are cross-checked against the orchestrator's own diff.
- **A code review cannot alter code**, structurally: the reviewer agents ship no `tools:`
  allowlist (so they inherit any memory MCP server the session has, with nothing to
  enumerate) and a `disallowedTools` list that removes `Write`/`Edit`/`MultiEdit`/
  `NotebookEdit` and the GitHub MCP server. Bash stays reachable because read-only git is
  how a reviewer recomputes the diff — a deny-list can't express "read-only shell", so
  the guard hook holds it to read-only inspection at runtime. Reviewers read memory for prior insight and may record
  durable repo facts, but never write a **finding**: unverified at the moment they hold
  it, and a memory is recalled as fact by every later review.
- resolve-pr-comments gates on the user before any reasoning happens: it presents the
  threads it found, then asks how to work them — fan out a **`thread-assessor`** per
  thread in parallel, go one at a time (assess → decide → next), or assess inline — on
  the model they pick (default / Opus / Sonnet / Fable). Fanning out over **6 threads**
  takes a second confirmation, defaulting to a **rolling queue** (6 in flight, refilled
  as each returns) rather than one big batch, so a busy PR can't silently become 20
  concurrent subagents. The assessor carries no Bash and no GitHub tools, so it can only
  read and propose.

See the [plugin README](github-pr-toolkit/README.md) for setup, flows, security notes,
and troubleshooting.
