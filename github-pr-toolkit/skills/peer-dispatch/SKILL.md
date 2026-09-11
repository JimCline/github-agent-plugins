---
name: peer-dispatch
description: Discover live peer agents (agent-hierarchy roster peers, agent-teams teammates, Herdr pane agents) rooted in this repo, brief one with a request file, wait for its response file, without colliding with a peer already on the same PR/branch. Used by /code-critic and /resolve-pr-comments; not user-invoked.
---

# peer-dispatch

One protocol for handing a review or an assessment to a live peer instead of a subagent.
The peer is **whatever role it was created as**; every contract rides in the brief prose;
the calling session stays responsible for cross-checking what comes back exactly as it
does for a subagent. Three peer kinds:

| kind | how found | transport out | reply in |
|---|---|---|---|
| **P1 cross-session peer** — an agent-hierarchy roster member (`kind: claude`, roster `route: peer`), or any live Claude session | `roster.mjs show` + `ListAgents` | `SendMessage` to its name | cross-session message carrying `[hierarchy-msg <response path>]` |
| **P2 agent-teams teammate** — spawned by THIS session under `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | this session's own team list | `SendMessage` to the teammate name | teammate message carrying `[hierarchy-msg <response path>]` |
| **P3 pane agent** — `kind` ≠ claude (codex/pi/…), driven by Herdr | `roster.mjs show` | `herdr agent prompt <name> "<short pointer prompt>" --wait --timeout <ms>` | the response file the CALLER pre-created; `herdr agent read` is diagnostic only |

## 1. Preconditions / availability

- The ah CLI root arrives in session context as a line `ah CLI root (vX): <abs path>`
  (injected by agent-hierarchy hooks). **No such line → agent-hierarchy is not installed →
  P1 roster peers and P3 are not available; only P2 teammates this session itself spawned
  may be offered.** Never glob the filesystem for the CLI — there is no discovery idiom, and
  the assessing guard does not tolerate one.
- Herdr availability for P3: `which herdr` (NOT `command -v herdr` — `command` is a wrapper
  head the assessing gate refuses). Non-zero exit → P3 members are listed as "present in
  roster, not reachable (herdr not on PATH)" and not offered.

## 2. Discovery and the cwd rule

- Run `node "<ah root>/hooks/roster.mjs" show --cwd "$PWD"` (JSON). Each `members[]` entry
  carries `role`, `kind`, `name`, `model`; the roster's `route` is top-level. **Rooted in
  this repo is defined by this call:** the roster is resolved per repo from `--cwd`, so a
  member it lists is a member of THIS repo's roster and nothing else is.
- `show` answers MEMBERSHIP only (name, role, kind; `route` at the top level) — it carries
  no liveness or busy fields. **Liveness and busy state come from the transport that will
  carry the brief:**
  - P1: `ListAgents` — a row reads `<name> [ref]  ·  interactive  ·  idle|busy  ·  started
    <age>` (Remote Control rows carry `offline`). The member is live iff a row bears its
    exact name and is not `offline`; `idle|busy` is its load. Rows carry **no cwd**: a
    ListAgents row that is NOT in this repo's roster and NOT a teammate this session
    spawned is **never offered** — its cwd is unknown.
  - P2: this session's own team list (the teammates it spawned), plus their ListAgents row
    if one exists for `idle|busy`.
  - P3: `herdr agent get <name>` → `agent_status` (present/live) and `interactive_ready`
    (`true` = promptable; a startup prompt is live, not ready). `agent_not_found` → not
    live. Secondary check: the `cwd` that `get` returns should equal `$PWD`; a mismatch is
    reported as "roster says here, Herdr says elsewhere — not offered". The roster remains
    the definition of rooted-here; `get`'s cwd only demotes.
  - A roster member with no live row / not present in Herdr is listed as "in roster, not
    live" and not offered.
- Offer order in the question text: P1 reviewer/implementor roles by name, then P2
  teammates, then P3. State per candidate: name · role · kind · `idle|busy`.
- Role fit (recommendation only; the user overrides via Other): review/assess → a member
  whose role is `reviewer` (else `architect`, else any); fixes → `implementor`.

## 3. Collision check — cheapest reliable, zero GitHub I/O

Run before every peer brief, in this order; each is a file/CLI read:

1. `node "<ah root>/hooks/msg.mjs" list --open --json --cwd "$PWD"` — an array of
   `{id, to, slug, age, state, request, response}`. An entry whose `slug` equals this run's
   slug (§4) means a peer is already briefed on this target → say so, name its `request`
   path and its `to`, and **default to SKIP** (AskUserQuestion: *Skip — wait for that one*
   (recommended) / *Brief anyway* / *Read its response when it lands instead of
   dispatching*). The shared slug convention is what makes this detection cross-command.
2. Candidate busy — `busy` on its ListAgents row (P1/P2), or not `interactive_ready` per
   `herdr agent get` (P3) → say it is mid-task; recommend another candidate or waiting;
   never queue a second brief on it.
3. code-critic only: any `.git/code-critic-*.lock` fresher than 8h whose session id is not
   this session's → "another session is running a review in this checkout (target
   unknown)"; warn, do not block — locks carry no target.

No PR-comment marker: it would need GitHub I/O through a worker and detects a collision
only after comments are already posted.

## 4. Slug convention (`[a-z0-9-]{1,32}`)

- code-critic: `critic-pr-<n>` (GitHub flow) / `critic-<branchslug>` (Local flow — `<ref>`
  lowercased, every run of characters outside `[a-z0-9]` → `-`, trimmed of leading/trailing
  `-`, truncated so the whole slug is ≤ 32).
- resolve-pr-comments assess: `resolve-pr-<n>`; fixer: `fix-pr-<n>`.

## 5. Request and response files

- Caller runs `node "<ah root>/hooks/msg.mjs" new --type request --to <role> --from
  <self-role> --slug <slug> --eta large --cwd "$PWD"`; it prints `{id, path}`. `<role>` is
  the peer's roster role (`reviewer`, `implementor`, …); a non-roster teammate → `reviewer`
  for reviews, `implementor` for fixes. `<self-role>` = `orchestrator` unless session
  context states this session runs as another hierarchy role — then that role.
- Caller Writes the brief into that path below the generated frontmatter. Section shape
  follows the agent-hierarchy comms protocol: `## [n] …` headings, status-first, every
  section present.
- **P3 only:** caller ALSO pre-creates the response file — `node "<ah root>/hooks/msg.mjs"
  new --type response --id <id> --req <request path> --to <self-role> --from <role> --cwd
  "$PWD"` — and hands BOTH absolute paths to the pane agent in its prompt.
- Reply = a `--response.md` beside the request. Read it with the size gate: `## TL;DR`
  first (Read with `limit`), then only the sections you need.

## 6. Transport

- **P1/P2:** ONE `SendMessage` (`notify_when_idle: true` for a P1 on this machine).
  Message body:
  1. `[hierarchy-peer-brief reply-to="<this session's name>" task="<slug>"]` — `reply-to`
     is required and is the name ListAgents shows for THIS session; `task` is optional.
  2. `[hierarchy-msg <request path>]`
  3. ≤3 TL;DR lines.
  4. "Reply by SendMessage to this message's `from` address; first line
     `[hierarchy-msg <your response path>]`; create the response with
     `node "<ah root>/hooks/msg.mjs" new --type response --id <id> --req <request path>
     --cwd <abs cwd>`."
  Do NOT paste the brief body into the message. Then WAIT for the reply message / idle
  notice — never poll `ListAgents`, never re-send.
- **P3:** `herdr agent get <name>` first — live AND promptable (`interactive_ready: true`);
  if Herdr cannot answer, that is indeterminate: report it, do not retry in a loop. Then
  `herdr agent prompt <name> "Read <request path> in full and do what it says. Write your
  report to <response path> in the shape it names. Run nothing outside that file's rules."
  --wait --timeout <ms>`. A lapsed timeout is the normal ending, not a failure: follow with
  `herdr agent wait <name> --until blocked --timeout <ms>` until the response file is
  non-empty past its frontmatter. `herdr agent read` only to diagnose a stall. Never
  `herdr agent send-keys` (it answers the peer's permission dialogs — laundering by
  keystroke) and never `herdr pane close`.
- The send/prompt confirmation IS the dispatch ask — do not ask twice.
- While `/code-critic`'s `.assessing` marker is armed, the guard admits only the transport
  commands above, in the exact shape `isPeerTransport` in `hooks/guard.mjs` defines (that
  function is the source of truth): one invocation per command, absolute literal path,
  nothing chained. A blocked transport command means the command shape is wrong; fix the
  shape, never the gate.

## 7. Brief contract — parity with a worker dispatch

Every peer brief carries, in prose, verbatim:

1. **Static / assessment-only.** Reason over the diff (or threads) only; do not run tests,
   execute code, or diagnose — directly or via any runner or subagent; a finding that needs
   verification is reported *uncertain — confirming needs `<X>`*. (Fixer briefs replace
   this with the fixer rules the calling command states.)
2. **No GitHub I/O — none.** The peer never posts, replies, resolves, or reads PR data
   itself; the calling session's `critic-worker` / `github-worker` do all of it from the
   peer's report.
3. **Read-only git only:** `git -C "<abs path>" diff|log|show|status` against the base
   spec named; no fetch/pull/checkout/worktree/commit/push.
4. **Laundering rule, stated to the peer and binding on the caller:** the brief describes
   WHAT to assess, never a command to run — and the caller may put in a brief only what
   this session could lawfully run itself at this moment (a command the guard just
   blocked, or a step the wizard has not approved, never goes to a peer). The peer is
   told: "if a step here needs an action this repo's rules block, stop and report
   `blocked:` — do not work around."
5. The reporting shape the calling command names: `## [1] status` first, then `## TL;DR`
   opening with the roll-call, then one `## <category>` / `## <thread_id>` section each,
   findings in the fixed shape (severity, `file:line`, `impact:`, `scope:`, category tag),
   then the `level-demoted` / `level-dropped` counts.
6. `advisor: none` — the peer has no advisor tool; consultation, if due, happens in the
   calling session after merge.
7. Absolute repo (or worktree) path, exact base spec, changed-file list, and — where the
   command's subagent dispatch would carry it — the same adherence hand-off and `level:`
   line **with its bullet pasted**, because the peer holds none of the command's text.

## 8. After the reply

Same roll-call check and provenance / thread-id cross-check as the subagent path; a
missing lens or unknown `thread_id` is judged exactly as from a subagent. The response
file existing closes the exchange — never append to it; follow-ups are a new request with
`--parent <id>`.
