#!/usr/bin/env bash
# Test harness for hooks/guard.mjs.  Run:  bash hooks/guard.test.sh
#
# WHY THIS EXISTS. The guard fails SILENTLY. A hook that exits 0 when it meant to
# exit 2 looks exactly like a hook that correctly allowed the call — there is no
# error, no log line, nothing to notice until someone runs `gh pr create` and it
# works. Three real defects were caught here rather than in the wild:
#   - a second MCP shell channel bypassed a gate keyed on `tool === "Bash"`
#     entirely, because its command lived in a different argument field.
#   - wrapper heads (`bash -c "gh …"`, `xargs gh …`, `env gh …`) walked past
#     command-position detection, a regression against the older regex.
#   - a `const` declared beside its helper at the bottom of the file threw
#     ReferenceError (temporal dead zone) — and exit 1 is NOT a block, so every
#     rule in the file stopped enforcing at once.
# That last one is the reason to keep running this: the failure mode of this file
# is total and invisible. Add a case for every rule you add.
#
# Each case: expected exit code, description, JSON input. 0 = allowed, 2 = blocked.
GUARD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/guard.mjs"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/.git"

pass=0; fail=0

check() {
  local want="$1" desc="$2" json="$3"
  local out rc
  out=$(printf '%s' "$json" | node "$GUARD" 2>&1); rc=$?
  if [ "$rc" = "$want" ]; then
    pass=$((pass+1)); printf 'ok    (%s) %s\n' "$rc" "$desc"
  else
    fail=$((fail+1)); printf 'FAIL  want=%s got=%s  %s\n      -> %s\n' "$want" "$rc" "$desc" "${out:0:140}"
  fi
}

bash_input() { printf '{"tool_name":"Bash","tool_input":{"command":%s},"cwd":"%s","session_id":"S1"}' "$1" "$SANDBOX"; }

# For SUBAGENT cases, exit 0 is ambiguous: it means either "actively granted" or
# "no decision — fall through". Those differ in consequence. A non-interactive
# subagent whose call falls through is auto-denied by the permission layer, so
# "not granted" IS the denial for reviewers — but a test asserting rc=0 cannot
# tell the two apart, and would pass just as happily if a grant leaked in.
# So assert on the grant itself: granted emits allow JSON on stdout, not-granted
# emits nothing.
check_grant() {
  local want="$1" desc="$2" json="$3"   # want: granted | not-granted
  local out got
  out=$(printf '%s' "$json" | node "$GUARD" 2>/dev/null)
  if grep -q '"permissionDecision":"allow"' <<<"$out"; then got=granted; else got=not-granted; fi
  if [ "$got" = "$want" ]; then
    pass=$((pass+1)); printf 'ok    (%s) %s\n' "$got" "$desc"
  else
    fail=$((fail+1)); printf 'FAIL  want=%s got=%s  %s\n' "$want" "$got" "$desc"
  fi
}

echo "=== always-on gh gate (main agent, NO locks) ==="
check 2 'gh pr create'                 "$(bash_input '"gh pr create --title x --body y"')"
check 2 'gh pr view (read is blocked too)' "$(bash_input '"gh pr view 5"')"
check 2 'gh api'                       "$(bash_input '"gh api repos/o/r/pulls"')"
check 2 'gh pr merge'                  "$(bash_input '"gh pr merge 5"')"
check 2 'gh auth token (prints PAT)'   "$(bash_input '"gh auth token"')"
check 2 'gh via absolute path'         "$(bash_input '"/usr/local/bin/gh pr list"')"
check 2 'gh in command substitution'   "$(bash_input '"PR=$(gh pr view --json number)"')"
check 2 'gh in backtick substitution'  "$(bash_input '"echo `gh pr list`"')"
check 2 'gh second in a pipeline'      "$(bash_input '"echo x | gh api --input -"')"
check 2 'gh after env prefix'          "$(bash_input '"GH_TOKEN=z gh pr list"')"

echo "=== carve-out: local diagnostics ==="
check 0 'gh auth status'               "$(bash_input '"gh auth status"')"
check 0 'gh auth status + flags'       "$(bash_input '"gh auth status --hostname github.com"')"
check 0 'gh auth status piped'         "$(bash_input '"gh auth status 2>&1 | head -1"')"
check 0 'gh --version'                 "$(bash_input '"gh --version"')"
check 0 'gh version'                   "$(bash_input '"gh version"')"

echo "=== no false positives (gh as TEXT, not a command) ==="
check 0 'grep for gh api in a file'    "$(bash_input '"grep -n \"gh api\" README.md"')"
check 0 'rg with gh pattern'           "$(bash_input '"rg -n \\"gh pr create\\" hooks/"')"
check 0 'echo mentioning gh'           "$(bash_input '"echo \"run gh auth first\""')"
check 0 'filename containing gh'       "$(bash_input '"cat docs/gh-notes.md"')"

echo "=== wrapper heads must not walk past the gate (regression vs 0.23.0 regex) ==="
check 2 'bash -c gh pr create'         "$(bash_input '"bash -c \"gh pr create\""')"
check 2 'sh -c gh api'                 "$(bash_input "\"sh -c 'gh api repos/o/r'\"")"
check 2 'eval gh pr create'            "$(bash_input '"eval \"gh pr create\""')"
check 2 'xargs gh pr create'           "$(bash_input '"xargs gh pr create"')"
check 2 'env gh pr list'               "$(bash_input '"env gh pr list"')"
check 2 'command gh pr view'           "$(bash_input '"command gh pr view 5"')"
check 2 'timeout 5 gh pr list'         "$(bash_input '"timeout 5 gh pr list"')"
check 0 'bash -c with diagnostic only' "$(bash_input '"bash -c \"gh auth status\""')"
check 0 'bash -c unrelated'            "$(bash_input '"bash -c \"npm test\""')"

echo "=== armed-only git tier: UNARMED, so allowed ==="
check 0 'git commit unarmed'           "$(bash_input '"git commit -m wip"')"
check 0 'git push unarmed'             "$(bash_input '"git push origin main"')"
check 0 'git worktree unarmed'         "$(bash_input '"git worktree add /tmp/x"')"
check 0 'git diff'                     "$(bash_input '"git diff origin/main"')"
check 0 'npm test unarmed'             "$(bash_input '"npm test"')"

echo "=== armed: outbound git blocked, gh still blocked, fetch/diff allowed ==="
touch "$SANDBOX/.git/code-critic-S1.lock"
check 2 'git commit ARMED'             "$(bash_input '"git commit -m wip"')"
check 2 'git push ARMED'               "$(bash_input '"git push origin main"')"
check 0 'git fetch ARMED'              "$(bash_input '"git fetch origin"')"
check 0 'git diff ARMED'               "$(bash_input '"git diff origin/main"')"
check 0 'gh auth status ARMED'         "$(bash_input '"gh auth status"')"
check 2 'gh pr create ARMED'           "$(bash_input '"gh pr create"')"
rm -f "$SANDBOX/.git/code-critic-S1.lock"

echo "=== assessing gate ==="
touch "$SANDBOX/.git/code-critic-S1.assessing"
check 2 'npm test while assessing'     "$(bash_input '"npm test"')"
check 0 'git diff while assessing'     "$(bash_input '"git diff"')"
check 2 'gh pr view while assessing'   "$(bash_input '"gh pr view 5"')"

# Durable-agent transport carve-out: pane.mjs send/wait/peek/list/cancel inject
# a prompt into another session and poll a mailbox — read-only for gate
# purposes. The match is narrow; every hole probed below is a hole an agent
# under a denied dispatch WILL eventually try.
echo "=== assessing gate: durable-agent transport carve-out ==="
check 0 'pane send, literal path'      "$(bash_input '"node /x/agent-hierarchy/hooks/pane.mjs send --key ah-crit-reviewer-1 --summary \"Review the PR\""')"
check 0 'pane send, quoted path'       "$(bash_input '"node \"/x/agent hierarchy/hooks/pane.mjs\" send --key ah-r-1"')"
check 0 'pane wait with timeout'       "$(bash_input '"node /x/agent-hierarchy/hooks/pane.mjs wait --key ah-r-1 --timeout 3600"')"
check 0 'pane list'                    "$(bash_input '"node /x/agent-hierarchy/hooks/pane.mjs list"')"
check 0 'pane cancel'                  "$(bash_input '"node /x/agent-hierarchy/hooks/pane.mjs cancel --key ah-r-1"')"
check 0 'discovery assignment + send'  "$(bash_input '"PANE=\"$(ls -t /x/*/agent-hierarchy/*/hooks/pane.mjs 2>/dev/null | head -1)\"; node \"$PANE\" send --key ah-r-1 --summary \"one line\""')"
check 0 'send with quoted heredoc'     "$(bash_input '"node /x/hooks/pane.mjs send --key ah-r-1 <<'\''PROMPT'\''\nReview the diff; run nothing.\nPROMPT"')"
check 0 'discovery + heredoc combined' "$(bash_input '"PANE=\"$(ls -t /x/*/hooks/pane.mjs 2>/dev/null | head -1)\"; node \"$PANE\" send --key ah-r-1 <<'\''PROMPT'\''\nbody\nPROMPT"')"
check 2 'pane close is not transport'  "$(bash_input '"node /x/agent-hierarchy/hooks/pane.mjs close --key ah-r-1"')"
check 2 'pane create is not transport' "$(bash_input '"node /x/agent-hierarchy/hooks/pane.mjs create --agent reviewer"')"
check 2 'chained command after send'   "$(bash_input '"node /x/hooks/pane.mjs send --key k; npm test"')"
check 2 'piped command after wait'     "$(bash_input '"node /x/hooks/pane.mjs wait --key k | sh"')"
check 2 'unquoted heredoc delimiter'   "$(bash_input '"node /x/hooks/pane.mjs send --key k <<PROMPT\nbody\nPROMPT"')"
check 2 'substitution head is not ls'  "$(bash_input '"PANE=\"$(node -e evil)\"; node \"$PANE\" send --key k"')"
check 2 'substitution smuggles a semicolon' "$(bash_input '"PANE=\"$(ls /x; rm -rf .)\"; node \"$PANE\" send --key k"')"
check 2 'bare $PANE, no assignment'    "$(bash_input '"node \"$PANE\" send --key k"')"
check 2 'pane.mjs as a comment decoy'  "$(bash_input '"npm test # node /x/hooks/pane.mjs send"')"
check 2 'expanding double-quoted arg'  "$(bash_input '"node /x/hooks/pane.mjs send --key k --summary \"x $(rm -rf .)\""')"
check 2 'redirect smuggled into wait'  "$(bash_input '"node /x/hooks/pane.mjs wait --key k > /etc/passwd"')"
check 0 'single-quoted arg is data'    "$(bash_input '"node /x/hooks/pane.mjs send --key ah-r-1 --summary '\''has; odd | chars'\''"')"
rm -f "$SANDBOX/.git/code-critic-S1.assessing"

echo "=== MCP gate (always on) ==="
check 2 'main agent toolkit MCP'       "{\"tool_name\":\"mcp__plugin_github-pr-toolkit_github__pull_request_read\",\"cwd\":\"$SANDBOX\",\"session_id\":\"S1\"}"
check 2 'main agent bare github MCP'   "{\"tool_name\":\"mcp__github__create_pull_request\",\"cwd\":\"$SANDBOX\",\"session_id\":\"S1\"}"
check 0 'github-worker granted MCP'    "{\"tool_name\":\"mcp__plugin_github-pr-toolkit_github__create_pull_request\",\"agent_id\":\"a1\",\"agent_type\":\"github-worker\",\"cwd\":\"$SANDBOX\"}"
check 0 'reviewer subagent read git'   "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git diff\"},\"agent_id\":\"a2\",\"agent_type\":\"code-reviewer-general\",\"cwd\":\"$SANDBOX\"}"
check 0 'subagent gh not gated by hook' "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"gh pr create\"},\"agent_id\":\"a3\",\"agent_type\":\"github-worker\",\"cwd\":\"$SANDBOX\"}"

# The armed-window Bash rules must NOT reach the workers: critic-worker runs
# `git worktree` / `git commit` during exactly that window, and if the outbound-git
# tier caught it the worker would strand mid-review and present as a worktree bug,
# nowhere near this file. The subagent branch exits before those tiers; these cases
# keep that ordering from being refactored away.
echo "=== workers must survive the armed-window Bash rules ==="
# ARM FIRST — these cases are meaningless unarmed, and an unarmed pass would look
# identical to a real one.
touch "$SANDBOX/.git/code-critic-S1.lock"
touch "$SANDBOX/.git/code-critic-S1.assessing"
check 0 'critic-worker git commit ARMED'  "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m x\"},\"agent_id\":\"a4\",\"agent_type\":\"critic-worker\",\"cwd\":\"$SANDBOX\",\"session_id\":\"S1\"}"
check 0 'reviewer git diff ASSESSING'     "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git diff\"},\"agent_id\":\"a5\",\"agent_type\":\"code-reviewer-general\",\"cwd\":\"$SANDBOX\",\"session_id\":\"S1\"}"
# A CODE REVIEW MUST NOT ALTER CODE. The hook's half of that is refusing to GRANT a
# mutating command — the platform then auto-denies the ungranted call. Asserted as
# grant/no-grant, since rc=0 covers both and would hide a leaked grant.
check_grant not-granted 'reviewer write via Bash not granted' "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo x > src/app.ts\"},\"agent_id\":\"a6\",\"agent_type\":\"code-reviewer-all\",\"cwd\":\"$SANDBOX\",\"session_id\":\"S1\"}"
check_grant not-granted 'reviewer sed -i not granted'         "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"sed -i s/a/b/ src/app.ts\"},\"agent_id\":\"a7\",\"agent_type\":\"code-reviewer-general\",\"cwd\":\"$SANDBOX\",\"session_id\":\"S1\"}"
check_grant not-granted 'reviewer npm test not granted'       "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"npm test\"},\"agent_id\":\"a8\",\"agent_type\":\"code-reviewer-general\",\"cwd\":\"$SANDBOX\",\"session_id\":\"S1\"}"
check_grant not-granted 'reviewer gh not granted'             "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"gh pr create\"},\"agent_id\":\"a9\",\"agent_type\":\"code-reviewer-general\",\"cwd\":\"$SANDBOX\",\"session_id\":\"S1\"}"
check_grant granted     'reviewer read git IS granted'        "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git diff origin/main\"},\"agent_id\":\"b1\",\"agent_type\":\"code-reviewer-all\",\"cwd\":\"$SANDBOX\",\"session_id\":\"S1\"}"
check_grant not-granted 'reviewer never granted GitHub MCP'   "{\"tool_name\":\"mcp__plugin_github-pr-toolkit_github__pull_request_read\",\"agent_id\":\"b2\",\"agent_type\":\"code-reviewer-general\",\"cwd\":\"$SANDBOX\",\"session_id\":\"S1\"}"

# Documented limitation, asserted so it cannot drift silently: the assessing gate
# and the reviewer grant are HEAD-ONLY — they do not look inside a wrapper
# payload the way the gh scan does. `bash` is not in READ_ONLY_HEADS, so a
# wrapped read is refused during assessment. That direction is the safe one (a
# wrapper is exactly where a test run would hide) and the fix is to re-issue
# without the wrapper, so it stays as-is rather than growing a second scanner.
check 2 'wrapped read blocked ASSESSING (by design)' "$(bash_input '"bash -c \"git diff\""')"
rm -f "$SANDBOX/.git/code-critic-S1.lock" "$SANDBOX/.git/code-critic-S1.assessing"

# ---------------------------------------------------------------------------
# WORKER-SCOPED DESTRUCTION GATE (third tier). The two tiers above gate WHO runs
# a command; this one gates WHAT it does, because delegation laundered them: the
# orchestrator, blocked from `git worktree` by the armed tier, wrote
# `git worktree remove --force <a worktree it did not create>` into a
# critic-worker dispatch, where nothing reliably shows it to a human first. Every
# case below is that failure or a variant of it.
agent_input() { printf '{"tool_name":"Bash","tool_input":{"command":%s},"agent_id":"w1","agent_type":"%s","cwd":"%s","session_id":"S1"}' "$1" "$2" "$SANDBOX"; }
LEDGER="$SANDBOX/.git/code-critic-worktrees"
printf 'S1\t%s\n' "$SANDBOX/seeded/pr-1" > "$LEDGER"
printf 'S1\t%s\n' "$SANDBOX/my wt/pr-2" >> "$LEDGER"

echo "=== the exact failure: forced removal, and removal of what we did not create ==="
check 2 'worker: worktree remove --force (recorded path — force is still denied)' "$(agent_input "\"git worktree remove --force $SANDBOX/seeded/pr-1\"" critic-worker)"
check 2 'worker: worktree remove -f'            "$(agent_input "\"git worktree remove -f $SANDBOX/seeded/pr-1\"" critic-worker)"
check 2 'worker: remove an UNRECORDED worktree' "$(agent_input "\"git worktree remove $SANDBOX/someone-elses-branch\"" critic-worker)"
check 2 'worker: remove with no path'           "$(agent_input '"git worktree remove"' critic-worker)"
check 2 'worker: remove a RELATIVE path'        "$(agent_input '"git worktree remove .claude/worktrees/pr-1"' critic-worker)"
check 2 'worker: worktree prune'                "$(agent_input '"git worktree prune"' critic-worker)"
check 2 'worker: force via git -C global opt'   "$(agent_input "\"git -C $SANDBOX worktree remove --force $SANDBOX/seeded/pr-1\"" critic-worker)"
check 2 'worker: force inside bash -c wrapper'  "$(agent_input "\"bash -c \\\"git worktree remove --force $SANDBOX/seeded/pr-1\\\"\"" critic-worker)"
check 2 'worker: rm -rf instead of git'         "$(agent_input "\"rm -rf $SANDBOX/seeded/pr-1\"" critic-worker)"
check 2 'worker: rmdir'                         "$(agent_input "\"rmdir $SANDBOX/seeded/pr-1\"" critic-worker)"
check 2 'worker: find -delete'                  "$(agent_input "\"find $SANDBOX/seeded -name pr-1 -delete\"" critic-worker)"

echo "=== removal IS allowed for a worktree this plugin recorded creating ==="
check 0 'worker: remove a recorded path'        "$(agent_input "\"git worktree remove $SANDBOX/seeded/pr-1\"" critic-worker)"
check 0 'worker: remove a recorded path with a SPACE (quoted)' "$(agent_input "\"git worktree remove \\\"$SANDBOX/my wt/pr-2\\\"\"" critic-worker)"
check 0 'worker: worktree add (the one creation)' "$(agent_input "\"git fetch origin pull/9/head:cc-pr-9 && git worktree add $SANDBOX/fresh/pr-9 cc-pr-9\"" critic-worker)"
# THE LEDGER ROUND-TRIP: the add above must have recorded the path, so this
# remove — identical in shape to the denied one two cases up — now passes. This is
# the whole mechanism; if recording breaks, CLEANUP starts failing mid-review.
grep -q "$SANDBOX/fresh/pr-9" "$LEDGER" \
  && { pass=$((pass+1)); printf 'ok    (ledger) worktree add was recorded\n'; } \
  || { fail=$((fail+1)); printf 'FAIL  worktree add was NOT recorded in the ledger\n'; }
check 0 'worker: remove the path the add just recorded' "$(agent_input "\"git worktree remove $SANDBOX/fresh/pr-9\"" critic-worker)"

echo "=== other destructive git, denied to this plugin's own agents ==="
check 2 'worker: reset --hard'          "$(agent_input '"git reset --hard origin/main"' critic-worker)"
check 2 'worker: clean -fd'             "$(agent_input '"git clean -fd"' critic-worker)"
check 2 'worker: push --force'          "$(agent_input '"git push --force origin cc-pr-9"' critic-worker)"
check 2 'worker: push --force-with-lease' "$(agent_input '"git push --force-with-lease origin cc-pr-9"' critic-worker)"
check 2 'worker: push +refspec'         "$(agent_input '"git push origin +HEAD:refs/heads/main"' critic-worker)"
check 2 'worker: push --delete'         "$(agent_input '"git push origin --delete cc-pr-9"' critic-worker)"
check 2 'worker: commit --amend'        "$(agent_input '"git commit --amend -m x"' critic-worker)"
check 2 'worker: branch -D'             "$(agent_input '"git branch -D cc-pr-9"' critic-worker)"
check 2 'worker: checkout'              "$(agent_input '"git checkout main"' critic-worker)"
check 2 'worker: restore (discards work)' "$(agent_input '"git restore src/app.ts"' critic-worker)"
check 2 'worker: rebase'                "$(agent_input '"git rebase origin/main"' critic-worker)"
check 2 'github-worker gets the same gate' "$(agent_input '"git reset --hard"' github-worker)"

# The reviewer half. isReviewerSafeBash refuses outbound git and redirection, but
# `git clean` / `git reset` sit inside its allowed heads — the same laundering
# through a different door, so the gate covers reviewers too. Asserted as rc=2
# (an active block), NOT merely not-granted, since not-granted would also pass if
# the case fell through to the permission layer for an unrelated reason.
echo "=== review subagents are covered too (they are this plugin's agents) ==="
check 2 'reviewer: git clean -fd'       "$(agent_input '"git clean -fd"' code-reviewer-general)"
check 2 'reviewer: git reset --hard'    "$(agent_input '"git reset --hard"' code-reviewer-all)"
check 2 'reviewer: custom category too' "$(agent_input '"git clean -fdx"' code-reviewer-my-house-rules)"

echo "=== the playbook must survive the gate (false positives cost a stranded review) ==="
check 0 'worker: plain commit'          "$(agent_input '"git commit -m subject -m body"' critic-worker)"
check 0 'worker: plain push -u'         "$(agent_input '"git push -u origin HEAD"' critic-worker)"
check 0 'worker: fetch'                 "$(agent_input '"git fetch origin main"' critic-worker)"
check 0 'worker: add -A'                "$(agent_input '"git add -A"' critic-worker)"
check 0 'worker: rev-parse via -C'      "$(agent_input "\"git -C $SANDBOX/seeded/pr-1 rev-parse HEAD\"" critic-worker)"
check 0 'worker: worktree list'         "$(agent_input '"git worktree list"' critic-worker)"
# A commit message that TALKS about the denied flags is not a use of them.
check 0 'worker: --force inside a commit message' "$(agent_input '"git commit -m \"deny worktree remove --force in the guard\""' critic-worker)"

# SCOPE, asserted so it cannot drift into a surprise: this tier covers the agents
# THIS PLUGIN defines. Any other subagent in the session is somebody else's
# business and falls through exactly as before.
check 0 'a non-plugin subagent is out of scope by design' "$(agent_input "\"git worktree remove --force $SANDBOX/someone-elses-branch\"" task-gopher)"
rm -f "$LEDGER"

# ---------------------------------------------------------------------------
# FRONTMATTER ASSERTIONS. Everything above tests guard.mjs. But half of "a code
# review cannot alter code" lives in the agent FILES, not the hook — and a
# deny-list that silently loses its Write entry fails exactly as quietly as a
# broken hook. These assert the declaration itself.
echo "=== reviewer agent frontmatter (the other half of the guarantee) ==="
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
for f in "$REPO"/github-pr-toolkit/agents/code-reviewer-*.md \
         "$REPO"/github-pr-toolkit/skills/add-review-category/template.md; do
  name="$(basename "$f")"
  fm="$(awk 'NR>1 && /^---$/{exit} {print}' "$f")"
  if ! grep -q '^disallowedTools:' <<<"$fm"; then
    fail=$((fail+1)); printf 'FAIL  %s: no disallowedTools in frontmatter\n' "$name"
  elif ! grep -qE '(^|[[:space:],])Write[,[:space:]]*$' <<<"$fm"; then
    fail=$((fail+1)); printf 'FAIL  %s: disallowedTools does not deny Write\n' "$name"
  elif ! grep -qE '(^|[[:space:],])Edit[,[:space:]]*$' <<<"$fm"; then
    fail=$((fail+1)); printf 'FAIL  %s: disallowedTools does not deny Edit\n' "$name"
  elif grep -q '^tools:' <<<"$fm"; then
    # An allow-list would re-narrow the inherited pool and drop memory servers,
    # which is the whole reason these files went deny-list.
    fail=$((fail+1)); printf 'FAIL  %s: has a tools: allow-list (should inherit)\n' "$name"
  elif ! grep -q 'You do not alter anything' "$f"; then
    # The THIRD layer, and the only one that covers a channel the other two miss.
    # disallowedTools stops the file-edit tools; the guard stops mutating Bash — but
    # the guard is keyed on `tool === "Bash"`, so a shell reached through any other
    # tool is governed by prose alone. That sentence is deliberately written as
    # "by any means", NOT nested under a Bash clause, because a prohibition that
    # reads as being about Bash is exactly the one a non-Bash channel slips past.
    fail=$((fail+1)); printf 'FAIL  %s: missing the channel-agnostic no-mutation rule\n' "$name"
  else
    pass=$((pass+1)); printf 'ok    %s: denies Write/Edit, no allow-list, prose ban present\n' "$name"
  fi
done

echo
printf 'pass=%d fail=%d\n' "$pass" "$fail"
[ "$fail" = 0 ]
