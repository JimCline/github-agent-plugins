# resolve-pr-comments

**Respond to and resolve the review comments left on your pull requests.**

> **Not a code-review tool** — it doesn't critique your code. It works through the review
> threads reviewers *already opened*: assess each, reply, fix or reject, and resolve.
> For *authoring* an adversarial review of a local diff or a GitHub PR, this repo ships a
> sibling plugin: **[code-critic](code-critic/README.md)** (`/code-critic`).

It does this with a clean split of labor:

- **A higher-reasoning agent (the orchestrator)** reasons, writes the code fixes, drives issue-by-issue
  approval with you, commits, and pushes. It has **no GitHub tools**.
- **Haiku (`github-worker` subagents)** do every GitHub read/write via the GitHub MCP
  server (with a `gh` CLI fallback) and hand back only distilled results.

Raw GitHub API payloads never enter the high-reasoning model's context, and the expensive
model is never spent driving a tool it doesn't need.

---

## Requirements

| Requirement | Why | Notes |
|---|---|---|
| **Claude Code** with subagent `mcpServers` + `permissionMode` frontmatter support | The gate + the Haiku worker rely on these | Verified on **v2.1.197**; use a recent version |
| **A GitHub MCP server** | The worker's actual GitHub tools | Default = official `github/github-mcp-server` (Docker). Alternatives below |
| **Docker** *(for the default server only)* | Runs `ghcr.io/github/github-mcp-server` | Skip if you use the native binary, npx classic, or remote server |
| **A GitHub Personal Access Token (PAT)** | Authenticates the worker's GitHub API calls | **See [GitHub token requirements](#github-token-requirements)** — this is the main setup step |
| **Git push access to the repo** | The orchestrator commits & pushes your fixes | Uses your normal git auth (SSH or credential helper), **separate** from the PAT |
| **`gh` CLI** *(optional)* | Fallback for servers lacking native thread ops | `gh auth login`; uses its own auth |

---

## Installation

### 1. Install & enable the plugin

**Local / development** — point Claude Code at this directory:

```sh
claude --plugin-dir /path/to/resolve-pr-comments
```

**From this repo** — it doubles as a marketplace (via `.claude-plugin/marketplace.json`)
carrying both plugins. In Claude Code:

```
/plugin marketplace add JimCline/resolve-pr-comments
/plugin install resolve-pr-comments@jimcline
/plugin install code-critic@jimcline          # optional sibling: adversarial PR/diff review
```

Enabling the plugin auto-loads its command (`/resolve-pr-comments`), the `pr-comments`
skill, and the `github-worker` agent. No `.mcp.json` changes are needed — the GitHub MCP
server is scoped **inside** the worker (see [How the gate works](#how-the-gate-works)).

### 2. Create a GitHub PAT

See [GitHub token requirements](#github-token-requirements) for exact scopes. In short:
create a token at **GitHub → Settings → Developer settings → Personal access tokens**, give
it access to the repo(s) you'll review, and grant it PR read+write.

### 3. Provide the token — part of install, no env var

The plugin declares a secure `userConfig` option, so when you run
`/plugin install resolve-pr-comments@jimcline` Claude Code shows a **configuration dialog**
with a masked **"GitHub Personal Access Token"** field. Paste your PAT there. It's stored in
your **OS keychain** — never in `settings.json`, a tracked file, or the shared
`GITHUB_PERSONAL_ACCESS_TOKEN` env var, so it can't clash with your other GitHub tooling.

Change it anytime via **`/plugin` → `resolve-pr-comments` → Configure**. Under the hood the
worker's MCP config reads it as `${user_config.github_pat}` and passes it to the server as
`GITHUB_PERSONAL_ACCESS_TOKEN`.

You don't have to get this perfect up front — running `/resolve-pr-comments` health-checks
GitHub access first and, if it fails (the most common cause is a missing token), **walks
you through the setup**.

### 4. Choose the GitHub MCP server runtime *(optional — Docker default works out of the box)*

The worker's server is defined in `agents/github-worker.md` → `mcpServers`. The default:

```yaml
command: docker
args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
       "-e", "GITHUB_TOOLSETS=pull_requests", "ghcr.io/github/github-mcp-server"]
```

`GITHUB_TOOLSETS=pull_requests` narrows the server to only the pull-request toolset — see
[Narrowing the MCP surface](#narrowing-the-mcp-surface-applied-by-default).

Alternatives (commented in that file):
- **Native binary** (no Docker): `github-mcp-server stdio`.
- **Classic npx server** `@modelcontextprotocol/server-github` — simplest to run, but a
  narrower/older toolset; if you use it, adjust the `mcp__github__*` tool names and rely on
  the `gh` fallback for thread resolution.
- **GitHub-hosted remote MCP** (`https://api.githubcopilot.com/mcp/`) — most capable, but
  OAuth-interactive, so **not** for headless/scheduled runs.

### 5. (Optional) `gh` CLI fallback

```sh
gh auth login
```

The official server handles unresolved-thread listing, in-thread replies, and thread
resolution natively, so `gh` is only a fallback for servers that lack those. Recommended
anyway.

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
- **Permissions** — the minimal set is just the first two rows:

| Permission | Access | Needed for |
|---|---|---|
| **Metadata** | Read-only | Mandatory (auto-selected for every fine-grained token). |
| **Pull requests** | **Read and write** | Read review threads/comments; post replies; **resolve threads**. This is the only capability the worker needs. |
| Contents | *(usually none)* | Not needed by the worker — it reads PR diffs/files via the **Pull requests** permission, and the orchestrator reads your working-tree files locally. Grant **Read and write** only if you push over HTTPS with *this* token (see below). |

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

- **Server toolset:** the worker runs the server with `-e GITHUB_TOOLSETS=pull_requests`, so
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
— and the bundled **`pr-comments`** skill auto-triggers the same flow (also `/pr-comments`).
Command and skill run one shared procedure; the skill delegates to the command file, so
there's no duplicated logic to drift.

**Flow:** preflight/onboarding → workers fetch unresolved threads → you assess (optionally
consulting an advisor) → issue-by-issue approve/deny/discuss (or auto-address all) → you
fix, commit, push → confirm → workers post replies and resolve each thread → final report.

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

- **Health-check fails / auth error.** The plugin's `github_pat` config is empty or invalid.
  Set it via `/plugin` → `resolve-pr-comments` → Configure (or the install dialog); it's
  stored in your OS keychain, not an env var.
- **Docker errors on the default server.** Ensure Docker is running, or switch the worker to
  the native binary / npx classic (see step 4).
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
