---
description: Diagnose github-pr-toolkit — reports orphaned /code-critic review markers left in .git by crashed runs (and offers to clear them), then probes both workers' access to the plugin's GitHub MCP server and reports connect/auth status, without running either flow.
argument-hint: "[PR number to probe with — optional]"
---

## Step 0 — Orphaned review markers (local, read-only, no dispatch)

Do this FIRST: it costs nothing, needs no network, and a wedged marker is exactly the
kind of thing people run a doctor to find. `/code-critic` arms marker files in
`.git/` and removes them on exit; a crashed or killed run leaves them behind.

**0.1 Inventory.** From the repo root:
```
find "$PWD/.git" -maxdepth 1 \( -name 'code-critic*.lock' -o -name 'code-critic*.assessing' \) -print
find "$PWD/.git" -maxdepth 1 \( -name 'code-critic*.lock' -o -name 'code-critic*.assessing' \) -mmin +480 -print
```
The second list is the subset older than 8h. Nothing found → say so in one line and go
to the MCP probes.

**0.2 Classify — they are NOT equally harmful.** Report each with its category:
- **`code-critic.lock` (bare, no session id)** — *blocks every session in this repo.*
  This is the one that actually hurts: it's the fallback armed when
  `$CLAUDE_CODE_SESSION_ID` was unavailable, and it can't tell sessions apart. Lead
  with it.
- **`code-critic-<sid>.lock`** — blocks only the session named in the filename. If that
  session is gone, it is inert; if it's a review running in another window, it's live
  and doing its job.
- **`code-critic*.assessing`** — blocks non-read-only Bash (the static-review gate) for
  its session. Same session-scoping logic as above.
- **Older than 8h** — the guard already ignores these (`MAX_AGE_MS` in
  `hooks/guard.mjs`), so they are litter, not blockers. Safe to remove.

**0.3 Offer to clear** (AskUserQuestion — never delete unprompted):
- **Clear the stale ones (default)** — everything from the `-mmin +480` list. The guard
  ignores them already; deleting only tidies `.git/`.
- **Clear everything** — including markers younger than 8h.
- **Leave them** — report and move on.

**The under-8h caveat, and say it plainly:** you cannot tell an orphan from a live
review in another window. A session-named marker younger than 8h may belong to a
`/code-critic` running right now elsewhere, and clearing it drops that review's guard
mid-flight. Only recommend clearing those when the user confirms no review is running —
otherwise recommend the stale-only option. A bare `code-critic.lock` is worth flagging
regardless of age, since it blocks everyone and nothing else can clear it.

Clearing markers is not arming a review — it is the one lock action the doctor may take,
and only with approval.

---

You are diagnosing the **github-pr-toolkit** plugin's GitHub wiring. The GitHub MCP
server is defined in the plugin's `.mcp.json` — a direct connection to GitHub's hosted
server, PAT from the plugin's `github_pat` config as a Bearer header. Its tools are
namespaced `mcp__plugin_github-pr-toolkit_github__*`, and a guard hook denies them to
you (the main agent) while granting them to the two worker subagents — so the only way
to probe is through the workers. Do that now, narrowly (do NOT arm the code-critic
review lock — this is not a review):

1. Determine `owner/repo` from `git remote get-url origin` (fall back to asking the
   user). **Do NOT run `gh` to find a PR number.** The guard denies you `gh` ALWAYS —
   not only during a review — and this diagnostic gets no exemption from its own
   plugin's invariant. (`gh auth status` and `gh --version` are the two carve-outs, and
   even those are cleaner to collect from inside the worker probe, where the CLI would
   actually be used.) The PR number comes from `$ARGUMENTS` if given; otherwise the
   `github-worker` probe below hands you one.
2. Probe both workers — they share the same server + PAT, but each has its own `tools:`
   allowlist, so a fault can sit in just one. **If `$ARGUMENTS` gave you a PR number,
   dispatch both in parallel.** If it did not, `critic-worker`'s probe has no PR to read,
   so run them in SEQUENCE instead: a doctor run is not latency-sensitive, and the only
   way to keep the parallelism would be a main-agent `gh pr list`, which is exactly what
   step 1 forbids.
   - `github-worker` (first, when sequencing): *"MCP-DOCTOR task — this verifies the
     GitHub MCP server + PAT, so success means a GitHub MCP call succeeded (a `gh`
     result cannot count as success here). Call
     `mcp__plugin_github-pr-toolkit_github__list_pull_requests` on `<owner/repo>`.
     Return EXACTLY three lines: line 1 `mcp: ok` or `mcp: failed — <the exact error,
     verbatim>`; line 2 the first line of `gh auth status` output, prefixed `gh: ` (or
     `gh: not installed`); line 3 `pr: #<number>` naming any open PR from that list, or
     `pr: none` if the list was empty or the call failed."*
     **In the parallel branch, ask for only the first TWO lines** — you already have a
     PR number from `$ARGUMENTS`, and a Haiku worker asked to produce a line nobody
     reads is a needless confabulation surface.
   - `critic-worker` (then, with that number): *"MCP-DOCTOR task — this verifies the
     GitHub MCP server + PAT, so success means a GitHub MCP call succeeded (a `gh`
     result cannot count as success here). Call
     `mcp__plugin_github-pr-toolkit_github__pull_request_read (method: get)` on PR #<N>
     of `<owner/repo>`. Return EXACTLY one line: `mcp: ok` or `mcp: failed — <the exact
     error, verbatim>`."*
   If line 3 came back `pr: none`, ask the user for any PR number on the repo. If they
   haven't got one, **skip the critic-worker probe and report it as `not probed (no PR
   number available)`** — never invent a number to probe with: a 404 on a PR that does
   not exist reads exactly like an auth failure and would send the whole diagnosis the
   wrong way.
   Phrase them positively as above — no "ONLY"/"FORBIDDEN" wording (exclusionary
   phrasing + any injected routing text reads as a prompt injection to the
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
   - `critic-worker: not probed (no PR number available)` → **not a fault.** Report it
     as unprobed, in those words. Do not round it up to healthy or down to broken; an
     empty repo simply has nothing for that probe to read.
   - The `gh:` line tells them whether the CLI fallback would work in the meantime.
     Note it is the WORKERS that use `gh`, so a worker-collected `gh:` line is the one
     that matters — the main agent is denied `gh` regardless of what the CLI says.
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

Never arm the review lock and never start either flow from the doctor. Clearing an
orphaned marker in Step 0, with the user's approval, is the sole exception.
