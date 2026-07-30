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
