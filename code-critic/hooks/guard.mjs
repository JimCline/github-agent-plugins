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
// Scope — two gates, both must hold or the guard is inert:
//   1. A sentinel marker at `<cwd>/.git/code-critic.lock`, written by the
//      /code-critic command at step 0 and removed on every exit path. A freshness
//      guard ignores a marker older than MAX_AGE_MS so a crashed run can't
//      silently block future sessions.
//   2. SESSION SCOPING: the marker's CONTENT is the initiating session's ID
//      (`$CLAUDE_CODE_SESSION_ID`). The guard blocks only when the hook input's
//      `session_id` matches — other Claude Code sessions in the same repo are
//      untouched. An EMPTY marker (env var unavailable) falls back to blocking
//      all sessions, the safe-but-blunt legacy behavior.
//
// What is blocked (main agent, during its own review):
//   - any `mcp__github__*` tool
//   - `gh` CLI
//   - remote-mutating git: push / pull / commit / worktree
// What stays allowed: read-only git (diff/log/status/show) AND `git fetch` —
// fetch publishes nothing and the orchestrator needs it to diff against a fresh
// `origin/<base>` (diff generation is deliberately NOT delegated to Haiku).

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8h — bounds a stale-marker footgun.

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

// Returns the lock's session-id content ('' if empty), or null if no live lock.
function activeLockSession(cwd) {
  const path = join(cwd || process.cwd(), '.git', 'code-critic.lock');
  try {
    const st = statSync(path);
    if (Date.now() - st.mtimeMs >= MAX_AGE_MS) return null; // stale → inert.
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null; // no marker (or unreadable) → guard inert.
  }
}

const input = readInput();

// Subagents (critic-worker carries agent_id) ARE the delegate — always allow.
if (input.agent_id) process.exit(0);

const lockSession = activeLockSession(input.cwd);

// Guard is inert outside an active review.
if (lockSession === null) process.exit(0);

// SESSION SCOPING: only the session that armed the lock is constrained. An empty
// lock (arming env var unavailable) blocks all sessions — safe fallback.
if (lockSession !== '' && input.session_id && input.session_id !== lockSession) {
  process.exit(0);
}

const tool = input.tool_name || '';
const cmd = (input.tool_input && input.tool_input.command) || '';

// Any GitHub MCP call from the main agent is forbidden during a review.
const isGithubMcp = /^mcp__github__/.test(tool);

// gh CLI and remote-mutating git must be delegated. `git fetch` and read-only
// git (diff/log/status/show) stay allowed so the orchestrator can generate
// diffs itself against a fresh origin/<base>.
const isOutboundBash =
  tool === 'Bash' &&
  /(^|[\s;&|(])(gh(\s|$)|git\s+(push|commit|worktree|pull)\b)/.test(cmd);

if (isGithubMcp || isOutboundBash) {
  const what = tool === 'Bash' ? `\`${cmd}\`` : tool;
  process.stderr.write(
    'code-critic guard: the main agent must not run GitHub or remote-mutating git ' +
      'actions during a review. Delegate this to the `critic-worker` Haiku subagent ' +
      'via the Task tool — worktree checkout, posting review comments, and any ' +
      'commit/push all go through the worker. (git fetch/diff/log/status/show are ' +
      `allowed — generate diffs yourself.) Blocked: ${what}`
  );
  process.exit(2);
}

process.exit(0);
