#!/usr/bin/env bash
# Test harness for hooks/guard.mjs.  Run:  bash hooks/guard.test.sh
#
# WHY THIS EXISTS. The guard fails SILENTLY. A hook that exits 0 when it meant to
# exit 2 looks exactly like a hook that correctly allowed the call — there is no
# error, no log line, nothing to notice until someone runs `gh pr create` and it
# works. Three real defects were caught here rather than in the wild:
#   - `ctx_execute(language:"bash", code:"gh pr create")` bypassed a gate keyed on
#     `tool === "Bash"` entirely (the command lives in `code`, not `command`).
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

echo "=== ctx_* second shell channel (command lives in \`code\`, not \`command\`) ==="
ctx_input() { printf '{"tool_name":"mcp__plugin_context-mode_context-mode__ctx_execute","tool_input":{"language":"bash","code":%s},"cwd":"%s","session_id":"S1"}' "$1" "$SANDBOX"; }
check 2 'ctx_execute gh pr create'     "$(ctx_input '"gh pr create --title x"')"
check 2 'ctx_execute gh api'           "$(ctx_input '"gh api repos/o/r/pulls"')"
check 2 'ctx_batch nested payload'     "{\"tool_name\":\"mcp__plugin_context-mode_context-mode__ctx_batch_execute\",\"tool_input\":{\"items\":[{\"language\":\"bash\",\"code\":\"gh pr create\"}]},\"cwd\":\"$SANDBOX\",\"session_id\":\"S1\"}"
check 0 'ctx_execute unrelated code'   "$(ctx_input '"npm run build"')"
check 0 'ctx_execute gh auth status'   "$(ctx_input '"gh auth status"')"
check 0 'ctx_execute no tool_input'    "{\"tool_name\":\"mcp__plugin_context-mode_context-mode__ctx_execute\",\"cwd\":\"$SANDBOX\",\"session_id\":\"S1\"}"

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
check 2 'ctx_execute closed ARMED'     "$(ctx_input '"npm test"')"
rm -f "$SANDBOX/.git/code-critic-S1.lock"

echo "=== assessing gate ==="
touch "$SANDBOX/.git/code-critic-S1.assessing"
check 2 'npm test while assessing'     "$(bash_input '"npm test"')"
check 0 'git diff while assessing'     "$(bash_input '"git diff"')"
check 2 'gh pr view while assessing'   "$(bash_input '"gh pr view 5"')"
check 2 'ctx_execute closed ASSESSING' "$(ctx_input '"npm test"')"
rm -f "$SANDBOX/.git/code-critic-S1.assessing"

echo "=== MCP gate (always on) ==="
check 2 'main agent toolkit MCP'       "{\"tool_name\":\"mcp__plugin_github-pr-toolkit_github__pull_request_read\",\"cwd\":\"$SANDBOX\",\"session_id\":\"S1\"}"
check 2 'main agent bare github MCP'   "{\"tool_name\":\"mcp__github__create_pull_request\",\"cwd\":\"$SANDBOX\",\"session_id\":\"S1\"}"
check 0 'github-worker granted MCP'    "{\"tool_name\":\"mcp__plugin_github-pr-toolkit_github__create_pull_request\",\"agent_id\":\"a1\",\"agent_type\":\"github-worker\",\"cwd\":\"$SANDBOX\"}"
check 0 'reviewer subagent read git'   "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git diff\"},\"agent_id\":\"a2\",\"agent_type\":\"code-reviewer-general\",\"cwd\":\"$SANDBOX\"}"
check 0 'subagent gh not gated by hook' "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"gh pr create\"},\"agent_id\":\"a3\",\"agent_type\":\"github-worker\",\"cwd\":\"$SANDBOX\"}"

# The armed-window ctx_* closure must NOT reach the workers. context-mode's hook
# rewrites a subagent's Bash into ctx_* calls, and critic-worker runs
# `git worktree` / `git commit` during exactly the armed window — if the closure
# caught it, the worker would strand mid-review and it would present as a
# worktree bug, nowhere near this file. The subagent branch exits before the
# closure; these two cases are what keep that ordering from being refactored away.
echo "=== workers must survive the armed-window ctx_* closure ==="
touch "$SANDBOX/.git/code-critic-S1.lock"
touch "$SANDBOX/.git/code-critic-S1.assessing"
check 0 'critic-worker ctx git commit ARMED' "{\"tool_name\":\"mcp__plugin_context-mode_context-mode__ctx_execute\",\"tool_input\":{\"language\":\"bash\",\"code\":\"git commit -m x\"},\"agent_id\":\"a4\",\"agent_type\":\"critic-worker\",\"cwd\":\"$SANDBOX\",\"session_id\":\"S1\"}"
check 0 'reviewer ctx read ASSESSING'        "{\"tool_name\":\"mcp__plugin_context-mode_context-mode__ctx_execute\",\"tool_input\":{\"language\":\"bash\",\"code\":\"git diff\"},\"agent_id\":\"a5\",\"agent_type\":\"code-reviewer-general\",\"cwd\":\"$SANDBOX\",\"session_id\":\"S1\"}"

# A CODE REVIEW MUST NOT ALTER CODE — and that has to hold for every shell channel,
# not just Bash. Reviewers no longer pin a `tools:` allowlist (they inherit the
# session's tools so any memory MCP comes along), which makes ctx_* ordinarily
# reachable rather than theoretical.
rev() { printf '{"tool_name":"mcp__plugin_context-mode_context-mode__ctx_execute","tool_input":{"language":"bash","code":%s},"agent_id":"r1","agent_type":"%s","cwd":"%s"}' "$1" "${2:-code-reviewer-general}" "$SANDBOX"; }
echo "=== reviewer ctx_* payloads held to read-only (a review never edits code) ==="
check 2 'reviewer ctx redirect to file'  "$(rev '"echo x > src/app.ts"')"
check 2 'reviewer ctx append to file'    "$(rev '"echo x >> src/app.ts"')"
check 2 'reviewer ctx sed -i'            "$(rev '"sed -i s/a/b/ src/app.ts"')"
check 2 'reviewer ctx rm'                "$(rev '"rm -rf src"')"
check 2 'reviewer ctx npm test'          "$(rev '"npm test"')"
check 2 'reviewer ctx git push'          "$(rev '"git push origin main"')"
check 2 'reviewer ctx gh pr create'      "$(rev '"gh pr create"')"
check 0 'reviewer ctx git diff'          "$(rev '"git diff origin/main"')"
check 0 'reviewer ctx grep'              "$(rev '"grep -rn TODO src | head -20"')"
check 2 'code-reviewer-all ctx write'    "$(rev '"echo x > src/app.ts"' 'code-reviewer-all')"
check 0 'code-reviewer-all ctx read'     "$(rev '"git diff origin/main"' 'code-reviewer-all')"
check 0 'reviewer Bash read still ok'    "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git log -5\"},\"agent_id\":\"r2\",\"agent_type\":\"code-reviewer-all\",\"cwd\":\"$SANDBOX\"}"
# commandLeaves is FAIL-CLOSED: a payload shape with no recognized command key
# reads as all-command, so another plugin renaming its field makes the check
# stricter rather than silently switching it off.
check 2 'reviewer ctx unknown shape'     "{\"tool_name\":\"mcp__plugin_context-mode_context-mode__ctx_execute\",\"tool_input\":{\"language\":\"bash\",\"payload\":{\"deep\":\"rm -rf src\"}},\"agent_id\":\"r3\",\"agent_type\":\"code-reviewer-general\",\"cwd\":\"$SANDBOX\"}"
# argv-style: a command key holding an ARRAY must be checked, not skipped.
check 2 'reviewer ctx args array'        "{\"tool_name\":\"mcp__plugin_context-mode_context-mode__ctx_execute\",\"tool_input\":{\"args\":[\"rm -rf src\"]},\"agent_id\":\"r4\",\"agent_type\":\"code-reviewer-general\",\"cwd\":\"$SANDBOX\"}"
# Mixed shape: `code` is recognized, so the fallback correctly does NOT fire and
# the string under `extra.nested` is not treated as a command. That is deliberate
# — ctx_execute runs `code`; an unexecuted string is not a mutation risk, and
# treating it as one would refuse ordinary reads. Asserted so the choice is visible.
check 0 'reviewer ctx mixed shape read'  "{\"tool_name\":\"mcp__plugin_context-mode_context-mode__ctx_execute\",\"tool_input\":{\"code\":\"git diff\",\"extra\":{\"nested\":\"rm -rf src\"}},\"agent_id\":\"r5\",\"agent_type\":\"code-reviewer-general\",\"cwd\":\"$SANDBOX\"}"
check 2 'MAIN agent ctx still closed ARMED'  "{\"tool_name\":\"mcp__plugin_context-mode_context-mode__ctx_execute\",\"tool_input\":{\"language\":\"bash\",\"code\":\"git commit -m x\"},\"cwd\":\"$SANDBOX\",\"session_id\":\"S1\"}"

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
  else
    pass=$((pass+1)); printf 'ok    %s: denies Write/Edit, no allow-list\n' "$name"
  fi
done

echo
printf 'pass=%d fail=%d\n' "$pass" "$fail"
[ "$fail" = 0 ]
