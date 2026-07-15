#!/usr/bin/env node
// code-critic PreToolUse guard.
//
// Enforces the hard invariant for the DURATION of a code-critic review, in the
// SESSION that initiated it: the high-reasoning MAIN agent must not touch GitHub
// (MCP or `gh`) or run remote-mutating git. Those actions are delegated to the
// `critic-worker` Haiku subagent.
//
// Mechanism: exit code 2 + a stderr message BLOCKS the tool call and feeds the
// message back to the model as feedback (per the Claude Code hooks reference).
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
// What is blocked (main agent, during its own review):
//   - any `mcp__github__*` tool
//   - `gh` CLI
//   - remote-mutating git: push / pull / commit / worktree
// What stays allowed: read-only git (diff/log/status/show) AND `git fetch` —
// fetch publishes nothing and the orchestrator needs it to diff against a fresh
// `origin/<base>` (diff generation is deliberately NOT delegated to Haiku).
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

const MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8h — bounds a stale-lock footgun.

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

// gh CLI and remote-mutating git must be delegated. `git fetch` and read-only
// git (diff/log/status/show) stay allowed so the orchestrator can generate
// diffs itself against a fresh origin/<base>.
const isOutboundBash =
  tool === 'Bash' &&
  /(^|[\s;&|(])(gh(\s|$)|git\s+(push|commit|worktree|pull)\b)/.test(cmd);

if (isOutboundBash) {
  process.stderr.write(
    'code-critic guard: the main agent must not run GitHub or remote-mutating git ' +
      'actions during a review. Delegate this to the `critic-worker` Haiku subagent ' +
      'via the Task tool — worktree checkout, posting review comments, and any ' +
      'commit/push all go through the worker. (git fetch/diff/log/status/show are ' +
      `allowed — generate diffs yourself.) Blocked: \`${cmd}\``
  );
  process.exit(2);
}

process.exit(0);

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
