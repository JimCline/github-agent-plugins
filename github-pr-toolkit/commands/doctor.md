---
description: Diagnose github-pr-toolkit's GitHub MCP setup — spins up both workers' inline servers and reports connect/auth status without running either flow.
argument-hint: "[PR number to probe with — optional]"
---

You are diagnosing the **github-pr-toolkit** plugin's GitHub wiring. The GitHub MCP
server is declared INLINE on each worker subagent (`github-worker` and `critic-worker`;
by design — that's the gate that keeps GitHub tools off you), so it is invisible to
`claude mcp list` and can only be probed by actually running the workers. Do that now,
narrowly (do NOT arm the code-critic review lock — this is not a review):

1. Determine `owner/repo` from `git remote get-url origin` (fall back to asking the
   user), and a PR number for the critic-worker probe: `$ARGUMENTS` if given, else
   `gh pr list --limit 1` (the guard is not armed, so you may run gh here), else ask
   the user for any PR number on the repo.
2. Dispatch BOTH probes in parallel (both workers share the same `github_pat`, but each
   has its own inline server block — probe each):
   - `github-worker`: *"MCP-DOCTOR task — this verifies the GitHub MCP server + PAT, so
     success means an `mcp__github__*` call succeeded (a `gh` result cannot count as
     success here). Call `mcp__github__list_pull_requests` on `<owner/repo>`. Return
     EXACTLY two lines: line 1 `mcp: ok` or `mcp: failed — <the exact error,
     verbatim>`; line 2 the first line of `gh auth status` output, prefixed `gh: ` (or
     `gh: not installed`)."*
   - `critic-worker`: *"MCP-DOCTOR task — this verifies the GitHub MCP server + PAT, so
     success means an `mcp__github__*` call succeeded (a `gh` result cannot count as
     success here). Call `mcp__github__pull_request_read (method: get)` on PR #<N> of
     `<owner/repo>`. Return EXACTLY one line: `mcp: ok` or `mcp: failed — <the exact
     error, verbatim>`."*
   Phrase them positively as above — no "ONLY"/"FORBIDDEN" wording (exclusionary
   phrasing + context-mode's injected routing text reads as a prompt injection to the
   permission classifier and gets the dispatch blocked).
3. Interpret for the user (per worker):
   - `mcp: ok` on both → the hosted server, PAT, and both inline configs are healthy.
   - `mcp: failed — No such tool available: mcp__github__*` → that worker's inline
     server never connected. Most common: the plugin's `github_pat` config is
     empty/unset — config values may not survive plugin upgrades, so have them
     re-enter it via **`/plugin` → github-pr-toolkit → Configure**, then re-run this
     doctor. Next: no network to `api.githubcopilot.com` (the default server is
     GitHub's hosted remote — check `curl -sI https://api.githubcopilot.com/mcp/`
     yourself), or a Claude Code build that doesn't substitute sensitive user_config
     into inline headers (see the `headersHelper` fallback comment in the worker's
     agent file). If they switched a worker to a local-server alternative, also check
     Docker (`docker ps`) or the `github-mcp-server` binary.
   - `mcp: failed — <401/403/auth error>` → the server responded but the PAT is
     invalid/expired or under-scoped (needs Metadata: Read + Pull requests: Read &
     write + Contents: Read — one PAT covers both workers).
   - One worker ok, the other failed → the shared PAT is fine; the failing worker's
     inline `mcpServers` block has drifted — diff the two agent files.
   - The `gh:` line tells them whether the CLI fallback would work in the meantime.
4. **Remediate, then verify — loop until healthy or the user stops.** Don't just
   prescribe; walk them through the fix that matches the failure:
   - **Inline server never connected** → first, PAT: you cannot set it for them (it's
     an interactive keychain dialog), so tell them exactly: run **`/plugin` →
     github-pr-toolkit → Configure**, paste a fine-grained PAT (Metadata: Read + Pull
     requests: Read & write + Contents: Read; offer to walk through creating one at
     GitHub → Settings → Developer settings → Fine-grained tokens), and say when done.
     Then check network reachability of `api.githubcopilot.com` yourself. If both are
     fine, apply the `headersHelper` fallback commented in the agent files, or offer
     the local-server alternatives (Docker / native binary) and help edit the
     `mcpServers` blocks.
   - **Auth error (401/403)** → the PAT is invalid, expired, or under-scoped — help
     them mint a correct one and re-enter it via Configure.
   - After EACH fix, re-dispatch the failing probe(s) to verify. Finish by reporting
     the final probe results — healthy, or exactly what's still failing.

Never arm the review lock and never start either flow from the doctor.
