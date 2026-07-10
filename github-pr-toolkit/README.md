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
| **Claude Code** (recent) | Plugin MCP server, subagents, PreToolUse hooks | Verified on **v2.1.206** |
| **A GitHub MCP server** | The workers' actual GitHub tools | Default = **GitHub's hosted remote MCP**, reached via the `mcp-remote` stdio bridge defined in the plugin's `.mcp.json`. Local alternative below |
| **`npx` (Node)** *(for the default server)* | Runs the `mcp-remote` bridge | Already present if you installed Claude Code via npm; else `brew install node`. Skip only if you switch `.mcp.json` to a local server (Docker / native binary) |
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
the plugin's `.mcp.json` reads it as `${user_config.github_pat}` and the `mcp-remote`
bridge sends it to GitHub's hosted server as a Bearer header. **Known Claude Code issue
([#62442](https://github.com/anthropics/claude-code/issues/62442)):** sensitive config
values can be lost on restart or upgrade — if GitHub access suddenly breaks, re-enter
the PAT here first.

You don't have to get this perfect up front — running `/resolve-pr-comments` health-checks
GitHub access first and, if it fails (the most common cause is a missing token), **walks
you through the setup**.

### 4. Choose the GitHub MCP server runtime *(optional — the hosted default needs only `npx`)*

The server is defined in the **plugin's `.mcp.json`** (not in the agent files — Claude
Code silently drops `mcpServers` declared in plugin agent frontmatter). The default
connects to **GitHub's hosted remote MCP server** through the `mcp-remote` stdio
bridge, with the PAT flowing keychain → env → bridge → Bearer header:

```json
{
  "mcpServers": {
    "github": {
      "command": "sh",
      "args": ["-c", "exec npx -y mcp-remote https://api.githubcopilot.com/mcp/x/pull_requests --header \"Authorization: Bearer $GITHUB_PAT\" --transport http-only"],
      "env": { "GITHUB_PAT": "${user_config.github_pat}" }
    }
  }
}
```

**Why the bridge instead of a direct `type: http` + `headers` entry:** Claude Code
does not substitute `${user_config.*}` into HTTP `headers:` values
([claude-code#51581](https://github.com/anthropics/claude-code/issues/51581) — the
header is sent literally) and `headersHelper` is unreliable (#41690, #48514, #72808);
env substitution into a stdio command is dependable. The `/x/pull_requests` URL path
narrows the server to only the pull-request toolset — see
[Narrowing the MCP surface](#narrowing-the-mcp-surface-applied-by-default).

Local alternative (edit `.mcp.json`; same env var, same tool names): run the official
server yourself — Docker
(`docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN -e GITHUB_TOOLSETS=pull_requests ghcr.io/github/github-mcp-server`)
or the native `github-mcp-server stdio` binary, with
`env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${user_config.github_pat}" }`.

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

- **Server toolset:** the plugin connects to the hosted server's `/x/pull_requests`
  endpoint (or, on the local alternative, runs with `-e GITHUB_TOOLSETS=pull_requests`), so
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

The GitHub MCP server is defined in the **plugin's `.mcp.json`**, so its tools
(namespaced `mcp__plugin_github-pr-toolkit_github__*`) are session-visible. The
delegation gate is enforced by the plugin's `PreToolUse` guard hook
(`hooks/guard.mjs`), which is **always on** for these tools:

- **Main agent (no `agent_id` in the hook input) → denied** with a message telling it
  to delegate to a worker.
- **This plugin's workers (`agent_type` is `github-worker`/`critic-worker`) →
  actively granted** (`permissionDecision: "allow"`), so the non-interactive Haiku
  workers run without prompts.
- **Any other subagent → normal permission flow** (prompt/rules decide).

> **Why not the inline-frontmatter gate?** The original design scoped the server
> inline in each worker agent's `mcpServers:` frontmatter, so the orchestrator never
> had the connection at all. Claude Code **silently drops `mcpServers` (and
> `permissionMode`) in plugin agent frontmatter** (verified on v2.1.206: no server
> spawn, no `mcp-logs-*` dir, tools report "No such tool available") — so the server
> moved to `.mcp.json` and the gate moved into the hook.

---

## Security notes

The guard hook grants the GitHub MCP tools only to this plugin's two workers; their
blast radius is bounded by their explicit `tools:` allowlists and by the orchestrators
handing them narrow, literal tasks. The workers also declare
`permissionMode: bypassPermissions` for their Bash usage (git/gh fallback) — note that
this frontmatter may not be honored for plugin agents on current Claude Code, in which
case Bash calls follow your normal permission rules.

Keep the PAT out of version control, scope it to the repos you actually review, and set an
expiry.

---

## Troubleshooting

Start with **`/github-pr-toolkit:doctor`** — it probes the plugin's GitHub MCP server
through both workers and reports connect/auth status without running either flow, then
walks you through the fix and re-probes.

- **`No such tool available: mcp__plugin_github-pr-toolkit_github__*`.** The plugin's
  server never connected. Most common cause: the `github_pat` config is empty —
  **sensitive config values can be lost on Claude Code restart or upgrade
  ([#62442](https://github.com/anthropics/claude-code/issues/62442))** — re-enter the
  PAT via `/plugin` → `github-pr-toolkit` → Configure. Then check `npx` exists (the
  bridge needs Node) and network to `api.githubcopilot.com`.
- **`permissions … haven't granted` from a worker.** The plugin's guard hook isn't
  loaded — run `/reload-plugins` or restart the session.
- **Health-check fails / auth error (401/403).** The PAT is invalid, expired, or
  under-scoped. `Incompatible auth server / does not support dynamic client
  registration` is a bad-PAT 401 in disguise (the bridge's OAuth fallback failing) —
  fix the PAT, ignore the OAuth wording.
- **Worker dispatches blocked by the permission classifier.** Don't phrase worker
  prompts with "ONLY use X" / "Y is FORBIDDEN" — combined with context-mode's injected
  tool-routing text, it reads as conflicting instruction sources (an injection
  signature). State what success means instead of banning tools.
- **Can reply but can't resolve threads.** The token's user lacks write/triage on the repo,
  or (on a non-official server) thread resolution isn't exposed — install/auth `gh` for the
  fallback.
- **Subagent can't use `gh` / Bash under context-mode.** Apply the step-6 allowance above.
