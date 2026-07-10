---
description: Diagnose github-pr-toolkit's GitHub MCP setup — probes both workers' access to the plugin's GitHub MCP server and reports connect/auth status without running either flow.
argument-hint: "[PR number to probe with — optional]"
---

You are diagnosing the **github-pr-toolkit** plugin's GitHub wiring. The GitHub MCP
server is defined in the plugin's `.mcp.json` — a direct connection to GitHub's hosted
server, PAT from the plugin's `github_pat` config as a Bearer header. Its tools are
namespaced `mcp__plugin_github-pr-toolkit_github__*`, and a guard hook denies them to
you (the main agent) while granting them to the two worker subagents — so the only way
to probe is through the workers. Do that now, narrowly (do NOT arm the code-critic
review lock — this is not a review):

1. Determine `owner/repo` from `git remote get-url origin` (fall back to asking the
   user), and a PR number for the critic-worker probe: `$ARGUMENTS` if given, else
   `gh pr list --limit 1` (the guard's Bash rules are not armed, so you may run gh
   here), else ask the user for any PR number on the repo.
2. Dispatch BOTH probes in parallel (both workers share the same server + PAT, but
   each has its own `tools:` allowlist — probe each):
   - `github-worker`: *"MCP-DOCTOR task — this verifies the GitHub MCP server + PAT, so
     success means a GitHub MCP call succeeded (a `gh` result cannot count as success
     here). Call `mcp__plugin_github-pr-toolkit_github__list_pull_requests` on
     `<owner/repo>`. Return EXACTLY two lines: line 1 `mcp: ok` or `mcp: failed — <the
     exact error, verbatim>`; line 2 the first line of `gh auth status` output,
     prefixed `gh: ` (or `gh: not installed`)."*
   - `critic-worker`: *"MCP-DOCTOR task — this verifies the GitHub MCP server + PAT, so
     success means a GitHub MCP call succeeded (a `gh` result cannot count as success
     here). Call `mcp__plugin_github-pr-toolkit_github__pull_request_read (method:
     get)` on PR #<N> of `<owner/repo>`. Return EXACTLY one line: `mcp: ok` or
     `mcp: failed — <the exact error, verbatim>`."*
   Phrase them positively as above — no "ONLY"/"FORBIDDEN" wording (exclusionary
   phrasing + context-mode's injected routing text reads as a prompt injection to the
   permission classifier and gets the dispatch blocked).
3. Interpret for the user (per worker):
   - `mcp: ok` on both → the server, PAT, and both workers are healthy.
   - `mcp: failed — No such tool available: …` → the plugin's server never connected.
     Most common: the `github_pat` config is empty/unset — sensitive config values can
     be LOST on Claude Code restart or upgrade (claude-code#62442), so have them
     re-enter it via **`/plugin` → github-pr-toolkit → Configure**, then re-run this
     doctor. Next: no network to `api.githubcopilot.com` (check
     `curl -sI https://api.githubcopilot.com/mcp/` yourself). Do NOT suggest moving
     the server into agent frontmatter — plugin agents' `mcpServers` blocks are
     silently dropped; that's why it lives in `.mcp.json`.
   - `mcp: failed — <401/403/auth error>` → the server responded but the PAT is
     invalid/expired or under-scoped (needs Metadata: Read + Pull requests: Read &
     write + Contents: Read — one PAT covers both workers).
   - `Authorization header is badly formatted` → the PAT value itself is malformed
     (empty/truncated/unsubstituted) — re-enter it via Configure.
   - `mcp: failed — … permissions … haven't granted` → the guard hook's worker grant
     isn't active (plugin hooks not loaded) — have them run `/reload-plugins` or
     restart the session, and confirm the plugin is enabled.
   - One worker ok, the other failed → the server and PAT are fine; the failing
     worker's `tools:` allowlist has drifted — diff the two agent files.
   - The `gh:` line tells them whether the CLI fallback would work in the meantime.
4. **Remediate, then verify — loop until healthy or the user stops.** Don't just
   prescribe; walk them through the fix that matches the failure:
   - **Server never connected** → first, PAT: you cannot set it for them (it's an
     interactive keychain dialog), so tell them exactly: run **`/plugin` →
     github-pr-toolkit → Configure**, paste a fine-grained PAT (Metadata: Read + Pull
     requests: Read & write + Contents: Read; offer to walk through creating one at
     GitHub → Settings → Developer settings → Fine-grained tokens), and say when done.
     Then check network reachability of `api.githubcopilot.com` yourself. If they
     can't use the hosted server at all,
     help edit the plugin's `.mcp.json` to run the official server locally instead
     (Docker: `docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN -e
     GITHUB_TOOLSETS=pull_requests ghcr.io/github/github-mcp-server`, or the native
     `github-mcp-server stdio` binary — same env var, same tool names).
   - **Auth error (401/403)** → the PAT is invalid, expired, or under-scoped — help
     them mint a correct one and re-enter it via Configure.
   - After EACH fix, re-dispatch the failing probe(s) to verify. Finish by reporting
     the final probe results — healthy, or exactly what's still failing.

Never arm the review lock and never start either flow from the doctor.
