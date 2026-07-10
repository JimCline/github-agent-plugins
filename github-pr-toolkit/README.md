# github-pr-toolkit

**Two pull-request workflows, one architecture, one PAT.**

| Command | What it does | Docs |
|---|---|---|
| **`/resolve-pr-comments`** | Work through the review threads reviewers *already opened*: assess each, reply, fix or reject, and resolve. | this file |
| **`/code-critic`** | *Author* an adversarial review of a local diff or a GitHub PR: severity-triaged findings, fix locally or post inline comments as one review. | [docs/code-critic.md](docs/code-critic.md) |
| **`/github-pr-toolkit:doctor`** | Diagnose (and help fix) the GitHub MCP wiring without running either flow. | below |

The two flows are complements — **code-critic writes reviews; resolve-pr-comments works
through the reviews others wrote** — and share a clean split of labor:

- **A higher-reasoning agent (the orchestrator)** reasons, writes the code fixes, drives
  issue-by-issue approval with you, commits, and pushes. It has **no GitHub tools**.
- **Haiku workers** (`github-worker` for resolving, `critic-worker` for reviewing) do
  every GitHub read/write via the GitHub MCP server (with a gated `gh` CLI fallback) and
  hand back only distilled results.

Raw GitHub API payloads never enter the high-reasoning model's context, and the expensive
model is never spent driving a tool it doesn't need. This documentation covers setup
(shared) and the `/resolve-pr-comments` flow; `/code-critic` details live in
[docs/code-critic.md](docs/code-critic.md).

---

## Requirements

| Requirement | Why | Notes |
|---|---|---|
| **Claude Code** with subagent `mcpServers` + `permissionMode` frontmatter support | The gate + the Haiku worker rely on these | Verified on **v2.1.197**; use a recent version |
| **A GitHub MCP server** | The workers' actual GitHub tools | Default = **GitHub's hosted remote MCP** (`api.githubcopilot.com/mcp/`), authenticated with the plugin's PAT via the `mcp-remote` stdio bridge — needs only `npx`, which ships with Node (already present if you installed Claude Code via npm; otherwise `brew install node`). Local alternatives below |
| **Docker** *(only if you switch to the local-server alternative)* | Runs `ghcr.io/github/github-mcp-server` locally | Not needed for the hosted default |
| **A GitHub Personal Access Token (PAT)** | Authenticates the worker's GitHub API calls | **See [GitHub token requirements](#github-token-requirements)** — this is the main setup step |
| **Git push access to the repo** | The orchestrator commits & pushes your fixes | Uses your normal git auth (SSH or credential helper), **separate** from the PAT |
| **`gh` CLI** *(optional)* | Fallback for servers lacking native thread ops | `gh auth login`; uses its own auth |

---

## Installation

### 1. Install & enable the plugin

**Local / development** — point Claude Code at this plugin's directory:

```sh
claude --plugin-dir /path/to/github-agent-plugins/github-pr-toolkit
```

**From the marketplace** (this repo's root `.claude-plugin/marketplace.json`). In Claude Code:

```
/plugin marketplace add JimCline/github-agent-plugins
/plugin install github-pr-toolkit@jimcline
```

> **Upgrading from the former `resolve-pr-comments` / `code-critic` plugins?** This
> plugin replaces both — uninstall them, install this one, and enter the PAT **once**
> (with the superset scopes below).

Enabling the plugin auto-loads both commands (`/resolve-pr-comments`, `/code-critic`),
their same-named skills, the doctor, and both worker agents. No `.mcp.json` changes are
needed — the GitHub MCP server is scoped **inside** each worker (see
[How the gate works](#how-the-gate-works)).

### 2. Create a GitHub PAT

See [GitHub token requirements](#github-token-requirements) for exact scopes. In short:
create a token at **GitHub → Settings → Developer settings → Personal access tokens**, give
it access to the repo(s) you'll review, and grant it PR read+write.

### 3. Provide the token — part of install, no env var

The plugin declares a secure `userConfig` option, so when you run
`/plugin install github-pr-toolkit@jimcline` Claude Code shows a **configuration dialog**
with a masked **"GitHub Personal Access Token"** field. Paste your PAT there — **once;
both commands and both workers share it**. It's stored in your **OS keychain** — never in
`settings.json`, a tracked file, or the shared `GITHUB_PERSONAL_ACCESS_TOKEN` env var, so
it can't clash with your other GitHub tooling.

Change it anytime via **`/plugin` → `github-pr-toolkit` → Configure**. Under the hood
each worker's MCP config reads it as `${user_config.github_pat}` and sends it to
GitHub's hosted MCP server as a Bearer header.

You don't have to get this perfect up front — running `/resolve-pr-comments` health-checks
GitHub access first and, if it fails (the most common cause is a missing token), **walks
you through the setup**.

### 4. Choose the GitHub MCP server runtime *(optional — the hosted default only needs `npx`)*

Each worker's server is defined in its agent file → `mcpServers`. The default is
**GitHub's hosted remote MCP server** — the official server, run by GitHub, with the
plugin's PAT sent as a Bearer header (the hosted server accepts PATs, not just OAuth) —
reached through the small `mcp-remote` stdio bridge:

```yaml
command: sh
args: ["-c", "exec npx -y mcp-remote https://api.githubcopilot.com/mcp/x/pull_requests --header \"Authorization: Bearer $GITHUB_PAT\" --transport http-only"]
env:
  GITHUB_PAT: "${user_config.github_pat}"
```

**Why the bridge instead of a direct `type: http` block:** Claude Code currently does
not substitute `${user_config.*}` into HTTP `headers:` values
([claude-code#51581](https://github.com/anthropics/claude-code/issues/51581) — the
header is sent literally, so auth fails) and `headersHelper` is unreliable (#41690,
#48514, #72808). Env substitution into a stdio command **is** reliable, so the PAT
flows keychain → env var → shell → header. The direct http config is commented in the
agent files, ready for when #51581 is fixed.

The `/x/pull_requests` URL path narrows the server to only the pull-request toolset — see
[Narrowing the MCP surface](#narrowing-the-mcp-surface-applied-by-default). Tool names are
identical to the local server's.

Local alternatives (commented in the agent files, same PAT, same tool names):
- **Official server via Docker** (`ghcr.io/github/github-mcp-server`) — for offline or
  self-hosted preferences.
- **Official server as a native binary** (no Docker): `github-mcp-server stdio`.

### 5. (Optional) `gh` CLI fallback

```sh
gh auth login
```

The official server handles unresolved-thread listing, in-thread replies, and thread
resolution natively, so `gh` is only a fallback for servers that lack those. The fallback
is **gated**: the worker may use `gh` for an operation only after the MCP call for that
same operation failed, and it must flag the fallback in its return
(`via: gh (mcp error: …)`) so a broken MCP setup can't hide behind it. The preflight
health check is MCP-only for the same reason. Recommended anyway.

### 6. (Optional) context-mode allowance

If you run the **context-mode** plugin, its `PreToolUse` hook redirects `WebFetch`/`Bash`
to its own MCP tools. Subagents that use Bash (e.g. for the `gh` fallback) need those tools
permission-allowed. This is a one-time **user-level** grant in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_context-mode_context-mode__ctx_fetch_and_index",
      "mcp__plugin_context-mode_context-mode__ctx_execute",
      "mcp__plugin_context-mode_context-mode__ctx_batch_execute",
      "mcp__plugin_context-mode_context-mode__ctx_execute_file"
    ]
  }
}
```

It's independent of this plugin; skip it if you don't run context-mode.

> **Known interaction:** context-mode's `PreToolUse` hook also appends a ~4.5 KB
> `<context_window_protection>` routing block to **every** subagent dispatch,
> unconditionally and with no off switch. Besides the token cost, that block can trip
> permission auto-classifiers ("keep raw bytes out of the transcript" pattern-matches
> monitoring evasion), causing a worker dispatch to be rejected. The orchestrator is
> instructed to re-send a rejected dispatch as a bare minimal task string; batching
> (one worker per write batch instead of one per thread) also pays this injection once
> instead of N times.

---

## GitHub token requirements

The PAT authenticates the **worker's** GitHub API calls: reading PRs and review threads,
posting replies to review comments, and **resolving** conversations. (Your code pushes go
through your normal git auth, not this token — see the note below.)

### Classic PAT (simplest)

| Scope | Needed for |
|---|---|
| **`repo`** | **Required.** Read PRs/review threads, post review-comment replies, resolve threads (private + public repos). |
| `read:org` | Only if you work with **organization-owned** repos and want the server's org tools. |

Create at **Settings → Developer settings → Personal access tokens → Tokens (classic)**,
check **`repo`**, set an expiry, generate, and paste it into the plugin's **GitHub Personal Access Token** config field (step 3).

### Fine-grained PAT (least privilege — recommended)

Create at **Settings → Developer settings → Personal access tokens → Fine-grained tokens**:

- **Repository access:** select the specific repo(s) you'll review (or *All repositories*).
- **Permissions** — the minimal set is the three rows below (drop Contents if you'll
  never use `/code-critic`):

| Permission | Access | Needed for |
|---|---|---|
| **Metadata** | Read-only | Mandatory (auto-selected for every fine-grained token). |
| **Pull requests** | **Read and write** | Read review threads/comments; post replies; **resolve threads**. This is the only capability the worker needs. |
| **Contents** | **Read** | Needed by `/code-critic` to check the PR branch out into a worktree. (If you'll only ever use `/resolve-pr-comments`, you can omit it.) Grant **Read and write** only if you push over HTTPS with *this* token (see below). |

> **Permission to resolve conversations:** the token's user must have **write/triage**
> access to the repository (or be the PR/comment author). A read-only collaborator can fetch
> and reply but cannot resolve threads.

### About code pushes

Step 6 of the flow (apply approved fixes) is done by the **orchestrator using `git`**, over
whatever git auth you already have configured (SSH keys or a credential helper) — **not**
this PAT. If you push over **HTTPS using a token**, that token needs `repo` (classic) or
**Contents: Read and write** (fine-grained).

### Narrowing the MCP surface *(applied by default)*

Two independent layers keep the surface tight, and both ship configured:

- **Server toolset:** the worker connects to the hosted server's `/x/pull_requests`
  endpoint (or, on the local alternatives, runs with `-e GITHUB_TOOLSETS=pull_requests`), so
  only the pull-request toolset loads — no repo-admin, actions, code-security, org, or
  file-write tools are even registered.
- **Worker allowlist:** `agents/github-worker.md`'s `tools:` lists only the five PR tools it
  actually calls — `list_pull_requests`, `search_pull_requests`, `pull_request_read`,
  `add_reply_to_pull_request_comment`, `pull_request_review_write`.

This is **separate from the PAT scopes** above: the PAT is the real security boundary at
GitHub's API, while the toolset + allowlist limit what the model can even invoke. Keep both
tight. (If you switch to a different MCP server, adjust these tool names and, if it lacks
native thread resolution, lean on the `gh` fallback.)

---

## Verify the setup

Run the command against any PR you can access:

```
/resolve-pr-comments <PR number or URL>
```

Its **preflight** confirms GitHub access via a worker, checks `gh`, and — if anything is
missing — onboards you through the fix before doing any work.

---

## Usage

```
/resolve-pr-comments            # asks which PR (defaults to this repo's remote)
/resolve-pr-comments 123        # target PR #123
/resolve-pr-comments <PR URL>
```

Or just ask in natural language — e.g. *"resolve the unresolved review comments on PR 123"*
— and the bundled **`resolve-pr-comments`** skill auto-triggers the same flow.
Command and skill share one name and one procedure; the skill delegates to the command
file, so there's no duplicated logic to drift.

**Flow:** preflight/onboarding (MCP-only health check) → ONE worker fetches unresolved
threads (only non-derivable fields; file handoff on very large PRs) → you assess
(optionally consulting an advisor) → issue-by-issue approve/deny/discuss (or auto-address
all) → you fix, commit, push → confirm → ONE batched worker posts every reply and
resolves every thread, returning `ok: <N> replied+resolved` (detail only for failures,
verified against the count sent) → final report.

Batching and exception-only returns keep the orchestrator's context lean: each worker
dispatch carries fixed overhead (and, under the context-mode plugin, a ~1.1k-token
injected routing block), so a 5-thread run costs ~3 dispatches instead of 7+.

---

## How the gate works

The GitHub MCP server is scoped **inline** in `agents/github-worker.md`'s `mcpServers`
frontmatter. Inline servers connect only while that subagent runs. As long as you do **not**
also register a `github` server globally (`.mcp.json` / user settings), the orchestrator
never has the connection and physically cannot call GitHub — it *must* delegate. This is an
architectural gate, not a permission rule. (`permissions.deny` would not work: it's global
and would block the Haiku worker too.)

---

## Security notes

`agents/github-worker.md` uses `permissionMode: bypassPermissions` so the non-interactive
Haiku worker can call its tools without prompts. Its blast radius is bounded by the explicit
`tools:` allowlist and by the fact that the orchestrator only hands it narrow tasks. For
tighter control, remove `permissionMode` and commit narrow allow rules (the specific
`mcp__github__*` tools plus `Bash(gh api *)`) to `.claude/settings.json` instead.

Keep the PAT out of version control, scope it to the repos you actually review, and set an
expiry.

---

## Troubleshooting

Start with **`/github-pr-toolkit:doctor`** — it spins up both workers' inline MCP
servers and reports connect/auth status, without running either flow. (The inline
servers are invisible to `claude mcp list` by design — that command only lists global
servers — so the doctor is the way to sanity-check them.)

- **`No such tool available: mcp__github__*`.** The inline server never started at all.
  Most common cause: the `github_pat` config is empty — **plugin config values may not
  survive plugin upgrades**, so after updating the plugin re-enter the PAT via
  `/plugin` → `github-pr-toolkit` → Configure. Also check network reachability of
  `api.githubcopilot.com` (or, on a local-server alternative, that Docker/the binary runs).
- **Health-check fails / auth error.** The plugin's `github_pat` config is empty or invalid.
  Set it via `/plugin` → `github-pr-toolkit` → Configure (or the install dialog); it's
  stored in your OS keychain, not an env var.
- **Worker dispatches blocked by the permission classifier.** Don't phrase worker
  prompts with "ONLY use X" / "Y is FORBIDDEN" — combined with context-mode's injected
  tool-routing text, it reads as conflicting instruction sources (an injection
  signature). State what success means instead of banning tools.
- **Docker errors.** Only relevant if you switched to the local Docker alternative —
  ensure Docker is running, or use the native binary / the hosted default (see step 4).
- **Can reply but can't resolve threads.** The token's user lacks write/triage on the repo,
  or (on a non-official server) thread resolution isn't exposed — install/auth `gh` for the
  fallback.
- **A tool name is rejected.** You're likely on a different server than the official one;
  adjust the `mcp__github__*` names in `agents/github-worker.md` to match it.
- **Subagent can't use `gh` / Bash under context-mode.** Apply the step-6 allowance above.

---

## Optional hardening

If you ever *must* register the GitHub MCP server globally (so the orchestrator can see it),
add a `PreToolUse` hook matching `mcp__github__.*` that returns
`permissionDecision: "deny"` unless the caller is the worker — the hook's stdin carries
`agent_id` (present only inside a subagent) and `agent_type` (the agent's `name`), so
"block the orchestrator, allow the Haiku fleet" is a short hook.
