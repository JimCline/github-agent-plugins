#!/usr/bin/env node
/**
 * github-pr-toolkit — compaction checkpoint for /code-critic's issue-by-issue loop.
 *
 * A long one-by-one review is the case where context grows fastest and matters most:
 * every remaining issue is re-sent over a window the earlier issues already filled. The
 * model cannot see its own context size — no tool reports it, and PreCompact's
 * `estimated_tokens` only arrives once compaction is already happening. A hook can,
 * because PostToolUse carries `transcript_path`.
 *
 * So this measures the transcript and nudges L7 to OFFER the user a compaction
 * checkpoint. It never compacts: nothing can self-trigger /compact from inside a turn.
 *
 * Scope: fires only while a code-critic session lock exists AND the `.assessing` marker
 * is gone — that pair is true exactly during L6/L7, after the user has chosen how to
 * work the list. During assessment there is no per-issue loop to checkpoint.
 *
 * The token figure is an ESTIMATE (bytes/4) and is labelled as one wherever it surfaces.
 * It must never reach the Review-stats block, which is measured-only by contract.
 */

import { existsSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_THRESHOLD_TOKENS = 200_000;
const BYTES_PER_TOKEN = 4;

// Re-nudge only after another full step, so a 15-issue loop cannot emit 15 nudges.
const RENUDGE_STEP_TOKENS = 50_000;

// A transcript can reach many MB; only the tail matters for locating the last compact
// boundary, and reading the whole file on every TaskUpdate would sit on the hot path.
const MAX_TAIL_BYTES = 8 * 1024 * 1024;

const COMPACT_MARKER = '"isCompactSummary":true';

const readStdin = async () => {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
};

/** Bytes of transcript after the last compaction boundary, or the whole file if none. */
const liveBytes = (path) => {
  const size = statSync(path).size;
  const start = Math.max(0, size - MAX_TAIL_BYTES);
  const len = size - start;
  const buf = Buffer.allocUnsafe(len);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }
  const tail = buf.toString("utf8");
  const idx = tail.lastIndexOf(COMPACT_MARKER);
  // No boundary in the tail means either no compaction yet, or one so far back that
  // everything since is already more than the tail — both mean "use what we measured".
  return idx === -1 ? size : len - idx;
};

const main = async () => {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return; // Malformed payload is the harness's problem, never this hook's to escalate.
  }

  const cwd = payload?.cwd;
  const sid = payload?.session_id;
  const transcript = payload?.transcript_path;
  if (!cwd || !transcript || !existsSync(transcript)) return;

  const gitDir = join(cwd, ".git");
  const lock = sid ? join(gitDir, `code-critic-${sid}.lock`) : null;
  const bare = join(gitDir, "code-critic.lock");
  const assessing = sid ? join(gitDir, `code-critic-${sid}.assessing`) : null;

  const inRun = (lock && existsSync(lock)) || existsSync(bare);
  if (!inRun) return;
  // Still assessing => no issue loop yet => nothing to checkpoint between.
  if (assessing && existsSync(assessing)) return;
  if (existsSync(join(gitDir, "code-critic.assessing"))) return;

  const threshold =
    Number(process.env.CODE_CRITIC_COMPACT_CHECKPOINT_TOKENS) || DEFAULT_THRESHOLD_TOKENS;

  let tokens;
  try {
    tokens = Math.round(liveBytes(transcript) / BYTES_PER_TOKEN);
  } catch {
    return;
  }

  // One nudge per RENUDGE_STEP_TOKENS crossed. The high-water mark lives beside the
  // lock so /doctor's existing `.git/code-critic*` sweep already collects it.
  const markPath = sid
    ? join(gitDir, `code-critic-${sid}.ctxmark`)
    : join(gitDir, "code-critic.ctxmark");
  let last = 0;
  try {
    if (existsSync(markPath)) last = Number(readFileSync(markPath, "utf8").trim()) || 0;
  } catch {
    /* unreadable mark just means we nudge again */
  }

  // A live window smaller than the mark means it was compacted away. Clear the mark HERE,
  // before the threshold check — a compacted window is below threshold by definition, so
  // resetting after that early return would leave the stale peak on disk and the next
  // window would have to beat the OLD peak before the user was ever offered again.
  if (tokens < last) {
    last = 0;
    try {
      writeFileSync(markPath, "0", "utf8");
    } catch {
      /* a failed reset only costs one missed offer, never a wrong one */
    }
  }

  if (tokens < threshold) return;
  if (last && tokens < last + RENUDGE_STEP_TOKENS) return;

  try {
    writeFileSync(markPath, String(tokens), "utf8");
  } catch {
    return; // Cannot debounce => do not nudge, rather than nudge on every tool call.
  }

  const approx = Math.round(tokens / 1000);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          `[code-critic] Context is roughly ${approx}k tokens (estimated from transcript ` +
          `size, not measured — never put this number in the Review stats block). ` +
          `Before starting the next issue, OFFER the user a compaction checkpoint per L7: ` +
          `state how many issues are done and how many remain, tell them the review state ` +
          `is on the task list and survives compaction, and that they can run /compact and ` +
          `then say continue. Do not compact anything yourself and do not stop working if ` +
          `they decline — this is an offer, not an instruction.`,
      },
    })
  );
};

main();
