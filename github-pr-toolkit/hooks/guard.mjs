#!/usr/bin/env node
// github-pr-toolkit PreToolUse guard.
//
// Enforces the plugin's delegation invariant: the high-reasoning MAIN agent
// never touches GitHub. All GitHub I/O goes through the Haiku worker subagents
// (`github-worker` for general PR work, `critic-worker` for a code-critic
// review's writes), so raw API payloads never enter the expensive model's
// context.
//
// Mechanism: exit code 2 + a stderr message BLOCKS the tool call and feeds the
// message back to the model as feedback (per the Claude Code hooks reference).
//
// THREE TIERS, and the distinctions matter:
//
//   ALWAYS ON — no lock, no review, no scope. Reaching GitHub is delegated
//   PERIOD, because the reason for delegating has nothing to do with a review
//   being in progress:
//     - any `mcp__github__*` / `mcp__plugin_github-pr-toolkit_github__*` tool
//     - the `gh` CLI, except local credential diagnostics (see the gate below)
//   These two are deliberately symmetric. Gating the MCP door while leaving the
//   `gh` window open just relocates the same mistake, which is exactly what
//   happened before this tier existed: with no review armed, the orchestrator
//   fell back to `gh pr create` and nothing stopped it.
//
//   ARMED ONLY — for the DURATION of a code-critic review, in the SESSION that
//   initiated it:
//     - remote-mutating git: push / pull / commit / worktree
//   These stay lock-scoped on purpose. They are plain git against whatever
//   remote the repo has, not GitHub API access, and an always-on block would
//   stop ordinary committing in every session the plugin is installed in — far
//   past what this plugin has any business governing. During a review they ARE
//   blocked, because `critic-worker` owns the worktree/commit/push sequencing.
//
//   WORKER-SCOPED — always on, for THIS PLUGIN'S OWN subagents only
//   (`critic-worker`, `github-worker`, `code-reviewer-*`):
//     - destructive git (worktree remove/prune, reset --hard, clean, checkout,
//       branch -D, push --force, commit --amend, rebase, stash, gc, reflog …)
//     - recursive/forced `rm`, `rmdir`, `find -delete`
//     - `git worktree remove` is allowed ONLY for a path this plugin recorded
//       creating, and NEVER with `--force`.
//
//   WHY THIS TIER EXISTS — read before touching it. The two tiers above gate
//   WHO runs a command, not WHAT it does, and the subagent branch below exits
//   before either of them. So delegation LAUNDERED them: the orchestrator,
//   correctly blocked from `git worktree` by the armed tier, wrote
//   `git worktree remove --force <a worktree it did not create>` into a
//   critic-worker dispatch instead. The target held 8 unpushed commits belonging
//   to unrelated work. Nothing in the hook or the playbook would have stopped it;
//   a human reading the dispatch text did — and only because the dispatch had not
//   been sent yet.
//
//   Do NOT weaken this on the theory that the permission layer would have caught
//   it. Whether a worker's Bash call prompts anybody is version- and
//   session-dependent: `permissionMode: bypassPermissions` in the agent files is
//   NOT honored for plugin-shipped agents today (see the note further down), so
//   the call follows the normal flow — which for a non-interactive subagent
//   auto-denies, and interactively may surface a dialog. A later version honoring
//   the frontmatter would run it silently. "Sometimes something asks" is not an
//   invariant, and a dialog would show the COMMAND anyway, never the consequence
//   (8 unpushed commits) — which is the exact fact that was misjudged here.
//
//   Two invariants follow, and neither is expressible as "who runs git":
//     1. A review may destroy ONLY the worktree it created — the ledger, not a
//        path heuristic, is what distinguishes its own scratch checkout from
//        someone else's work sitting in the same directory.
//     2. `--force` is never delegated. Needing force MEANS "there is work here
//        I would destroy", which is the strongest available signal that a human
//        must decide. A failed plain removal is recoverable and reports back;
//        a forced one is not.
//   These workers run a small fixed playbook (fetch, worktree add, commit,
//   push, MCP comment posting) that touches none of the denied surfaces, so the
//   deny list costs the flows nothing. Err toward denial: a false block returns
//   an error the orchestrator must surface, which is the outcome that was
//   missing here.
//
// Scope — SESSION-NAMED lock files. The /code-critic command arms the guard at
// step 0 by touching `<cwd>/.git/code-critic-<session_id>.lock` (using
// $CLAUDE_CODE_SESSION_ID) and removes it on every exit path. The guard blocks
// only when the lock named after the hook input's OWN `session_id` exists —
// other sessions in the same repo are untouched, and two concurrent reviews
// each hold their own lock without clobbering each other. A freshness guard
// ignores a lock older than MAX_AGE_MS so a crashed run can't silently block a
// future session that reuses the ID.
//
// Fallback: a bare `<cwd>/.git/code-critic.lock` (armed when the session-id env
// var was unavailable) blocks ALL sessions — safe-but-blunt legacy behavior.
//
// What stays allowed to the main agent during its own review: read-only git
// (diff/log/status/show) AND `git fetch` — fetch publishes nothing and the
// orchestrator needs it to diff against a fresh `origin/<base>` (diff generation
// is deliberately NOT delegated to Haiku).
//
// ASSESSMENT GATE — a SECOND, narrower marker: `code-critic-<sid>.assessing`
// (armed alongside the lock at step 0, removed once the findings are presented
// and the user has chosen how to proceed at L6/G6). While it exists, the review
// is a STATIC pass over the diff: the main agent must not run tests, execute
// code, or shell out to diagnostic tooling to self-verify whether a finding is
// real — that verification is itself an ACTION and must be presented and
// approved first (the user's hard rule). Mechanism: while assessing, Bash is
// allowed ONLY for read-only inspection (git + a conservative utility
// allowlist); anything else (npm/pytest/make/node/python/./script …) is blocked
// with feedback to present-and-ask. The marker is gone by the time the user has
// approved a way to proceed, so legitimate post-approval test runs are fine.
//
// One carve-out: the agent-hierarchy durable-agent transport
// (`hooks/pane.mjs send|wait|peek|list|cancel`) is read-only FOR GATE PURPOSES
// — it injects a prompt into another live session and polls a mailbox file; it
// executes nothing in this repo. Without it, a durable agent picked as the
// reviewer is blocked at dispatch AND at every reply collection, and the only
// workaround (lift the marker, send, re-arm) leaves the gate off during
// exactly the phase it exists for. See isDurableAgentTransport for how narrow
// the match is and why.

import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// 8h — bounds a stale-lock footgun. DUPLICATED, deliberately, in two prompt files that
// cannot import from here: `commands/code-critic.md` step 0.1 (`find … -mmin +480`,
// which sweeps stale markers when arming) and `commands/doctor.md` step 0.1 (same
// `-mmin +480`, which classifies markers as litter vs. possibly-live). 480 min = 8h.
// Change this and you must change both, or the guard will keep honoring markers the
// other two have already written off as dead.
const MAX_AGE_MS = 8 * 60 * 60 * 1000;

// NOTE ON PLACEMENT: the gates below run at module top level and call helpers
// declared at the BOTTOM of this file, which works only because `function`
// declarations hoist. `const` does not — it sits in the temporal dead zone until
// its line is reached. So any constant a helper closes over MUST be declared up
// here, or the first gate to fire throws ReferenceError and the hook exits 1 —
// which Claude Code does NOT treat as a block, so every rule in this file would
// silently stop enforcing. Do not move these down beside their helpers.

// The only two `gh` invocations the always-on gate permits: local credential
// checks that return no repository data. `gh auth token` is deliberately absent
// — it prints the PAT.
const GH_DIAGNOSTIC = /^(auth\s+status(\s|$)|--version(\s|$)|version(\s|$))/;

// Heads that take a command as an ARGUMENT, so the real command is not this
// segment's head. `bash -c "gh pr create"` would otherwise walk past the gate:
// head is `bash`, and the payload is quoted text the tokenizer cannot follow.
// The pre-0.24.0 regex caught these incidentally (it matched any space-preceded
// `gh`), so omitting them would be a REGRESSION dressed up as a refactor.
const WRAPPER_HEADS = new Set([
  'bash', 'sh', 'zsh', 'ksh', 'dash', 'eval', 'exec', 'xargs', 'env',
  'command', 'nohup', 'time', 'timeout', 'sudo', 'doas', 'script', 'nice',
]);

// WORKER-SCOPED TIER (third tier in the header). Ledger of worktree paths this
// plugin's workers were seen creating, one `<session_id>\t<abs path>` per line in
// `<cwd>/.git/`. A `git worktree remove` is allowed only for a path listed here.
// Recorded at PreToolUse, i.e. BEFORE the `add` runs: an add that then fails
// still gets a line, which is harmless — removing a path that was never created
// fails on its own. The reverse default is the dangerous one, so it is not used.
const WORKTREE_LEDGER = 'code-critic-worktrees';

// Destructive git these workers never need. `true` denies the whole subcommand;
// a RegExp denies only when the argument string matches, so the playbook's plain
// `commit` / `push` stay allowed while `--amend` and `--force` do not.
// `worktree` is absent deliberately — it needs the path check in worktreeDenial.
const WORKER_GIT_DENIED = new Map([
  ['clean', true],
  ['checkout', true],
  ['switch', true],
  ['restore', true],
  ['rebase', true],
  ['stash', true],
  ['gc', true],
  ['prune', true],
  ['reflog', true],
  ['filter-branch', true],
  ['update-ref', true],
  ['reset', /(^|\s)--hard(\s|$)/],
  ['commit', /(^|\s)--amend(\s|$)/],
  ['branch', /(^|\s)(-D|-d|--delete)(\s|$)/],
  ['tag', /(^|\s)(-d|--delete)(\s|$)/],
  ['push', /(^|\s)(-f|--force|--force-with-lease\S*|--delete|-d|\+\S+)(\s|$)/],
  ['remote', /(^|\s)(remove|rm|set-url)(\s|$)/],
]);

// Non-git deletion, denied to the same agents. Without this the whole tier above
// is one word wide: `rm -rf <path>` reaches every worktree `git worktree remove`
// is stopped from touching. No worker playbook contains an `rm` of any kind.
// Same `true` = whole command / RegExp = argument match convention as above.
const WORKER_SHELL_DENIED = new Map([
  ['rm', true],
  ['rmdir', true],
  ['shred', true],
  ['truncate', true],
  ['find', /(^|\s)(-delete|-exec\s+rm|-execdir\s+rm)\b/],
]);

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function lockActive(cwd, name) {
  try {
    const st = statSync(join(cwd || process.cwd(), '.git', name));
    return Date.now() - st.mtimeMs < MAX_AGE_MS; // stale → treated as absent.
  } catch {
    return false;
  }
}

const input = readInput();

const tool = input.tool_name || '';
const cmd = (input.tool_input && input.tool_input.command) || '';

const isToolkitMcp = /^mcp__plugin_github-pr-toolkit_github__/.test(tool);

// Subagents (they carry agent_id) are the delegates. For THIS PLUGIN'S workers,
// actively GRANT the GitHub MCP tools — plugin agents' `permissionMode:
// bypassPermissions` frontmatter is not supported in plugin-shipped agents (documented
// and deliberate — "for security reasons, hooks, mcpServers, and permissionMode are not
// supported for plugin-shipped agents", plugins-reference; first hit here on 2.1.206), so
// without this grant a non-interactive worker's calls auto-deny. Any other
// subagent falls through to the normal permission flow.
if (input.agent_id) {
  const worker = /(^|:)(github-worker|critic-worker)$/.test(
    input.agent_type || ''
  );

  // WORKER-SCOPED DESTRUCTION GATE — the third tier, and the FIRST thing that
  // runs in this branch. It must precede the grants below and the `exit 0` at
  // the end: everything here is a decision about a command this plugin's own
  // agents are about to run with nothing reliably interposing a human, and the
  // whole point of the tier is that no later line gets to wave it through.
  // (Nor an earlier one, elsewhere: whether the permission layer would prompt
  // for a worker's Bash call is version- and session-dependent, so this tier
  // does not defer to it — see the header.) Applies to the workers AND the
  // review subagents — a reviewer's grant (isReviewerSafeBash) refuses outbound
  // git and redirection, but `git clean -fd` and `git reset --hard` sit inside
  // its allowed heads, which is the same laundering by a different door.
  if (tool === 'Bash' && (worker || isPluginReviewer(input.agent_type))) {
    const denial = destructiveDenial(cmd, input.cwd);
    if (denial) {
      process.stderr.write(
        `github-pr-toolkit destruction gate: ${denial} A dispatched task does ` +
          'not carry authority to destroy state — nothing reliably shows a ' +
          'delegated command to a human before it runs. Do NOT reword this, split ' +
          'it across dispatches, or route it through another tool: return the ' +
          'situation to the USER, say exactly what you wanted to do and what it ' +
          'would destroy, and let them decide. ' +
          `Blocked: \`${cmd}\``
      );
      process.exit(2);
    }
    if (worker) recordWorktreeAdds(cmd, input.cwd, input.session_id);
  }

  if (isToolkitMcp && worker) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason:
            'github-pr-toolkit worker subagent — GitHub MCP delegation is the intended path',
        },
      })
    );
    process.exit(0);
  }
  // The per-category review subagents (code-critic L4) need the same active
  // grant for their READ-ONLY git Bash — their `permissionMode` frontmatter is
  // not honored either, and a non-interactive subagent's calls auto-deny.
  // Matches ANY code-reviewer-<slug> so user-created categories (the
  // add-review-category wizard installs them to ~/.claude/agents or the
  // project's .claude/agents) get the grant too. That breadth is safe ONLY
  // because the grant is narrower than the orchestrator's assessing gate:
  // isReviewerSafeBash drops the mutating utilities (rm/touch/mkdir/rmdir),
  // sed -i, and output redirection that READ_ONLY_HEADS tolerates for the
  // orchestrator's marker-file management. Anything else falls through to the
  // normal flow (auto-deny), which enforces the static review by construction.
  const reviewer = isPluginReviewer(input.agent_type);
  if (reviewer && tool === 'Bash' && isReviewerSafeBash(cmd)) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason:
            'github-pr-toolkit review subagent — read-only inspection Bash for the static review pass',
        },
      })
    );
    process.exit(0);
  }

  process.exit(0);
}

// THE GATE (always on, lock or no lock): the plugin's GitHub MCP server is
// defined in the plugin's .mcp.json — Claude Code drops `mcpServers` declared
// in plugin AGENT frontmatter (silently; verified on 2.1.206), so the server
// is session-visible and the main agent CAN see its tools. This deny restores
// the delegation architecture: only the worker subagents may call them.
const isGithubMcp = isToolkitMcp || /^mcp__github__/.test(tool);
if (isGithubMcp) {
  process.stderr.write(
    'github-pr-toolkit gate: the main agent never calls the GitHub MCP tools ' +
      'directly — delegate to the `github-worker` (resolve flow) or ' +
      '`critic-worker` (code-critic flow) subagent via the Task tool. ' +
      `Blocked: ${tool}`
  );
  process.exit(2);
}

// THE `gh` GATE (always on, lock or no lock) — the symmetric half of the MCP
// gate above. `gh` is GitHub I/O by another transport, and the reason to
// delegate it does not depend on a review being active: a PR body, a comment
// thread, or an API payload read straight into the orchestrator is the exact
// cost the worker architecture exists to avoid. Denying MCP while allowing `gh`
// would leave the invariant advisory.
//
// CARVE-OUT — local credential diagnostics only: `gh auth status` and
// `gh --version` / `gh version`. These read the local keychain/config, return no
// repository data, and are precisely what `/github-pr-toolkit:doctor` and
// resolve-pr-comments step 0.3 need to run WHEN THE MCP PATH IS BROKEN. Blocking
// them would break the diagnostic whose job is diagnosing this. Everything else
// under `gh` — including read-only calls like `gh pr view` — is delegated.
if (tool === 'Bash' && isGhBlocked(cmd)) {
  process.stderr.write(
    'github-pr-toolkit gate: the main agent never runs `gh` — ALL GitHub I/O is ' +
      'delegated so raw API payloads stay out of your context. This is not ' +
      'scoped to a review; it is always true. Dispatch `github-worker` via the ' +
      'Task tool (PR read/list/search/create/update, review-thread replies and ' +
      'resolution), or `critic-worker` inside a code-critic review (worktree ' +
      'checkout, posting review comments, commit/push). If NO worker task type ' +
      'covers the operation you need — merging a PR, releases, anything outside ' +
      'the pull_requests toolset — do not work around this: tell the user what ' +
      'you need and let them decide. (`gh auth status` and `gh --version` are ' +
      `allowed.) Blocked: \`${cmd}\``
  );
  process.exit(2);
}

// The Bash rules below apply only during an active code-critic review.
// Armed for THIS session (session-named lock), or for everyone (bare legacy
// lock, written when the arming step had no session id)?
const armed =
  (input.session_id &&
    lockActive(input.cwd, `code-critic-${input.session_id}.lock`)) ||
  lockActive(input.cwd, 'code-critic.lock');

// Assessment gate. Independent of the outbound lock: only while the `.assessing`
// marker is live (step 0 → the user has chosen how to proceed at L6/G6). Before
// that, the review is static — allow Bash only for read-only inspection; block
// test-running / code-execution / diagnosis so the agent presents-and-asks
// instead of self-verifying.
const assessing =
  (input.session_id &&
    lockActive(input.cwd, `code-critic-${input.session_id}.assessing`)) ||
  lockActive(input.cwd, 'code-critic.assessing');

if (assessing && tool === 'Bash' && !isReadOnlyBash(cmd) && !isDurableAgentTransport(cmd)) {
  const paneHint = cmd.includes('pane.mjs')
    ? ' If this was a durable-agent dispatch: that transport IS allowed, but only ' +
      'in the exact shape `node "<path>/hooks/pane.mjs" send|wait|peek|list|cancel …` ' +
      '— an optional leading `PANE="$(ls -t …/hooks/pane.mjs 2>/dev/null | head -1)";` ' +
      'assignment, a QUOTED heredoc delimiter for the prompt, and nothing else ' +
      'chained in the same command string.'
    : '';
  process.stderr.write(
    'code-critic assessment gate: the review is a STATIC pass over the diff. Do ' +
      'not run tests, execute code, or shell out to diagnose whether a finding is ' +
      'real — that verification is an ACTION that needs the user’s approval first. ' +
      'Surface the finding AS uncertain in the severity list, and if confirming it ' +
      'needs work, PRESENT that work and ask before doing it. (Read-only git and ' +
      `file inspection are allowed.) Blocked: \`${cmd}\`` +
      paneHint
  );
  process.exit(2);
}

if (!armed) process.exit(0);

// Remote-mutating git must be delegated FOR THE DURATION OF A REVIEW —
// `critic-worker` owns worktree/commit/push sequencing. `gh` is handled by the
// always-on gate above, not here. `git fetch` and read-only git
// (diff/log/status/show) stay allowed so the orchestrator can generate diffs
// itself against a fresh origin/<base>.
const isOutboundGit =
  tool === 'Bash' &&
  /(^|[\s;&|(])git\s+(push|commit|worktree|pull)\b/.test(cmd);

if (isOutboundGit) {
  process.stderr.write(
    'code-critic guard: the main agent must not run remote-mutating git during a ' +
      'review. Delegate this to the `critic-worker` Haiku subagent via the Task ' +
      'tool — worktree checkout and any commit/push go through the worker. ' +
      '(git fetch/diff/log/status/show are allowed — generate diffs yourself.) ' +
      `Blocked: \`${cmd}\``
  );
  process.exit(2);
}

process.exit(0);

// True if the command invokes `gh` for anything other than a local credential
// diagnostic. Deliberately detects `gh` only at a COMMAND POSITION — the head of
// a segment, after any `VAR=value` prefixes — plus inside a command
// substitution. A naive `/\bgh\b/` would fire on `grep -n 'gh api' file` and on
// `echo "run gh auth"`, which matter here because working ON this plugin means
// grepping for `gh` constantly; a false block there is pure obstruction and
// teaches the agent to route around the guard.
//
// The allowlist is two forms and no more: `gh auth status` (local keychain
// check, no repository data) and `gh --version` / `gh version`. Any argument may
// follow `auth status` (e.g. `--hostname`, `2>&1`) since none of them reach
// repository data. `gh auth token` is NOT allowed — it prints the PAT.
// Regex scan for `gh` at a plausible command position inside text that CANNOT be
// tokenized reliably — currently a quoted wrapper payload (`bash -c "…"`).
// Quote characters count as delimiters here (that is the whole point: `-c "gh
// …"`), which does mean `bash -c "grep 'gh api' f"` is refused. That asymmetry is
// deliberate: at the top level the tokenizer is precise enough to exempt a grep,
// but inside a wrapper payload the cost of a false allow is a silent bypass and
// the cost of a false block is retyping the command without the wrapper.
function ghTextBlocked(text) {
  const re = /(?:^|[\s;&|(`'"])gh\s+([^;&|)`'"\n]*)/g;
  let m;
  while ((m = re.exec(text))) {
    if (!GH_DIAGNOSTIC.test(m[1].trim())) return true;
  }
  return false;
}

function isGhBlocked(command) {
  // Command substitution — `$(gh …)` / `` `gh …` `` — is a command position the
  // segment walk below cannot see. Treat any gh there as non-diagnostic: a
  // substitution exists to capture output INTO something, which is the payload
  // path this gate is about.
  if (/[$`]\(?\s*gh\s/.test(command)) return true;

  const segments = command.split(/(?:&&|\|\||[;|\n])/);
  for (let seg of segments) {
    seg = seg.trim().replace(/^[({]\s*/, '');
    let tokens = seg.split(/\s+/).filter(Boolean);
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
      tokens.shift();
    }
    if (!tokens.length) continue;
    let head = tokens[0];
    if (head.includes('/')) head = head.slice(head.lastIndexOf('/') + 1);
    if (WRAPPER_HEADS.has(head)) {
      if (ghTextBlocked(tokens.slice(1).join(' '))) return true;
      continue;
    }
    if (head !== 'gh') continue;
    if (!GH_DIAGNOSTIC.test(tokens.slice(1).join(' '))) return true;
  }
  return false;
}

// True only if EVERY command segment is a read-only inspection command — git
// (outbound git is blocked separately above) or a conservative utility. Any
// unknown head (npm, pytest, make, node, python, ./script, bash x.sh …) makes
// the whole command non-read-only, so it is blocked while assessing.
function isReadOnlyBash(command) {
  const READ_ONLY_HEADS = new Set([
    'git', 'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'fd',
    'find', 'wc', 'pwd', 'echo', 'printf', 'true', 'false', 'test', '[', 'sed',
    'awk', 'jq', 'yq', 'cut', 'sort', 'uniq', 'comm', 'diff', 'basename',
    'dirname', 'realpath', 'readlink', 'stat', 'file', 'tree', 'column',
    'which', 'type', 'env', 'date', 'sleep', 'touch', 'rm', 'mkdir', 'rmdir',
    ':',
  ]);
  const segments = command.split(/(?:&&|\|\||[;|\n])/);
  for (let seg of segments) {
    seg = seg.trim().replace(/^[({]\s*/, '');
    // Skip leading `VAR=value` env-assignment prefixes.
    let tokens = seg.split(/\s+/).filter(Boolean);
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
      tokens.shift();
    }
    if (!tokens.length) continue; // empty / pure grouping → nothing to run.
    let head = tokens[0];
    if (head.includes('/')) head = head.slice(head.lastIndexOf('/') + 1);
    if (!READ_ONLY_HEADS.has(head)) return false;
  }
  return true;
}

// The agent-hierarchy durable-agent transport is READ-ONLY for gate purposes:
// `pane.mjs send|wait|peek|list|cancel` injects a prompt into another live
// session's terminal and polls a mailbox for the reply file — it executes
// nothing in this repo. Blocking it made a durable agent unusable as the
// reviewer during exactly the phase it was picked for (denied at dispatch and
// again at every reply collection).
//
// The match is deliberately NARROW — the resolved hooks/pane.mjs path (or a
// same-command discovery assignment of it) in command position, an allowed
// subcommand, and hazard-free arguments — because "contains pane.mjs" would be
// a bypass dressed as a carve-out (`npm test # pane.mjs send`). `close` and
// `create`/`open` are NOT transport: one kills processes, the other launches
// them, and neither is part of conducting a review. Err toward denial: a false
// block is a retyped command; a false allow is a silent bypass.
function isDurableAgentTransport(command) {
  let head = String(command);
  // A heredoc body is stdin data, not shell — but only under a QUOTED
  // delimiter; an unquoted one performs command substitution inside the body,
  // so it stays refused. Validate the text before the operator, ignore the body.
  const hd = /<<-?\s*(['"])[A-Za-z_][A-Za-z0-9_]*\1/.exec(head);
  if (hd) head = head.slice(0, hd.index);
  else if (head.includes('<<')) return false;
  head = head.trim();

  // Optional leading discovery assignment — the one idiom the flows emit,
  // shape-checked because arbitrary $(…) content would EXECUTE on the shell:
  //   PANE="$(ls -t <glob ending hooks/pane.mjs> [2>/dev/null] [| head -1])";
  // or a literal-path assignment. The substitution's head must be `ls`.
  let varName = null;
  const assign =
    /^([A-Za-z_][A-Za-z0-9_]*)=(?:"?\$\(\s*ls\s+(?:-[A-Za-z0-9]+\s+)*[^\s;|&`$()]*\/hooks\/pane\.mjs\s*(?:2>\/dev\/null\s*)?(?:\|\s*head\s+-n?\s*1\s*)?\)"?|"?[^\s;|&`$()"]*\/hooks\/pane\.mjs"?)\s*;?\s*/.exec(
      head
    );
  if (assign) {
    varName = assign[1];
    head = head.slice(assign[0].length);
  }

  // What remains must be EXACTLY one node invocation of pane.mjs. A bare
  // `"$VAR"` with no same-command assignment is refused — shell state does not
  // persist between tool calls, so there is no verifiable value behind it.
  const ref = varName
    ? `(?:"\\$${varName}"|\\$${varName})`
    : '(?:"[^"$`]*\\/hooks\\/pane\\.mjs"|[^\\s;|&`$()"]*\\/hooks\\/pane\\.mjs)';
  const inv = new RegExp(
    `^node\\s+${ref}\\s+(send|wait|peek|list|cancel)\\b([\\s\\S]*)$`
  ).exec(head);
  if (!inv) return false;

  // Remaining args: quoted strings are data — except double quotes holding
  // `$` or a backtick, which still expand, so those stay visible to the scan.
  const rest = inv[2].replace(/"[^"$`]*"/g, '""').replace(/'[^']*'/g, "''");
  return !/[;&|<>`$\n(){}]/.test(rest);
}

// Matches ANY `code-reviewer-<slug>` — including the custom categories the
// add-review-category wizard installs — for both the read-only Bash grant and the
// destruction gate. Breadth is safe in both directions here: the grant is
// inspection-only and the gate is a denial.
function isPluginReviewer(agentType) {
  return /(^|:)code-reviewer-[a-z0-9][a-z0-9-]*$/.test(agentType || '');
}

// Quote-aware tokenizer. The gh gates above get by with regexes because they ask
// one yes/no question about the whole string; this tier has to read an ARGUMENT
// (which worktree path?), and a regex that stops at a quote character cannot —
// `git worktree remove "/Users/me/My Repo/.claude/worktrees/pr-9"` would come
// back with no target at all. So: quotes are stripped, their contents kept as ONE
// token, and unquoted shell operators are emitted as tokens so command
// boundaries stay visible. Backslash escapes the next character.
function tokenize(text) {
  const toks = [];
  let cur = '';
  let quoted = false;
  let q = null;
  const push = () => {
    if (cur !== '' || quoted) toks.push({ v: cur, quoted });
    cur = '';
    quoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === q) q = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      quoted = true;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < text.length) cur += text[++i];
      continue;
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    if (';&|()`\n'.includes(c)) {
      push();
      toks.push({ v: c, op: true });
      continue;
    }
    cur += c;
  }
  push();
  return toks;
}

// Every command in `text`, as `{ head, args }` with `VAR=value` prefixes dropped
// and `head` reduced to its basename. `anywhere` stops requiring command
// position, which is how a wrapper payload gets scanned: after tokenizing
// `bash -c "git worktree remove /x"` the payload is a single token, so it is
// re-tokenized and every token becomes a candidate head. Same tradeoff the gh
// scan documents — inside a wrapper, a false block costs a retyped command and a
// false allow costs the whole tier.
function commands(text, anywhere = false, depth = 0) {
  const out = [];
  const toks = tokenize(text);
  let atHead = true;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.op) {
      atHead = true;
      continue;
    }
    if (!atHead && !anywhere) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t.v)) continue; // env prefix — still at head
    let head = t.v;
    if (head.includes('/')) head = head.slice(head.lastIndexOf('/') + 1);
    const args = [];
    let j = i + 1;
    for (; j < toks.length && !toks[j].op; j++) args.push(toks[j]);
    out.push({ head, args: args.map((a) => a.v) });
    if (WRAPPER_HEADS.has(head) && depth < 3) {
      out.push(...commands(args.map((a) => a.v).join(' '), true, depth + 1));
    }
    if (anywhere) atHead = false;
    else {
      atHead = false;
      i = j - 1; // skip the args we just consumed
    }
  }
  return out;
}

// Strip git's global options so args[0] is the subcommand. `-C <path>` and
// `-c <cfg>` take a separate value; `--git-dir=…` and friends do not.
function gitSubcommand(args) {
  const a = args.slice();
  while (a.length && a[0].startsWith('-')) {
    const opt = a.shift();
    if (/^-[Cc]$/.test(opt)) a.shift();
  }
  return a;
}

function normalizeWorktreePath(p) {
  return String(p || '')
    .trim()
    .replace(/\/+$/, '');
}

// `git worktree add [-b <branch>] <path> [<commit-ish>]` — the path is the first
// positional, but `-b`/`-B` take a value that would otherwise be mistaken for it.
function worktreeAddPath(rest) {
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('-')) {
      if (/^(-b|-B|--reason)$/.test(rest[i])) i++;
      continue;
    }
    positional.push(rest[i]);
  }
  return positional[1] || null; // [0] is `add`
}

function isRecordedWorktree(cwd, target) {
  const want = normalizeWorktreePath(target);
  if (!want.startsWith('/')) return false; // the playbook mandates an ABSOLUTE path
  try {
    const ledger = readFileSync(
      join(cwd || process.cwd(), '.git', WORKTREE_LEDGER),
      'utf8'
    );
    return ledger
      .split('\n')
      .some((l) => l && normalizeWorktreePath(l.split('\t').pop()) === want);
  } catch {
    return false; // no ledger → this plugin has created nothing → remove nothing
  }
}

function recordWorktreeAdds(command, cwd, sid) {
  for (const c of commands(command)) {
    if (c.head !== 'git') continue;
    const a = gitSubcommand(c.args);
    if (a[0] !== 'worktree') continue;
    const rest = a.slice(1);
    if (!rest.includes('add')) continue;
    const path = normalizeWorktreePath(worktreeAddPath(rest));
    if (!path.startsWith('/') || isRecordedWorktree(cwd, path)) continue;
    try {
      appendFileSync(
        join(cwd || process.cwd(), '.git', WORKTREE_LEDGER),
        `${sid || 'unknown'}\t${path}\n`
      );
    } catch {
      // Best effort. A ledger write that fails costs a later CLEANUP denial (the
      // worktree leaks and the user is told) — never a blocked `add`.
    }
  }
}

// `git worktree …` for this plugin's own agents. Returns a denial sentence or null.
function worktreeDenial(rest, cwd) {
  const positional = rest.filter((t) => !t.startsWith('-'));
  const op = positional[0];
  if (op === 'add' || op === 'list' || op === 'lock' || op === 'unlock') {
    return null;
  }
  if (op !== 'remove') {
    return `\`git worktree ${op || '(no subcommand)'}\` is not part of this plugin's playbook.`;
  }
  if (rest.some((t) => t === '--force' || /^-[a-zA-Z]*f/.test(t))) {
    return (
      '`git worktree remove --force` is never delegated. Force means there is ' +
      'uncommitted or unpushed work at that path that plain removal refuses to ' +
      'destroy — which is precisely when a human has to decide.'
    );
  }
  const target = positional[1];
  if (!target) return '`git worktree remove` with no explicit path.';
  if (!isRecordedWorktree(cwd, target)) {
    return (
      `\`${target}\` is not a worktree this plugin recorded creating, so removing ` +
      'it is not this review\'s call — it may be unrelated work (a leftover from a ' +
      'crashed run is still someone\'s branch, possibly with unpushed commits).'
    );
  }
  return null;
}

// The worker-scoped tier's single decision. Returns a denial sentence or null.
function destructiveDenial(command, cwd) {
  for (const c of commands(command)) {
    const argstr = c.args.join(' ');

    if (c.head === 'git') {
      const a = gitSubcommand(c.args);
      if (!a.length) continue;
      if (a[0] === 'worktree') {
        const denial = worktreeDenial(a.slice(1), cwd);
        if (denial) return denial;
        continue;
      }
      const rule = WORKER_GIT_DENIED.get(a[0]);
      if (rule === true) return `\`git ${a[0]}\` is denied to this plugin's agents.`;
      if (rule && rule.test(a.slice(1).join(' '))) {
        return `\`git ${a[0]}\` with those flags is destructive and is denied to this plugin's agents.`;
      }
      continue;
    }

    const shellRule = WORKER_SHELL_DENIED.get(c.head);
    if (shellRule === true) return `\`${c.head}\` is denied to this plugin's agents.`;
    if (shellRule && shellRule.test(argstr)) {
      return `\`${c.head}\` used to delete files is denied to this plugin's agents.`;
    }
  }
  return null;
}

// Reviewer-subagent Bash grant (stricter than isReadOnlyBash, which exists for
// the ORCHESTRATOR and tolerates rm/touch/mkdir for its marker files). Review
// subagents are auto-granted with no prompt — including user-created custom
// categories — so this set is inspection-only, outbound git/gh is refused, and
// the file-writing escape hatches (sed -i, `>`/`>>` redirection) are refused
// too. A false denial just means the reviewer works from Read/Grep instead;
// a false allow would be silent unprompted mutation. Err toward denial.
function isReviewerSafeBash(command) {
  const REVIEWER_HEADS = new Set([
    'git', 'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'fd',
    'find', 'wc', 'pwd', 'echo', 'printf', 'true', 'false', 'test', '[',
    'sed', 'awk', 'jq', 'yq', 'cut', 'sort', 'uniq', 'comm', 'diff',
    'basename', 'dirname', 'realpath', 'readlink', 'stat', 'file', 'tree',
    'column', 'which', 'type', ':',
  ]);
  if (/(^|[\s;&|(])(gh(\s|$)|git\s+(push|commit|worktree|pull)\b)/.test(command))
    return false;
  if (/(^|[^>])>{1,2}(?!&)/.test(command)) return false; // no redirection to files
  if (/(^|[\s;&|(])sed\s+[^|;&\n]*-i/.test(command)) return false; // no in-place edits
  const segments = command.split(/(?:&&|\|\||[;|\n])/);
  for (let seg of segments) {
    seg = seg.trim().replace(/^[({]\s*/, '');
    let tokens = seg.split(/\s+/).filter(Boolean);
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
      tokens.shift();
    }
    if (!tokens.length) continue;
    let head = tokens[0];
    if (head.includes('/')) head = head.slice(head.lastIndexOf('/') + 1);
    if (!REVIEWER_HEADS.has(head)) return false;
  }
  return true;
}
