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
// TWO TIERS, and the distinction matters:
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

import { readFileSync, statSync } from 'node:fs';
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
// bypassPermissions` frontmatter is not honored (observed on 2.1.206), so
// without this grant a non-interactive worker's calls auto-deny. Any other
// subagent falls through to the normal permission flow.
if (input.agent_id) {
  const worker = /(^|:)(github-worker|critic-worker)$/.test(
    input.agent_type || ''
  );
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
  const reviewer = /(^|:)code-reviewer-[a-z0-9][a-z0-9-]*$/.test(
    input.agent_type || ''
  );
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
// SECOND SHELL CHANNEL. Bash is not the only way to run a command: the
// context-mode plugin exposes `ctx_execute` / `ctx_batch_execute`, which take the
// shell command in `code` (not `command`) and are session-visible to the main
// agent — both worker files list them precisely because they are reachable. A
// gate keyed only on `tool === 'Bash'` therefore has a door beside it, and
// `ctx_execute(language: "bash", code: "gh pr create")` walks through. Verified
// empirically: before this branch, that input returned rc=0.
//
// The blob is scanned rather than parsed, because the argument shape belongs to
// another plugin and may change. Erring toward denial is right here: a false
// block costs one retry through Bash, where the precise tokenizer applies.
const isCtxExec = /ctx_(execute|batch_execute)$/.test(tool);
const ctxBlocked =
  isCtxExec &&
  stringLeaves(input.tool_input).some((s) => ghTextBlocked(s));

if ((tool === 'Bash' && isGhBlocked(cmd)) || ctxBlocked) {
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

// The two tiers below (`assessing`, `isOutboundGit`) inspect a shell command by
// TOKENIZING it, which a ctx_* payload does not survive — so during a review the
// opaque channel is closed outright rather than approximated. Without this,
// `ctx_execute(code: "npm test")` defeats the static-review gate and
// `ctx_execute(code: "git push")` defeats the outbound-git tier, both silently.
// Outside a review the ctx_* tools stay unrestricted apart from the `gh` scan
// above — this is a review-time restriction, matching the tiers it protects.
if (isCtxExec && (armed || assessing)) {
  process.stderr.write(
    'code-critic guard: while a review is active, run shell commands through the ' +
      'Bash tool, not the context-mode ctx_* tools. The guard inspects Bash ' +
      'commands precisely (read-only inspection is allowed during assessment; ' +
      'outbound git is delegated to `critic-worker`); it cannot apply those rules ' +
      'to an opaque ctx_* payload, so it declines instead of guessing. Re-issue ' +
      `this as a Bash call. Blocked: ${tool}`
  );
  process.exit(2);
}

if (assessing && tool === 'Bash' && !isReadOnlyBash(cmd)) {
  process.stderr.write(
    'code-critic assessment gate: the review is a STATIC pass over the diff. Do ' +
      'not run tests, execute code, or shell out to diagnose whether a finding is ' +
      'real — that verification is an ACTION that needs the user’s approval first. ' +
      'Surface the finding AS uncertain in the severity list, and if confirming it ' +
      'needs work, PRESENT that work and ask before doing it. (Read-only git and ' +
      `file inspection are allowed.) Blocked: \`${cmd}\``
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
// tokenized reliably — a quoted wrapper payload, or a ctx_* argument blob.
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

// Every string leaf in a tool_input object, joined. Used for the ctx_* execute
// tools, whose shape (`code` for ctx_execute, an array of items for
// ctx_batch_execute) is another plugin's contract and can change under us —
// walking every string is shape-agnostic, so a renamed or nested field cannot
// silently reopen the gate.
function stringLeaves(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out);
  else if (value && typeof value === 'object')
    for (const v of Object.values(value)) stringLeaves(v, out);
  return out;
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
